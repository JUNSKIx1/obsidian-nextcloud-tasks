/*
 * Translations.
 *
 * Two flat tables and a `t()`. English is the source of truth: every key exists
 * in EN, and a missing German key falls back to the English string rather than
 * printing the key, because a visible English word is a smaller failure than a
 * visible `panel.empty`.
 *
 * Deliberately not translated: what the code block *accepts* as input. `due:
 * heute` keeps working when the UI is English, and `due: today` keeps working
 * when it is German, because a note is not re-read every time someone changes
 * an app setting.
 */

const EN = {
  'cmd.new': 'New task',
  'cmd.refresh': 'Refresh tasks',
  'cmd.probe': 'Test connection',

  'panel.title': 'Open tasks',
  'panel.add': 'New task',
  'panel.newList': 'New list',
  'panel.refresh': 'Reload tasks',
  'panel.loading': 'Loading…',
  'panel.empty': 'Nothing open. 🎉',
  'panel.unconfigured': 'Not connected yet. Enter your server, username and app password '
    + 'in the plugin settings under "Nextcloud Tasks", then pick the lists you want to see.',
  'panel.error': 'Tasks unavailable. ',
  'panel.stale': 'Offline, last updated {time}',
  'panel.unknownList': 'Unknown list "{key}". Check the key in the plugin settings.',

  'group.other': 'Other',
  'group.empty': 'Nothing open',
  'group.more': '+{n} more',
  'group.less': 'Show less',
  'row.untitled': '(untitled)',
  'row.task': 'Task',
  'row.edit': 'Edit {title}',
  'row.new': 'New task…',
  'row.newAdd': 'Type a title and press Enter',
  'row.newDue': 'Due date',
  'row.newPriority': 'Priority',

  'due.yesterday': 'yesterday',
  'due.overdue': '{n} days overdue',
  'due.today': 'today',
  'due.tomorrow': 'tomorrow',
  'due.inDays': 'in {n} days',

  'modal.new.title': 'New task',
  'modal.edit.title': 'Edit task',
  'modal.new.summary': 'Title',
  'modal.new.summaryPlaceholder': 'What needs doing?',
  'modal.new.list': 'List',
  'modal.new.listFixed': 'A task is moved to another list in Nextcloud, not here.',
  'modal.new.due': 'Due',
  'modal.new.dueDesc': 'Optional. Stored as an all-day date, which is how Reminders and the '
    + 'Tasks web app expect it.',
  'modal.new.priority': 'Priority',
  'prio.none': 'none',
  'prio.high': 'high',
  'prio.medium': 'medium',
  'prio.low': 'low',

  'modal.probe.title': 'Connection to Nextcloud',
  'modal.probe.hint': 'PROPFIND, REPORT and MKCALENDAR are not ordinary HTTP methods. This test '
    + 'shows which of them get through on this device, so run it once on the desktop and once '
    + 'on your phone.',
  'modal.probe.none': 'No result.',

  'modal.newList.title': 'New task list',
  'modal.newList.name': 'Name',
  'modal.newList.namePlaceholder': 'e.g. Errands',
  'modal.newList.color': 'Color',

  'modal.confirmDelete.title': 'Delete task?',
  'modal.confirmDelete.body': '"{title}" will be deleted in Nextcloud. This cannot be undone here.',

  'btn.cancel': 'Cancel',
  'btn.create': 'Create',
  'btn.save': 'Save',
  'btn.delete': 'Delete',
  'btn.close': 'Close',
  'btn.test': 'Test',
  'btn.load': 'Load',
  'btn.up': 'Move up',
  'btn.down': 'Move down',

  'set.connection': 'Connection',
  'set.server': 'Nextcloud address',
  'set.serverDesc': 'The base address only, without /remote.php/dav.',
  'set.username': 'Username',
  'set.password': 'App password',
  'set.passwordDesc': 'Nextcloud → Settings → Security → Create new app password. Not your account '
    + 'password, and never written into a note.',
  'set.test': 'Test connection',
  'set.testDesc': 'Shows every step on its own, so it is clear where it breaks.',

  'set.lists': 'Task lists',
  'set.listsNotLoaded': 'Not loaded yet. "Load" fetches your task lists from the server.',
  'set.listsFound': '{n} task list(s) on the server. Tick the ones you want in your notes.',
  'set.load': 'Task lists',
  'set.loadDesc': 'Load them from the server, or add a new one there.',
  'set.createList': 'Create list',
  'set.listMissing': 'Not found on the server during the last load.',
  'set.listKey': 'Key for `list: {key}`',
  'set.listShow': 'Show',
  'set.listLabel': 'Heading',
  'set.listColor': 'Color',
  'set.noListsYet': 'No lists configured yet. Press "Load".',

  'set.refresh': 'Refresh automatically',
  'set.refreshDesc': 'How often to look for tasks added, edited or completed somewhere else. '
    + 'It only runs while a task list is actually on screen.',
  'set.refreshOff': 'Never',
  'set.refreshOneMinute': 'Every minute',
  'set.refreshMinutes': 'Every {n} minutes',

  'set.language': 'Language',
  'set.languageDesc': 'Automatic follows the language set in Obsidian.',
  'set.languageAuto': 'Automatic',

  'set.mobile': 'On your phone',
  'set.mobileHelp': 'The same lists work in the built-in reminders app: add a CalDAV account with '
    + 'the address, username and app password above. You then get push and widgets without '
    + 'Obsidian running.',

  'notice.refreshed': 'Tasks updated, {n} open.',
  'notice.refreshFailed': 'Tasks: {error}',
  'notice.saveFailed': 'Could not save: {error}',
  'notice.connectFirst': 'Connect in the plugin settings first, then tick at least one list.',
  'notice.created': 'Created in {list}.',
  'notice.createFailed': 'Creating failed: {error}',
  'notice.updated': 'Task saved.',
  'notice.deleted': 'Task deleted.',
  'notice.deleteFailed': 'Deleting failed: {error}',
  'notice.summaryMissing': 'The title is empty.',
  'notice.listsFound': '{n} list(s) found.',
  'notice.listsFailed': 'Could not load the lists: {error}',
  'notice.listCreated': 'Created: {name}',
  'notice.listExisted': '{name} already existed.',
  'notice.nameMissing': 'The name is empty.',
  'notice.probing': 'Testing the connection…',

  'err.401': 'Sign-in refused (401). The username or app password is wrong. Create a new one in '
    + 'Nextcloud under Settings → Security.',
  'err.403': 'Access denied (403). This app password is not allowed to see that list.',
  'err.404': 'Not found (404): {url}',
  'err.405': '{method} is not allowed here (405). The resource probably exists already.',
  'err.412': 'The server changed the task in the meantime (412).',
  'err.501': 'The server or the platform does not know {method} (501).',
  'err.server': 'Server error ({status}) on {method} {url}.',
  'err.http': '{method} {url} → HTTP {status}',
  'err.credentials': 'Server, username or app password is missing.',
  'err.noPrincipal': 'The server returned no current-user-principal.',
  'err.noHome': 'The server returned no calendar-home-set.',
  'err.noTodo': 'There is no task in this file (no VTODO).',
  'err.exists': 'already existed',

  'probe.principal': 'PROPFIND /remote.php/dav/ (principal)',
  'probe.home': 'PROPFIND principal (calendar-home-set)',
  'probe.lists': 'PROPFIND home, Depth 1 (lists)',
  'probe.report': 'REPORT calendar-query (read tasks)',
  'probe.fallback': 'Fallback PROPFIND + GET',
  'probe.noLists': 'no VTODO list found',
  'probe.tasks': '{name}: {n} task(s)',
  'probe.tasksFallback': '{name}: {n} task(s). REPORT is not needed.',
};

const DE = {
  'cmd.new': 'Aufgabe: neu',
  'cmd.refresh': 'Aufgaben: aktualisieren',
  'cmd.probe': 'Aufgaben: Verbindung testen',

  'panel.title': 'Offene Aufgaben',
  'panel.add': 'Neue Aufgabe',
  'panel.newList': 'Neue Liste',
  'panel.refresh': 'Aufgaben neu laden',
  'panel.loading': 'Lade …',
  'panel.empty': 'Nichts offen. 🎉',
  'panel.unconfigured': 'Noch nicht verbunden. Server, Benutzername und App-Passwort stehen in den '
    + 'Plugin-Einstellungen unter „Nextcloud Tasks“ — dort wählst du auch die Listen aus.',
  'panel.error': 'Aufgaben nicht erreichbar. ',
  'panel.stale': 'Offline, Stand {time}',
  'panel.unknownList': 'Unbekannte Liste „{key}“. Prüf den Schlüssel in den Plugin-Einstellungen.',

  'group.other': 'Ohne Zuordnung',
  'group.empty': 'Keine Aufgaben',
  'group.more': '+{n} weitere',
  'group.less': 'Weniger',
  'row.untitled': '(ohne Titel)',
  'row.task': 'Aufgabe',
  'row.edit': '{title} bearbeiten',
  'row.new': 'Neue Aufgabe …',
  'row.newAdd': 'Titel eingeben und Enter drücken',
  'row.newDue': 'Fälligkeit',
  'row.newPriority': 'Priorität',

  'due.yesterday': 'gestern',
  'due.overdue': '{n} Tage überfällig',
  'due.today': 'heute',
  'due.tomorrow': 'morgen',
  'due.inDays': 'in {n} Tagen',

  'modal.new.title': 'Neue Aufgabe',
  'modal.edit.title': 'Aufgabe bearbeiten',
  'modal.new.summary': 'Titel',
  'modal.new.summaryPlaceholder': 'Was ist zu tun?',
  'modal.new.list': 'Liste',
  'modal.new.listFixed': 'In eine andere Liste verschiebst du eine Aufgabe in Nextcloud, nicht hier.',
  'modal.new.due': 'Fällig',
  'modal.new.dueDesc': 'Optional. Wird als ganzer Tag gespeichert — so zeigt Erinnerungen es sauber an.',
  'modal.new.priority': 'Priorität',
  'prio.none': 'ohne',
  'prio.high': 'hoch',
  'prio.medium': 'mittel',
  'prio.low': 'niedrig',

  'modal.probe.title': 'Verbindung zu Nextcloud',
  'modal.probe.hint': 'PROPFIND, REPORT und MKCALENDAR sind keine gewöhnlichen HTTP-Methoden. '
    + 'Dieser Test zeigt, welche davon auf diesem Gerät durchkommen — führe ihn einmal am Laptop '
    + 'und einmal auf dem Handy aus.',
  'modal.probe.none': 'Kein Ergebnis.',

  'modal.newList.title': 'Neue Aufgabenliste',
  'modal.newList.name': 'Name',
  'modal.newList.namePlaceholder': 'z. B. Besorgungen',
  'modal.newList.color': 'Farbe',

  'modal.confirmDelete.title': 'Aufgabe löschen?',
  'modal.confirmDelete.body': '„{title}“ wird in Nextcloud gelöscht. Von hier aus lässt sich das '
    + 'nicht rückgängig machen.',

  'btn.cancel': 'Abbrechen',
  'btn.create': 'Anlegen',
  'btn.save': 'Speichern',
  'btn.delete': 'Löschen',
  'btn.close': 'Schließen',
  'btn.test': 'Testen',
  'btn.load': 'Laden',
  'btn.up': 'Nach oben',
  'btn.down': 'Nach unten',

  'set.connection': 'Verbindung',
  'set.server': 'Nextcloud-Adresse',
  'set.serverDesc': 'Nur die Basis, ohne /remote.php/dav.',
  'set.username': 'Benutzername',
  'set.password': 'App-Passwort',
  'set.passwordDesc': 'Nextcloud → Einstellungen → Sicherheit → App-Passwort erzeugen. Nicht das '
    + 'Konto-Passwort, und niemals in eine Notiz schreiben.',
  'set.test': 'Verbindung testen',
  'set.testDesc': 'Zeigt jeden Schritt einzeln, damit klar ist, woran es hängt.',

  'set.lists': 'Aufgabenlisten',
  'set.listsNotLoaded': 'Noch nicht geladen. „Laden“ holt deine Aufgabenlisten vom Server.',
  'set.listsFound': '{n} Aufgabenliste(n) auf dem Server. Hak an, was in den Notizen erscheinen soll.',
  'set.load': 'Aufgabenlisten',
  'set.loadDesc': 'Vom Server holen — oder dort eine neue anlegen.',
  'set.createList': 'Liste anlegen',
  'set.listMissing': 'Beim letzten Laden nicht auf dem Server gefunden.',
  'set.listKey': 'Schlüssel für `list: {key}`',
  'set.listShow': 'Anzeigen',
  'set.listLabel': 'Überschrift',
  'set.listColor': 'Farbe',
  'set.noListsYet': 'Noch keine Listen eingerichtet. Drück „Laden“.',

  'set.refresh': 'Automatisch aktualisieren',
  'set.refreshDesc': 'Wie oft nach Aufgaben gesucht wird, die woanders angelegt, geändert oder '
    + 'erledigt wurden. Läuft nur, solange eine Liste wirklich sichtbar ist.',
  'set.refreshOff': 'Nie',
  'set.refreshOneMinute': 'Jede Minute',
  'set.refreshMinutes': 'Alle {n} Minuten',

  'set.language': 'Sprache',
  'set.languageDesc': 'Automatisch folgt der in Obsidian eingestellten Sprache.',
  'set.languageAuto': 'Automatisch',

  'set.mobile': 'Auf dem Handy',
  'set.mobileHelp': 'Dieselben Listen laufen in der Erinnerungen-App: CalDAV-Account hinzufügen, '
    + 'mit der Adresse, dem Benutzernamen und dem App-Passwort von oben. Danach gibt es Push und '
    + 'Widgets, ganz ohne Obsidian.',

  'notice.refreshed': 'Aufgaben aktualisiert — {n} offen.',
  'notice.refreshFailed': 'Aufgaben: {error}',
  'notice.saveFailed': 'Konnte nicht speichern — {error}',
  'notice.connectFirst': 'Erst in den Plugin-Einstellungen verbinden und mindestens eine Liste anhaken.',
  'notice.created': 'Angelegt in {list}.',
  'notice.createFailed': 'Anlegen fehlgeschlagen — {error}',
  'notice.updated': 'Aufgabe gespeichert.',
  'notice.deleted': 'Aufgabe gelöscht.',
  'notice.deleteFailed': 'Löschen fehlgeschlagen — {error}',
  'notice.summaryMissing': 'Titel fehlt.',
  'notice.listsFound': '{n} Liste(n) gefunden.',
  'notice.listsFailed': 'Listen konnten nicht geladen werden — {error}',
  'notice.listCreated': 'Angelegt: {name}',
  'notice.listExisted': '{name} bestand schon.',
  'notice.nameMissing': 'Name fehlt.',
  'notice.probing': 'Verbindung wird getestet …',

  'err.401': 'Anmeldung abgelehnt (401) — Benutzername oder App-Passwort stimmt nicht. Ein neues '
    + 'erzeugst du in Nextcloud unter Einstellungen → Sicherheit.',
  'err.403': 'Zugriff verweigert (403) — das App-Passwort darf diese Liste nicht sehen.',
  'err.404': 'Nicht gefunden (404): {url}',
  'err.405': 'Methode {method} hier nicht erlaubt (405) — die Ressource existiert vermutlich schon.',
  'err.412': 'Der Server hat die Aufgabe zwischenzeitlich geändert (412).',
  'err.501': 'Der Server oder die Plattform kennt {method} nicht (501).',
  'err.server': 'Serverfehler ({status}) bei {method} {url}.',
  'err.http': '{method} {url} → HTTP {status}',
  'err.credentials': 'Server, Benutzername oder App-Passwort fehlt.',
  'err.noPrincipal': 'Der Server hat kein current-user-principal geliefert.',
  'err.noHome': 'Der Server hat kein calendar-home-set geliefert.',
  'err.noTodo': 'In dieser Datei steht keine Aufgabe (kein VTODO).',
  'err.exists': 'bestand schon',

  'probe.principal': 'PROPFIND /remote.php/dav/ (Principal)',
  'probe.home': 'PROPFIND Principal (calendar-home-set)',
  'probe.lists': 'PROPFIND Home, Depth 1 (Listen)',
  'probe.report': 'REPORT calendar-query (Aufgaben lesen)',
  'probe.fallback': 'Fallback PROPFIND + GET',
  'probe.noLists': 'keine VTODO-Liste gefunden',
  'probe.tasks': '{name}: {n} Aufgabe(n)',
  'probe.tasksFallback': '{name}: {n} Aufgabe(n) — REPORT wird nicht gebraucht',
};

const TABLES = { en: EN, de: DE };
const FALLBACK = 'en';

let current = FALLBACK;

/**
 * Which table to use. An explicit preference wins; `auto` falls back to the app
 * language the caller passes in, which is Obsidian's `getLanguage()`. It is
 * passed rather than read here on purpose: this module must import cleanly in
 * plain node, where the tests run it with no Obsidian and no DOM.
 *
 * @param {string} pref `auto` | `en` | `de`
 * @param {string} [appLanguage] e.g. `de`, `en`, `pt-BR`
 */
function resolveLocale(pref, appLanguage) {
  const want = String(pref || 'auto').toLowerCase();
  if (TABLES[want]) return want;
  const ui = String(appLanguage || '').toLowerCase().split(/[-_]/)[0];
  return TABLES[ui] ? ui : FALLBACK;
}

function setLocale(pref, appLanguage) {
  current = resolveLocale(pref, appLanguage);
  return current;
}

function getLocale() {
  return current;
}

/** BCP 47 tag for Intl and localeCompare. */
function localeTag() {
  return current === 'de' ? 'de-DE' : 'en-GB';
}

/**
 * @param {string} key
 * @param {object} [params] values for `{name}` placeholders
 */
function t(key, params) {
  const raw = (TABLES[current] && TABLES[current][key]) || EN[key];
  if (raw === undefined) return key;              // a typo should be loud, not silent
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  ));
}

export { EN, DE, TABLES, t, setLocale, getLocale, localeTag, resolveLocale };
