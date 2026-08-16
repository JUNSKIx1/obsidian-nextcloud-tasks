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
  parseBlock, dueLabel, daysUntil, selectTasks, groupByList, orderOf, accentOf,
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

  const untranslated = enKeys.filter((k) => EN[k] === DE[k] && !/^(prio|btn)\./.test(k));
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
  deep(groups.map((g) => g.key), ['work', 'school', ''],
    'render: groups follow the configured order, orphans last in a keyless bucket');
  eq(groups[0].label, '💼 Work', 'render: the group heading is the label the user typed');
  eq(groups[0].color, '#4a7699', 'render: the group carries its accent colour');
  eq(groups[1].rows.length, 2, 'render: rows land in their own group');
  eq(groups[2].label, t('group.other'), 'render: a task from a list nobody configured still shows up');

  eq(groupByList(rows, []).length, 1, 'render: no configured lists, everything in one bucket');
  eq(groupByList([], LISTS).length, 0, 'render: no rows, no groups');
  eq(groupByList(rows.slice(0, 1), LISTS).length, 1, 'render: only non-empty groups are rendered');

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
