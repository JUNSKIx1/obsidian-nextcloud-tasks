/*
 * Nextcloud Tasks for Obsidian.
 *
 * Invariants worth keeping if you touch this:
 *
 *   - Nothing about a task is ever written into a note or to disk. The fetched
 *     list lives in memory for the session and nowhere else. That is what keeps
 *     "your tasks live in Nextcloud" literally true instead of aspirationally
 *     true, and it is why there is no cache file that can go stale.
 *   - No timer, no polling. Refresh happens on layout-ready, on a block being
 *     rendered while the data is stale, on the command, and after a write.
 *   - The app password lives in this plugin's settings, never in a note.
 *   - Every request goes through requestUrl, so the same code runs on iOS.
 *   - Which lists exist is the user's business. This file iterates whatever is
 *     ticked in the settings and knows nothing else about them.
 */

import { Plugin, Notice, MarkdownRenderChild, requestUrl, getLanguage } from 'obsidian';

import { CalDav } from './caldav.js';
import { parseBlock, selectTasks, renderPanel } from './render.js';
import { normalizeSettings, enabledLists } from './model.js';
import { setLocale, t } from './i18n.js';
import { NextcloudTasksSettingTab } from './settings.js';
import { TaskModal, ProbeModal, ConfirmModal } from './modals.js';

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const message = (e) => (e && e.message ? e.message : String(e));
const pad = (n) => String(n).padStart(2, '0');

/** What an `<input type="date">` wants: the local day, never a UTC shift. */
function dateInputValue(due) {
  if (!due || !due.date) return '';
  const d = due.date;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default class NextcloudTasksPlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.applyLocale();

    this.entries = [];          // in memory only, by design
    this.fetchedAt = null;
    this.error = null;
    this.loading = false;
    this.blocks = new Set();
    this.timer = null;
    this.stickyDone = new Set();   // ticked in this session, kept on screen

    this.registerMarkdownCodeBlockProcessor('nextcloud-tasks', (source, el, ctx) => {
      const block = { el, cfg: parseBlock(source) };
      this.blocks.add(block);
      ctx.addChild(new BlockHandle(el, () => {
        this.blocks.delete(block);
        // Nothing of ours is on screen any more, so "the task you just ticked"
        // stops being a thing worth keeping. This is the "until you leave" line.
        if (!this.blocks.size) this.stickyDone.clear();
      }));
      this.draw(block);
      if (this.configured && this.isStale()) this.refresh(false);
    });

    this.addCommand({
      id: 'new-task',
      name: t('cmd.new'),
      callback: () => this.promptNewTask(null),
    });
    this.addCommand({
      id: 'refresh',
      name: t('cmd.refresh'),
      callback: () => this.refresh(true),
    });
    this.addCommand({
      id: 'test-connection',
      name: t('cmd.probe'),
      callback: () => this.runProbe(),
    });

    this.addSettingTab(new NextcloudTasksSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => { if (this.configured) this.refresh(false); });
    this.applyRefreshTimer();
  }

  onunload() {
    this.blocks.clear();
    this.stickyDone.clear();
  }

  /* -------------------------------------------------------------- pulling */

  /**
   * The only timer in the plugin, and it lives inside Obsidian: it is created
   * on load, replaced when the interval setting changes, and cleared by
   * `registerInterval` when the plugin unloads. Without it nothing would ever
   * arrive from the server on its own, which is wrong for a plugin whose whole
   * premise is that the tasks live there and not here.
   */
  applyRefreshTimer() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    const minutes = this.settings.refreshMinutes;
    if (!minutes) return;
    this.timer = window.setInterval(() => this.tick(), minutes * 60000);
    this.registerInterval(this.timer);
  }

  /** A tick that would achieve nothing costs a request, so it is skipped. */
  tick() {
    if (!this.configured || this.loading) return;
    if (!this.blocks.size) return;                       // no panel on screen
    if (typeof document !== 'undefined' && document.hidden) return;   // app in the background
    this.refresh(false);
  }

  /**
   * `getLanguage()` arrived in a later API than this plugin's minimum, so it is
   * probed rather than called outright; without it, `auto` simply means English.
   */
  applyLocale() {
    const app = typeof getLanguage === 'function' ? getLanguage() : '';
    setLocale(this.settings.language, app);
  }

  get configured() {
    const s = this.settings;
    return !!(s.baseUrl && s.username && s.password && enabledLists(s).length);
  }

  /** A fresh client whenever the credentials changed; discovery is cached on it. */
  client(force) {
    const s = this.settings;
    const key = `${s.baseUrl}|${s.username}|${s.password}`;
    if (!this._dav || force || this._davKey !== key) {
      this._davKey = key;
      this._dav = new CalDav({
        baseUrl: s.baseUrl,
        username: s.username,
        password: s.password,
        request: requestUrl,
      });
    }
    return this._dav;
  }

  /** Should a block rendering right now trigger a fetch. */
  isStale() {
    if (!this.fetchedAt) return true;
    return (Date.now() - this.fetchedAt.getTime()) / 1000 > this.settings.staleSeconds;
  }

  /**
   * Should the footer admit the data may be out of date. Deliberately not
   * `isStale()`: with a five-minute timer, a sixty-second staleness window
   * would claim to be offline four minutes out of every five.
   */
  looksOffline() {
    if (this.error || !this.fetchedAt) return true;
    const minutes = this.settings.refreshMinutes;
    const grace = minutes ? minutes * 3 * 60 : 600;
    return (Date.now() - this.fetchedAt.getTime()) / 1000 > grace;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.client(true);
    this.applyRefreshTimer();
  }

  /* -------------------------------------------------------------- loading */

  async refresh(loud) {
    if (this.loading) return;
    if (!this.configured) { this.drawAll(); return; }

    this.loading = true;
    if (!this.entries.length) this.drawAll();

    const dav = this.client();
    const rows = [];
    const problems = [];

    for (const list of enabledLists(this.settings)) {
      try {
        for (const entry of await dav.listTasks(list.url)) {
          rows.push(Object.assign({ listKey: list.key, listUrl: list.url }, entry));
        }
      } catch (e) {
        // One unreachable list must not blank out the others.
        problems.push(`${list.label || list.key}: ${message(e)}`);
      }
    }

    this.loading = false;
    if (problems.length && !rows.length) {
      this.error = problems.join(' · ');
    } else {
      this.error = problems.length ? problems.join(' · ') : null;
      this.entries = rows;
      this.fetchedAt = new Date();
    }
    this.drawAll();

    if (loud) {
      new Notice(this.error && !rows.length
        ? t('notice.refreshFailed', { error: this.error })
        : t('notice.refreshed', { n: rows.filter((r) => !r.done).length }));
    }
  }

  /* ------------------------------------------------------------ rendering */

  drawAll() {
    for (const block of this.blocks) this.draw(block);
  }

  draw(block) {
    const now = new Date();
    const cfg = block.cfg;
    const lists = this.settings.lists;
    const state = !this.configured ? 'unconfigured'
      : (this.loading && !this.fetchedAt) ? 'loading'
        : (this.error && !this.entries.length) ? 'error'
          : 'ready';

    renderPanel(block.el, {
      state,
      cfg,
      now,
      lists,
      unknownList: !!cfg.list && !lists.some((l) => l.key === cfg.list),
      rows: state === 'ready' ? selectTasks(this.entries, cfg, now, lists, this.stickyDone) : [],
      grouped: !cfg.list,
      stale: state === 'ready' && this.looksOffline(),
      fetchedAt: this.fetchedAt ? hhmm(this.fetchedAt) : '',
      message: this.error || '',
    }, {
      onCreate: (listKey) => this.promptNewTask(listKey || null),
      onRefresh: () => this.refresh(true),
      onToggle: (entry, done, settle) => this.toggle(entry, done, settle),
      onEdit: (entry) => this.promptEditTask(entry),
    });
  }

  /* -------------------------------------------------------------- writing */

  async toggle(entry, done, settle) {
    try {
      await this.client().setDone(entry.url, done);
      entry.done = done;
      // Remembered so the row survives every later refresh, greyed out rather
      // than gone. That is what makes redrawing safe: without it, the task you
      // just ticked would disappear from under the cursor.
      if (done) this.stickyDone.add(entry.url); else this.stickyDone.delete(entry.url);
      settle(true);
      this.drawAll();               // every block agrees, not only the one you clicked
    } catch (e) {
      console.error('[nextcloud-tasks]', e);
      new Notice(t('notice.saveFailed', { error: message(e) }));
      settle(false);
    }
  }

  promptNewTask(preselect) {
    if (!this.configured) {
      new Notice(t('notice.connectFirst'));
      return;
    }
    const available = enabledLists(this.settings);
    const chosen = available.find((l) => l.key === preselect) || available[0];

    new TaskModal(this.app, {
      mode: 'create',
      lists: available,
      listKey: chosen.key,
      onSubmit: async (values) => {
        const target = available.find((l) => l.key === values.listKey) || chosen;
        try {
          await this.client().createTask(target.url, {
            summary: values.summary,
            due: values.due,
            priority: values.priority,
          });
          new Notice(t('notice.created', { list: target.label || target.key }));
          await this.refresh(false);
        } catch (e) {
          console.error('[nextcloud-tasks]', e);
          new Notice(t('notice.createFailed', { error: message(e) }));
        }
      },
    }).open();
  }

  /**
   * Clicking a task opens the same dialog that creates one, prefilled. What
   * comes back is only what the user actually changed, which is then the only
   * thing written: everything else about the task keeps whichever client's
   * bytes it already had.
   */
  promptEditTask(entry) {
    const lists = this.settings.lists;
    const list = lists.find((l) => l.key === entry.listKey);

    new TaskModal(this.app, {
      mode: 'edit',
      lists: list ? [list] : lists,
      listKey: list ? list.key : (lists[0] && lists[0].key) || '',
      summary: entry.todo.summary || '',
      due: dateInputValue(entry.todo.due),
      priority: entry.todo.priority || 0,
      onSubmit: async (fields) => {
        if (!Object.keys(fields).length) return;        // nothing moved, nothing written
        try {
          await this.client().updateTask(entry.url, fields);
          new Notice(t('notice.updated'));
          await this.refresh(false);
        } catch (e) {
          console.error('[nextcloud-tasks]', e);
          new Notice(t('notice.saveFailed', { error: message(e) }));
        }
      },
      onDelete: () => this.confirmDelete(entry),
    }).open();
  }

  confirmDelete(entry) {
    new ConfirmModal(this.app, {
      title: t('modal.confirmDelete.title'),
      body: t('modal.confirmDelete.body', { title: entry.todo.summary || t('row.untitled') }),
      confirmText: t('btn.delete'),
      onConfirm: async () => {
        try {
          await this.client().deleteTask(entry.url);
          this.stickyDone.delete(entry.url);
          new Notice(t('notice.deleted'));
          await this.refresh(false);
        } catch (e) {
          console.error('[nextcloud-tasks]', e);
          new Notice(t('notice.deleteFailed', { error: message(e) }));
        }
      },
    }).open();
  }

  async runProbe() {
    const notice = new Notice(t('notice.probing'), 0);
    let steps;
    try {
      steps = await this.client().probe();
    } finally {
      notice.hide();
    }
    new ProbeModal(this.app, steps).open();
  }
}

/** Lets a code block deregister itself when its note closes. */
class BlockHandle extends MarkdownRenderChild {
  constructor(el, onGone) { super(el); this.onGone = onGone; }
  onunload() { this.onGone(); }
}
