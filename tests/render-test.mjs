#!/usr/bin/env node
/*
 * render · model · i18n.
 *
 *   node tests/render-test.mjs
 *
 * This is where the "any vault, any lists" claim is actually checked: an
 * arbitrary number of lists, keys the user chose, the order the user put them
 * in, and the migration off the fixed three-way split the plugin started with.
 */

import {
  parseBlock, dueLabel, daysUntil, selectTasks, groupByList, foldRows, priorityLevel, orderOf,
  accentOf, renderPanel,
} from '../src/render.js';
import {
  normalizeSettings, mergeDiscovered, enabledLists, slugify, titleCase, lastSegment,
} from '../src/model.js';
import { EN, DE, t, setLocale, getLocale, resolveLocale } from '../src/i18n.js';

/* ------------------------------------------------------------- harness */

let passed = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { passed += 1; return; }
  failures.push(extra ? `${label}\n      ${extra}` : label);
}
const eq = (a, b, label) => ok(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const deep = (a, b, label) => eq(JSON.stringify(a), JSON.stringify(b), label);

setLocale('en');

/* ================================================================= i18n */

{
  const enKeys = Object.keys(EN).sort();
  const deKeys = Object.keys(DE).sort();
  deep(deKeys, enKeys, 'i18n: both tables carry exactly the same keys');
  ok(enKeys.length > 60, 'i18n: the table is actually populated');

  const untranslated = enKeys.filter((k) => EN[k] === DE[k] && !/^btn\./.test(k));
  ok(untranslated.length < 6, `i18n: German is translated, not copied (${untranslated.join(', ')})`);

  eq(t('due.overdue', { n: 3 }), '3 days overdue', 'i18n: placeholders are substituted');
  eq(t('due.overdue'), '{n} days overdue', 'i18n: no params leaves the placeholder visible');
  eq(t('nope.not.a.key'), 'nope.not.a.key', 'i18n: an unknown key is loud, not empty');

  eq(resolveLocale('de'), 'de', 'i18n: an explicit preference wins');
  eq(resolveLocale('auto', 'de'), 'de', 'i18n: auto follows the app language');
  eq(resolveLocale('auto', 'de-DE'), 'de', 'i18n: a region tag still resolves');
  eq(resolveLocale('auto', 'pt-BR'), 'en', 'i18n: an untranslated app language lands on English');
  eq(resolveLocale('auto', ''), 'en', 'i18n: no app language lands on English');
  eq(resolveLocale('klingon', ''), 'en', 'i18n: nonsense lands on English');

  setLocale('de');
  eq(getLocale(), 'de', 'i18n: setLocale sticks');
  eq(t('due.today'), 'heute', 'i18n: German table in use');
  setLocale('en');
  eq(t('due.today'), 'today', 'i18n: back to English');
}

/* ================================================================ model */

{
  const s = normalizeSettings(undefined);
  deep(s.lists, [], 'model: no data yields no lists, not a crash');
  eq(s.baseUrl, '', 'model: no server is baked in');
  eq(s.language, 'auto', 'model: language defaults to auto');
  eq(s.staleSeconds, 60, 'model: stale window defaults to 60s');
}

{
  // The one migration that matters: the fixed three-way split this plugin
  // started with becomes three ordinary entries.
  const legacy = normalizeSettings({
    baseUrl: 'https://cloud.example.com',
    username: 'alice',
    password: 'pw',
    lists: {
      personal: 'https://cloud.example.com/remote.php/dav/calendars/alice/personal/',
      studium: 'https://cloud.example.com/remote.php/dav/calendars/alice/studium/',
      work: '',
    },
  });
  eq(legacy.lists.length, 2, 'model: an unassigned legacy slot does not become a list');
  deep(legacy.lists.map((l) => l.key), ['personal', 'studium'],
    'model: the legacy keys survive, so `os: studium` in a note keeps resolving');
  deep(legacy.lists.map((l) => l.label), ['Personal', 'Studium'], 'model: a readable label is derived');
  ok(legacy.lists.every((l) => l.enabled), 'model: a list that was configured stays switched on');
  ok(legacy.lists.every((l) => /^#[0-9a-f]{6}$/i.test(l.color)), 'model: every list gets a colour');
  eq(legacy.username, 'alice', 'model: the credentials come through untouched');
}

{
  const kept = normalizeSettings({
    lists: [
      { url: 'https://x/a/', key: 'alpha', label: '🌿 Alpha', color: '#111111', enabled: true },
      { url: 'https://x/b/', key: 'beta', label: 'Beta', color: '#222222', enabled: false },
    ],
  });
  deep(kept.lists.map((l) => l.key), ['alpha', 'beta'], 'model: keys survive a reload');
  eq(kept.lists[0].label, '🌿 Alpha', 'model: an emoji label survives a reload');
  eq(kept.lists[1].enabled, false, 'model: an unticked list stays unticked');
  eq(enabledLists(kept).length, 1, 'model: only ticked lists are fetched');
}

{
  const clashing = normalizeSettings({
    lists: [
      { url: 'https://x/a/', key: 'same', label: 'A' },
      { url: 'https://x/b/', key: 'same', label: 'B' },
    ],
  });
  eq(clashing.lists[0].key, 'same', 'model: the first claim on a key keeps it');
  ok(clashing.lists[1].key !== 'same', 'model: a duplicate key is renamed, never shared');
}

{
  const odd = normalizeSettings({ language: 'klingon', staleSeconds: -5, lists: [{ label: 'no url' }] });
  eq(odd.language, 'auto', 'model: an unknown language falls back to auto');
  eq(odd.staleSeconds, 60, 'model: a nonsense stale window falls back to 60s');
  eq(odd.lists.length, 0, 'model: an entry without a URL is not a list');
}

{
  eq(normalizeSettings({}).refreshMinutes, 5, 'model: the refresh interval defaults to five minutes');
  eq(normalizeSettings({ refreshMinutes: 0 }).refreshMinutes, 0,
    'model: zero is a real choice, not a missing value — it means never');
  eq(normalizeSettings({ refreshMinutes: 15 }).refreshMinutes, 15, 'model: a chosen interval survives');
  eq(normalizeSettings({ refreshMinutes: -3 }).refreshMinutes, 5, 'model: a negative interval falls back');
  eq(normalizeSettings({ refreshMinutes: 99999 }).refreshMinutes, 5, 'model: an absurd interval falls back');
  eq(normalizeSettings({ refreshMinutes: 'soon' }).refreshMinutes, 5, 'model: a non-number falls back');
}

{
  eq(slugify('Persönliches & Mehr'), 'persoenliches-mehr', 'model: slugs survive umlauts');
  eq(slugify('🌿 Personal'), 'personal', 'model: an emoji does not end up in a key');
  eq(titleCase('shopping-list'), 'Shopping list', 'model: a readable label out of a slug');
  eq(lastSegment('https://x/dav/calendars/alice/my%20list/'), 'my list', 'model: URL segments are decoded');
}

{
  const discovered = [
    { url: 'https://x/a/', displayName: 'Alpha', color: '#101010' },
    { url: 'https://x/b/', displayName: 'Beta', color: '' },
  ];
  const first = mergeDiscovered([], discovered, true);
  eq(first.length, 2, 'merge: a first run adopts everything the server has');
  ok(first.every((l) => l.enabled), 'merge: a first run ticks them, so a new install shows tasks at once');
  deep(first.map((l) => l.key), ['alpha', 'beta'], 'merge: keys are slugged from the display names');
  eq(first[0].color, '#101010', 'merge: the server colour is adopted');
  ok(/^#/.test(first[1].color), 'merge: a list without a server colour still gets one');

  const later = mergeDiscovered(first, [...discovered, { url: 'https://x/c/', displayName: 'Gamma' }], false);
  eq(later.length, 3, 'merge: a new list on the server shows up');
  eq(later[2].enabled, false, 'merge: but it is not switched on behind the user’s back');

  const renamed = later.map((l) => (l.key === 'alpha' ? { ...l, label: '🌿 Mine', key: 'mine', color: '#abcdef' } : l));
  const again = mergeDiscovered(renamed, discovered, false);
  eq(again[0].label, '🌿 Mine', 'merge: a hand-written label is never overwritten by the server');
  eq(again[0].key, 'mine', 'merge: a hand-picked key is never overwritten');
  eq(again[0].color, '#abcdef', 'merge: a hand-picked colour is never overwritten');
  eq(again[2].missing, true, 'merge: a list the server no longer returns is flagged, not dropped');
  eq(again[0].missing, false, 'merge: a list that is still there is not flagged');

  const noSlash = mergeDiscovered(
    [{ url: 'https://x/a', key: 'a', label: 'A', enabled: true }],
    [{ url: 'https://x/a/', displayName: 'A' }], false,
  );
  eq(noSlash.length, 1, 'merge: a trailing slash does not duplicate a list');
}

/* =============================================================== render */

{
  const c = parseBlock('list: errands\nlimit: 5\ndue: today');
  eq(c.list, 'errands', 'render: list read');
  eq(c.limit, 5, 'render: limit read');
  eq(c.due, 'today', 'render: due read');
  eq(c.showDone, false, 'render: completed hidden by default');

  eq(parseBlock('os: errands').list, 'errands', 'render: `os:` still works, for notes written before');
  eq(parseBlock('all').list, null, 'render: "all" groups every list');
  eq(parseBlock('').list, null, 'render: an empty block is "all"');
  eq(parseBlock('list: ERRANDS').list, 'errands', 'render: keys are case-insensitive');
  eq(parseBlock('list: nonsense').list, 'nonsense',
    'render: parseBlock does not validate the key — only the caller knows what is configured');
  eq(parseBlock('due: woche').due, 'week', 'render: German "woche" understood whatever the UI language is');
  eq(parseBlock('due: heute').due, 'today', 'render: German "heute" understood');
  eq(parseBlock('done: ja').showDone, true, 'render: German "ja" understood');
  eq(parseBlock('done: yes').showDone, true, 'render: English "yes" understood');
  eq(parseBlock('title: Shopping').title, 'Shopping', 'render: custom title');

  eq(parseBlock('all').preview, 2, 'render: two rows per list unless the block says otherwise');
  eq(parseBlock('preview: 5').preview, 5, 'render: preview read');
  eq(parseBlock('preview: 0').preview, 0, 'render: "preview: 0" means fold nothing away');
  eq(parseBlock('limit: 5').preview, 2, 'render: limit and preview are separate caps');
}

{
  const now = new Date(2026, 7, 14);                        // Fri 14 Aug 2026
  const at = (y, m, d) => ({ date: new Date(y, m, d), allDay: true });
  eq(daysUntil(at(2026, 7, 18), now), 4, 'render: whole days counted');
  eq(dueLabel(at(2026, 7, 14), now).text, 'today', 'render: today');
  eq(dueLabel(at(2026, 7, 15), now).text, 'tomorrow', 'render: tomorrow');
  eq(dueLabel(at(2026, 7, 13), now).text, 'yesterday', 'render: yesterday');
  eq(dueLabel(at(2026, 7, 10), now).state, 'overdue', 'render: overdue flagged');
  eq(dueLabel(at(2026, 7, 10), now).text, '4 days overdue', 'render: overdue counted');
  eq(dueLabel(at(2026, 7, 18), now).text, 'in 4 days', 'render: in four days');
  eq(dueLabel(null, now).text, '', 'render: no due date, no label');
  ok(/30/.test(dueLabel(at(2026, 8, 30), now).text), 'render: a far date is shown as a date');

  // The label is prose and gets translated; the CSS must key off state.
  eq(dueLabel(at(2026, 7, 14), now).state, 'today', 'render: state, not text, is what CSS matches');
  setLocale('de');
  eq(dueLabel(at(2026, 7, 14), now).text, 'heute', 'render: the label follows the language');
  eq(dueLabel(at(2026, 7, 14), now).state, 'today', 'render: the state does not');
  setLocale('en');
}

const LISTS = [
  { url: 'https://x/w/', key: 'work', label: '💼 Work', color: '#4a7699', enabled: true },
  { url: 'https://x/s/', key: 'school', label: '🎓 School', color: '#c07a34', enabled: true },
  { url: 'https://x/p/', key: 'private', label: '🌿 Private', color: '#6f9553', enabled: true },
];

const task = (listKey, summary, due, priority, done) => ({
  listKey,
  done: !!done,
  url: `x/${summary}`,
  todo: { summary, priority: priority || 0, due: due ? { date: due, allDay: true } : null },
});

{
  const now = new Date(2026, 7, 14);
  const entries = [
    task('work', 'No date', null),
    task('school', 'Day after tomorrow', new Date(2026, 7, 16)),
    task('private', 'Overdue', new Date(2026, 7, 10)),
    task('school', 'Today, urgent', new Date(2026, 7, 14), 1),
    task('school', 'Today, whatever', new Date(2026, 7, 14)),
    task('work', 'Done', new Date(2026, 7, 13), 0, true),
    task('private', 'Next month', new Date(2026, 8, 20)),
  ];

  const all = selectTasks(entries, parseBlock('all'), now, LISTS);
  deep(all.map((e) => e.todo.summary),
    ['Overdue', 'Today, urgent', 'Today, whatever', 'Day after tomorrow', 'Next month', 'No date'],
    'render: overdue first, undated last, priority breaks the tie');
  ok(!all.some((e) => e.done), 'render: completed are filtered out');

  eq(selectTasks(entries, parseBlock('done: true'), now, LISTS).length, 7,
    'render: "done: true" shows completed too');

  deep(selectTasks(entries, parseBlock('list: school'), now, LISTS).map((e) => e.todo.summary),
    ['Today, urgent', 'Today, whatever', 'Day after tomorrow'], 'render: one list only');
  deep(selectTasks(entries, parseBlock('os: school'), now, LISTS).map((e) => e.todo.summary),
    ['Today, urgent', 'Today, whatever', 'Day after tomorrow'],
    'render: the `os:` alias selects exactly the same rows');
  eq(selectTasks(entries, parseBlock('list: ghost'), now, LISTS).length, 0,
    'render: an unconfigured key selects nothing rather than everything');

  deep(selectTasks(entries, parseBlock('due: today'), now, LISTS).map((e) => e.todo.summary),
    ['Overdue', 'Today, urgent', 'Today, whatever'],
    'render: "due: today" includes overdue, or it would vanish silently');
  deep(selectTasks(entries, parseBlock('due: week'), now, LISTS).map((e) => e.todo.summary),
    ['Overdue', 'Today, urgent', 'Today, whatever', 'Day after tomorrow'], 'render: "due: week"');
  eq(selectTasks(entries, parseBlock('limit: 2'), now, LISTS).length, 2, 'render: limit applies');

  // The boundary the first attempt got wrong: only 1–4 was marked, so a task
  // set to "medium" or "low" was written and then shown as nothing at all.
  eq(priorityLevel(0), '', 'render: 0 is unset, not urgent');
  eq(priorityLevel(undefined), '', 'render: no priority at all is unset');
  eq(priorityLevel(1), 'high', 'render: 1 is the most urgent in RFC 5545');
  eq(priorityLevel(4), 'high', 'render: 4 still counts as high');
  eq(priorityLevel(5), 'medium', 'render: 5 is medium — and must show something');
  eq(priorityLevel(6), 'low', 'render: 6 is already low');
  eq(priorityLevel(9), 'low', 'render: 9 is the least urgent');
  eq(priorityLevel(42), '', 'render: outside 1–9 means unset, not a fourth level');

  // PRIORITY 0 means "unset" in RFC 5545 and must not outrank a real 1.
  const prio = selectTasks([
    task('work', 'No priority', new Date(2026, 7, 20), 0),
    task('work', 'Low', new Date(2026, 7, 20), 9),
    task('work', 'High', new Date(2026, 7, 20), 1),
  ], parseBlock('all'), now, LISTS);
  deep(prio.map((e) => e.todo.summary), ['High', 'Low', 'No priority'],
    'render: PRIORITY 0 means "unset", not "most urgent"');

  // Same day, same priority: the order the user dragged the lists into decides.
  const tie = selectTasks([
    task('private', 'A', new Date(2026, 7, 20)),
    task('work', 'A', new Date(2026, 7, 20)),
    task('school', 'A', new Date(2026, 7, 20)),
  ], parseBlock('all'), now, LISTS);
  deep(tie.map((e) => e.listKey), ['work', 'school', 'private'],
    'render: ties fall back to the configured list order, not to a hardcoded one');
}

{
  const rows = [task('school', 'S1'), task('work', 'W1'), task('school', 'S2'), task('ghost', 'G1')];

  const groups = groupByList(rows, LISTS);
  deep(groups.map((g) => g.key), ['work', 'school', 'private', ''],
    'render: groups follow the configured order, orphans last in a keyless bucket');
  eq(groups[0].label, '💼 Work', 'render: the group heading is the label the user typed');
  eq(groups[0].color, '#4a7699', 'render: the group carries its accent colour');
  eq(groups[1].rows.length, 2, 'render: rows land in their own group');
  eq(groups[3].label, t('group.other'), 'render: a task from a list nobody configured still shows up');

  // A list with nothing in it keeps its heading: vanishing is indistinguishable
  // from failing to load, and it was what the old global `limit` did to a list
  // whose rows another list had already eaten.
  eq(groups[2].rows.length, 0, 'render: a list with no rows is still a group');
  eq(groupByList([], LISTS).length, 3, 'render: no rows at all, still every configured list');
  eq(groupByList(rows, []).length, 1, 'render: no configured lists, everything in one bucket');
  eq(groupByList([], []).length, 0, 'render: nothing configured and nothing to show, no groups');

  const off = LISTS.map((l) => (l.key === 'school' ? Object.assign({}, l, { enabled: false }) : l));
  deep(groupByList(rows, off).map((g) => g.key), ['work', 'private', ''],
    'render: an unticked list is never fetched, so it is never a group either');

  // The case this feature exists for: one busy list must not starve the others.
  const busy = groupByList(
    Array.from({ length: 7 }, (_, i) => task('private', `P${i}`)).concat(task('school', 'S9')),
    LISTS,
  );
  deep(busy.map((g) => g.rows.length), [0, 1, 7], 'render: every list reports its own count');

  const seven = Array.from({ length: 7 }, (_, i) => ({
    url: `https://x/${i}/`, key: `k${i}`, label: `L${i}`, color: '', enabled: true,
  }));
  const many = groupByList(seven.map((l) => task(l.key, `t${l.key}`)), seven);
  eq(many.length, 7, 'render: seven lists is not a special case');
  deep(many.map((g) => g.key), seven.map((l) => l.key), 'render: seven groups, in order');

  const one = groupByList([task('solo', 'x')], [{ key: 'solo', label: 'Solo', color: '', enabled: true }]);
  eq(one.length, 1, 'render: one list is not a special case either');
}

{
  const seven = Array.from({ length: 7 }, (_, i) => task('private', `P${i}`));
  const names = (f) => f.shown.map((e) => e.todo.summary);

  const shut = foldRows(seven, 2, false);
  deep(names(shut), ['P0', 'P1'], 'render: two rows shown by default');
  eq(shut.folded, true, 'render: a long list is folded');
  eq(shut.hidden, 5, 'render: the toggle counts what it is hiding');

  const open = foldRows(seven, 2, true);
  eq(open.shown.length, 7, 'render: unfolded shows everything');
  eq(open.folded, true, 'render: an open group keeps its toggle, or there is no way back');

  eq(foldRows(seven, 0, false).shown.length, 7, 'render: "preview: 0" folds nothing');
  eq(foldRows(seven, 0, false).folded, false, 'render: and offers no toggle');
  eq(foldRows(seven.slice(0, 2), 2, false).folded, false, 'render: exactly the preview size is not folded');
  eq(foldRows([], 2, false).folded, false, 'render: an empty group has nothing to fold');
}

/* ------------------------------------------------------------ the panel */

/*
 * Enough of an element to let `renderPanel` build into it. Obsidian's helpers
 * are all `createX(tag, { cls, text })`, so recording those four things is the
 * whole DOM this needs — and it is what turns "the arrow sits next to the list
 * name" from something you squint at into something that fails a test.
 */
function fakeEl(tag) {
  const el = {
    tag,
    cls: '',
    text: '',
    icon: '',
    attrs: {},
    kids: [],
    empty() { el.kids.length = 0; },
    createEl(name, o) {
      const kid = fakeEl(name);
      kid.cls = (o && o.cls) || '';
      kid.text = (o && o.text) || '';
      el.kids.push(kid);
      return kid;
    },
    createDiv(o) { return el.createEl('div', o); },
    createSpan(o) { return el.createEl('span', o); },
    appendText(s) { el.text += s; },
    setAttribute(k, v) { el.attrs[k] = v; },
    addEventListener() {},
    addClass() {},
    removeClass() {},
    toggleClass() {},
  };
  return el;
}

const flatten = (el) => el.kids.reduce((acc, k) => acc.concat(flatten(k)), [el]);
const pick = (el, cls) => flatten(el).filter((n) => n.cls.split(' ').includes(cls));

{
  const now = new Date(2026, 7, 14);
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => task('private', `P${i}`)),
    task('work', 'W1', null, 1),
    task('ghost', 'G1'),                       // a list nobody has configured
  ];
  const handlers = {
    icon: (el, name) => { el.icon = name; },
    onExpand: () => {},
    onCreate: () => {},
    onRefresh: () => {},
    onNewList: () => {},
    onQuickAdd: () => {},
    onPriorityMenu: () => {},
  };
  const draw = (source, extra) => {
    const el = fakeEl('div');
    const cfg = parseBlock(source);
    renderPanel(el, Object.assign({
      state: 'ready',
      cfg,
      now,
      lists: LISTS,
      // what selectTasks would have handed over
      rows: cfg.list ? rows.filter((e) => e.listKey === cfg.list) : rows,
      grouped: !cfg.list,
      expanded: new Set(),
      drafts: new Map(),
    }, extra), handlers);
    return el;
  };

  const all = draw('all');
  const labels = pick(all, 'nct-group-label');
  deep(labels.map((n) => n.tag), ['div', 'div', 'button', 'div'],
    'render: only a list with something to unfold gets a pressable heading');
  eq(labels[0].text, '💼 Work', 'render: a short list keeps a plain heading');

  const folded = labels[2];
  eq(pick(folded, 'nct-chevron')[0].icon, 'chevron-right', 'render: a folded list points right');
  eq(pick(folded, 'nct-label-text')[0].text, '🌿 Private', 'render: the name sits next to the arrow');
  eq(pick(folded, 'nct-count')[0].text, '5', 'render: and says how many it is holding back');
  eq(folded.attrs['aria-expanded'], 'false', 'render: the state is announced, not only drawn');

  const opened = draw('all', { expanded: new Set(['private']) });
  const shown = pick(opened, 'nct-group-label')[2];
  eq(pick(shown, 'nct-chevron')[0].icon, 'chevron-down', 'render: an open list points down');
  eq(pick(shown, 'nct-count').length, 0, 'render: nothing hidden, nothing to count');
  eq(pick(opened, 'nct-row').length, 9, 'render: unfolded, every row of that list is there');

  // Icon-only actions: what used to be the label is now the accessible name.
  const buttons = pick(all, 'nct-btn');
  deep(buttons.map((b) => b.icon), ['plus', 'list-plus', 'refresh-cw'], 'render: the header is icons');
  deep(buttons.map((b) => b.text), ['', '', ''], 'render: and carries no text');
  eq(buttons[0].attrs['aria-label'], t('panel.add'), 'render: the label moved to aria-label');

  // The blank row: one per real list, and none in the bucket for tasks whose
  // list is gone — there is nowhere to write those.
  const news = pick(all, 'nct-new');
  eq(news.length, 3, 'render: every configured list ends in a blank row');
  deep(news.map((n) => pick(n, 'nct-new-input')[0].attrs['data-list']), ['work', 'school', 'private'],
    'render: each blank row knows which list it writes to');
  eq(pick(all, 'nct-none').length, 0, 'render: the blank row replaces the "nothing open" line');
  deep(pick(all, 'nct-list').map((l) => l.kids[0].cls.split(' ')[0]), ['nct-new', 'nct-new', 'nct-new', 'nct-row'],
    'render: the blank row opens the list, above the tasks');
  eq(pick(news[0], 'nct-date')[0].tag, 'input', 'render: a real date input backs the calendar button');

  // The flag, for every level — the half that was missing the first time.
  const flag = pick(all, 'nct-flag')[0];
  ok(flag && flag.cls.includes('is-high'), 'render: a priority-1 task is marked high');
  eq(flag.icon, 'flag', 'render: and marked with the flag icon');

  const typed = draw('all', {
    drafts: new Map([['work', { text: 'Halb getippt', due: '2026-08-20', priority: 5 }]]),
  });
  const box = pick(typed, 'nct-new-input')[0];
  eq(box.value, 'Halb getippt', 'render: a redraw puts back what was being typed');
  eq(pick(typed, 'nct-send')[0].disabled, false, 'render: with a title, the send button is live');
  eq(pick(all, 'nct-send')[0].disabled, true, 'render: an empty row has nothing to send');
  eq(pick(all, 'nct-send')[0].icon, 'send', 'render: and it is marked as the send action');
  ok(pick(typed, 'nct-mini-text')[0].text.length > 0, 'render: a chosen date shows on its button');

  const readOnly = (() => {
    const el = fakeEl('div');
    renderPanel(el, {
      state: 'ready', cfg: parseBlock('all'), now, lists: LISTS, rows, grouped: true,
      expanded: new Set(), drafts: new Map(),
    }, { icon: handlers.icon });
    return el;
  })();
  eq(pick(readOnly, 'nct-new').length, 0, 'render: no quick-add handler, no blank row');
  eq(pick(readOnly, 'nct-none').length, 1, 'render: and the empty list says so in words again');

  // A single-list block has no group heading, so its title carries the fold.
  const one = draw('list: private');
  eq(pick(one, 'nct-group-label').length, 0, 'render: one list, no group heading');
  const title = pick(one, 'nct-title')[0];
  eq(title.tag, 'button', 'render: there the panel title is the fold toggle');
  eq(pick(title, 'nct-count')[0].text, '5', 'render: with the same count');
  eq(pick(one, 'nct-btn').map((b) => b.icon).includes('list-plus'), false,
    'render: no "new list" button in a block that shows one list');
}

{
  // A task you just ticked stays on screen, struck through, so you can see what
  // you did and undo it. Everything else that is done stays filtered out.
  const now = new Date(2026, 7, 14);
  const mine = task('work', 'Just ticked', new Date(2026, 7, 14), 0, true);
  const theirs = task('work', 'Done last week', new Date(2026, 7, 10), 0, true);
  const open = task('work', 'Still open', new Date(2026, 7, 14));
  const rows = [mine, theirs, open];

  const sticky = new Set([mine.url]);
  deep(selectTasks(rows, parseBlock('all'), now, LISTS, sticky).map((e) => e.todo.summary),
    ['Just ticked', 'Still open'],
    'render: the task you just ticked stays, the one completed elsewhere does not');

  deep(selectTasks(rows, parseBlock('all'), now, LISTS, new Set()).map((e) => e.todo.summary),
    ['Still open'], 'render: an empty sticky set behaves exactly as before');
  deep(selectTasks(rows, parseBlock('all'), now, LISTS).map((e) => e.todo.summary),
    ['Still open'], 'render: no sticky set at all is the same thing');

  eq(selectTasks(rows, parseBlock('done: true'), now, LISTS, sticky).length, 3,
    'render: "done: true" is unaffected by stickiness');
  eq(selectTasks(rows, parseBlock('list: school'), now, LISTS, sticky).length, 0,
    'render: a sticky task does not leak into another list');
}

{
  eq(orderOf(LISTS, 'school'), 1, 'render: orderOf reads the configured position');
  eq(orderOf(LISTS, 'ghost'), Number.MAX_SAFE_INTEGER, 'render: an unknown list sorts last');
  eq(accentOf(LISTS, { list: 'private' }), '#6f9553', 'render: a single-list block keeps its accent');
  eq(accentOf(LISTS, { list: null }), '', 'render: a grouped block has no single accent');
}

/* ------------------------------------------------------------- report */

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} of ${passed + failures.length} checks failed:\n`);
  for (const f of failures) console.log(`   ✗ ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`✓ ${passed} checks passed (i18n · model · render)`);
