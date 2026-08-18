/*
 * The settings tab.
 *
 * The list section is the whole point of this plugin being installable by
 * anyone: it shows what the server actually has, and the user ticks what they
 * want. Nothing here assumes a number of lists, a naming scheme, or a folder
 * structure in the vault.
 */

import { PluginSettingTab, Setting, Notice } from 'obsidian';
import { t } from './i18n.js';
import { mergeDiscovered } from './model.js';

class NextcloudTasksSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.discovered = null;               // last successful discovery, this session
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('nct-settings');
    this.connectionSection(containerEl);
    this.listSection(containerEl);
    this.miscSection(containerEl);
  }

  save() {
    return this.plugin.saveSettings();
  }

  /* ----------------------------------------------------------- connection */

  connectionSection(containerEl) {
    const s = this.plugin.settings;
    new Setting(containerEl).setName(t('set.connection')).setHeading();

    new Setting(containerEl)
      .setName(t('set.server'))
      .setDesc(t('set.serverDesc'))
      .addText((text) => text
        .setPlaceholder('https://cloud.example.com')
        .setValue(s.baseUrl)
        .onChange(async (v) => { s.baseUrl = v.trim(); await this.save(); }));

    new Setting(containerEl)
      .setName(t('set.username'))
      .addText((text) => text
        .setValue(s.username)
        .onChange(async (v) => { s.username = v.trim(); await this.save(); }));

    new Setting(containerEl)
      .setName(t('set.password'))
      .setDesc(t('set.passwordDesc'))
      .addText((text) => {
        text.setValue(s.password).onChange(async (v) => { s.password = v.trim(); await this.save(); });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName(t('set.test'))
      .setDesc(t('set.testDesc'))
      .addButton((b) => b.setButtonText(t('btn.test')).onClick(() => this.plugin.runProbe()));
  }

  /* ---------------------------------------------------------------- lists */

  listSection(containerEl) {
    const s = this.plugin.settings;
    new Setting(containerEl).setName(t('set.lists')).setHeading();

    containerEl.createDiv({
      cls: 'nct-note',
      text: this.discovered
        ? t('set.listsFound', { n: this.discovered.length })
        : t('set.listsNotLoaded'),
    });

    new Setting(containerEl)
      .setName(t('set.load'))
      .setDesc(t('set.loadDesc'))
      .addButton((b) => b.setButtonText(t('btn.load')).onClick(() => this.loadLists()))
      .addButton((b) => b.setButtonText(t('set.createList')).onClick(() => this.createList()));

    if (!s.lists.length) {
      containerEl.createDiv({ cls: 'nct-note', text: t('set.noListsYet') });
      return;
    }
    s.lists.forEach((entry, i) => this.listRow(containerEl, entry, i));
  }

  listRow(containerEl, entry, index) {
    const s = this.plugin.settings;
    const row = new Setting(containerEl)
      .setClass('nct-list-row')
      .setName(entry.label || entry.key)
      .setDesc(entry.missing ? t('set.listMissing') : t('set.listKey', { key: entry.key }));

    row.addToggle((toggle) => {
      toggle.setTooltip(t('set.listShow'));
      toggle.setValue(!!entry.enabled).onChange(async (v) => {
        entry.enabled = v;
        await this.save();
        this.plugin.refresh(false);
      });
    });

    row.addText((text) => {
      text.setPlaceholder(t('set.listLabel'));
      text.setValue(entry.label).onChange(async (v) => {
        entry.label = v;
        await this.save();
        this.plugin.drawAll();
      });
    });

    row.addText((text) => {
      text.setPlaceholder(t('set.listKey', { key: '' }));
      text.setValue(entry.key).onChange(async (v) => {
        const next = v.trim().toLowerCase();
        if (!next || s.lists.some((l) => l !== entry && l.key === next)) return;
        entry.key = next;
        await this.save();
        this.plugin.drawAll();
      });
    });

    row.addColorPicker((picker) => {
      picker.setValue(entry.color || '#888888').onChange(async (v) => {
        entry.color = v;
        await this.save();
        this.plugin.drawAll();
      });
    });

    row.addExtraButton((b) => b
      .setIcon('chevron-up')
      .setTooltip(t('btn.up'))
      .setDisabled(index === 0)
      .onClick(() => this.move(index, -1)));

    row.addExtraButton((b) => b
      .setIcon('chevron-down')
      .setTooltip(t('btn.down'))
      .setDisabled(index === s.lists.length - 1)
      .onClick(() => this.move(index, 1)));
  }

  async move(index, delta) {
    const lists = this.plugin.settings.lists;
    const to = index + delta;
    if (to < 0 || to >= lists.length) return;
    const [item] = lists.splice(index, 1);
    lists.splice(to, 0, item);
    await this.save();
    this.display();
    this.plugin.drawAll();
  }

  async loadLists() {
    try {
      const d = await this.plugin.client().discover(true);
      this.discovered = d.lists;
      this.plugin.home = d.home;
      const firstRun = !this.plugin.settings.lists.length;
      this.plugin.settings.lists = mergeDiscovered(this.plugin.settings.lists, d.lists, firstRun);
      await this.save();
      new Notice(t('notice.listsFound', { n: d.lists.length }));
      this.display();
      this.plugin.refresh(false);
    } catch (e) {
      new Notice(t('notice.listsFailed', { error: message(e) }));
    }
  }

  /**
   * The same dialog the panel offers, and deliberately the same code: creating a
   * collection on the server is a write, and one implementation of a write is
   * enough. All this end does is redraw the table around the result.
   */
  createList() {
    this.plugin.promptNewList((d) => {
      this.discovered = d.lists;
      this.display();
    });
  }

  /* ----------------------------------------------------------------- misc */

  miscSection(containerEl) {
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName(t('set.refresh'))
      .setDesc(t('set.refreshDesc'))
      .addDropdown((drop) => {
        drop.addOption('0', t('set.refreshOff'));
        drop.addOption('1', t('set.refreshOneMinute'));
        for (const n of [2, 5, 10, 15, 30]) drop.addOption(String(n), t('set.refreshMinutes', { n }));
        drop.setValue(String(s.refreshMinutes)).onChange(async (v) => {
          s.refreshMinutes = parseInt(v, 10) || 0;
          await this.save();            // saveSettings restarts the timer
          this.plugin.drawAll();        // the footer's patience depends on it
        });
      });

    new Setting(containerEl)
      .setName(t('set.language'))
      .setDesc(t('set.languageDesc'))
      .addDropdown((drop) => {
        drop.addOption('auto', t('set.languageAuto'));
        drop.addOption('en', 'English');
        drop.addOption('de', 'Deutsch');
        drop.setValue(s.language).onChange(async (v) => {
          s.language = v;
          this.plugin.applyLocale();
          await this.save();
          this.display();
          this.plugin.drawAll();
        });
      });

    new Setting(containerEl).setName(t('set.mobile')).setHeading();
    containerEl.createDiv({ cls: 'nct-note', text: t('set.mobileHelp') });
  }
}

const message = (e) => (e && e.message ? e.message : String(e));

export { NextcloudTasksSettingTab };
