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
import { NewTaskModal, ProbeModal } from './modals.js';

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const message = (e) => (e && e.message ? e.message : String(e));

export default class NextcloudTasksPlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.applyLocale();

    this.entries = [];          // in memory only, by design
    this.fetchedAt = null;
    this.error = null;
    this.loading = false;
    this.blocks = new Set();

    this.registerMarkdownCodeBlockProcessor('nextcloud-tasks', (source, el, ctx) => {
      const block = { el, cfg: parseBlock(source) };
      this.blocks.add(block);
      ctx.addChild(new BlockHandle(el, () => this.blocks.delete(block)));
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
  }

  onunload() {
    this.blocks.clear();
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

  isStale() {
    if (!this.fetchedAt) return true;
    return (Date.now() - this.fetchedAt.getTime()) / 1000 > this.settings.staleSeconds;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.client(true);
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
      rows: state === 'ready' ? selectTasks(this.entries, cfg, now, lists) : [],
      grouped: !cfg.list,
      stale: state === 'ready' && (this.error || this.isStale()),
      fetchedAt: this.fetchedAt ? hhmm(this.fetchedAt) : '',
      message: this.error || '',
    }, {
      onCreate: (listKey) => this.promptNewTask(listKey || null),
      onRefresh: () => this.refresh(true),
      onToggle: (entry, done, settle) => this.toggle(entry, done, settle),
    });
  }

  /* -------------------------------------------------------------- writing */

  async toggle(entry, done, settle) {
    try {
      await this.client().setDone(entry.url, done);
      entry.done = done;
      // Deliberately no immediate redraw: the row stays visible, greyed out,
      // until the next refresh. A task that vanishes the instant you tick it
      // gives you no chance to notice you ticked the wrong one.
      settle(true);
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

    new NewTaskModal(this.app, {
      lists: available,
      listKey: chosen.key,
      onSubmit: async (values) => {
        const target = available.find((l) => l.key === values.listKey) || chosen;
        try {
          await this.client().createTask(target.url, {
            summary: values.summary,
            due: values.due ? new Date(`${values.due}T00:00:00`) : null,
            priority: values.priority ? parseInt(values.priority, 10) : 0,
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
