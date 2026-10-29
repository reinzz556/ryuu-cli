import { Chalk } from 'chalk';
import process from 'node:process';
import { PASTE_END, PASTE_START } from './input.js';
import { charWidth, displayWidth } from './width.js';
import { maskSettingsSecret, setSetting } from '../config/settings.js';
import { describeSetting, validateSetting } from '../config/settings-registry.js';
import { RyuuError } from '../utils/errors.js';
import { redact } from '../utils/redaction.js';

/**
 * `ryuu --settings --tui`: a dedicated settings screen.
 *
 * It is a small retained screen (list + detail + status) rather than a second
 * chat TUI, and it reuses the terminal conventions of the main TUI: alternate
 * screen, raw mode, a resize redraw, masked secrets, and an unconditional
 * teardown that restores the terminal on every exit path.
 */

const PALETTE = {
  white: '#e2e8f0',
  sky: '#38bdf8',
  green: '#4ade80',
  red: '#f87171',
  gray: '#9ca3af',
  violet: '#a78bfa',
  amber: '#fbbf24',
};

const KEYS = [
  ['\x1b[A', 'up'],
  ['\x1b[B', 'down'],
  ['\x1b[C', 'right'],
  ['\x1b[D', 'left'],
  ['\x1b[H', 'home'],
  ['\x1b[F', 'end'],
  ['\x1b[1~', 'home'],
  ['\x1b[4~', 'end'],
  ['\x1b[5~', 'pageup'],
  ['\x1b[6~', 'pagedown'],
  ['\x1b[3~', 'delete'],
];

/** Select-type descriptors: ←/→ cycles them; typing still allows a custom id. */
const SELECT_TYPES = new Set(['provider', 'enum', 'model']);

function truncate(text, width) {
  const value = String(text ?? '');
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  let output = '';
  let used = 0;
  for (const char of value) {
    const size = charWidth(char.codePointAt(0));
    if (used + size > Math.max(0, width - 1)) break;
    output += char;
    used += size;
  }
  return `${output}…`;
}

function charsOf(text) {
  return Array.from(String(text ?? ''));
}

/** Greedy word wrap for the description pane (never splits a word). */
function wrapWords(text, width) {
  const max = Math.max(8, width);
  const lines = [];
  let line = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    if (!line) {
      line = word;
      continue;
    }
    if (displayWidth(`${line} ${word}`) <= max) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

export class SettingsTui {
  constructor({
    input,
    output,
    store,
    makeRegistry,
    data = null,
    version = '',
    color = null,
  } = {}) {
    if (!store) throw new Error('SettingsTui needs a store.');
    if (typeof makeRegistry !== 'function') throw new Error('SettingsTui needs a makeRegistry function.');
    this.input = input;
    this.output = output;
    this.store = store;
    this.makeRegistry = makeRegistry;
    this.data = data || { version: 1 };
    this.version = version;
    this.terminal = Boolean(input?.isTTY && output?.isTTY);
    const useColor = color === null ? Boolean(output?.isTTY && !process.env.NO_COLOR) : Boolean(color);
    this.c = new Chalk({ level: useColor ? 3 : 0 });

    this.entries = makeRegistry(this.data);
    this.index = 0;
    this.offset = 0;
    this.editing = null;
    this.status = { text: '', kind: 'info' };
    this.buffer = '';
    this.paste = null;
    this.escTimer = null;
    this.closed = false;
    this.exited = null;
    this.queue = Promise.resolve();

    this.onData = (chunk) => this.push(chunk);
    this.onResize = () => this.render();
    // A hard exit (uncaught error, SIGTERM) must still give the terminal back.
    this.exitHandler = () => {
      try {
        this.output?.write?.('\x1b[?25h\x1b[?1049l');
      } catch {
        // Ignore: the stream may already be gone.
      }
      try {
        this.input?.setRawMode?.(false);
      } catch {
        // Ignore: the stream may already be gone.
      }
    };
  }

  paint(name, text) {
    return this.c.hex(PALETTE[name] || PALETTE.white)(String(text ?? ''));
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async run() {
    if (!this.terminal) {
      throw new RyuuError(
        'The settings TUI needs an interactive terminal. Run `ryuu --settings` for the line editor.',
        { code: 'SETTINGS_TTY_REQUIRED' },
      );
    }
    this.enter();
    await new Promise((resolve) => {
      this.exited = resolve;
    });
    return 0;
  }

  enter() {
    this.output.write('\x1b[?1049h\x1b[2J\x1b[?25l');
    try {
      this.input.setRawMode?.(true);
      this.input.resume?.();
    } catch {
      // A non-standard stream may refuse raw mode; the screen still renders.
    }
    this.input.on('data', this.onData);
    this.output.on('resize', this.onResize);
    process.once('exit', this.exitHandler);
    this.render();
  }

  /** Restore the terminal exactly once, on every exit path. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
    this.input?.off?.('data', this.onData);
    this.output?.off?.('resize', this.onResize);
    process.off('exit', this.exitHandler);
    try {
      this.input?.setRawMode?.(false);
    } catch {
      // Ignore: the stream may already be gone.
    }
    this.output?.write?.('\x1b[?25h\x1b[?1049l');
    this.input?.pause?.();
    const resolve = this.exited;
    this.exited = null;
    resolve?.();
  }

  // ── input ────────────────────────────────────────────────────────────────

  push(chunk) {
    if (this.closed) return;
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.drain();
  }

  drain() {
    for (;;) {
      if (!this.buffer || this.closed) return;
      if (this.paste !== null) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end === -1) {
          this.paste += this.buffer;
          this.buffer = '';
          return;
        }
        this.paste += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        const text = this.paste;
        this.paste = null;
        this.insertText(text);
        continue;
      }
      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.paste = '';
        continue;
      }
      if (this.buffer[0] === '\x1b') {
        const sequence = this.#readEscape();
        if (sequence === null) {
          this.#armEscape();
          return;
        }
        this.buffer = this.buffer.slice(sequence.length);
        this.#dispatchKey(sequence);
        continue;
      }
      const special = this.buffer.search(/[\x00-\x1f\x7f]/);
      if (special === -1) {
        const text = this.buffer;
        this.buffer = '';
        this.insertText(text);
        continue;
      }
      if (special > 0) {
        const text = this.buffer.slice(0, special);
        this.buffer = this.buffer.slice(special);
        this.insertText(text);
        continue;
      }
      const char = this.buffer[0];
      this.buffer = this.buffer.slice(1);
      this.#dispatchControl(char);
    }
  }

  #readEscape() {
    if (this.buffer.length === 1) return null;
    if (this.buffer[1] === '[') {
      for (let index = 2; index < this.buffer.length; index += 1) {
        const code = this.buffer.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) return this.buffer.slice(0, index + 1);
      }
      return null;
    }
    if (this.buffer[1] === 'O') return this.buffer.length < 3 ? null : this.buffer.slice(0, 3);
    return this.buffer.slice(0, 2);
  }

  #armEscape() {
    if (this.escTimer) return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.buffer.startsWith('\x1b') && this.buffer.length === 1) {
        this.buffer = '';
        this.#dispatchKey('\x1b');
      }
    }, 40);
    this.escTimer.unref?.();
  }

  #dispatchKey(sequence) {
    if (sequence === '\x1b') return this.enqueue('escape');
    const name = KEYS.find(([code]) => code === sequence)?.[1];
    if (name) this.enqueue(name);
  }

  #dispatchControl(char) {
    if (char === '\x03') return this.enqueue('ctrl-c');
    if (char === '\r' || char === '\n') return this.enqueue('enter');
    if (char === '\x7f' || char === '\x08') return this.enqueue('backspace');
    if (char === '\t') return this.enqueue('tab');
    if (char === '\x15') {
      if (this.editing) {
        this.editing.buffer = '';
        this.editing.cursor = 0;
        this.render();
      }
      return undefined;
    }
    // Other control keys are ignored: they must never leak into a value.
    return undefined;
  }

  insertText(text) {
    if (!this.editing) return;
    const clean = String(text ?? '').replace(/[\r\n]+/g, '');
    if (!clean) return;
    const chars = charsOf(this.editing.buffer);
    const cursor = this.editing.cursor;
    this.editing.buffer = [...chars.slice(0, cursor), ...Array.from(clean), ...chars.slice(cursor)].join('');
    this.editing.cursor = cursor + Array.from(clean).length;
    this.render();
  }

  /** Serialise key handling so two Enter presses cannot commit twice at once. */
  enqueue(key) {
    this.queue = this.queue
      .then(() => this.handleKey(key))
      .catch(() => {})
      .then(() => this.render());
    return this.queue;
  }

  // ── navigation and editing ───────────────────────────────────────────────

  get selected() {
    return this.entries[this.index] || null;
  }

  select(index) {
    if (this.entries.length === 0) return;
    this.index = Math.max(0, Math.min(index, this.entries.length - 1));
    this.editing = null;
    this.render();
  }

  beginEdit() {
    const entry = this.selected;
    if (!entry) return;
    if (SELECT_TYPES.has(entry.type)) {
      const choices = entry.choices || [];
      const current = entry.value === null || entry.value === undefined ? '' : String(entry.value);
      const at = choices.indexOf(current);
      const buffer = at === -1 ? (choices[0] ?? '') : current;
      this.editing = {
        entry,
        buffer,
        cursor: charsOf(buffer).length,
        secret: Boolean(entry.secret),
        original: entry.value,
      };
    } else {
      const current = entry.secret
        ? ''
        : entry.value === null || entry.value === undefined
          ? ''
          : Array.isArray(entry.value)
            ? entry.value.join(', ')
            : String(entry.value);
      this.editing = {
        entry,
        buffer: current,
        cursor: charsOf(current).length,
        secret: Boolean(entry.secret),
        original: entry.value,
      };
    }
    this.status = {
      text:
        entry.secret && entry.value
          ? 'editing a new secret · Enter save · Esc cancel (the stored key stays masked)'
          : SELECT_TYPES.has(entry.type)
            ? '←/→ change or type an id · Enter save · Ctrl+U clear · Esc cancel'
            : 'type a value · Enter save · Ctrl+U clear · Esc cancel',
      kind: 'info',
    };
    this.render();
  }

  cancelEdit() {
    this.editing = null;
    this.status = { text: 'Edit cancelled; nothing changed.', kind: 'info' };
    this.render();
  }

  cycle(delta) {
    const edit = this.editing;
    if (!edit) return;
    const choices = edit.entry.choices || [];
    if (choices.length === 0) return;
    const current = choices.indexOf(edit.buffer);
    const next = ((current === -1 ? 0 : current + delta) % choices.length + choices.length) % choices.length;
    edit.buffer = String(choices[next]);
    edit.cursor = edit.buffer.length;
    this.render();
  }

  moveCursor(delta) {
    const edit = this.editing;
    if (!edit) return;
    const chars = charsOf(edit.buffer);
    edit.cursor = Math.max(0, Math.min(edit.cursor + delta, chars.length));
    this.render();
  }

  backspace() {
    const edit = this.editing;
    if (!edit || edit.cursor <= 0) return;
    const chars = charsOf(edit.buffer);
    edit.buffer = [...chars.slice(0, edit.cursor - 1), ...chars.slice(edit.cursor)].join('');
    edit.cursor -= 1;
    this.render();
  }

  deleteForward() {
    const edit = this.editing;
    if (!edit) return;
    const chars = charsOf(edit.buffer);
    if (edit.cursor >= chars.length) return;
    edit.buffer = [...chars.slice(0, edit.cursor), ...chars.slice(edit.cursor + 1)].join('');
    this.render();
  }

  async commit() {
    const edit = this.editing;
    if (!edit) return;
    const { entry } = edit;
    const result = validateSetting(entry, edit.buffer);
    if (!result.ok) {
      this.status = { text: `${entry.label}: ${result.error}`, kind: 'error' };
      this.render();
      return;
    }
    let saved;
    try {
      saved = await this.store.update((draft) => {
        setSetting(draft, entry.key, result.value);
        return draft;
      });
    } catch (error) {
      this.status = { text: `${entry.label} was NOT saved: ${redact(error.message)}`, kind: 'error' };
      this.render();
      return;
    }
    this.data = saved;
    const index = this.index;
    this.entries = this.makeRegistry(this.data);
    this.index = Math.min(index, this.entries.length - 1);
    this.editing = null;
    const warning = result.warning ? ` — ${result.warning}` : '';
    this.status = { text: `Saved ${entry.label}${warning}`, kind: 'ok' };
    this.render();
  }

  /** Handle one key name. Async only when it saves. */
  async handleKey(name) {
    if (this.closed) return;
    if (this.editing) {
      switch (name) {
        case 'escape':
          this.cancelEdit();
          return;
        case 'enter':
          await this.commit();
          return;
        case 'left':
          if (SELECT_TYPES.has(this.editing.entry.type)) this.cycle(-1);
          else this.moveCursor(-1);
          return;
        case 'right':
          if (SELECT_TYPES.has(this.editing.entry.type)) this.cycle(1);
          else this.moveCursor(1);
          return;
        case 'home':
          if (!SELECT_TYPES.has(this.editing.entry.type)) {
            this.editing.cursor = 0;
            this.render();
          }
          return;
        case 'end':
          if (!SELECT_TYPES.has(this.editing.entry.type)) {
            this.editing.cursor = charsOf(this.editing.buffer).length;
            this.render();
          }
          return;
        case 'backspace':
          this.backspace();
          return;
        case 'delete':
          this.deleteForward();
          return;
        case 'ctrl-c':
          this.cancelEdit();
          return;
        default:
          return;
      }
    }

    switch (name) {
      case 'up':
        this.select(this.index - 1);
        return;
      case 'down':
        this.select(this.index + 1);
        return;
      case 'home':
        this.select(0);
        return;
      case 'end':
        this.select(this.entries.length - 1);
        return;
      case 'pageup':
        this.select(this.index - this.pageSize());
        return;
      case 'pagedown':
        this.select(this.index + this.pageSize());
        return;
      case 'tab':
        this.select((this.index + 1) % Math.max(1, this.entries.length));
        return;
      case 'enter':
        this.beginEdit();
        return;
      case 'left':
      case 'right': {
        const entry = this.selected;
        if (!entry || !SELECT_TYPES.has(entry.type)) return;
        this.beginEdit();
        this.cycle(name === 'left' ? -1 : 1);
        return;
      }
      case 'escape':
      case 'ctrl-c':
        this.close();
        return;
      default:
        return;
    }
  }

  pageSize() {
    const height = Math.max(10, Number(this.output?.rows) || 24);
    return Math.max(1, height - 7);
  }

  // ── rendering ────────────────────────────────────────────────────────────

  renderRows(width, height) {
    const rows = [];
    const inner = Math.max(20, width - 2);
    const headerLeft = ` ${this.paint('sky', '◈')} ${this.c.bold(this.paint('sky', 'RYUU SETTINGS'))}`;
    const headerRight = this.paint('gray', `${this.version ? `v${this.version} · ` : ''}config.json`);
    const room = Math.max(0, inner - displayWidth(headerLeft, { ansi: true }) - displayWidth(headerRight, { ansi: true }));
    rows.push(`${headerLeft}${' '.repeat(room)}${headerRight}`);
    rows.push(this.paint('gray', ` ${'─'.repeat(inner)}`));

    // Fixed rows: header, rule, column header, rule, two description rows,
    // constraints, control hint and status. The rest is the scrolling list.
    const listRows = Math.max(1, height - 9);
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + listRows) this.offset = this.index - listRows + 1;

    const labelWidth = Math.min(
      30,
      Math.max(12, ...this.entries.map((entry) => displayWidth(entry.label))),
      Math.max(8, width - 24),
    );
    const valueWidth = Math.max(8, width - labelWidth - 9);
    rows.push(
      `   ${this.paint('gray', '#'.padEnd(3))}${this.paint('gray', 'SETTING'.padEnd(labelWidth))} ${this.paint(
        'gray',
        'VALUE',
      )}`,
    );

    for (let row = 0; row < listRows; row += 1) {
      const entry = this.entries[this.offset + row];
      if (!entry) {
        rows.push('');
        continue;
      }
      const index = this.offset + row;
      const selected = index === this.index;
      const marker = selected ? this.paint('sky', '▸') : ' ';
      const number = String(index + 1).padEnd(3);
      const label = truncate(entry.label, labelWidth).padEnd(labelWidth);

      const editing = this.editing && this.editing.entry === entry;
      const flag = entry.envOverride ? this.paint('amber', ' !') : '';
      const labelText = selected ? this.c.bold(this.paint('white', label)) : this.paint('gray', label);
      let valueText;
      if (editing) {
        valueText = this.paint(entry.secret ? 'amber' : 'green', this.#editingDisplay());
      } else if (entry.secret) {
        valueText = this.paint('gray', maskSettingsSecret(entry.value));
      } else {
        valueText = truncate(formatValue(entry), valueWidth);
      }
      rows.push(` ${marker} ${this.paint('gray', number)}${labelText} ${valueText}${flag}`);
    }

    rows.push(this.paint('gray', ` ${'─'.repeat(inner)}`));
    const entry = this.selected;
    if (entry) {
      const description = wrapWords(entry.description, Math.max(10, inner - 2));
      const first = description[0] || '';
      const second = description.length > 2 ? `${description[1]}…` : description[1] || '';
      rows.push(`  ${this.paint('white', first)}`);
      rows.push(`  ${this.paint('white', second)}`);
      const constraints = describeSetting(entry);
      rows.push(`  ${this.paint('gray', truncate(constraints, inner - 2))}`);
      if (this.editing) {
        rows.push(
          `  ${this.paint('amber', 'editing')} ${this.paint(
            'gray',
            SELECT_TYPES.has(entry.type)
              ? '←/→ change · Enter save · Esc cancel'
              : 'Enter save · Esc cancel · Home/End · Backspace',
          )}`,
        );
      } else {
        rows.push(`  ${this.paint('gray', 'Enter edit · ↑↓ move · Esc exit · Ctrl+C quit')}`);
      }
    } else {
      rows.push(`  ${this.paint('gray', 'No editable settings for this installation.')}`);
      rows.push('');
      rows.push('');
    }

    const statusText = this.status.text || `file: ${this.store.file}`;
    const tone = this.status.kind === 'error' ? 'red' : this.status.kind === 'ok' ? 'green' : 'gray';
    rows.push(` ${this.paint(tone, truncate(statusText, inner))}`);

    // Pad/trim to exactly `height` so stale rows never survive a shrinking frame.
    while (rows.length < height) rows.push('');
    return rows.slice(0, height);
  }

  #editingDisplay() {
    const edit = this.editing;
    const chars = charsOf(edit.buffer);
    const shown = edit.secret ? chars.map(() => '•') : chars;
    const cursor = Math.min(edit.cursor, shown.length);
    const withCursor = [...shown.slice(0, cursor), this.paint('sky', '▏'), ...shown.slice(cursor)].join('');
    if (edit.secret && chars.length === 0) return `${withCursor}${this.paint('gray', ' (new value)')}`;
    return withCursor;
  }

  render() {
    if (!this.terminal || this.closed) return;
    const width = Math.max(30, Number(this.output.columns) || 80);
    const height = Math.max(10, Number(this.output.rows) || 24);
    const rows = this.renderRows(width, height);
    let frame = '\x1b[?25l';
    for (let index = 0; index < rows.length; index += 1) {
      frame += `\x1b[${index + 1};1H${rows[index]}\x1b[K`;
    }
    this.output.write(frame);
  }
}

function formatValue(entry) {
  if (entry.type === 'provider') return entry.value ? String(entry.value) : 'auto';
  const value = entry.value;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none)';
  if (value === null || value === undefined || value === '') {
    if (entry.defaultValue !== null && entry.defaultValue !== undefined && entry.defaultValue !== '') {
      return `${Array.isArray(entry.defaultValue) ? entry.defaultValue.join(', ') : entry.defaultValue} (default)`;
    }
    return '(not set)';
  }
  return String(value);
}

