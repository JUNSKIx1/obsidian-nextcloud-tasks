#!/usr/bin/env node
/*
 * Opt-in smoke test against a real Nextcloud. Nothing else in this repo talks to
 * the network; this is the one place, and it only runs when you hand it
 * credentials in the environment.
 *
 *   NC_URL=https://cloud.example.com NC_USER=alice NC_APP_PASSWORD=xxxxx-xxxxx \
 *     node scripts/live-check.mjs
 *
 * Options (environment):
 *   NC_URL    Nextcloud base address (required)
 *   NC_USER   username (required)
 *   NC_APP_PASSWORD  app password, never the account password (required)
 *   NC_LIST   display name of the list to use, default the first VTODO list
 *   NC_KEEP   set to 1 to leave the test task behind instead of deleting it
 *
 * The app password is read from the environment on purpose: it must never end
 * up in a file.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 * It proves the *server* answers PROPFIND, REPORT, PUT and MKCALENDAR, and that
 * our request bodies are ones it accepts. It says nothing about whether
 * Obsidian's requestUrl carries those verbs on the desktop or on a phone: node's
 * fetch is a different HTTP stack. That question is answered by the in-app
 * command "Test connection", which has to be run on each device.
 */

import process from 'node:process';

import { CalDav } from '../src/caldav.js';
import * as ics from '../src/ics.js';

const BASE = process.env.NC_URL || '';
const USER = process.env.NC_USER || '';
const PASS = process.env.NC_APP_PASSWORD || '';
const WANT_LIST = process.env.NC_LIST || '';
const KEEP = process.env.NC_KEEP === '1';

if (!BASE || !USER || !PASS) {
  console.error('✗ NC_URL, NC_USER and NC_APP_PASSWORD must all be set.\n');
  console.error('  Create an app password: Nextcloud → Settings → Security.');
  console.error('  Example:\n    NC_URL=https://cloud.example.com NC_USER=alice \\');
  console.error('      NC_APP_PASSWORD=… node scripts/live-check.mjs\n');
  process.exit(2);
}

/** requestUrl-shaped adapter over node's fetch. */
const request = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body, redirect: 'follow' });
  const text = await res.text();
  const out = {};
  res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return { status: res.status, text, headers: out };
};

let pass = 0;
let fail = 0;
const check = (ok, msg, extra) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${extra ? ` — ${extra}` : ''}`);
};

(async () => {
  console.log(`\nnextcloud-tasks live check against ${BASE} as ${USER}\n`);

  const dav = new CalDav({
    baseUrl: BASE,
    username: USER,
    password: PASS,
    request,
    log: (m) => console.log(`    · ${m}`),
  });

  console.log('  Discovery');
  const d = await dav.discover();
  check(!!d.principal, 'current-user-principal', d.principal);
  check(!!d.home, 'calendar-home-set', d.home);
  check(d.lists.length > 0, `${d.lists.length} VTODO list(s)`,
    d.lists.map((l) => l.displayName).join(', '));
  if (!d.lists.length) {
    console.log('\n  No task list on this account. In Obsidian: Settings → Nextcloud Tasks →');
    console.log('  "Create list". Then run this check again.\n');
    process.exit(1);
  }

  const list = WANT_LIST
    ? d.lists.find((l) => l.displayName === WANT_LIST)
    : d.lists[0];
  if (!list) {
    console.error(`\n✗ list "${WANT_LIST}" not found.\n`);
    process.exit(1);
  }
  console.log(`\n  List: ${list.displayName}  (${list.url})\n`);

  console.log('  Reading');
  const before = await dav.listTasks(list.url);
  check(Array.isArray(before), `${before.length} task(s) read`,
    dav.reportUnsupported ? 'via the PROPFIND fallback' : 'via REPORT');
  check(!dav.reportUnsupported, 'the server supports REPORT',
    dav.reportUnsupported ? 'the fallback was needed' : '');

  const title = `live-check ${new Date().toISOString().slice(0, 19)}`;
  console.log('\n  Creating');
  const created = await dav.createTask(list.url, {
    summary: title,
    due: new Date(Date.now() + 86400000),
    priority: 5,
  });
  check(!!created.uid, 'PUT accepted', created.url);

  const afterCreate = await dav.listTasks(list.url);
  const mine = afterCreate.find((e) => e.todo.uid === created.uid);
  check(!!mine, 'the task reads back');
  if (mine) {
    check(mine.todo.summary === title, 'the title is unchanged', mine.todo.summary);
    check(!!mine.todo.due && mine.todo.due.allDay, 'the due date is stored as an all-day date');
    check(mine.done === false, 'it is open');
  }

  console.log('\n  Completing');
  if (mine) {
    await dav.setDone(mine.url, true);
    const afterDone = await dav.listTasks(list.url);
    const done = afterDone.find((e) => e.todo.uid === created.uid);
    check(!!done && done.done, 'reads back as completed');
    check(!!done && done.todo.summary === title, 'the title survived the edit');

    await dav.setDone(mine.url, false);
    const reopened = (await dav.listTasks(list.url)).find((e) => e.todo.uid === created.uid);
    check(!!reopened && !reopened.done, 'set back to open');
  }

  console.log('\n  Cleaning up');
  if (KEEP) {
    console.log(`  ~ NC_KEEP=1: "${title}" stays in ${list.displayName}.`);
  } else if (mine) {
    await dav.deleteTask(mine.url);
    const afterDelete = await dav.listTasks(list.url);
    check(!afterDelete.some((e) => e.todo.uid === created.uid), 'the test task is gone again');
    check(afterDelete.length === before.length, 'the list is back to what it was',
      `${before.length} → ${afterDelete.length}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('\nNote: this checks the server. Whether Obsidian lets the same HTTP methods');
  console.log('through is only shown by the "Test connection" command, on each device.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`\n✗ aborted: ${e && e.message ? e.message : e}`);
  if (e && e.status) console.error(`  HTTP ${e.status} on ${e.method} ${e.url}`);
  console.error('');
  process.exit(1);
});
