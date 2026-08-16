#!/usr/bin/env node
/*
 * Smoke-tests the built bundle, not the loose sources.
 *
 *   npm run build && node tests/bundle-test.mjs
 *
 * The other suites import src/*.js directly, so they would still pass if the
 * bundle were broken. This loads main.js exactly as Obsidian does, with a
 * stubbed `obsidian` module, and drives a whole fake CalDAV round trip through
 * the plugin object itself: settings migration, discovery, REPORT, parsing,
 * completion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '..', 'main.js');

if (!fs.existsSync(MAIN)) {
  console.error(`✗ ${MAIN} is missing. Run "npm run build" first.`);
  process.exit(1);
}

/* ---------------------------------------------------- the obsidian stub */

const registered = { commands: [], codeBlocks: [], settingTabs: [], intervals: [] };
let saveDataCalls = 0;
let loadDataReturns = {};

class FakePlugin {
  constructor(app) { this.app = app; }
  addCommand(c) { registered.commands.push(c); }
  addSettingTab(tab) { registered.settingTabs.push(tab); }
  registerMarkdownCodeBlockProcessor(lang, fn) { registered.codeBlocks.push({ lang, fn }); }
  registerInterval(id) { registered.intervals.push(id); return id; }
  async loadData() { return loadDataReturns; }
  async saveData() { saveDataCalls += 1; }
}

const chainable = () => new Proxy(function stub() {}, {
  get: (target, prop) => {
    if (prop === 'inputEl' || prop === 'controlEl' || prop === 'containerEl') return chainable();
    return () => chainable();
  },
  apply: () => chainable(),
});

class FakeSetting {
  setName() { return this; }
  setDesc() { return this; }
  setClass() { return this; }
  setHeading() { return this; }
  setTooltip() { return this; }
  addText(cb) { if (cb) cb(chainable()); return this; }
  addToggle(cb) { if (cb) cb(chainable()); return this; }
  addButton(cb) { if (cb) cb(chainable()); return this; }
  addDropdown(cb) { if (cb) cb(chainable()); return this; }
  addColorPicker(cb) { if (cb) cb(chainable()); return this; }
  addExtraButton(cb) { if (cb) cb(chainable()); return this; }
  then(cb) { if (cb) cb(this); return this; }
}

let networkCalls = [];
let route = async () => ({ status: 404, headers: {}, text: '' });

/*
 * Obsidian runs in a browser; node does not have these. The timers hand out
 * ids without ever scheduling anything: what is under test is that the plugin
 * registers an interval and hands it to Obsidian for cleanup, not that node
 * would eventually fire it. A real setInterval here would also keep this
 * process alive forever.
 */
let nextTimerId = 1;
globalThis.window = {
  setInterval: () => nextTimerId++,
  clearInterval: () => {},
};
globalThis.document = { hidden: false };

const obsidianStub = {
  Plugin: FakePlugin,
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: FakeSetting,
  Modal: class {
    constructor(app) { this.app = app; this.contentEl = fakeEl(); }
    setTitle() {}
    open() { if (this.onOpen) this.onOpen(); }
    close() {}
  },
  Notice: class { hide() {} },
  MarkdownRenderChild: class { constructor(el) { this.containerEl = el; } },
  requestUrl: async (req) => { networkCalls.push(req); return route(req); },
  getLanguage: () => 'en',
  normalizePath: (p) => String(p).replace(/\/+/g, '/'),
};

/**
 * This is how Obsidian loads a plugin: it evaluates main.js as CommonJS with a
 * `require` that only knows about its own API. Anything else the bundle tries
 * to require throws here, which is exactly the failure worth catching — this
 * plugin must ship with no dependencies at all.
 */
function loadBundle() {
  const mod = { exports: {} };
  const fakeRequire = (id) => {
    if (id === 'obsidian') return obsidianStub;
    throw new Error(`the bundle tried to require('${id}') at runtime`);
  };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', fs.readFileSync(MAIN, 'utf8'))(mod.exports, mod, fakeRequire);
  return mod.exports;
}

/* ------------------------------------------------------------- harness */

let pass = 0;
let fail = 0;
const check = (cond, msg, extra) => {
  if (cond) pass += 1; else fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${!cond && extra ? ` — ${extra}` : ''}`);
};

const CRLF = '\r\n';
const ical = (...l) => l.join(CRLF) + CRLF;
const MS = (inner) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`;

const BASE = 'https://cloud.example.com';
const LIST_URL = `${BASE}/remote.php/dav/calendars/alice/errands/`;

const TASK = ical('BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:bundle-1',
  'SUMMARY:Through the bundle', 'STATUS:NEEDS-ACTION', 'X-KEEP-ME:yes', 'END:VTODO', 'END:VCALENDAR');

let stored = TASK;

function server(req) {
  if (req.method === 'PROPFIND' && req.url.endsWith('/remote.php/dav/')) {
    return { status: 207, headers: {}, text: MS('<d:response><d:href>/remote.php/dav/</d:href><d:propstat><d:prop>'
      + '<d:current-user-principal><d:href>/remote.php/dav/principals/users/alice/</d:href></d:current-user-principal>'
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>') };
  }
  if (req.method === 'PROPFIND' && req.url.includes('/principals/')) {
    return { status: 207, headers: {}, text: MS('<d:response><d:href>/remote.php/dav/principals/users/alice/</d:href>'
      + '<d:propstat><d:prop><c:calendar-home-set><d:href>/remote.php/dav/calendars/alice/</d:href></c:calendar-home-set>'
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>') };
  }
  if (req.method === 'PROPFIND') {
    return { status: 207, headers: {}, text: MS('<d:response><d:href>/remote.php/dav/calendars/alice/errands/</d:href>'
      + '<d:propstat><d:prop><d:displayname>Errands</d:displayname>'
      + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
      + '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>'
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>') };
  }
  if (req.method === 'REPORT') {
    return { status: 207, headers: {}, text: MS('<d:response>'
      + '<d:href>/remote.php/dav/calendars/alice/errands/bundle-1.ics</d:href><d:propstat><d:prop>'
      + `<d:getetag>"e1"</d:getetag><c:calendar-data><![CDATA[${stored}]]></c:calendar-data>`
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>') };
  }
  if (req.method === 'GET') return { status: 200, headers: { etag: '"e1"' }, text: stored };
  if (req.method === 'PUT') { stored = req.body; return { status: 204, headers: { etag: '"e2"' } }; }
  return { status: 404, headers: {}, text: '' };
}

const app = { workspace: { onLayoutReady() {} } };

(async () => {
  console.log('\nloading the built bundle as Obsidian would\n');

  const mod = loadBundle();
  const PluginClass = mod && mod.default ? mod.default : mod;
  check(typeof PluginClass === 'function', 'main.js exports a plugin class');

  /* ---- loads clean, with nothing configured ---- */
  {
    loadDataReturns = {};
    const plugin = new PluginClass(app);
    await plugin.onload();

    const names = registered.commands.map((c) => c.name).sort();
    check(names.length === 3, 'three commands registered', names.join(' · '));
    check(names.includes('New task') && names.includes('Refresh tasks') && names.includes('Test connection'),
      'commands are the documented three', names.join(' · '));
    check(registered.commands.every((c) => !/^nextcloud-tasks/.test(c.id)),
      'command ids do not repeat the plugin id', registered.commands.map((c) => c.id).join(','));
    check(registered.codeBlocks.some((c) => c.lang === 'nextcloud-tasks'),
      'code block processor registered under nextcloud-tasks',
      registered.codeBlocks.map((c) => c.lang).join(','));
    check(registered.settingTabs.length === 1, 'one settings tab registered');
    check(plugin.configured === false, 'starts unconfigured, so nothing hits the network');
    check(plugin.entries.length === 0 && plugin.fetchedAt === null,
      'no task data exists before a refresh — nothing is cached on disk');
    check(networkCalls.length === 0, 'loading the plugin makes no requests at all');

    // The settings tab is what a user actually opens; building it must not throw.
    const tab = registered.settingTabs[0];
    tab.containerEl = fakeEl();
    tab.display();
    check(true, 'the settings tab renders with no lists configured');
  }

  /* ---- the old three-way settings shape migrates on load ---- */
  {
    registered.commands.length = 0;
    loadDataReturns = {
      baseUrl: BASE,
      username: 'alice',
      password: 'pw',
      lists: { personal: `${BASE}/x/personal/`, studium: `${BASE}/x/studium/`, work: '' },
    };
    const plugin = new PluginClass(app);
    await plugin.onload();
    const keys = plugin.settings.lists.map((l) => l.key);
    check(keys.length === 2, 'the legacy list object became two entries', JSON.stringify(keys));
    check(keys[0] === 'personal' && keys[1] === 'studium',
      'the legacy keys survive, so `os: studium` in a note still resolves', JSON.stringify(keys));
    check(plugin.configured === true, 'a migrated install is configured right away');
  }

  /* ---- a full round trip through the bundled client ---- */
  {
    registered.commands.length = 0;
    networkCalls = [];
    route = server;
    saveDataCalls = 0;
    loadDataReturns = {
      baseUrl: BASE,
      username: 'alice',
      password: 'pw',
      lists: [{ url: LIST_URL, key: 'errands', label: 'Errands', color: '#4a7699', enabled: true }],
    };
    const plugin = new PluginClass(app);
    await plugin.onload();

    await plugin.refresh(false);
    check(plugin.entries.length === 1, 'REPORT and ics parsing work through the bundle',
      JSON.stringify(plugin.entries.length));
    check(plugin.entries[0].todo.summary === 'Through the bundle', 'the task text came through');
    check(plugin.entries[0].listKey === 'errands', 'every row is tagged with the list it came from');
    check(plugin.fetchedAt instanceof Date, 'the fetch time is remembered, in memory');
    check(saveDataCalls === 0, 'a refresh writes nothing to disk');

    const entry = plugin.entries[0];
    await plugin.toggle(entry, true, () => {});
    const put = networkCalls.filter((c) => c.method === 'PUT').pop();
    check(!!put && put.headers['If-Match'] === '"e1"', 'completion PUTs with If-Match');
    check(/STATUS:COMPLETED/.test(stored), 'completion was written through the bundle');
    check(stored.includes('X-KEEP-ME:yes'), 'an unknown property survived the bundled edit');
    check(saveDataCalls === 0, 'ticking a task still writes nothing to disk');
    check(plugin.stickyDone.has(entry.url),
      'a ticked task is remembered so it does not vanish from under the cursor');

    // The edit path, end to end through the bundle. This is the one that would
    // quietly destroy data if setFields were ever rewritten carelessly.
    await plugin.client().updateTask(entry.url, { summary: 'Renamed through the bundle' });
    check(/SUMMARY:Renamed through the bundle/.test(stored), 'an edited title reached the server');
    check(stored.includes('X-KEEP-ME:yes'), 'the unknown property survived the edit as well');
    check(/STATUS:COMPLETED/.test(stored), 'editing the title did not undo the completion');
  }

  /* ---- the refresh timer ---- */
  {
    registered.commands.length = 0;
    registered.intervals.length = 0;
    loadDataReturns = {
      baseUrl: BASE,
      username: 'alice',
      password: 'pw',
      refreshMinutes: 5,
      lists: [{ url: LIST_URL, key: 'errands', label: 'Errands', enabled: true }],
    };
    const plugin = new PluginClass(app);
    await plugin.onload();
    check(registered.intervals.length === 1, 'a refresh interval is registered for cleanup',
      String(registered.intervals.length));
    check(plugin.timer !== null, 'and the plugin holds it');
    window.clearInterval(plugin.timer);

    registered.intervals.length = 0;
    loadDataReturns = Object.assign({}, loadDataReturns, { refreshMinutes: 0 });
    const off = new PluginClass(app);
    await off.onload();
    check(registered.intervals.length === 0 && off.timer === null,
      'zero minutes really means no timer at all');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e); process.exit(1); });

/** The few DOM helpers Obsidian adds and the settings tab actually calls. */
function fakeEl() {
  const el = {
    empty() {},
    addClass() {},
    createDiv() { return fakeEl(); },
    createEl() { return fakeEl(); },
    createSpan() { return fakeEl(); },
    appendText() {},
    setText() {},
    setAttribute() {},
    addEventListener() {},
  };
  return el;
}
