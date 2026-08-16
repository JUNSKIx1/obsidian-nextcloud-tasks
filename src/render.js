/*
 * The view. Split deliberately in two:
 *
 *   pure    parseBlock · selectTasks · dueLabel · groupByList — no DOM, no
 *           Obsidian, so the sorting and the "overdue / today / tomorrow"
 *           wording are covered by a plain-node test rather than by squinting
 *           at a rendered page.
 *
 *   DOM     renderPanel — builds elements with Obsidian's createEl helpers.
 *           No inline styles; the one dynamic value is the per-list accent
 *           colour, which is user data and therefore cannot be a static class.
 *
 * Nothing here knows how many lists there are or what they are called. A list
 * is whatever the user ticked in the settings: `{ key, label, color, url }`.
 */

import { t, localeTag } from './i18n.js';

/**
 * Code block body. Every line optional:
 *
 *   all                   every configured list, grouped
 *   list: errands         one list, by its key
 *   os: errands           accepted alias, for vaults that used the old wording
 *   limit: 5              at most this many rows
 *   due: today | week     only what is due by then; overdue is always included
 *   done: true            show completed ones too
 *   title: …              panel heading
 *
 * `parseBlock` stays pure and does not validate the key against the settings:
 * an unknown key is reported by the caller, which is the only place that knows
 * what is configured.
 */
function parseBlock(source) {
  const body = String(source || '').trim();
  const cfg = { list: null, limit: 0, due: '', showDone: false, title: '' };

  const one = (re) => { const m = body.match(re); return m ? m[1].trim() : ''; };
  const key = (one(/^list:\s*(.+)$/mi) || one(/^os:\s*(.+)$/mi)).toLowerCase();
  if (key && key !== 'all') cfg.list = key;

  const limit = one(/^limit:\s*(\d+)$/mi);
  if (limit) cfg.limit = parseInt(limit, 10);

  // German synonyms stay accepted whatever the UI language is: a note must not
  // change meaning because someone switched Obsidian to English.
  const due = one(/^due:\s*(today|heute|week|woche)$/mi).toLowerCase();
  if (due) cfg.due = (due === 'heute' ? 'today' : due === 'woche' ? 'week' : due);

  if (/^done:\s*(true|ja|yes|1)$/mi.test(body)) cfg.showDone = true;
  cfg.title = one(/^title:\s*(.+)$/mi);
  return cfg;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DAY = 86400000;

/** Whole days from today to the due date; negative means overdue. */
function daysUntil(due, now) {
  if (!due || !due.date) return null;
  return Math.round((startOfDay(due.date) - startOfDay(now)) / DAY);
}

/**
 * Label for a due date. Returns a `state` too, because that is what the CSS
 * colours — the text itself must never be the thing a stylesheet matches on,
 * least of all once the text is translated.
 */
function dueLabel(due, now) {
  const days = daysUntil(due, now);
  if (days === null) return { text: '', state: '' };
  if (days < 0) {
    return { text: days === -1 ? t('due.yesterday') : t('due.overdue', { n: -days }), state: 'overdue' };
  }
  if (days === 0) return { text: t('due.today'), state: 'today' };
  if (days === 1) return { text: t('due.tomorrow'), state: 'today' };
  if (days <= 7) return { text: t('due.inDays', { n: days }), state: 'soon' };
  return { text: shortDate(due.date), state: '' };
}

/** Anything further out than a week is a plain date, in the reader's format. */
function shortDate(d) {
  try {
    return new Intl.DateTimeFormat(localeTag(), { day: '2-digit', month: 'short' }).format(d);
  } catch {
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
  }
}

/** Position of a list in the configured order; unknown lists sort last. */
function orderOf(lists, key) {
  const i = (lists || []).findIndex((l) => l.key === key);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * Filter + sort. Overdue first, then by due date, undated last; within a day
 * the higher priority wins (PRIORITY 1 is the most urgent in RFC 5545, and 0
 * means "unset", which is the trap here). Ties fall back to the order the user
 * put the lists in, then to the title.
 *
 * @param {Array} entries rows carrying `listKey`
 * @param {object} cfg    from parseBlock
 * @param {Date} now
 * @param {Array} lists   the configured lists, for ordering
 */
function selectTasks(entries, cfg, now, lists) {
  const when = now || new Date();
  const c = cfg || {};
  let rows = (entries || []).slice();

  if (!c.showDone) rows = rows.filter((e) => !e.done);
  if (c.list) rows = rows.filter((e) => e.listKey === c.list);

  if (c.due === 'today' || c.due === 'week') {
    const span = c.due === 'today' ? 0 : 7;
    rows = rows.filter((e) => {
      const d = daysUntil(e.todo.due, when);
      return d !== null && d <= span;
    });
  }

  const rank = (e) => {
    const d = daysUntil(e.todo.due, when);
    return d === null ? Number.MAX_SAFE_INTEGER : d;
  };
  const prio = (e) => {
    const p = e.todo.priority;
    return !p || p < 1 ? 10 : p;                 // unset sorts after every real priority
  };

  const tag = localeTag();
  rows.sort((a, b) => rank(a) - rank(b)
    || prio(a) - prio(b)
    || orderOf(lists, a.listKey) - orderOf(lists, b.listKey)
    || String(a.todo.summary).localeCompare(String(b.todo.summary), tag));

  if (c.limit > 0) rows = rows.slice(0, c.limit);
  return rows;
}

/**
 * One group per configured list, in the configured order, plus a trailing
 * bucket for anything whose list is no longer configured.
 */
function groupByList(rows, lists) {
  const groups = [];
  const known = new Set();
  for (const l of (lists || [])) {
    known.add(l.key);
    const mine = (rows || []).filter((e) => e.listKey === l.key);
    if (mine.length) groups.push({ key: l.key, label: l.label || l.key, color: l.color || '', rows: mine });
  }
  const rest = (rows || []).filter((e) => !known.has(e.listKey));
  if (rest.length) groups.push({ key: '', label: t('group.other'), color: '', rows: rest });
  return groups;
}

/* -------------------------------------------------------------------- DOM */

/**
 * @param {HTMLElement} el   the code block's container
 * @param {object} view      { state, rows, grouped, lists, fetchedAt, message, cfg, now, stale }
 * @param {object} handlers  { onToggle(entry, done, settle), onCreate(listKey), onRefresh() }
 */
function renderPanel(el, view, handlers) {
  el.empty();
  const h = handlers || {};
  const wrap = el.createDiv({ cls: 'nct-panel' });

  const head = wrap.createDiv({ cls: 'nct-head' });
  head.createSpan({ cls: 'nct-title', text: view.cfg && view.cfg.title ? view.cfg.title : t('panel.title') });
  const tools = head.createDiv({ cls: 'nct-tools' });

  if (h.onCreate) {
    const add = tools.createEl('button', { cls: 'nct-btn', text: t('panel.add') });
    add.addEventListener('click', () => h.onCreate(view.cfg ? view.cfg.list : null));
  }
  if (h.onRefresh) {
    const ref = tools.createEl('button', { cls: 'nct-btn is-quiet', text: '↻' });
    ref.setAttribute('aria-label', t('panel.refresh'));
    ref.addEventListener('click', () => h.onRefresh());
  }

  if (view.state === 'unconfigured') {
    wrap.createDiv({ cls: 'nct-note', text: t('panel.unconfigured') });
    return wrap;
  }

  if (view.state === 'loading') {
    wrap.createDiv({ cls: 'nct-empty', text: t('panel.loading') });
    return wrap;
  }

  if (view.state === 'error') {
    const p = wrap.createDiv({ cls: 'nct-note' });
    p.createEl('b', { text: t('panel.error') });
    p.appendText(view.message || '');
    return wrap;
  }

  if (view.unknownList) {
    wrap.createDiv({ cls: 'nct-note', text: t('panel.unknownList', { key: view.cfg.list }) });
    return wrap;
  }

  const groups = view.grouped
    ? groupByList(view.rows, view.lists)
    : [{ key: view.cfg && view.cfg.list, label: '', color: accentOf(view.lists, view.cfg), rows: view.rows }];

  if (!view.rows.length) {
    wrap.createDiv({ cls: 'nct-empty', text: t('panel.empty') });
  }

  for (const g of groups) {
    const section = wrap.createDiv({ cls: 'nct-group' });
    if (g.color && section.setCssProps) section.setCssProps({ '--nct-accent': g.color });
    if (view.grouped && g.label) section.createDiv({ cls: 'nct-group-label', text: g.label });
    const list = section.createDiv({ cls: 'nct-list' });
    for (const entry of g.rows) renderRow(list, entry, view, h);
  }

  if (view.stale) {
    wrap.createDiv({
      cls: 'nct-foot',
      text: t('panel.stale', { time: view.fetchedAt || '?' }),
    });
  }
  return wrap;
}

/** The accent of a single-list block, so one list keeps its colour ungrouped. */
function accentOf(lists, cfg) {
  if (!cfg || !cfg.list) return '';
  const hit = (lists || []).find((l) => l.key === cfg.list);
  return hit ? hit.color || '' : '';
}

function renderRow(list, entry, view, h) {
  const row = list.createDiv({ cls: `nct-row${entry.done ? ' is-done' : ''}` });

  const box = row.createEl('input', { cls: 'nct-check', type: 'checkbox' });
  box.checked = !!entry.done;
  box.setAttribute('aria-label', entry.todo.summary || t('row.task'));
  if (h.onToggle) {
    box.addEventListener('change', () => {
      // Optimistic: the row reacts now, and reverts in place if the PUT fails.
      row.toggleClass('is-done', box.checked);
      row.addClass('is-pending');
      h.onToggle(entry, box.checked, (okResult) => {
        row.removeClass('is-pending');
        if (!okResult) {
          box.checked = !box.checked;
          row.toggleClass('is-done', box.checked);
        }
      });
    });
  } else {
    box.disabled = true;
  }

  const what = row.createDiv({ cls: 'nct-what' });
  what.createSpan({ cls: 'nct-summary', text: entry.todo.summary || t('row.untitled') });
  if (entry.todo.priority >= 1 && entry.todo.priority <= 4) {
    what.createSpan({ cls: 'nct-flag', text: '!' });
  }

  const label = dueLabel(entry.todo.due, view.now || new Date());
  if (label.text) {
    row.createSpan({ cls: `nct-due${label.state ? ` is-${label.state}` : ''}`, text: label.text });
  }
}

export {
  parseBlock,
  daysUntil,
  dueLabel,
  shortDate,
  selectTasks,
  groupByList,
  orderOf,
  accentOf,
  renderPanel,
};
