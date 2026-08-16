/*
 * CalDAV against Nextcloud, over Obsidian's `requestUrl`.
 *
 * `requestUrl` rather than `fetch` for one reason: it bypasses CORS and works
 * unchanged on iOS. The HTTP function is injected rather than imported so the
 * whole client is testable against a fake in plain `node` — no network, no
 * credentials, no install.
 *
 * Two things here are load-bearing:
 *
 *   - PROPFIND, REPORT and MKCALENDAR are not methods every HTTP stack passes
 *     through. `probe()` exists to find that out on each platform *before* the
 *     UI is built on top, and `listTasks` carries a standard-HTTP fallback
 *     (PROPFIND + GET per object) for a platform that refuses REPORT.
 *   - Completion never regenerates the calendar object. We GET the original,
 *     hand it to ics.setCompletion, and PUT the result back with If-Match.
 */

import { davResponses, kid, kids, textOf, escapeXml } from './xml.js';
import * as ics from './ics.js';
import { t } from './i18n.js';

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"'
  + ' xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns"'
  + ' xmlns:ic="http://apple.com/ns/ical/"';

const XML_HEAD = '<?xml version="1.0" encoding="utf-8" ?>';

/**
 * UTF-8 safe Basic auth. `btoa` alone mangles anything above U+00FF, so the
 * string is encoded first and then base64'd byte by byte. Both `btoa` and
 * `TextEncoder` are globals in a browser, on a phone and in node alike.
 */
function basicAuth(user, pass) {
  const raw = `${user || ''}:${pass || ''}`;
  let bin = '';
  for (const b of new TextEncoder().encode(raw)) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** `https://cloud.example.com/index.php/` → `https://cloud.example.com` */
function normalizeBase(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/index\.php$/i, '');
  u = u.replace(/\/remote\.php\/dav.*$/i, '');
  return u;
}

/** DAV hrefs come back as absolute paths; make them absolute URLs. */
function absolute(base, href) {
  const h = String(href || '');
  if (/^https?:\/\//i.test(h)) return h;
  return base + (h.startsWith('/') ? h : `/${h}`);
}

/** Path part of a URL, which is what an href in a multistatus is. */
function pathOf(url) {
  const m = /^https?:\/\/[^/]+(\/.*)$/i.exec(String(url));
  return m ? m[1] : String(url);
}

class DavError extends Error {
  constructor(message, status, method, url) {
    super(message);
    this.name = 'DavError';
    this.status = status;
    this.method = method;
    this.url = url;
  }
}

/** Turns an HTTP status into something a person can act on. */
function describe(status, method, url) {
  if (status === 401) return t('err.401');
  if (status === 403) return t('err.403');
  if (status === 404) return t('err.404', { url });
  if (status === 405) return t('err.405', { method });
  if (status === 412) return t('err.412');
  if (status === 501) return t('err.501', { method });
  if (status >= 500) return t('err.server', { status, method, url });
  return t('err.http', { method, url, status });
}

class CalDav {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   Nextcloud root, e.g. https://cloud.example.com
   * @param {string} o.username
   * @param {string} o.password  app password, never the account password
   * @param {function} o.request requestUrl-compatible; injected for testing
   */
  constructor(o) {
    this.base = normalizeBase(o.baseUrl);
    this.username = o.username || '';
    this.password = o.password || '';
    this.request = o.request;
    this.log = o.log || (() => {});
    this.discovery = null;                  // cached for the session only
    this.reportUnsupported = false;         // flipped by the fallback, per session
  }

  get configured() {
    return !!(this.base && this.username && this.password);
  }

  async raw(method, url, opts) {
    const o = opts || {};
    const headers = Object.assign({
      Authorization: basicAuth(this.username, this.password),
      'User-Agent': 'Obsidian nextcloud-tasks',
    }, o.headers || {});
    if (o.depth !== undefined) headers.Depth = String(o.depth);
    if (o.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = o.contentType || 'application/xml; charset=utf-8';
    }

    let res;
    try {
      res = await this.request({
        url,
        method,
        headers,
        body: o.body,
        throw: false,
      });
    } catch (e) {
      // requestUrl rejects outright when a platform refuses the verb.
      throw new DavError(`${method} ${url}: ${e && e.message ? e.message : e}`, 0, method, url);
    }
    const status = res && typeof res.status === 'number' ? res.status : 0;
    this.log(`${method} ${pathOf(url)} → ${status}`);
    return { status, text: (res && res.text) || '', headers: (res && res.headers) || {} };
  }

  async dav(method, url, opts) {
    const res = await this.raw(method, url, opts);
    const ok = (opts && opts.allow) || [200, 201, 204, 207];
    if (!ok.includes(res.status)) {
      throw new DavError(describe(res.status, method, url), res.status, method, url);
    }
    return res;
  }

  /* ------------------------------------------------------------ discovery */

  /**
   * principal → calendar-home-set → the VTODO collections in it.
   * The full chain rather than a hardcoded /remote.php/dav/calendars/<user>/ —
   * it is fifteen extra lines and removes every username-casing bug.
   */
  async discover(force) {
    if (this.discovery && !force) return this.discovery;
    if (!this.configured) throw new DavError(t('err.credentials'), 0, '', '');

    const principal = await this.findPrincipal();
    const home = await this.findHome(principal);
    const lists = await this.findLists(home);
    this.discovery = { principal, home, lists };
    return this.discovery;
  }

  async findPrincipal() {
    const url = `${this.base}/remote.php/dav/`;
    const body = `${XML_HEAD}<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
    const res = await this.dav('PROPFIND', url, { depth: 0, body });
    for (const r of davResponses(res.text)) {
      const href = textOf(kid(r.props['current-user-principal'], 'href'));
      if (href) return absolute(this.base, href);
    }
    throw new DavError(t('err.noPrincipal'), res.status, 'PROPFIND', url);
  }

  async findHome(principal) {
    const body = `${XML_HEAD}<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
    const res = await this.dav('PROPFIND', principal, { depth: 0, body });
    for (const r of davResponses(res.text)) {
      const href = textOf(kid(r.props['calendar-home-set'], 'href'));
      if (href) return absolute(this.base, href).replace(/\/?$/, '/');
    }
    throw new DavError(t('err.noHome'), res.status, 'PROPFIND', principal);
  }

  async findLists(home) {
    const body = `${XML_HEAD}<d:propfind ${NS}><d:prop>`
      + '<d:displayname/><d:resourcetype/>'
      + '<c:supported-calendar-component-set/>'
      + '<ic:calendar-color/>'
      + '</d:prop></d:propfind>';
    const res = await this.dav('PROPFIND', home, { depth: 1, body });

    const homePath = pathOf(home).replace(/\/?$/, '/');
    const lists = [];
    for (const r of davResponses(res.text)) {
      const href = r.href;
      if (!href) continue;
      const path = pathOf(absolute(this.base, href)).replace(/\/?$/, '/');
      if (path === homePath) continue;                       // the home itself
      if (/\/trashbin\//i.test(path) || /\/inbox\/|\/outbox\//i.test(path)) continue;

      const rt = r.props['resourcetype'];
      if (!rt || !kid(rt, 'calendar')) continue;             // not a calendar
      if (kid(rt, 'subscribed')) continue;                   // read-only ICS subscription

      const compSet = r.props['supported-calendar-component-set'];
      // Absent means the server did not restrict it, which Nextcloud reads as
      // "everything" — so absence is permissive, not a reason to hide the list.
      const comps = compSet ? kids(compSet, 'comp').map((c) => String(c.attrs.name || '').toUpperCase()) : [];
      if (comps.length && !comps.includes('VTODO')) continue;

      lists.push({
        url: absolute(this.base, href).replace(/\/?$/, '/'),
        path,
        displayName: textOf(r.props['displayname']) || decodeURIComponent(path.split('/').filter(Boolean).pop() || ''),
        color: textOf(r.props['calendar-color']) || '',
        supportsTodo: !comps.length || comps.includes('VTODO'),
      });
    }
    return lists;
  }

  /* -------------------------------------------------------------- reading */

  /**
   * All VTODOs in a list, as { href, etag, ics, todo }.
   * `todo` is the parsed model; `ics` is the untouched original text, which is
   * what a later completion edits.
   */
  async listTasks(listUrl) {
    if (!this.reportUnsupported) {
      try {
        return await this.listViaReport(listUrl);
      } catch (e) {
        // 405/501 means this stack will not carry REPORT — remember it and fall
        // back for the rest of the session rather than paying the failure twice.
        if (e instanceof DavError && (e.status === 405 || e.status === 501 || e.status === 0)) {
          this.reportUnsupported = true;
          this.log(`REPORT unavailable (${e.status}), falling back to PROPFIND + GET`);
        } else {
          throw e;
        }
      }
    }
    return this.listViaPropfind(listUrl);
  }

  async listViaReport(listUrl) {
    const body = `${XML_HEAD}<c:calendar-query ${NS}>`
      + '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
      + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>'
      + '</c:calendar-query>';
    const res = await this.dav('REPORT', listUrl, { depth: 1, body });
    return this.toEntries(davResponses(res.text).map((r) => ({
      href: r.href,
      etag: textOf(r.props['getetag']),
      ics: textOf(r.props['calendar-data']),
    })));
  }

  /** Standard-HTTP path: enumerate, then GET each object. */
  async listViaPropfind(listUrl) {
    const body = `${XML_HEAD}<d:propfind ${NS}><d:prop><d:getetag/><d:getcontenttype/></d:prop></d:propfind>`;
    const res = await this.dav('PROPFIND', listUrl, { depth: 1, body });
    const listPath = pathOf(listUrl).replace(/\/?$/, '/');

    const out = [];
    for (const r of davResponses(res.text)) {
      const path = pathOf(absolute(this.base, r.href));
      if (!r.href || path === listPath || path.endsWith('/')) continue;
      const type = textOf(r.props['getcontenttype']);
      if (type && !/calendar/i.test(type)) continue;
      const got = await this.dav('GET', absolute(this.base, r.href), { allow: [200] });
      out.push({ href: r.href, etag: textOf(r.props['getetag']), ics: got.text });
    }
    return this.toEntries(out);
  }

  toEntries(rows) {
    const out = [];
    for (const row of rows) {
      if (!row.ics || !/BEGIN:VTODO/i.test(row.ics)) continue;
      for (const todo of ics.parseTodos(row.ics)) {
        if (todo.recurrenceId) continue;              // an override, not its own task
        out.push({
          href: row.href,
          url: absolute(this.base, row.href),
          etag: row.etag,
          ics: row.ics,
          todo,
          done: ics.isDone(todo),
        });
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- writing */

  /** PUT a brand-new object. If-None-Match:* so we can never clobber one. */
  async createTask(listUrl, fields) {
    const { uid, ics: body } = ics.buildTodo(fields || {});
    const url = `${String(listUrl).replace(/\/?$/, '/')}${encodeURIComponent(uid)}.ics`;
    const res = await this.dav('PUT', url, {
      body,
      contentType: 'text/calendar; charset=utf-8',
      headers: { 'If-None-Match': '*' },
      allow: [200, 201, 204],
    });
    return { uid, url, etag: (res.headers && (res.headers.etag || res.headers.ETag)) || '' };
  }

  /**
   * Every write to an existing object goes through here. It re-reads the object
   * first so the edit is applied to what the server currently holds, then PUTs
   * with If-Match. A 412 means someone — Reminders, the web UI, the other
   * laptop — changed it in between; we refetch once and reapply, because
   * `transform` is a small idempotent edit of the original text, not a
   * whole-object overwrite that would be unsafe to replay.
   *
   * `transform` returns null when the object holds no VTODO, and returns the
   * text it was handed when there is nothing to change. Neither ends in a PUT.
   */
  async editObject(entryUrl, transform, attempt) {
    const got = await this.dav('GET', entryUrl, { allow: [200] });
    const etag = (got.headers && (got.headers.etag || got.headers.ETag)) || '';
    const next = transform(got.text);
    if (next === null) {
      throw new DavError(t('err.noTodo'), 0, 'PUT', entryUrl);
    }
    if (next === got.text) return { url: entryUrl, etag, unchanged: true };

    const res = await this.raw('PUT', entryUrl, {
      body: next,
      contentType: 'text/calendar; charset=utf-8',
      headers: etag ? { 'If-Match': etag } : {},
    });
    if (res.status === 412 && !attempt) return this.editObject(entryUrl, transform, 1);
    if (![200, 201, 204].includes(res.status)) {
      throw new DavError(describe(res.status, 'PUT', entryUrl), res.status, 'PUT', entryUrl);
    }
    return {
      url: entryUrl,
      etag: (res.headers && (res.headers.etag || res.headers.ETag)) || '',
      unchanged: false,
    };
  }

  /** Tick or un-tick. */
  async setDone(entryUrl, done) {
    return this.editObject(entryUrl, (text) => ics.setCompletion(text, done));
  }

  /**
   * Change title, due date or priority. `fields` is partial: a key that is not
   * there leaves that property exactly as whichever client wrote it left it.
   */
  async updateTask(entryUrl, fields) {
    return this.editObject(entryUrl, (text) => ics.setFields(text, fields));
  }

  async deleteTask(entryUrl) {
    await this.dav('DELETE', entryUrl, { allow: [200, 202, 204, 404] });
  }

  /* --------------------------------------------------------- list creation */

  /**
   * MKCALENDAR a VTODO-only list. 405 means the collection is already there,
   * which is reported rather than treated as an error: pressing the button
   * twice must not break anything.
   */
  async createList(home, displayName, color) {
    const slug = String(displayName).toLowerCase()
      .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list';
    const url = `${String(home).replace(/\/?$/, '/')}${encodeURIComponent(slug)}/`;
    const body = `${XML_HEAD}<c:mkcalendar ${NS}><d:set><d:prop>`
      + `<d:displayname>${escapeXml(displayName)}</d:displayname>`
      + (color ? `<ic:calendar-color>${escapeXml(color)}</ic:calendar-color>` : '')
      + '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>'
      + '</d:prop></d:set></c:mkcalendar>';

    const res = await this.raw('MKCALENDAR', url, { body });
    if (res.status === 405) return { url, created: false, reason: t('err.exists') };
    if (![200, 201, 207].includes(res.status)) {
      throw new DavError(describe(res.status, 'MKCALENDAR', url), res.status, 'MKCALENDAR', url);
    }
    this.discovery = null;                    // force rediscovery next time
    return { url, created: true };
  }

  /* ----------------------------------------------------------- diagnostics */

  /**
   * What "Test connection" runs. Reports every step with its HTTP status
   * instead of one opaque failure, so a platform that refuses a verb is
   * obvious rather than mysterious. Never throws.
   */
  async probe() {
    const steps = [];
    const step = async (label, fn) => {
      try {
        const note = await fn();
        steps.push({ label, ok: true, note: note || 'ok' });
        return true;
      } catch (e) {
        steps.push({ label, ok: false, note: e && e.message ? e.message : String(e) });
        return false;
      }
    };

    let principal = '';
    let home = '';
    let lists = [];

    if (!await step(t('probe.principal'), async () => {
      principal = await this.findPrincipal();
      return pathOf(principal);
    })) return steps;

    if (!await step(t('probe.home'), async () => {
      home = await this.findHome(principal);
      return pathOf(home);
    })) return steps;

    if (!await step(t('probe.lists'), async () => {
      lists = await this.findLists(home);
      return lists.length ? lists.map((l) => l.displayName).join(', ') : t('probe.noLists');
    })) return steps;

    if (lists.length) {
      await step(t('probe.report'), async () => {
        const rows = await this.listViaReport(lists[0].url);
        return t('probe.tasks', { name: lists[0].displayName, n: rows.length });
      });
      if (!steps[steps.length - 1].ok) {
        await step(t('probe.fallback'), async () => {
          const rows = await this.listViaPropfind(lists[0].url);
          return t('probe.tasksFallback', { name: lists[0].displayName, n: rows.length });
        });
      }
    }
    return steps;
  }
}

export { CalDav, DavError, basicAuth, normalizeBase, absolute, pathOf, describe };
