/*
 * The three dialogs. Kept out of main.js because none of them knows anything
 * about the plugin: each takes plain values in and hands plain values back.
 */

import { Modal, Setting, Notice } from 'obsidian';
import { t } from './i18n.js';
import { PALETTE } from './model.js';

/**
 * Title, list, due date, priority. Enter submits. The same dialog creates a
 * task and edits one; the difference is that an edit reports **only what
 * changed**, because a property this plugin never sends is a property it can
 * never flatten. Comparing against the values it opened with is what does that:
 * an untouched date field means the caller gets no `due` key at all, so a task
 * with a real time on it keeps that time when you only fix a typo in the title.
 */
class TaskModal extends Modal {
  /**
   * @param {import('obsidian').App} app
   * @param {object} o { mode, lists, listKey, listLabel, summary, due, priority,
   *                     onSubmit(fields), onDelete() }
   */
  constructor(app, o) {
    super(app);
    this.o = o;
    this.edit = o.mode === 'edit';
    this.initial = {
      summary: o.summary || '',
      due: o.due || '',                                   // yyyy-mm-dd, or empty
      priority: o.priority ? String(o.priority) : '',
    };
    this.values = Object.assign({}, this.initial, { listKey: o.listKey });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('nct-modal');
    this.setTitle(t(this.edit ? 'modal.edit.title' : 'modal.new.title'));

    new Setting(contentEl).setName(t('modal.new.summary')).addText((text) => {
      text.setPlaceholder(t('modal.new.summaryPlaceholder'))
        .setValue(this.values.summary)
        .onChange((v) => { this.values.summary = v; });
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      });
      this.first = text.inputEl;
    });

    new Setting(contentEl)
      .setName(t('modal.new.list'))
      .setDesc(this.edit ? t('modal.new.listFixed') : '')
      .addDropdown((drop) => {
        for (const l of this.o.lists) drop.addOption(l.key, l.label || l.key);
        drop.setValue(this.values.listKey).onChange((v) => { this.values.listKey = v; });
        // CalDAV has no atomic move: it would mean writing the task into the
        // other collection and deleting this one, and a failure halfway leaves
        // you with two of them. Nextcloud does that properly; we do not.
        if (this.edit) drop.setDisabled(true);
      });

    new Setting(contentEl)
      .setName(t('modal.new.due'))
      .setDesc(t('modal.new.dueDesc'))
      .then((s) => {
        const input = s.controlEl.createEl('input', { type: 'date' });
        input.value = this.values.due;
        input.addEventListener('change', () => { this.values.due = input.value; });
      });

    new Setting(contentEl).setName(t('modal.new.priority')).addDropdown((drop) => {
      drop.addOption('', t('prio.none'));
      drop.addOption('1', t('prio.high'));
      drop.addOption('5', t('prio.medium'));
      drop.addOption('9', t('prio.low'));
      // Another client may have used one of the other six RFC 5545 levels.
      // Offer it verbatim rather than silently rounding someone's data.
      if (this.values.priority && !['1', '5', '9'].includes(this.values.priority)) {
        drop.addOption(this.values.priority, this.values.priority);
      }
      drop.setValue(this.values.priority).onChange((v) => { this.values.priority = v; });
    });

    const buttons = new Setting(contentEl);
    if (this.edit && this.o.onDelete) {
      buttons.addButton((b) => b.setButtonText(t('btn.delete')).setWarning().onClick(() => {
        this.close();
        this.o.onDelete();
      }));
    }
    buttons
      .addButton((b) => b.setButtonText(t('btn.cancel')).onClick(() => this.close()))
      .addButton((b) => b
        .setButtonText(t(this.edit ? 'btn.save' : 'btn.create'))
        .setCta()
        .onClick(() => this.submit()));

    if (this.first) this.first.focus();
  }

  /** Only the fields the user actually moved. */
  changed() {
    const out = {};
    if (this.values.summary !== this.initial.summary) out.summary = this.values.summary.trim();
    if (this.values.due !== this.initial.due) {
      out.due = this.values.due ? new Date(`${this.values.due}T00:00:00`) : null;
    }
    if (this.values.priority !== this.initial.priority) {
      out.priority = this.values.priority ? parseInt(this.values.priority, 10) : 0;
    }
    return out;
  }

  submit() {
    if (!this.values.summary.trim()) { new Notice(t('notice.summaryMissing')); return; }
    const fields = this.edit
      ? this.changed()
      : {
        summary: this.values.summary.trim(),
        due: this.values.due ? new Date(`${this.values.due}T00:00:00`) : null,
        priority: this.values.priority ? parseInt(this.values.priority, 10) : 0,
        listKey: this.values.listKey,
      };
    this.close();
    this.o.onSubmit(fields);
  }

  onClose() { this.contentEl.empty(); }
}

/** One deliberate step in front of anything that cannot be undone from here. */
class ConfirmModal extends Modal {
  /** @param {object} o { title, body, confirmText, onConfirm } */
  constructor(app, o) {
    super(app);
    this.o = o;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('nct-modal');
    this.setTitle(this.o.title);
    contentEl.createEl('p', { cls: 'nct-hint', text: this.o.body });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('btn.cancel')).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.o.confirmText).setWarning().onClick(() => {
        this.close();
        this.o.onConfirm();
      }));
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

export { TaskModal, NewListModal, ProbeModal, ConfirmModal };
