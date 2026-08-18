# Nextcloud Tasks for Obsidian

Read, create, edit and complete your **Nextcloud Tasks** inside a note, over CalDAV.

Your tasks stay on your server. This plugin does not copy them into your vault, does not write
checkboxes into your notes, and does not keep a cache file that can drift out of sync. It fetches
what is there, shows it, and writes your changes straight back.

That is the difference from the other CalDAV plugins in the directory: they sync markdown checkboxes
in your notes to a server, so there are two copies of every task. Here there is one copy, and it is
the one in Nextcloud.

It is plain JavaScript with no dependencies and no native code, so the same build runs on the
desktop app and on a phone.

```mermaid
flowchart LR
  subgraph vault["Your vault"]
    B["A nextcloud-tasks code block<br/>in any note"]
    S["Plugin settings<br/>server, username, app password,<br/>which lists to show"]
  end

  subgraph mem["The plugin, in memory only"]
    M["This session's task list<br/>no cache file<br/>no checkboxes written to notes"]
  end

  subgraph nc["Your Nextcloud"]
    L1["List: Errands"]
    L2["List: Work"]
    L3["List: whatever you tick"]
  end

  B --> M
  S --> M
  M -- "PROPFIND, REPORT<br/>on open and on a timer" --> nc
  nc -- "the tasks themselves" --> M
  M -- "tick, add, edit, delete<br/>PUT and DELETE, straight away" --> nc
```

## Any lists, any names

There is no fixed set of categories and no folder convention. You load your task lists from the
server, tick the ones you want, and give each one a heading, a colour and a short key. The key is
what a note refers to. Two lists or nine, in whatever order you drag them into, is all the same to
the plugin.

## Install

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/JUNSKIx1/obsidian-nextcloud-tasks/releases/latest) into
`<vault>/.obsidian/plugins/nextcloud-tasks/`, then enable it in Settings, Community plugins.

## Setup

1. In Nextcloud, go to Settings, Security, and create an **app password**. Use that, never your
   account password. It can be revoked on its own, and it is the only credential this plugin stores.
2. In Obsidian, open Settings, Nextcloud Tasks, and fill in the address (`https://cloud.example.com`,
   the base only, without `/remote.php/dav`), your username and the app password.
3. Press **Load**. Every task list on your account appears. Tick the ones you want, rename the
   headings, pick colours, and drag them into the order you want them grouped in.
4. Set **Refresh automatically** to how often the plugin should look for tasks you added or ticked
   somewhere else. Five minutes by default, and **Never** if you would rather fetch by hand. It only
   runs while a task list is actually on screen, so it costs nothing while you write.
5. Press **Test connection** if something does not work. It reports every step on its own, so a
   failure points at one line rather than at "could not connect".

Do not have a task list yet? **Create list** makes one on the server without leaving Obsidian.

## Showing tasks in a note

Put a fenced block in any note:

````markdown
```nextcloud-tasks
all
preview: 3
```
````

Every list you ticked gets its own heading, even when there is nothing in it, and shows its first
two tasks. If it has more, the heading grows an arrow and the number it is holding back — press it
to unfold that list, press it again to fold it away.

Each list ends in a **blank row**: type a title, press Enter, and the task is on the server. The two
small buttons on the right of that row set a due date and a priority for it first; Escape clears the
row. Nothing you type is lost to a background refresh.

Every line is optional:

| Line | What it does |
| --- | --- |
| `all` (or an empty block) | every list you ticked, grouped by list. This is the default. |
| `list: errands` | one list only, by its key |
| `os: errands` | the same thing, kept working for notes written against older versions |
| `preview: 3` | rows shown per list before the **+n more** line. `preview: 0` shows every task |
| `limit: 8` | show at most this many rows **in total**. A hard ceiling, applied before the lists are split up, so a busy list can use it all up — `preview` is usually what you want |
| `due: today` | only what is due today. **Overdue is always included**, or it would vanish silently |
| `due: week` | only what is due within seven days, overdue included |
| `done: true` | show completed tasks as well |
| `title: Shopping` | your own heading for the panel |

`due: heute`, `due: woche` and `done: ja` are accepted too, so a note keeps its meaning if you
switch Obsidian's language.

Rows sort the way you would triage them: overdue first, then by due date, undated last, and a tie
falls back to the order you put your lists in.

The panel header carries three icons: **new task**, **new list** (in a block showing every list) and
**refresh**.

## Working with a task

- **Tick the box** to complete it. It is written to the server straight away, and the row stays on
  screen with a line through it until you leave the note, so you can see what you did and undo it if
  you hit the wrong one.
- **Click the title** to edit it: title, due date and priority, in the same dialog that creates one.
  Only what you actually changed is written, so a repeat, a reminder, a description or a subtask that
  the plugin does not show is not touched. A task moves to another list in Nextcloud, not here.
- **Delete** is in that dialog too, behind one confirmation.

## Commands

| Command | What it does |
| --- | --- |
| **New task** | a small dialog: title, list, due date, priority |
| **Refresh tasks** | fetches now, instead of waiting for the timer |
| **Test connection** | walks discovery step by step and shows what each one answered |

The plugin fetches when Obsidian starts, on the interval you set, when a block renders with data
older than a minute, when you run the command, and after you write something. It never fetches while
no task list is on screen or while the app is in the background.

## Your phone

The same lists work in your phone's built-in reminders app: add a CalDAV account with the same
address, username and app password. You get notifications and widgets without Obsidian running, and
anything you tick there shows up here on the next refresh. The plugin itself also runs on the mobile
app if you would rather use it directly.

## Languages

English and German, following Obsidian's own language setting. You can also force one of them in the
plugin settings.

## Development

```bash
npm install
npm run lint          # eslint-plugin-obsidianmd, the same rules the directory review runs
npm test              # core, render and bundle suites: no install, no network, no credentials
npm run build         # bundles src/ into main.js
```

Deploy a local build into a vault:

```bash
VAULT="/path/to/your/vault" bash scripts/deploy-to-vault.sh
```

Against a real server, only with credentials in the environment and never in a file:

```bash
NC_URL=https://cloud.example.com NC_USER=alice NC_APP_PASSWORD=xxxxx-xxxxx \
  node scripts/live-check.mjs
```

It creates, reads, completes and deletes one test task. It proves the *server* speaks CalDAV. It
says nothing about whether Obsidian passes the verbs on your device, which is what **Test
connection** is for.

`main.js` is generated. Edit `src/`, never the bundle.

## Design notes

Things that look like details and are not:

- **Nothing is written to disk, not even as a cache.** The fetched list lives in memory for the
  session. That is what makes "your tasks live in Nextcloud" literally true, and it is why there is
  no file that can go stale.
- **Completing or editing a task rewrites the original calendar object line by line** and copies
  every other byte through. Regenerating it from a parsed model would silently drop `RRULE`,
  `VALARM`, `CATEGORIES`, `RELATED-TO` and every `X-` property other clients wrote. The test asserts
  byte identity of untouched lines, for both writers.
- **An edit sends only the fields you changed.** Leaving the date field alone is different from
  clearing it: the first never mentions `DUE` at all, so a task due at a particular time of day keeps
  that time when you fix a typo in its title. The second removes the line.
- **Completion is judged in the client**, because three clients express it three ways: `STATUS`,
  a bare `COMPLETED:` property, or `PERCENT-COMPLETE:100`. A server-side filter that gets this
  wrong hides tasks, which is worse than showing one too many.
- **Priority follows RFC 5545, where 1 is the most urgent and 0 means unset**: 1–4 shows as high,
  5 as medium, 6–9 as low, and every one of them gets a coloured flag. Marking only the top band is
  what made an earlier version look broken — the level was written to the server correctly and then
  displayed as nothing at all.
- **Discovery walks the real chain**, `current-user-principal` to `calendar-home-set` to the
  collections in it, instead of guessing `/remote.php/dav/calendars/<user>/`. Fifteen lines, and one
  whole class of username casing bug disappears.
- **XML is read without caring about namespace prefixes.** Nextcloud's `d:` and `cal:` are not
  contractual.
- **If `REPORT` is refused**, the client falls back to `PROPFIND` plus one `GET` per object and
  remembers that for the session, so a platform that blocks the verb still works.
- **Everything goes through `requestUrl`**, which bypasses CORS and works on iOS.

## License

MIT. See [LICENSE](LICENSE).
