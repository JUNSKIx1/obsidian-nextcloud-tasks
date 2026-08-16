/*
 * The three dialogs. Kept out of main.js because none of them knows anything
 * about the plugin: each takes plain values in and hands plain values back.
 */

import { Modal, Setting, Notice } from 'obsidian';
import { t } from './i18n.js';
import { PALETTE } from './model.js';

/** Title, list, due date, priority. Enter submits. */
class NewTaskModal extends Modal {
  /**
   * @param {import('obsidian').App} app
   * @param {object} o { lists, listKey, onSubmit(values) }
   */
  constructor(app, o) {
    super(app);
    this.o = o;
    this.values = { summary: '', due: '', priority: '', listKey: o.listKey };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('nct-modal');
    this.setTitle(t('modal.new.title'));

    new Setting(contentEl).setName(t('modal.new.summary')).addText((text) => {
      text.setPlaceholder(t('modal.new.summaryPlaceholder'))
        .onChange((v) => { this.values.summary = v; });
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      });
      this.first = text.inputEl;
    });

    new Setting(contentEl).setName(t('modal.new.list')).addDropdown((drop) => {
      for (const l of this.o.lists) drop.addOption(l.key, l.label || l.key);
      drop.setValue(this.values.listKey).onChange((v) => { this.values.listKey = v; });
    });

    new Setting(contentEl)
      .setName(t('modal.new.due'))
      .setDesc(t('modal.new.dueDesc'))
      .then((s) => {
        const input = s.controlEl.createEl('input', { type: 'date' });
        input.addEventListener('change', () => { this.values.due = input.value; });
      });

    new Setting(contentEl).setName(t('modal.new.priority')).addDropdown((drop) => {
      drop.addOption('', t('prio.none'));
      drop.addOption('1', t('prio.high'));
      drop.addOption('5', t('prio.medium'));
      drop.addOption('9', t('prio.low'));
      drop.onChange((v) => { this.values.priority = v; });
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('btn.cancel')).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t('btn.create')).setCta().onClick(() => this.submit()));

    if (this.first) this.first.focus();
  }

  submit() {
    if (!this.values.summary.trim()) { new Notice(t('notice.summaryMissing')); return; }
    this.close();
    this.o.onSubmit(this.values);
  }

  onClose() { this.contentEl.empty(); }
}

/** Name and colour for a list to be created on the server. */
class NewListModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
    this.values = { name: '', color: PALETTE[0] };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('nct-modal');
    this.setTitle(t('modal.newList.title'));

    new Setting(contentEl).setName(t('modal.newList.name')).addText((text) => {
      text.setPlaceholder(t('modal.newList.namePlaceholder'))
        .onChange((v) => { this.values.name = v; });
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      });
      this.first = text.inputEl;
    });

    new Setting(contentEl).setName(t('modal.newList.color')).addColorPicker((picker) => {
      picker.setValue(this.values.color).onChange((v) => { this.values.color = v; });
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('btn.cancel')).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t('btn.create')).setCta().onClick(() => this.submit()));

    if (this.first) this.first.focus();
  }

  submit() {
    if (!this.values.name.trim()) { new Notice(t('notice.nameMissing')); return; }
    this.close();
    this.onSubmit(this.values);
  }

  onClose() { this.contentEl.empty(); }
}

/**
 * Every discovery step with its own result. The point is that a platform which
 * refuses one HTTP verb shows up as one failed row, not as a single opaque
 * "could not connect".
 */
class ProbeModal extends Modal {
  constructor(app, steps) {
    super(app);
    this.steps = steps || [];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('nct-modal');
    this.setTitle(t('modal.probe.title'));
    contentEl.createEl('p', { cls: 'nct-hint', text: t('modal.probe.hint') });

    const list = contentEl.createDiv({ cls: 'nct-probe' });
    for (const s of this.steps) {
      const row = list.createDiv({ cls: `nct-probe-row ${s.ok ? 'is-ok' : 'is-bad'}` });
      row.createSpan({ cls: 'nct-probe-mark', text: s.ok ? '✓' : '✗' });
      const body = row.createDiv({ cls: 'nct-probe-body' });
      body.createDiv({ cls: 'nct-probe-label', text: s.label });
      body.createDiv({ cls: 'nct-probe-note', text: s.note });
    }
    if (!this.steps.length) list.createDiv({ cls: 'nct-empty', text: t('modal.probe.none') });

    new Setting(contentEl).addButton((b) => b.setButtonText(t('btn.close')).setCta().onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

export { NewTaskModal, NewListModal, ProbeModal };
