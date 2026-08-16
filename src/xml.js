/*
 * A very small XML reader, written for exactly one shape: WebDAV `multistatus`
 * bodies as Nextcloud emits them.
 *
 * Why not DOMParser, which Obsidian has on both platforms: it does not exist in
 * plain `node`, and every custom piece in this vault has a test that runs with
 * nothing installed. A multistatus is a constrained document, so ~120 lines of
 * reader buys full testability.
 *
 * The other reason is robustness. Namespace *prefixes* are not contractual —
 * Nextcloud writes `d:`, other servers write `D:` or `dav:`, and the same server
 * can change them between versions. Every lookup here matches on the **local
 * name, lowercased**, and ignores the prefix entirely. Nothing may key off a
 * prefix; that is the bug this file exists to prevent.
 *
 * What it deliberately does not do: DTDs, entities beyond the five predefined
 * ones plus numeric references, namespace *resolution*, mixed-content ordering.
 * None of that appears in a DAV response.
 */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const cp = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

/** Escapes a text value for insertion into a request body we build. */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `cal:supported-calendar-component-set` → `supported-calendar-component-set`. */
function localName(qname) {
  const n = String(qname);
  const colon = n.lastIndexOf(':');
  return (colon < 0 ? n : n.slice(colon + 1)).toLowerCase();
}

/** Index of the `>` closing the tag that starts at `open`, respecting quotes. */
function findTagEnd(src, open) {
  let quote = '';
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(s) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) {
    attrs[localName(m[1])] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function node(name, attrs) {
  return { name, attrs: attrs || {}, children: [], text: '' };
}

/**
 * Parses a document into a tree of { name, attrs, children, text }.
 * `name` is always the lowercased local name. Unclosed tags are tolerated: at
 * EOF whatever is still open is simply closed, because a truncated response
 * should degrade to partial data rather than throw.
 */
function parseXml(text) {
  const src = String(text == null ? '' : text);
  const root = node('#document');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().text += src.slice(lt + 9, end < 0 ? src.length : end);   // literal, no decoding
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {      // declaration, doctype
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) break;                                              // truncated tag
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const name = localName(inner.slice(1).trim());
      // Pop to the matching open tag; a stray close for something never opened
      // is ignored rather than unwinding the whole document.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) { stack.length = d; break; }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/[\s]/);
    const name = localName(space < 0 ? body : body.slice(0, space));
    if (!name) continue;
    const el = node(name, space < 0 ? {} : parseAttrs(body.slice(space)));
    top().children.push(el);
    if (!selfClosing) stack.push(el);
  }

  return root;
}

/* ---------------------------------------------------------------- queries */

const kids = (n, name) => (n && n.children ? n.children.filter((c) => c.name === name) : []);
const kid = (n, name) => kids(n, name)[0] || null;

/** First descendant at any depth, breadth-first. */
function descend(n, name) {
  const queue = n && n.children ? n.children.slice() : [];
  while (queue.length) {
    const c = queue.shift();
    if (c.name === name) return c;
    queue.push(...c.children);
  }
  return null;
}

function descendAll(n, name, out) {
  const acc = out || [];
  for (const c of (n && n.children ? n.children : [])) {
    if (c.name === name) acc.push(c);
    descendAll(c, name, acc);
  }
  return acc;
}

const textOf = (n) => (n ? String(n.text).trim() : '');

/* ------------------------------------------------------------ DAV shaping */

/**
 * Flattens a multistatus into one entry per `<response>`:
 *
 *   { href, status, props: { <localname>: <node> } }
 *
 * Only props inside a 2xx `<propstat>` are kept — a `404 Not Found` propstat is
 * the server saying "asked, don't have it", and treating that as an empty value
 * is how a missing displayname turns into a list called "".
 */
function davResponses(xmlText) {
  const doc = parseXml(xmlText);
  const ms = descend(doc, 'multistatus') || doc;
  return descendAll(ms, 'response').map((res) => {
    const props = {};
    for (const ps of kids(res, 'propstat')) {
      const code = statusCode(textOf(kid(ps, 'status')));
      if (code !== null && (code < 200 || code >= 300)) continue;
      const prop = kid(ps, 'prop');
      for (const c of (prop ? prop.children : [])) props[c.name] = c;
    }
    return { href: textOf(kid(res, 'href')), status: textOf(kid(res, 'status')), props };
  });
}

/** `HTTP/1.1 404 Not Found` → 404; anything unparseable → null. */
function statusCode(line) {
  const m = /\s(\d{3})(\s|$)/.exec(String(line));
  return m ? parseInt(m[1], 10) : null;
}

export {
  parseXml,
  davResponses,
  decodeEntities,
  escapeXml,
  localName,
  statusCode,
  kid,
  kids,
  descend,
  descendAll,
  textOf,
};
