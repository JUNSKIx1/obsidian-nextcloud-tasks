/*
 * The settings model, kept free of `obsidian` imports so the plain-node tests
 * can exercise it directly.
 *
 * A list entry is:
 *
 *   { url, key, label, color, enabled, missing }
 *
 *   url      the CalDAV collection, the only field the network cares about
 *   key      what a code block writes: ```nextcloud-tasks / list: <key>
 *   label    the group heading, free text, emoji welcome
 *   color    the accent, '#rrggbb' or ''
 *   enabled  ticked in the settings; an unticked list is never fetched
 *   missing  set when the last discovery did not return it, so a server hiccup
 *            greys the row out instead of silently dropping the group
 *
 * The array's order is the order the groups render in. There is no fixed number
 * of lists and no meaning attached to any particular key.
 */

const DEFAULTS = {
  baseUrl: '',
  username: '',
  password: '',
  lists: [],
  language: 'auto',
  refreshMinutes: 5,
  staleSeconds: 60,
};

/** Accents for lists whose server sends no calendar-color. Muted on purpose. */
const PALETTE = ['#6f9553', '#c07a34', '#4a7699', '#8a5fa8', '#3f8f86', '#b05f6b', '#7d7f8c'];

/** A key is what a note types, so keep it to what is easy to type. */
function slugify(name) {
  return String(name || '').toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `slugify` plus "not one of these already". */
function uniqueKey(name, taken, fallback) {
  const base = slugify(name) || slugify(fallback) || 'list';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Last path segment of a collection URL, decoded. */
function lastSegment(url) {
  const parts = String(url || '').split(/[?#]/)[0].split('/').filter(Boolean);
  const seg = parts.length ? parts[parts.length - 1] : '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function titleCase(s) {
  const clean = String(s || '').replace(/[-_]+/g, ' ').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : '';
}

function entryFrom(url, opts, index, taken) {
  const o = opts || {};
  const fallbackName = lastSegment(url);
  const label = o.label || titleCase(fallbackName) || 'List';
  const key = o.key && !taken.has(o.key) ? o.key : uniqueKey(o.key || label, taken, fallbackName);
  taken.add(key);
  return {
    url: String(url || ''),
    key,
    label,
    color: o.color || PALETTE[index % PALETTE.length],
    enabled: o.enabled !== false,
    missing: false,
  };
}

/**
 * Accepts whatever `loadData()` returned, including nothing, and returns a
 * complete settings object.
 *
 * The one migration that matters: versions before this one stored
 * `lists: { personal: url, studium: url, work: url }` — a fixed three-way split
 * baked into the code. Those become three ordinary entries whose keys are the
 * old object keys, so an existing note saying `os: studium` keeps resolving to
 * the same list. Nothing else about a vault is assumed anywhere.
 */
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = Object.assign({}, DEFAULTS, src);
  const taken = new Set();
  const lists = [];

  if (Array.isArray(src.lists)) {
    src.lists.forEach((l, i) => {
      if (!l || !l.url) return;
      lists.push(entryFrom(l.url, {
        key: typeof l.key === 'string' && l.key ? slugify(l.key) : '',
        label: l.label,
        color: l.color,
        enabled: l.enabled !== false,
      }, i, taken));
    });
  } else if (src.lists && typeof src.lists === 'object') {
    Object.keys(src.lists).forEach((legacyKey, i) => {
      const url = src.lists[legacyKey];
      if (!url) return;                       // an unassigned slot is not a list
      lists.push(entryFrom(url, {
        key: slugify(legacyKey),
        label: titleCase(legacyKey),
        enabled: true,
      }, i, taken));
    });
  }

  out.lists = lists;
  out.language = ['auto', 'en', 'de'].includes(out.language) ? out.language : 'auto';
  // 0 is a real value here: it means "do not fetch on a timer at all".
  out.refreshMinutes = Number.isFinite(out.refreshMinutes)
    && out.refreshMinutes >= 0 && out.refreshMinutes <= 1440 ? out.refreshMinutes : 5;
  out.staleSeconds = Number.isFinite(out.staleSeconds) && out.staleSeconds > 0 ? out.staleSeconds : 60;
  out.baseUrl = String(out.baseUrl || '');
  out.username = String(out.username || '');
  out.password = String(out.password || '');
  return out;
}

const sameUrl = (a, b) => String(a || '').replace(/\/?$/, '/') === String(b || '').replace(/\/?$/, '/');

/**
 * Folds a fresh discovery into the configured list array.
 *
 * Kept, never overwritten: the user's key, label, colour, tick and order.
 * Updated: whether the server still has it. Added at the end: lists that are
 * new to us — ticked on a first run, so a new install shows tasks immediately,
 * and unticked afterwards, so a calendar appearing on the server later does not
 * quietly rearrange someone's note.
 */
function mergeDiscovered(configured, discovered, firstRun) {
  const found = Array.isArray(discovered) ? discovered : [];
  const taken = new Set((configured || []).map((l) => l.key));
  const out = (configured || []).map((l) => {
    const hit = found.find((d) => sameUrl(d.url, l.url));
    return Object.assign({}, l, { missing: !hit, url: hit ? hit.url : l.url });
  });

  found.forEach((d, i) => {
    if (out.some((l) => sameUrl(l.url, d.url))) return;
    out.push(entryFrom(d.url, {
      label: d.displayName,
      color: d.color,
      enabled: !!firstRun,
    }, out.length + i, taken));
  });
  return out;
}

/** The lists actually fetched: ticked, and with somewhere to fetch from. */
function enabledLists(settings) {
  return ((settings && settings.lists) || []).filter((l) => l.enabled && l.url);
}

export {
  DEFAULTS,
  PALETTE,
  slugify,
  uniqueKey,
  lastSegment,
  titleCase,
  normalizeSettings,
  mergeDiscovered,
  enabledLists,
  sameUrl,
};
