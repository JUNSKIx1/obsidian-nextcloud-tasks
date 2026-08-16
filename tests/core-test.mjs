#!/usr/bin/env node
/*
 * xml · ics · caldav.
 *
 *   node tests/core-test.mjs
 *
 * Plain node, nothing installed, no network, no credentials. Drives the real
 * CalDAV client against a fake HTTP function, so a broken request body fails
 * here rather than against somebody's server.
 *
 * The assertion labels are German. They came over verbatim from the suite this
 * plugin grew out of, and a translated label is a rewritten test.
 */

import * as xml from '../src/xml.js';
import * as ics from '../src/ics.js';
import { CalDav, DavError, basicAuth, normalizeBase } from '../src/caldav.js';

/* ------------------------------------------------------------- harness */

let passed = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { passed++; return; }
  failures.push(extra ? `${label}\n      ${extra}` : label);
}
const eq = (a, b, label) => ok(a === b, label, `erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);
const deep = (a, b, label) => eq(JSON.stringify(a), JSON.stringify(b), label);

async function throws(fn, test, label) {
  try {
    await fn();
    ok(false, label, 'kein Fehler geworfen');
  } catch (e) {
    ok(test(e), label, `Fehler war: ${e && e.message}`);
  }
}

const CRLF = '\r\n';
const ical = (...lines) => lines.join(CRLF) + CRLF;

/* ================================================================= xml.js */

const MS_PRINCIPAL = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/</d:href>
    <d:propstat>
      <d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/alice/</d:href></d:current-user-principal></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

{
  const rows = xml.davResponses(MS_PRINCIPAL);
  eq(rows.length, 1, 'xml: eine response');
  eq(rows[0].href, '/remote.php/dav/', 'xml: href gelesen');
  eq(xml.textOf(xml.kid(rows[0].props['current-user-principal'], 'href')),
    '/remote.php/dav/principals/users/alice/', 'xml: verschachtelter href');

  // The same document with different prefixes must parse identically — prefixes
  // are not contractual and this is the bug the reader exists to prevent.
  const shouted = MS_PRINCIPAL.replace(/d:/g, 'D:').replace(/xmlns:D=/, 'xmlns:D=');
  const named = MS_PRINCIPAL.replace(/d:/g, 'dav:').replace(/xmlns:dav=/, 'xmlns:dav=');
  deep(xml.davResponses(shouted), rows, 'xml: Großbuchstaben-Präfix identisch');
  deep(xml.davResponses(named), rows, 'xml: anderes Präfix identisch');
}

{
  const doc = `<d:multistatus xmlns:d="DAV:"><d:response>
    <d:href>/x/</d:href>
    <d:propstat><d:prop><d:displayname>Da</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    <d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  </d:response></d:multistatus>`;
  const r = xml.davResponses(doc)[0];
  eq(xml.textOf(r.props['displayname']), 'Da', 'xml: 200-propstat übernommen');
  eq(r.props['getetag'], undefined, 'xml: 404-propstat verworfen');
}

{
  eq(xml.decodeEntities('Ma&#223;e &amp; Gr&#xF6;&#xDF;e &lt;x&gt;'), 'Maße & Größe <x>', 'xml: Entities dekodiert');
  eq(xml.decodeEntities('&unknown; bleibt'), '&unknown; bleibt', 'xml: unbekannte Entity bleibt stehen');
  eq(xml.escapeXml(`ME&ME "a" <b> 'c'`), 'ME&amp;ME &quot;a&quot; &lt;b&gt; &apos;c&apos;', 'xml: escapeXml');
}

{
  const doc = '<root><a><![CDATA[BEGIN:VCALENDAR & <stuff>]]></a><b n="VTODO"/><!-- weg --></root>';
  const parsed = xml.parseXml(doc);
  eq(xml.textOf(xml.descend(parsed, 'a')), 'BEGIN:VCALENDAR & <stuff>', 'xml: CDATA roh übernommen');
  eq(xml.descend(parsed, 'b').attrs.n, 'VTODO', 'xml: Attribut am self-closing Tag');
  eq(xml.descendAll(parsed, 'a').length, 1, 'xml: Kommentar erzeugt keinen Knoten');
}

{
  // localName is the whole contract of this reader: prefix dropped, case folded.
  eq(xml.localName('cal:supported-calendar-component-set'), 'supported-calendar-component-set', 'xml: Präfix entfernt');
  eq(xml.localName('D:HREF'), 'href', 'xml: Lokalname kleingeschrieben');
  eq(xml.localName('href'), 'href', 'xml: Name ohne Präfix bleibt');
  const shouty = '<D:MULTISTATUS xmlns:D="DAV:"><D:RESPONSE><D:HREF>/x/</D:HREF>'
    + '<D:PROPSTAT><D:PROP><D:DISPLAYNAME>Laut</D:DISPLAYNAME></D:PROP>'
    + '<D:STATUS>HTTP/1.1 200 OK</D:STATUS></D:PROPSTAT></D:RESPONSE></D:MULTISTATUS>';
  const r = xml.davResponses(shouty)[0];
  eq(r && r.href, '/x/', 'xml: durchgehend großgeschriebenes Dokument gelesen');
  eq(xml.textOf(r.props['displayname']), 'Laut', 'xml: Property über den kleingeschriebenen Namen gefunden');
}

eq(xml.statusCode('HTTP/1.1 207 Multi-Status'), 207, 'xml: statusCode');
eq(xml.statusCode('kaputt'), null, 'xml: statusCode unlesbar → null');

/* ================================================================= ics.js */

{
  const folded = ical('BEGIN:VTODO', 'SUMMARY:Das ist ein sehr langer Titel der garantiert', '  über die Grenze geht', 'END:VTODO');
  const lines = ics.unfold(folded);
  eq(lines[1], 'SUMMARY:Das ist ein sehr langer Titel der garantiert über die Grenze geht',
    'ics: gefaltete Zeile wieder zusammengesetzt');

  const long = `SUMMARY:${'ä'.repeat(200)}`;
  const out = ics.foldLine(long, CRLF).split(CRLF);
  ok(out.every((l) => ics.byteLength(l) <= 75), 'ics: jede Zeile ≤ 75 Oktett');
  ok(out.slice(1).every((l) => l[0] === ' '), 'ics: Fortsetzungen mit Leerzeichen');
  eq(ics.unfold(out.join(CRLF) + CRLF)[0], long, 'ics: falten/entfalten ist verlustfrei');
  ok(!out.join('').includes('\uFFFD'), 'ics: kein zerschnittenes Mehrbyte-Zeichen');
}

{
  const raw = 'Milch, Brot; und ein \\ Backslash\nZweite Zeile';
  eq(ics.unescapeText(ics.escapeText(raw)), raw, 'ics: TEXT-Escaping ist umkehrbar');
  eq(ics.escapeText(raw), 'Milch\\, Brot\\; und ein \\\\ Backslash\\nZweite Zeile', 'ics: Escaping-Reihenfolge');
}

{
  const p = ics.parseLine('DUE;TZID="Europe/Berlin:seltsam";VALUE=DATE-TIME:20260820T140000');
  eq(p.name, 'DUE', 'ics: Property-Name');
  eq(p.params.TZID, 'Europe/Berlin:seltsam', 'ics: Doppelpunkt im Quoted-Parameter');
  eq(p.value, '20260820T140000', 'ics: Wert nach dem echten Doppelpunkt');
  eq(ics.propName('SUMMARY;LANGUAGE=de:Hallo'), 'SUMMARY', 'ics: propName ohne Parsing');
}

{
  const d1 = ics.parseIcsDate('20260820', { VALUE: 'DATE' });
  eq(d1.allDay, true, 'ics: DATE ist ganztägig');
  eq(d1.date.getFullYear(), 2026, 'ics: DATE Jahr');
  eq(d1.date.getMonth(), 7, 'ics: DATE Monat');
  eq(d1.date.getDate(), 20, 'ics: DATE Tag');

  const d2 = ics.parseIcsDate('20260820T140000Z', {});
  eq(d2.allDay, false, 'ics: DATE-TIME nicht ganztägig');
  eq(d2.date.toISOString(), '2026-08-20T14:00:00.000Z', 'ics: Z wird als UTC gelesen');

  const d3 = ics.parseIcsDate('20260820T140000', { TZID: 'Europe/Berlin' });
  eq(d3.date.getHours(), 14, 'ics: TZID als lokale Wanduhrzeit');
  eq(ics.parseIcsDate('unfug', {}), null, 'ics: unlesbares Datum → null');
}

const TASK = ical(
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Nextcloud Tasks//EN',
  'BEGIN:VTODO',
  'UID:abc-123',
  'DTSTAMP:20260810T090000Z',
  'CREATED:20260810T090000Z',
  'LAST-MODIFIED:20260810T090000Z',
  'SUMMARY:Zahnarzt anrufen',
  'DESCRIPTION:Erste Zeile\\nZweite Zeile mit einem sehr langen Text der beim',
  '  Speichern gefaltet wurde und exakt so bleiben muss',
  'DUE;VALUE=DATE:20260820',
  'PRIORITY:1',
  'CATEGORIES:Privat,Telefon',
  'STATUS:NEEDS-ACTION',
  'PERCENT-COMPLETE:0',
  'SEQUENCE:3',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'X-APPLE-SORT-ORDER:12',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'SUMMARY:Erinnerung die kein Task-Titel ist',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VTODO',
  'END:VCALENDAR');

{
  const todos = ics.parseTodos(TASK);
  eq(todos.length, 1, 'ics: ein VTODO');
  const t = todos[0];
  eq(t.uid, 'abc-123', 'ics: UID');
  eq(t.summary, 'Zahnarzt anrufen', 'ics: SUMMARY — nicht die aus dem VALARM');
  eq(t.description, 'Erste Zeile\nZweite Zeile mit einem sehr langen Text der beim Speichern gefaltet wurde und exakt so bleiben muss',
    'ics: gefaltete DESCRIPTION entfaltet und entescaped');
  eq(t.due.allDay, true, 'ics: DUE ganztägig');
  eq(t.priority, 1, 'ics: PRIORITY');
  eq(t.sequence, 3, 'ics: SEQUENCE');
  deep(t.categories, ['Privat', 'Telefon'], 'ics: CATEGORIES');
  eq(t.hasRrule, true, 'ics: RRULE erkannt');
  eq(ics.isDone(t), false, 'ics: offen');
}

{
  const byStatus = ics.parseTodos(ical('BEGIN:VTODO', 'UID:a', 'STATUS:COMPLETED', 'END:VTODO'))[0];
  const byProp = ics.parseTodos(ical('BEGIN:VTODO', 'UID:b', 'COMPLETED:20260810T100000Z', 'END:VTODO'))[0];
  const byPct = ics.parseTodos(ical('BEGIN:VTODO', 'UID:c', 'PERCENT-COMPLETE:100', 'END:VTODO'))[0];
  const cancelled = ics.parseTodos(ical('BEGIN:VTODO', 'UID:d', 'STATUS:CANCELLED', 'END:VTODO'))[0];
  ok(ics.isDone(byStatus) && ics.isDone(byProp) && ics.isDone(byPct) && ics.isDone(cancelled),
    'ics: alle drei Schreibweisen von „erledigt" zählen');
}

{
  const { uid, ics: text } = ics.buildTodo({
    summary: 'Test; mit, Sonderzeichen',
    due: new Date(2026, 8, 1),
    priority: 5,
    now: new Date(Date.UTC(2026, 7, 14, 12, 0, 0)),
  });
  ok(/^[0-9a-f-]{10,}$/i.test(uid), 'ics: UID erzeugt');
  ok(text.endsWith(`END:VCALENDAR${CRLF}`), 'ics: endet mit CRLF');
  ok(text.includes('DUE;VALUE=DATE:20260901'), 'ics: DUE als DATE');
  ok(text.includes('DTSTAMP:20260814T120000Z'), 'ics: DTSTAMP in UTC');
  const back = ics.parseTodos(text)[0];
  eq(back.summary, 'Test; mit, Sonderzeichen', 'ics: erzeugtes SUMMARY liest sich zurück');
  eq(back.uid, uid, 'ics: erzeugte UID liest sich zurück');
  eq(ics.isDone(back), false, 'ics: neue Aufgabe ist offen');
}

/* --- setCompletion: the invariant that everything else rests on ---------- */

{
  const done = ics.setCompletion(TASK, true, { now: new Date(Date.UTC(2026, 7, 14, 15, 30, 0)) });
  const t = ics.parseTodos(done)[0];
  eq(ics.isDone(t), true, 'ics: nach setCompletion erledigt');
  eq(t.status, 'COMPLETED', 'ics: STATUS ersetzt');
  eq(t.percent, 100, 'ics: PERCENT-COMPLETE ersetzt');
  eq(t.sequence, 4, 'ics: SEQUENCE hochgezählt');
  ok(done.includes('COMPLETED:20260814T153000Z'), 'ics: COMPLETED eingefügt');
  ok(done.includes('LAST-MODIFIED:20260814T153000Z'), 'ics: LAST-MODIFIED aktualisiert');
  ok(done.includes(`${CRLF}END:VTODO${CRLF}`), 'ics: VTODO bleibt geschlossen');
  ok(done.split(CRLF).length > 1 && !done.includes('\n\n'), 'ics: CRLF beibehalten');

  // The point of the whole design: lines we do not own come through untouched.
  const touched = new Set(['STATUS', 'COMPLETED', 'PERCENT-COMPLETE', 'LAST-MODIFIED', 'DTSTAMP', 'SEQUENCE']);
  const keep = (text) => ics.splitPhysical(text)
    .filter((p) => !touched.has(ics.propName(p.text)))
    .map((p) => p.text + p.eol);
  deep(keep(done), keep(TASK), 'ics: jede andere Zeile ist byteidentisch geblieben');
  ok(done.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'), 'ics: RRULE überlebt');
  ok(done.includes('X-APPLE-SORT-ORDER:12'), 'ics: unbekannte X-Property überlebt');
  ok(done.includes('BEGIN:VALARM') && done.includes('TRIGGER:-PT15M'), 'ics: VALARM überlebt');
  ok(done.includes('  Speichern gefaltet wurde'), 'ics: Faltung der DESCRIPTION unverändert');
}

{
  // Properties that were not in the file get inserted, immediately before END:VTODO.
  const bare = ical('BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:x', 'SUMMARY:Ohne Status', 'END:VTODO', 'END:VCALENDAR');
  const done = ics.setCompletion(bare, true, { now: new Date(Date.UTC(2026, 7, 14, 15, 30, 0)) });
  const lines = done.split(CRLF);
  const endIdx = lines.indexOf('END:VTODO');
  ok(lines.slice(0, endIdx).includes('STATUS:COMPLETED'), 'ics: STATUS vor END:VTODO ergänzt');
  ok(lines.slice(0, endIdx).includes('SEQUENCE:1'), 'ics: SEQUENCE von 0 auf 1');
  eq(lines[endIdx + 1], 'END:VCALENDAR', 'ics: nichts hinter END:VTODO eingefügt');
  eq(ics.parseTodos(done)[0].summary, 'Ohne Status', 'ics: SUMMARY unberührt');
}

{
  const done = ics.setCompletion(TASK, true, { now: new Date() });
  const open = ics.setCompletion(done, false, { now: new Date() });
  const t = ics.parseTodos(open)[0];
  eq(ics.isDone(t), false, 'ics: wieder geöffnet');
  eq(t.status, 'NEEDS-ACTION', 'ics: STATUS zurückgesetzt');
  ok(!/[\r\n]COMPLETED:/.test(open), 'ics: COMPLETED wieder entfernt');
  eq(t.percent, 0, 'ics: PERCENT-COMPLETE zurückgesetzt');
}

{
  // A recurring task with an override: the master is the one that gets ticked.
  const withOverride = ical(
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO', 'UID:r', 'RECURRENCE-ID:20260801', 'SUMMARY:Ausnahme', 'STATUS:NEEDS-ACTION', 'END:VTODO',
    'BEGIN:VTODO', 'UID:r', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Serie', 'STATUS:NEEDS-ACTION', 'END:VTODO',
    'END:VCALENDAR');
  const block = ics.findTodoBlock(ics.logicalLines(ics.splitPhysical(withOverride)));
  const out = ics.setCompletion(withOverride, true);
  const parts = out.split('BEGIN:VTODO');
  ok(block.from > 1, 'ics: nicht der erste Block gewählt');
  ok(parts[1].includes('STATUS:NEEDS-ACTION'), 'ics: die Ausnahme bleibt offen');
  ok(parts[2].includes('STATUS:COMPLETED'), 'ics: die Serie wird erledigt');
}

eq(ics.setCompletion(ical('BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:e', 'END:VEVENT', 'END:VCALENDAR'), true), null,
  'ics: ohne VTODO wird nichts geschrieben');

{
  // LF-only input keeps LF; the spec says CRLF but we do not rewrite a server's bytes.
  const lf = 'BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:l\nSTATUS:NEEDS-ACTION\nEND:VTODO\nEND:VCALENDAR\n';
  const out = ics.setCompletion(lf, true);
  ok(!out.includes('\r'), 'ics: LF-Datei bleibt LF');
  eq(ics.parseTodos(out)[0].status, 'COMPLETED', 'ics: LF-Datei korrekt bearbeitet');
}

/* --- setFields: dasselbe Versprechen für Titel, Datum und Priorität ------- */

const EDIT_NOW = { now: new Date(Date.UTC(2026, 7, 14, 15, 30, 0)) };

{
  const out = ics.setFields(TASK, { summary: 'Zahnarzt absagen' }, EDIT_NOW);
  const t = ics.parseTodos(out)[0];
  eq(t.summary, 'Zahnarzt absagen', 'ics: SUMMARY geändert');
  eq(t.sequence, 4, 'ics: SEQUENCE hochgezählt');
  ok(out.includes('LAST-MODIFIED:20260814T153000Z'), 'ics: LAST-MODIFIED aktualisiert');

  // Same invariant as setCompletion, and the entire reason setFields exists.
  const touched = new Set(['SUMMARY', 'LAST-MODIFIED', 'DTSTAMP', 'SEQUENCE']);
  const keep = (text) => ics.splitPhysical(text)
    .filter((p) => !touched.has(ics.propName(p.text)))
    .map((p) => p.text + p.eol);
  deep(keep(out), keep(TASK), 'ics: setFields lässt jede andere Zeile byteidentisch');
  ok(out.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'), 'ics: RRULE überlebt eine Titeländerung');
  ok(out.includes('X-APPLE-SORT-ORDER:12'), 'ics: unbekannte X-Property überlebt');
  ok(out.includes('BEGIN:VALARM') && out.includes('TRIGGER:-PT15M'), 'ics: VALARM überlebt');
  eq(t.status, 'NEEDS-ACTION', 'ics: der Erledigt-Status bleibt unangetastet');
  eq(t.priority, 1, 'ics: eine nicht angefasste PRIORITY bleibt');
  eq(t.due.allDay, true, 'ics: ein nicht angefasstes DUE bleibt');
}

{
  // undefined heißt „nicht anfassen" — sonst würde eine Titelkorrektur eine
  // Uhrzeit in einen ganzen Tag verwandeln.
  const timed = ical('BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:z', 'SUMMARY:Termin',
    'DUE;TZID=Europe/Berlin:20260820T140000', 'END:VTODO', 'END:VCALENDAR');

  const renamed = ics.setFields(timed, { summary: 'Termin verschoben' }, EDIT_NOW);
  ok(renamed.includes('DUE;TZID=Europe/Berlin:20260820T140000'),
    'ics: ein nicht angefasstes DUE behält Zeitzone und Uhrzeit');

  const dated = ics.setFields(timed, { due: new Date(2026, 8, 1) }, EDIT_NOW);
  ok(dated.includes('DUE;VALUE=DATE:20260901'), 'ics: gesetztes DUE wird ganztägig geschrieben');
  ok(!dated.includes('TZID'), 'ics: das alte DUE ist ersetzt, nicht verdoppelt');

  const cleared = ics.setFields(timed, { due: null }, EDIT_NOW);
  ok(!/[\r\n]DUE/.test(cleared), 'ics: due: null entfernt die Zeile');
  eq(ics.parseTodos(cleared)[0].summary, 'Termin', 'ics: der Rest bleibt beim Entfernen unberührt');
}

{
  ok(!/[\r\n]PRIORITY:/.test(ics.setFields(TASK, { priority: 0 }, EDIT_NOW)),
    'ics: Priorität 0 heißt „unbestimmt" und entfernt die Zeile');
  ok(ics.setFields(TASK, { priority: 9 }, EDIT_NOW).includes('PRIORITY:9'), 'ics: PRIORITY ersetzt');
  ok(!/[\r\n]PRIORITY:/.test(ics.setFields(TASK, { priority: 42 }, EDIT_NOW)),
    'ics: eine unsinnige Priorität wird entfernt statt geschrieben');
}

{
  const long = 'Sehr langer Titel mit Umlauten äöü der garantiert über fünfundsiebzig '
    + 'Oktette hinausgeht und deshalb gefaltet werden muss';
  const out = ics.setFields(TASK, { summary: `${long}; mit, Sonderzeichen` }, EDIT_NOW);
  eq(ics.parseTodos(out)[0].summary, `${long}; mit, Sonderzeichen`,
    'ics: langer Titel mit Sonderzeichen liest sich unversehrt zurück');
  eq(out.split(CRLF).filter((l) => ics.byteLength(l) > 75).length, 0,
    'ics: der neue Titel ist auf 75 Oktette gefaltet, ohne Zeichen zu zerschneiden');
}

{
  eq(ics.setFields(TASK, {}, EDIT_NOW), TASK, 'ics: ohne Änderung bleibt der Text identisch — kein PUT nötig');
  eq(ics.setFields(TASK, undefined, EDIT_NOW), TASK, 'ics: gar keine Felder ist auch keine Änderung');
  eq(ics.setFields(ical('BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:e', 'END:VEVENT', 'END:VCALENDAR'), { summary: 'x' }),
    null, 'ics: ohne VTODO wird auch hier nichts geschrieben');
}

/* ============================================================== caldav.js */

const BASE = 'https://cloud.example.com';

const MS_HOME = `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/remote.php/dav/principals/users/alice/</d:href>
    <d:propstat><d:prop><cal:calendar-home-set><d:href>/remote.php/dav/calendars/alice/</d:href></cal:calendar-home-set></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const MS_LISTS = `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <d:response><d:href>/remote.php/dav/calendars/alice/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>

  <d:response><d:href>/remote.php/dav/calendars/alice/persoenlich/</d:href>
    <d:propstat><d:prop>
      <d:displayname>Pers&#246;nlich</d:displayname>
      <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
      <cal:supported-calendar-component-set><cal:comp name="VTODO"/><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
      <ic:calendar-color>#0082c9</ic:calendar-color>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>

  <d:response><d:href>/remote.php/dav/calendars/alice/termine/</d:href>
    <d:propstat><d:prop>
      <d:displayname>Termine</d:displayname>
      <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
      <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>

  <d:response><d:href>/remote.php/dav/calendars/alice/feiertage/</d:href>
    <d:propstat><d:prop>
      <d:displayname>Feiertage</d:displayname>
      <d:resourcetype><d:collection/><cal:calendar/><cs:subscribed xmlns:cs="http://calendarserver.org/ns/"/></d:resourcetype>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>

  <d:response><d:href>/remote.php/dav/calendars/alice/trashbin/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

const MS_TASKS = `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/remote.php/dav/calendars/alice/persoenlich/abc-123.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>"etag-1"</d:getetag>
      <cal:calendar-data><![CDATA[${TASK}]]></cal:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>

  <d:response><d:href>/remote.php/dav/calendars/alice/persoenlich/fertig.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>"etag-2"</d:getetag>
      <cal:calendar-data><![CDATA[${ical('BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:fertig', 'SUMMARY:Schon erledigt', 'STATUS:COMPLETED', 'END:VTODO', 'END:VCALENDAR')}]]></cal:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

/** Records every call and answers from a route table. */
function fakeHttp(routes) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    for (const r of routes) {
      if (r.method && r.method !== req.method) continue;
      if (r.url && !req.url.includes(r.url)) continue;
      const reply = typeof r.reply === 'function' ? r.reply(req, calls) : r.reply;
      return Object.assign({ status: 207, text: '', headers: {} }, reply);
    }
    return { status: 404, text: '', headers: {} };
  };
  fn.calls = calls;
  return fn;
}

const DISCOVERY_ROUTES = [
  { method: 'PROPFIND', url: '/remote.php/dav/principals/users/alice/', reply: { status: 207, text: MS_HOME } },
  { method: 'PROPFIND', url: '/remote.php/dav/calendars/alice/', reply: { status: 207, text: MS_LISTS } },
  { method: 'PROPFIND', url: '/remote.php/dav/', reply: { status: 207, text: MS_PRINCIPAL } },
];

const client = (routes) => {
  const request = fakeHttp(routes);
  return { dav: new CalDav({ baseUrl: BASE, username: 'ncp', password: 'app-pw', request }), request };
};

eq(normalizeBase('cloud.example.com/index.php/'), 'https://cloud.example.com', 'caldav: Basis-URL normalisiert');
eq(normalizeBase('https://cloud.example.com/remote.php/dav/calendars/alice/'), 'https://cloud.example.com',
  'caldav: eingefügter DAV-Pfad wird abgeschnitten');
eq(basicAuth('alice', 'gehäim'), `Basic ${Buffer.from('alice:gehäim', 'utf8').toString('base64')}`,
  'caldav: Basic-Auth ist UTF-8-fest');

(async function run() {
  /* ---- discovery ---- */
  {
    const { dav, request } = client(DISCOVERY_ROUTES);
    const d = await dav.discover();
    eq(d.principal, `${BASE}/remote.php/dav/principals/users/alice/`, 'caldav: Principal gefunden');
    eq(d.home, `${BASE}/remote.php/dav/calendars/alice/`, 'caldav: calendar-home-set gefunden');
    eq(request.calls.length, 3, 'caldav: genau drei Anfragen für die Discovery');
    eq(request.calls[0].headers.Depth, '0', 'caldav: Depth 0 für den Principal');
    eq(request.calls[2].headers.Depth, '1', 'caldav: Depth 1 für die Listen');
    ok(request.calls[0].headers.Authorization.startsWith('Basic '), 'caldav: Basic-Auth gesetzt');
    ok(request.calls[0].body.includes('current-user-principal'), 'caldav: PROPFIND fragt den Principal ab');
    eq(request.calls[0].throw, false, 'caldav: requestUrl wirft nicht selbst');

    deep(d.lists.map((l) => l.displayName), ['Persönlich'], 'caldav: nur die VTODO-Liste bleibt übrig');
    eq(d.lists[0].url, `${BASE}/remote.php/dav/calendars/alice/persoenlich/`, 'caldav: Listen-URL absolut');
    eq(d.lists[0].color, '#0082c9', 'caldav: Farbe gelesen');

    await dav.discover();
    eq(request.calls.length, 3, 'caldav: Discovery wird zwischengespeichert');
  }

  /* ---- reading ---- */
  {
    const { dav, request } = client([
      ...DISCOVERY_ROUTES,
      { method: 'REPORT', reply: { status: 207, text: MS_TASKS } },
    ]);
    const rows = await dav.listTasks(`${BASE}/remote.php/dav/calendars/alice/persoenlich/`);
    const report = request.calls.find((c) => c.method === 'REPORT');
    ok(report.body.includes('<c:comp-filter name="VTODO"/>'), 'caldav: calendar-query filtert auf VTODO');
    ok(report.body.includes('calendar-data'), 'caldav: calendar-query holt die Daten mit');
    eq(report.headers.Depth, '1', 'caldav: REPORT mit Depth 1');

    eq(rows.length, 2, 'caldav: beide Aufgaben gelesen — erledigte werden nicht serverseitig gefiltert');
    eq(rows[0].todo.summary, 'Zahnarzt anrufen', 'caldav: Aufgabe geparst');
    eq(rows[0].etag, '"etag-1"', 'caldav: ETag übernommen');
    eq(rows[0].done, false, 'caldav: offen erkannt');
    eq(rows[1].done, true, 'caldav: erledigt erkannt');
    ok(rows[0].ics.includes('RRULE'), 'caldav: Originaltext wird mitgeführt');
  }

  /* ---- REPORT refused → standard-HTTP fallback ---- */
  {
    const objects = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/remote.php/dav/calendars/alice/persoenlich/</d:href>
        <d:propstat><d:prop><d:getetag>"coll"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/remote.php/dav/calendars/alice/persoenlich/abc-123.ics</d:href>
        <d:propstat><d:prop><d:getetag>"etag-1"</d:getetag><d:getcontenttype>text/calendar; charset=utf-8</d:getcontenttype></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const { dav, request } = client([
      { method: 'REPORT', reply: { status: 501, text: '' } },
      { method: 'PROPFIND', url: '/persoenlich/', reply: { status: 207, text: objects } },
      { method: 'GET', url: 'abc-123.ics', reply: { status: 200, text: TASK, headers: { etag: '"etag-1"' } } },
    ]);
    const listUrl = `${BASE}/remote.php/dav/calendars/alice/persoenlich/`;
    const rows = await dav.listTasks(listUrl);
    eq(rows.length, 1, 'caldav: Fallback liefert die Aufgabe');
    eq(rows[0].todo.uid, 'abc-123', 'caldav: Fallback liest denselben Task');
    ok(request.calls.some((c) => c.method === 'GET'), 'caldav: Fallback holt das Objekt per GET');

    const before = request.calls.length;
    await dav.listTasks(listUrl);
    ok(!request.calls.slice(before).some((c) => c.method === 'REPORT'),
      'caldav: REPORT wird danach nicht erneut versucht');
  }

  /* ---- creating ---- */
  {
    const { dav, request } = client([
      { method: 'PUT', reply: { status: 201, headers: { etag: '"neu"' } } },
    ]);
    const res = await dav.createTask(`${BASE}/remote.php/dav/calendars/alice/persoenlich/`, { summary: 'Neue Aufgabe' });
    const put = request.calls[0];
    eq(put.method, 'PUT', 'caldav: Anlegen ist ein PUT');
    eq(put.headers['If-None-Match'], '*', 'caldav: If-None-Match verhindert Überschreiben');
    ok(put.headers['Content-Type'].startsWith('text/calendar'), 'caldav: Content-Type text/calendar');
    eq(put.url, `${BASE}/remote.php/dav/calendars/alice/persoenlich/${res.uid}.ics`, 'caldav: Dateiname ist die UID');
    ok(put.body.includes('SUMMARY:Neue Aufgabe'), 'caldav: Titel im Body');
    eq(res.etag, '"neu"', 'caldav: ETag der neuen Aufgabe');
  }

  /* ---- completing ---- */
  {
    let stored = TASK;
    const { dav, request } = client([
      { method: 'GET', reply: () => ({ status: 200, text: stored, headers: { etag: '"etag-1"' } }) },
      { method: 'PUT', reply: (req) => { stored = req.body; return { status: 204, headers: { etag: '"etag-2"' } }; } },
    ]);
    const url = `${BASE}/remote.php/dav/calendars/alice/persoenlich/abc-123.ics`;
    await dav.setDone(url, true);
    const put = request.calls.find((c) => c.method === 'PUT');
    eq(put.headers['If-Match'], '"etag-1"', 'caldav: If-Match aus dem gelesenen ETag');
    eq(ics.isDone(ics.parseTodos(stored)[0]), true, 'caldav: Aufgabe ist danach erledigt');
    ok(stored.includes('X-APPLE-SORT-ORDER:12'), 'caldav: PUT schickt das Original mit unserer Änderung');
  }

  {
    // Someone ticked it elsewhere between our GET and our PUT.
    let puts = 0;
    const { dav, request } = client([
      { method: 'GET', reply: { status: 200, text: TASK, headers: { etag: '"frisch"' } } },
      { method: 'PUT', reply: () => (++puts === 1 ? { status: 412 } : { status: 204, headers: { etag: '"ok"' } }) },
    ]);
    const res = await dav.setDone(`${BASE}/x/abc.ics`, true);
    eq(puts, 2, 'caldav: 412 führt zu genau einem zweiten Versuch');
    eq(request.calls.filter((c) => c.method === 'GET').length, 2, 'caldav: vor dem zweiten PUT wird neu gelesen');
    eq(res.etag, '"ok"', 'caldav: ETag nach erfolgreichem Wiederholen');
  }

  /* ---- editing ---- */
  {
    let stored = TASK;
    const { dav, request } = client([
      { method: 'GET', reply: () => ({ status: 200, text: stored, headers: { etag: '"etag-1"' } }) },
      { method: 'PUT', reply: (req) => { stored = req.body; return { status: 204, headers: { etag: '"etag-2"' } }; } },
    ]);
    const url = `${BASE}/remote.php/dav/calendars/alice/persoenlich/abc-123.ics`;

    const res = await dav.updateTask(url, { summary: 'Anders' });
    const put = request.calls.find((c) => c.method === 'PUT');
    eq(put.headers['If-Match'], '"etag-1"', 'caldav: Ändern schickt If-Match mit');
    eq(res.unchanged, false, 'caldav: als geschrieben gemeldet');
    eq(ics.parseTodos(stored)[0].summary, 'Anders', 'caldav: der neue Titel steht auf dem Server');
    ok(stored.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'), 'caldav: die Wiederholung hat das Ändern überlebt');
    ok(stored.includes('X-APPLE-SORT-ORDER:12'), 'caldav: fremde Properties überleben das Ändern');
    eq(ics.parseTodos(stored)[0].priority, 1, 'caldav: nicht angefasste Felder bleiben stehen');
  }

  {
    // Nothing to change must not cost a PUT.
    const { dav, request } = client([
      { method: 'GET', reply: { status: 200, text: TASK, headers: { etag: '"e"' } } },
      { method: 'PUT', reply: { status: 204 } },
    ]);
    const res = await dav.updateTask(`${BASE}/x/abc.ics`, {});
    eq(res.unchanged, true, 'caldav: ohne Änderung wird nichts geschrieben');
    eq(request.calls.filter((c) => c.method === 'PUT').length, 0, 'caldav: und wirklich kein PUT gesendet');
  }

  {
    const { dav, request } = client([{ method: 'DELETE', reply: { status: 204 } }]);
    await dav.deleteTask(`${BASE}/x/abc.ics`);
    eq(request.calls[0].method, 'DELETE', 'caldav: Löschen ist ein DELETE');

    const gone = client([{ method: 'DELETE', reply: { status: 404 } }]);
    await gone.dav.deleteTask(`${BASE}/x/weg.ics`);
    ok(true, 'caldav: eine bereits gelöschte Aufgabe ist kein Fehler');
  }

  await throws(
    async () => {
      const { dav } = client([{ method: 'PROPFIND', reply: { status: 401, text: '' } }]);
      await dav.discover();
    },
    (e) => e instanceof DavError && e.status === 401 && /app password/i.test(e.message),
    'caldav: 401 nennt das App-Passwort');

  /* ---- creating a list ---- */
  {
    const { dav, request } = client([{ method: 'MKCALENDAR', reply: { status: 201 } }]);
    const res = await dav.createList(`${BASE}/remote.php/dav/calendars/alice/`, 'Errands', '#4a7699');
    const call = request.calls[0];
    eq(call.method, 'MKCALENDAR', 'caldav: Liste anlegen ist MKCALENDAR');
    eq(call.url, `${BASE}/remote.php/dav/calendars/alice/errands/`, 'caldav: Slug aus dem Namen');
    ok(call.body.includes('<c:comp name="VTODO"/>'), 'caldav: neue Liste kann nur VTODO');
    ok(call.body.includes('<d:displayname>Errands</d:displayname>'), 'caldav: Anzeigename gesetzt');
    ok(call.body.includes('#4a7699'), 'caldav: Farbe gesetzt');
    eq(res.created, true, 'caldav: als angelegt gemeldet');

    const umlaut = client([{ method: 'MKCALENDAR', reply: { status: 201 } }]);
    await umlaut.dav.createList(`${BASE}/remote.php/dav/calendars/alice/`, 'Persönliches & Mehr', '');
    eq(umlaut.request.calls[0].url, `${BASE}/remote.php/dav/calendars/alice/persoenliches-mehr/`,
      'caldav: Umlaute und Sonderzeichen im Slug');
  }

  {
    const { dav } = client([{ method: 'MKCALENDAR', reply: { status: 405 } }]);
    const res = await dav.createList(`${BASE}/remote.php/dav/calendars/alice/`, 'Errands', '');
    eq(res.created, false, 'caldav: vorhandene Liste ist kein Fehler');
  }

  /* ---- probe ---- */
  {
    const { dav } = client([...DISCOVERY_ROUTES, { method: 'REPORT', reply: { status: 207, text: MS_TASKS } }]);
    const steps = await dav.probe();
    eq(steps.length, 4, 'caldav: Probe meldet vier Schritte');
    ok(steps.every((s) => s.ok), 'caldav: Probe erfolgreich');
    ok(/Persönlich/.test(steps[2].note), 'caldav: Probe nennt die gefundene Liste');
  }

  {
    const { dav } = client([
      ...DISCOVERY_ROUTES,
      { method: 'REPORT', reply: { status: 501 } },
      { method: 'GET', reply: { status: 200, text: TASK } },
    ]);
    const steps = await dav.probe();
    eq(steps.length, 5, 'caldav: gescheitertes REPORT löst den Fallback-Schritt aus');
    eq(steps[3].ok, false, 'caldav: Probe meldet REPORT als gescheitert');
    ok(/501/.test(steps[3].note), 'caldav: Probe nennt den Status');
  }

  {
    const { dav } = client([{ method: 'PROPFIND', reply: { status: 401 } }]);
    const steps = await dav.probe();
    eq(steps.length, 1, 'caldav: Probe bricht nach dem ersten Fehler ab');
    ok(steps.every((s) => typeof s.note === 'string'), 'caldav: Probe wirft nie');
  }

  /* ------------------------------------------------------------- report */

  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} von ${passed + failures.length} Prüfungen fehlgeschlagen:\n`);
    for (const f of failures) console.log(`   ✗ ${f}`);
    console.log('');
    process.exit(1);
  }
  console.log(`✓ ${passed} Prüfungen bestanden (xml · ics · caldav)`);
})().catch((e) => {
  console.error('\n✗ Testlauf abgebrochen:', e);
  process.exit(1);
});
