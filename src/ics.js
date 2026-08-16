/*
 * iCalendar (RFC 5545) — only the VTODO slice this plugin needs.
 *
 * Two very different jobs live here, and keeping them apart is the whole design:
 *
 *   READING  unfolds into logical lines and builds a convenient task model.
 *            Lossy on purpose — we model what we render.
 *
 *   WRITING  never regenerates an existing object. `setCompletion` edits the
 *            *physical* lines of the original text and copies every other byte
 *            through untouched. Reparse-and-regenerate would silently drop
 *            RRULE, VALARM, CATEGORIES, RELATED-TO, X-APPLE-* and everything
 *            else Reminders or the Nextcloud Tasks app wrote and we don't model.
 *            Same instinct as never rewriting a .note: the other client owns
 *            those bytes.
 *
 * Only `buildTodo` generates iCalendar from scratch, and only for objects that
 * do not exist yet.
 */

const PRODID = '-//obsidian-nextcloud-tasks//EN';

/* ------------------------------------------------------------ text values */

/** RFC 5545 §3.3.11 TEXT escaping. Backslash first or the others double-escape. */
function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function unescapeText(s) {
  let out = '';
  const src = String(s == null ? '' : s);
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '\\') { out += src[i]; continue; }
    const next = src[++i];
    if (next === undefined) { out += '\\'; break; }
    if (next === 'n' || next === 'N') out += '\n';
    else out += next;                      // \\ \; \, and anything else: literal
  }
  return out;
}

/** UTF-8 byte length, because folding is specified in octets, not characters. */
function byteLength(s) {
  let n = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Folds one logical line to 75 octets per physical line, continuations
 * prefixed with a single space. Splits only on character boundaries — cutting
 * a multi-byte character in half is how umlauts turn into mojibake on the phone.
 */
function foldLine(line, eol) {
  const nl = eol || '\r\n';
  const chars = Array.from(String(line));
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of chars) {
    const w = byteLength(ch);
    if (bytes + w > 75) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += w;
  }
  out.push(cur);
  return out.join(nl);
}

/* -------------------------------------------------------- physical lines */

/**
 * Splits into physical lines, each keeping the exact terminator it had, so
 * `parts.map(p => p.text + p.eol).join('')` reproduces the input byte for byte.
 */
function splitPhysical(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  let i = 0;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    if (nl < 0) { out.push({ text: src.slice(i), eol: '' }); break; }
    let end = nl;
    let eol = '\n';
    if (end > i && src[end - 1] === '\r') { end -= 1; eol = '\r\n'; }
    out.push({ text: src.slice(i, end), eol });
    i = nl + 1;
  }
  return out;
}

/** Groups physical lines into logical ones. A leading space or tab continues. */
function logicalLines(phys) {
  const groups = [];
  for (let i = 0; i < phys.length; i++) {
    const t = phys[i].text;
    if (groups.length && (t[0] === ' ' || t[0] === '\t')) {
      const g = groups[groups.length - 1];
      g.end = i;
      g.value += t.slice(1);
    } else {
      groups.push({ start: i, end: i, value: t });
    }
  }
  return groups;
}

function dominantEol(phys) {
  let crlf = 0;
  let lf = 0;
  for (const p of phys) {
    if (p.eol === '\r\n') crlf++;
    else if (p.eol === '\n') lf++;
  }
  return lf > crlf ? '\n' : '\r\n';        // iCalendar says CRLF; ties go to spec
}

/** Unfolds into logical line strings. Read path only. */
function unfold(text) {
  return logicalLines(splitPhysical(text)).map((g) => g.value);
}

/* ---------------------------------------------------------------- parsing */

/** `DUE;VALUE=DATE:20260820` → { name:'DUE', params:{VALUE:'DATE'}, value:'20260820' } */
function parseLine(line) {
  const src = String(line);
  let i = 0;
  let quote = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"') quote = !quote;
    else if (c === ':' && !quote) break;
  }
  if (i >= src.length) return { name: src.toUpperCase(), params: {}, value: '' };

  const head = src.slice(0, i);
  const value = src.slice(i + 1);
  const parts = splitParams(head);
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) { params[p.toUpperCase()] = ''; continue; }
    let v = p.slice(eq + 1);
    if (v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    params[p.slice(0, eq).toUpperCase()] = v;
  }
  return { name: parts[0].toUpperCase(), params, value };
}

/** Splits `NAME;A=1;B="x;y"` on unquoted semicolons. */
function splitParams(head) {
  const out = [];
  let cur = '';
  let quote = false;
  for (const c of String(head)) {
    if (c === '"') { quote = !quote; cur += c; continue; }
    if (c === ';' && !quote) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Property name of a logical line, without parsing the rest. */
function propName(line) {
  const s = String(line);
  const cut = s.search(/[;:]/);
  return (cut < 0 ? s : s.slice(0, cut)).trim().toUpperCase();
}

/**
 * `20260820` / `20260820T140000Z` / `20260820T140000` + TZID → { date, allDay }.
 *
 * A TZID'd value is read as **local wall-clock time**. Doing it properly needs a
 * tz database, which is exactly the kind of weight this vault refuses; on the
 * devices this runs on the zone is Europe/Berlin anyway, so the reading is
 * correct in practice and off by an hour at worst for a foreign-zone task.
 */
function parseIcsDate(value, params) {
  const v = String(value || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = hh === undefined || (params && String(params.VALUE).toUpperCase() === 'DATE');
  if (allDay) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)), allDay: false };
  return { date: new Date(+y, +mo - 1, +d, +hh, +mm, +ss), allDay: false };
}

const pad = (n, w) => String(n).padStart(w || 2, '0');

/** UTC form used for DTSTAMP / COMPLETED / LAST-MODIFIED. */
function icsStamp(d) {
  const t = d || new Date();
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`
    + `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}

/** Local date form used for an all-day DUE. */
function icsDay(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/* ------------------------------------------------------------ task model */

const COMPLETED_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

/**
 * Reads every VTODO in a calendar object into a model. `raw` is not kept here —
 * the caller holds the original text, because that is what writing edits.
 */
function parseTodos(icsText) {
  const lines = unfold(icsText);
  const todos = [];
  let cur = null;
  let depth = 0;

  for (const line of lines) {
    const { name, params, value } = parseLine(line);
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VTODO' && depth === 0) {
        cur = emptyTodo();
        depth = 1;
      } else if (cur) {
        depth++;                            // a VALARM inside; skip its properties
      }
      continue;
    }
    if (name === 'END') {
      if (!cur) continue;
      depth--;
      if (depth === 0) { todos.push(cur); cur = null; }
      continue;
    }
    if (!cur || depth !== 1) continue;
    applyProp(cur, name, params, value);
  }
  return todos;
}

function emptyTodo() {
  return {
    uid: '', summary: '', description: '', status: '', percent: null,
    due: null, priority: null, categories: [], sequence: 0,
    completedAt: null, recurrenceId: '', hasRrule: false,
  };
}

function applyProp(t, name, params, value) {
  switch (name) {
    case 'UID': t.uid = value.trim(); break;
    case 'SUMMARY': t.summary = unescapeText(value); break;
    case 'DESCRIPTION': t.description = unescapeText(value); break;
    case 'STATUS': t.status = value.trim().toUpperCase(); break;
    case 'PERCENT-COMPLETE': t.percent = parseInt(value, 10); break;
    case 'DUE': t.due = parseIcsDate(value, params); break;
    case 'PRIORITY': t.priority = parseInt(value, 10); break;
    case 'SEQUENCE': t.sequence = parseInt(value, 10) || 0; break;
    case 'COMPLETED': t.completedAt = parseIcsDate(value, params); break;
    case 'RECURRENCE-ID': t.recurrenceId = value.trim(); break;
    case 'RRULE': t.hasRrule = true; break;
    case 'CATEGORIES':
      t.categories = value.split(',').map((c) => unescapeText(c).trim()).filter(Boolean);
      break;
    default: break;
  }
}

/**
 * Three different clients express "done" three different ways, so all three
 * count. This is checked here rather than in a server-side prop-filter, where
 * getting it wrong silently hides tasks instead of showing a wrong one.
 */
function isDone(todo) {
  if (!todo) return false;
  if (COMPLETED_STATUSES.has(todo.status)) return true;
  if (todo.completedAt) return true;
  return todo.percent === 100;
}

/* -------------------------------------------------------------- creating */

function newUid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-a${rnd().slice(1)}-${rnd()}${rnd()}${rnd()}`;
}

/**
 * A fresh calendar object. `due` is a Date; it is written as an all-day DATE
 * value, which is what Apple Reminders renders as a plain day rather than a
 * time-of-day alarm.
 */
function buildTodo(opts) {
  const o = opts || {};
  const eol = o.eol || '\r\n';
  const now = o.now || new Date();
  const stamp = icsStamp(now);
  const uid = o.uid || newUid();

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `CREATED:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SUMMARY:${escapeText(o.summary || '')}`,
  ];
  if (o.description) lines.push(`DESCRIPTION:${escapeText(o.description)}`);
  if (o.due instanceof Date && !isNaN(o.due)) lines.push(`DUE;VALUE=DATE:${icsDay(o.due)}`);
  if (o.priority) lines.push(`PRIORITY:${parseInt(o.priority, 10)}`);
  lines.push('STATUS:NEEDS-ACTION', 'PERCENT-COMPLETE:0', 'END:VTODO', 'END:VCALENDAR');

  return { uid, ics: lines.map((l) => foldLine(l, eol)).join(eol) + eol };
}

/* ---------------------------------------------------- completing in place */

/** Physical-line range of the VTODO we should edit: the master, not an override. */
function findTodoBlock(logi) {
  const blocks = [];
  let start = -1;
  let depth = 0;
  for (let i = 0; i < logi.length; i++) {
    const { name, value } = parseLine(logi[i].value);
    if (name === 'BEGIN' && value.toUpperCase() === 'VTODO' && depth === 0) { start = i; depth = 1; continue; }
    if (start < 0) continue;
    if (name === 'BEGIN') depth++;
    else if (name === 'END') {
      depth--;
      if (depth === 0) { blocks.push({ from: start, to: i }); start = -1; }
    }
  }
  if (!blocks.length) return null;
  const isOverride = (b) => logi.slice(b.from, b.to + 1)
    .some((g) => propName(g.value) === 'RECURRENCE-ID');
  return blocks.find((b) => !isOverride(b)) || blocks[0];
}

/**
 * Ticks (or un-ticks) a task by rewriting only the properties that express
 * completion. Every other physical line — including ones we cannot parse — is
 * copied through byte for byte.
 *
 * Returns null when the object holds no VTODO, so the caller can refuse to PUT
 * rather than upload something it did not understand.
 */
function setCompletion(icsText, done, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const phys = splitPhysical(icsText);
  const logi = logicalLines(phys);
  const block = findTodoBlock(logi);
  if (!block) return null;

  const eol = dominantEol(phys);
  const stamp = icsStamp(now);

  let sequence = 0;
  for (let i = block.from; i <= block.to; i++) {
    if (propName(logi[i].value) === 'SEQUENCE') sequence = parseInt(parseLine(logi[i].value).value, 10) || 0;
  }

  // null means "remove this property if present, do not add it".
  const wanted = done
    ? {
      'STATUS': 'STATUS:COMPLETED',
      'COMPLETED': `COMPLETED:${stamp}`,
      'PERCENT-COMPLETE': 'PERCENT-COMPLETE:100',
      'LAST-MODIFIED': `LAST-MODIFIED:${stamp}`,
      'DTSTAMP': `DTSTAMP:${stamp}`,
      'SEQUENCE': `SEQUENCE:${sequence + 1}`,
    }
    : {
      'STATUS': 'STATUS:NEEDS-ACTION',
      'COMPLETED': null,
      'PERCENT-COMPLETE': 'PERCENT-COMPLETE:0',
      'LAST-MODIFIED': `LAST-MODIFIED:${stamp}`,
      'DTSTAMP': `DTSTAMP:${stamp}`,
      'SEQUENCE': `SEQUENCE:${sequence + 1}`,
    };

  // Which logical lines inside the block are ones we replace or drop.
  const handled = new Map();               // logical index → replacement | null
  const seen = new Set();
  for (let i = block.from; i <= block.to; i++) {
    const name = propName(logi[i].value);
    if (!Object.prototype.hasOwnProperty.call(wanted, name)) continue;
    if (seen.has(name)) { handled.set(i, null); continue; }   // duplicate: drop it
    seen.add(name);
    handled.set(i, wanted[name]);
  }

  const missing = Object.keys(wanted)
    .filter((n) => !seen.has(n) && wanted[n] !== null)
    .map((n) => wanted[n]);

  // Physical index at which the block's END:VTODO line starts — insertion point.
  const endPhys = logi[block.to].start;

  // Every physical line belonging to a handled property disappears; where the
  // property started, its single-line replacement takes its place. Property
  // order in the file is therefore preserved.
  const dropped = new Set();
  const replaceAt = new Map();
  for (const [li, replacement] of handled) {
    for (let p = logi[li].start; p <= logi[li].end; p++) dropped.add(p);
    if (replacement !== null) replaceAt.set(logi[li].start, replacement);
  }

  const out = [];
  for (let p = 0; p < phys.length; p++) {
    if (p === endPhys) {
      for (const line of missing) out.push({ text: foldLine(line, eol), eol });
    }
    if (replaceAt.has(p)) {
      out.push({ text: foldLine(replaceAt.get(p), eol), eol: phys[p].eol || eol });
      continue;
    }
    if (dropped.has(p)) continue;
    out.push(phys[p]);                       // untouched line: the original object
  }

  return out.map((p) => p.text + p.eol).join('');
}

export {
  PRODID,
  escapeText,
  unescapeText,
  byteLength,
  foldLine,
  unfold,
  splitPhysical,
  logicalLines,
  dominantEol,
  parseLine,
  propName,
  parseIcsDate,
  icsStamp,
  icsDay,
  parseTodos,
  isDone,
  newUid,
  buildTodo,
  setCompletion,
  findTodoBlock,
};
