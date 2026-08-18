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
 *   limit: 5              at most this many rows in total, across every list
 *   preview: 3            rows shown per list before the "+n more" toggle; 0 = all
 *   due: today | week     only what is due by then; overdue is always included
 *   done: true            show completed ones too
 *   title: …              panel heading
 *
 * `limit` and `preview` are different caps and both apply: `limit` is a hard
 * ceiling on what is fetched into the panel at all, applied before grouping, so
 * one busy list can starve the others — `preview` only folds rows away per list
 * and every one of them stays reachable.
 *
 * `parseBlock` stays pure and does not validate the key against the settings:
 * an unknown key is reported by the caller, which is the only place that knows
 * what is configured.
 */
function parseBlock(source) {
  const body = String(source || '').trim();
  const cfg = { list: null, limit: 0, preview: 2, due: '', showDone: false, title: '' };

  const one = (re) => { const m = body.match(re); return m ? m[1].trim() : ''; };
  const key = (one(/^list:\s*(.+)$/mi) || one(/^os:\s*(.+)$/mi)).toLowerCase();
  if (key && key !== 'all') cfg.list = key;

  const limit = one(/^limit:\s*(\d+)$/mi);
  if (limit) cfg.limit = parseInt(limit, 10);

  // '0' is a real answer here — "never fold anything away" — and a non-empty
  // string, so it survives this test where a missing line does not.
  const preview = one(/^preview:\s*(\d+)$/mi);
  if (preview) cfg.preview = parseInt(preview, 10);

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

/**
 * RFC 5545 counts 1 as the most urgent and 9 as the least, with 0 meaning
 * "unset" — and the three bands below are what every other client (Nextcloud
 * Tasks, Reminders) shows as high/medium/low. Getting this boundary wrong is
 * exactly how the last attempt failed: only 1–4 was marked, so a task set to
 * "medium" or "low" was written correctly and then displayed as nothing.
 */
function priorityLevel(p) {
  const n = parseInt(p, 10);
  if (!n || n < 1 || n > 9) return '';
  if (n <= 4) return 'high';
  return n === 5 ? 'medium' : 'low';
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
 * `keepDone` holds the URLs of tasks ticked in this session. They stay on
 * screen, struck through, even though they are done: a task that vanishes the
 * instant you tick it gives you no chance to notice you ticked the wrong one.
 *
 * @param {Array} entries  rows carrying `listKey`
 * @param {object} cfg     from parseBlock
 * @param {Date} now
 * @param {Array} lists    the configured lists, for ordering
 * @param {Set} [keepDone] task URLs to show despite being done
 */
function selectTasks(entries, cfg, now, lists, keepDone) {
  const when = now || new Date();
  const c = cfg || {};
  let rows = (entries || []).slice();

  if (!c.showDone) rows = rows.filter((e) => !e.done || (keepDone && keepDone.has(e.url)));
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
 * One group per ticked list, in the configured order, plus a trailing bucket
 * for anything whose list is no longer configured.
 *
 * A list with nothing in it still gets its group: a heading saying "nothing
 * open" is information, whereas a list that silently disappears looks exactly
 * like a list that failed to load.
 */
function groupByList(rows, lists) {
  const groups = [];
  const known = new Set();
  for (const l of (lists || [])) {
    known.add(l.key);
    if (l.enabled === false) continue;          // never fetched, so never a group
    groups.push({
      key: l.key,
      label: l.label || l.key,
      color: l.color || '',
      rows: (rows || []).filter((e) => e.listKey === l.key),
    });
  }
  const rest = (rows || []).filter((e) => !known.has(e.listKey));
  if (rest.length) groups.push({ key: '', label: t('group.other'), color: '', rows: rest });
  return groups;
}

/**
 * How much of a group to show. `n` is the preview size, `0` meaning "all of it";
 * `open` is whether the reader unfolded this one.
 *
 * `folded` is deliberately not `rows.length > shown.length`: an open group has
 * nothing hidden and still needs its toggle, or there would be no way back.
 */
function foldRows(rows, n, open) {
  const all = rows || [];
  const folded = n > 0 && all.length > n;
  return { folded, hidden: folded ? all.length - n : 0, shown: folded && !open ? all.slice(0, n) : all };
}

/* -------------------------------------------------------------------- DOM */

/**
 * A heading that folds what it names: chevron, text, and the number of rows
 * currently hidden. Nothing to fold means an ordinary heading rather than a
 * control that does nothing when pressed.
 *
 * Used twice: for a group label, and — in a single-list block, which has no
 * group label — for the panel title, because there the title *is* the heading
 * of the one group.
 */
function foldHeader(parent, cls, text, fold, open, h, key) {
  const live = fold.folded && !!h.onExpand;
  if (!live) return parent.createDiv({ cls, text });

  const el = parent.createEl('button', { cls: `${cls} is-toggle` });
  const chevron = el.createSpan({ cls: 'nct-chevron' });
  if (h.icon) h.icon(chevron, open ? 'chevron-down' : 'chevron-right');
  el.createSpan({ cls: 'nct-label-text', text });
  if (!open) el.createSpan({ cls: 'nct-count', text: String(fold.hidden) });

  // The words left the button, so this is now the only place that says what it
  // does — to a screen reader and to the tooltip alike.
  el.setAttribute('aria-expanded', open ? 'true' : 'false');
  el.setAttribute('aria-label', open ? t('group.less') : t('group.more', { n: fold.hidden }));
  el.addEventListener('click', () => h.onExpand(key));
  return el;
}

/** An action reduced to its icon; the label survives as tooltip and for a11y. */
function iconButton(parent, cls, icon, label, h, onClick) {
  const b = parent.createEl('button', { cls: `${cls} is-icon` });
  if (h.icon) h.icon(b, icon);
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @param {HTMLElement} el   the code block's container
 * @param {object} view      { state, rows, grouped, lists, fetchedAt, message, cfg, now, stale,
 *                             expanded }
 * @param {object} handlers  { onToggle(entry, done, settle), onCreate(listKey), onNewList(),
 *                             onRefresh(), onEdit(entry), onExpand(listKey), icon(el, name) }
 *
 * `icon` is handed in rather than imported: this file must stay loadable by
 * plain node, which is what lets the sorting and folding be tested without a
 * browser. Everything it does is optional, so a caller without it still works.
 */
function renderPanel(el, view, handlers) {
  el.empty();
  const h = handlers || {};
  const wrap = el.createDiv({ cls: 'nct-panel' });

  const cfg = view.cfg || {};
  const isOpen = (key) => !!(view.expanded && view.expanded.has(key));
  const foldOf = (rows, key) => foldRows(rows, cfg.preview, isOpen(key));

  const head = wrap.createDiv({ cls: 'nct-head' });
  // A single-list block has no group label, so its title carries the fold.
  const titleFold = view.grouped ? { folded: false, hidden: 0 } : foldOf(view.rows, cfg.list);
  foldHeader(head, 'nct-title', cfg.title || t('panel.title'), titleFold, isOpen(cfg.list), h, cfg.list);
  const tools = head.createDiv({ cls: 'nct-tools' });

  if (h.onCreate) {
    iconButton(tools, 'nct-btn', 'plus', t('panel.add'), h, () => h.onCreate(cfg.list || null));
  }
  // Only where every list is on show: offering "add a list" in a block that
  // deliberately shows one list is the wrong offer in the wrong place.
  if (h.onNewList && view.grouped) {
    iconButton(tools, 'nct-btn is-quiet', 'list-plus', t('panel.newList'), h, () => h.onNewList());
  }
  if (h.onRefresh) {
    iconButton(tools, 'nct-btn is-quiet', 'refresh-cw', t('panel.refresh'), h, () => h.onRefresh());
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
    : [{ key: cfg.list, label: '', color: accentOf(view.lists, cfg), rows: view.rows }];

  // Every group now carries its own "nothing open" line, so the panel-wide one
  // is only for the case where there is no group at all to say it in.
  if (!groups.length) {
    wrap.createDiv({ cls: 'nct-empty', text: t('panel.empty') });
  }

  for (const g of groups) {
    const section = wrap.createDiv({ cls: 'nct-group' });
    if (g.color && section.setCssProps) section.setCssProps({ '--nct-accent': g.color });

    const fold = foldOf(g.rows, g.key);
    if (view.grouped && g.label) {
      foldHeader(section, 'nct-group-label', g.label, fold, isOpen(g.key), h, g.key);
    }

    const list = section.createDiv({ cls: 'nct-list' });

    // The blank row opens every real list: it sits under the heading, where the
    // cursor already is, and it does not move when the list grows or folds. The
    // orphan bucket has no list to write to, so it does not get one — and
    // without a quick-add handler an empty list says so in words instead.
    if (h.onQuickAdd && g.key) renderQuickAdd(list, g.key, view, h);
    else if (!g.rows.length) list.createDiv({ cls: 'nct-none', text: t('group.empty') });

    for (const entry of fold.shown) renderRow(list, entry, view, h);
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

/** The draft belonging to one list, created on first use. */
function draftOf(view, key) {
  const drafts = view.drafts;
  if (!drafts) return { text: '', due: '', priority: 0 };
  let d = drafts.get(key);
  if (!d) {
    d = { text: '', due: '', priority: 0 };
    drafts.set(key, d);
  }
  return d;
}

/**
 * The blank row: type a title, press Enter, the task exists. Due date and
 * priority are set from the two small buttons on the right *before* submitting,
 * so the common case — a title and nothing else — stays one line of typing.
 *
 * Neither button redraws the panel. They change the draft and restyle
 * themselves, because a redraw would take the focus out of the input the user
 * is typing in. The draft itself lives on the block (`view.drafts`), so the
 * refresh timer firing mid-sentence cannot swallow what was typed.
 */
function renderQuickAdd(list, key, view, h) {
  const d = draftOf(view, key);
  const row = list.createDiv({ cls: 'nct-new' });

  const input = row.createEl('input', { cls: 'nct-new-input', type: 'text' });
  input.value = d.text || '';
  input.placeholder = t('row.new');
  input.setAttribute('aria-label', t('row.newAdd'));
  input.setAttribute('data-list', key);

  const tools = row.createDiv({ cls: 'nct-new-tools' });

  /* --- due: a real date input, kept out of sight until it is asked for --- */
  const picker = tools.createEl('input', { cls: 'nct-date', type: 'date' });
  picker.value = d.due || '';
  picker.setAttribute('tabindex', '-1');
  picker.setAttribute('aria-hidden', 'true');

  const dueBtn = tools.createEl('button', { cls: 'nct-mini' });
  const paintDue = () => {
    dueBtn.empty();
    if (h.icon) h.icon(dueBtn, 'calendar');
    if (d.due) dueBtn.createSpan({ cls: 'nct-mini-text', text: shortIsoDate(d.due) });
    dueBtn.toggleClass('is-set', !!d.due);
    dueBtn.setAttribute('aria-label', t('row.newDue'));
  };
  paintDue();
  dueBtn.addEventListener('click', () => {
    // showPicker is the supported way; older builds only respond to a click.
    try {
      if (typeof picker.showPicker === 'function') picker.showPicker();
      else picker.click();
    } catch {
      picker.click();
    }
  });
  picker.addEventListener('change', () => { d.due = picker.value; paintDue(); });

  /* --- priority: the menu is Obsidian's, so it arrives as a handler ------ */
  const prioBtn = tools.createEl('button', { cls: 'nct-mini nct-flag-btn' });
  const paintPrio = () => {
    for (const lvl of ['high', 'medium', 'low']) prioBtn.removeClass(`is-${lvl}`);
    const level = priorityLevel(d.priority);
    if (level) prioBtn.addClass(`is-${level}`);
    prioBtn.setAttribute('aria-label', t('row.newPriority'));
    if (h.icon) h.icon(prioBtn, 'flag');
  };
  paintPrio();
  if (h.onPriorityMenu) {
    prioBtn.addEventListener('click', (evt) => {
      h.onPriorityMenu(evt, d.priority || 0, (value) => { d.priority = value; paintPrio(); });
    });
  } else {
    prioBtn.disabled = true;
  }

  /* --- send: the same thing Enter does, for anyone who would rather click -- */
  const send = tools.createEl('button', { cls: 'nct-mini nct-send' });
  if (h.icon) h.icon(send, 'send');
  send.setAttribute('aria-label', t('row.newAdd'));

  const submit = () => {
    if (!input.value.trim()) return;
    d.text = input.value;
    h.onQuickAdd(key, d);
  };
  send.addEventListener('click', submit);

  // Nothing to send is a disabled button, not a lit one that does nothing.
  const armSend = () => { send.disabled = !input.value.trim(); };
  armSend();
  input.addEventListener('input', () => { d.text = input.value; armSend(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      d.text = '';
      d.due = '';
      d.priority = 0;
      input.value = '';
      picker.value = '';
      paintDue();
      paintPrio();
      armSend();
    }
  });
  return row;
}

/** `2026-08-20` → the same short form the due labels use. */
function shortIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? shortDate(new Date(+m[1], +m[2] - 1, +m[3])) : '';
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
  const title = entry.todo.summary || t('row.untitled');
  if (h.onEdit) {
    // A real button, not a span with a click handler: it has to be reachable by
    // keyboard and to announce itself as a control. The CSS takes the chrome
    // back off so the row still reads as a line of text.
    const open = what.createEl('button', { cls: 'nct-summary is-editable', text: title });
    open.setAttribute('aria-label', t('row.edit', { title }));
    open.addEventListener('click', () => h.onEdit(entry));
  } else {
    what.createSpan({ cls: 'nct-summary', text: title });
  }

  const level = priorityLevel(entry.todo.priority);
  if (level) {
    const flag = row.createSpan({ cls: `nct-flag is-${level}` });
    if (h.icon) h.icon(flag, 'flag');
    flag.setAttribute('aria-label', t(`prio.${level}`));
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
  priorityLevel,
  foldRows,
  orderOf,
  accentOf,
  renderPanel,
};
