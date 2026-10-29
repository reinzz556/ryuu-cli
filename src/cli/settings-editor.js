import process from 'node:process';
import readline from 'node:readline/promises';
import {
  describeSetting,
  findSetting,
  formatSettingValue,
  validateSetting,
} from '../config/settings-registry.js';
import { setSetting } from '../config/settings.js';
import { redact } from '../utils/redaction.js';
import { charWidth, displayWidth } from './width.js';

/**
 * `ryuu --settings`: the line-oriented settings editor.
 *
 * Every successfully validated change is written immediately (read-modify-write
 * through the store), so an interrupted terminal never loses a saved value. A
 * failed write leaves the in-memory copy untouched and says so, which means the
 * editor's view never pretends a change was persisted.
 */

const HELP_LINES = [
  'Settings commands:',
  '  <number> <value>   save a new value for that setting',
  '  /list              redraw the numbered settings list',
  '  /show <number>     show one setting, its description and constraints',
  '  /reset <number>    reset one setting to its default (asks first)',
  '  /help              show this help',
  '  /exit              leave the editor (changes are already saved)',
  'A value may contain spaces; everything after the number is kept.',
];

function truncate(text, width) {
  const value = String(text ?? '');
  if (displayWidth(value) <= width) return value;
  let output = '';
  let used = 0;
  for (const char of value) {
    const size = charWidth(char.codePointAt(0));
    if (used + size > width - 1) break;
    output += char;
    used += size;
  }
  return `${output}…`;
}

export class SettingsSession {
  constructor({ store, makeRegistry, data, file = store?.file || '', title = '◇ Ryuu Settings' }) {
    if (!store) throw new Error('SettingsSession needs a store.');
    if (typeof makeRegistry !== 'function') throw new Error('SettingsSession needs a makeRegistry function.');
    this.store = store;
    this.makeRegistry = makeRegistry;
    this.data = data || { version: 1 };
    this.file = file;
    this.title = title;
    this.entries = makeRegistry(this.data);
  }

  #refresh() {
    this.entries = this.makeRegistry(this.data);
  }

  listLines() {
    const width = Math.min(
      34,
      Math.max(12, ...this.entries.map((entry) => displayWidth(entry.label))),
    );
    const lines = [
      this.title,
      `file: ${this.file}`,
      '',
      `  ${'#'.padEnd(3)} ${'SETTING'.padEnd(width)} VALUE`,
    ];
    this.entries.forEach((entry, index) => {
      const label = entry.label.padEnd(width);
      lines.push(`  ${String(index + 1).padEnd(3)} ${label} ${truncate(formatSettingValue(entry), 56)}`);
    });
    lines.push('');
    lines.push('Enter a number and a new value. Format: <number> <value>');
    lines.push('Type /help for commands, /exit to leave (each change is saved immediately).');
    return lines;
  }

  describeLines(entry) {
    const lines = [
      `${entry.label} · ${entry.key}`,
      `  value: ${formatSettingValue(entry)}`,
      `  type: ${entry.type}${entry.secret ? ' (secret, always masked)' : ''}${
        entry.required ? ' · required' : ''
      }`,
      `  ${entry.description}`,
    ];
    const constraints = describeSetting(entry);
    if (constraints) lines.push(`  ${constraints}`);
    lines.push('  use: /reset ' + this.#indexOf(entry) + ' to restore the default');
    return lines;
  }

  #indexOf(entry) {
    return this.entries.indexOf(entry) + 1;
  }

  #lookup(reference, { allowKey = true } = {}) {
    return findSetting(this.entries, reference, { allowKey });
  }

  /** Validate and persist one value; the in-memory copy only moves on success. */
  async assign(reference, rawValue) {
    const entry = this.#lookup(reference);
    if (!entry) {
      return { ok: false, message: `Unknown setting: ${reference}. Use /list to see the numbers.` };
    }
    const result = validateSetting(entry, rawValue);
    if (!result.ok) return { ok: false, message: `${entry.label}: ${result.error}` };
    if (!entry.editable) return { ok: false, message: `${entry.label} is not editable here.` };

    const key = entry.key;
    let saved;
    try {
      saved = await this.store.update((draft) => {
        setSetting(draft, key, result.value);
        return draft;
      });
    } catch (error) {
      return {
        ok: false,
        message: `${entry.label} was NOT saved: ${redact(error.message)}`,
      };
    }
    this.data = saved;
    this.#refresh();
    const refreshed = findSetting(this.entries, key, { allowKey: true });
    const warning = result.warning ? ` — ${result.warning}` : '';
    return { ok: true, message: `Saved ${entry.label} = ${formatSettingValue(refreshed)}${warning}` };
  }

  /** Reset one setting to its registry default after an explicit confirmation. */
  async reset(reference, { confirm } = {}) {
    const entry = this.#lookup(reference);
    if (!entry) {
      return { ok: false, message: `Unknown setting: ${reference}. Use /list to see the numbers.` };
    }
    const shown = entry.secret
      ? '(empty)'
      : Array.isArray(entry.defaultValue)
        ? entry.defaultValue.join(', ')
        : entry.defaultValue === null || entry.defaultValue === undefined || entry.defaultValue === ''
          ? '(empty)'
          : String(entry.defaultValue);
    const approved = typeof confirm === 'function' ? await confirm(`Reset ${entry.label} to ${shown}? [y/N] `) : false;
    if (!approved) return { ok: false, message: 'Reset cancelled; nothing changed.' };
    const raw = Array.isArray(entry.defaultValue)
      ? entry.defaultValue.join(', ')
      : entry.defaultValue === null || entry.defaultValue === undefined
        ? ''
        : String(entry.defaultValue);
    return this.assign(entry.key, raw);
  }

  /**
   * Handle one editor line. Returns the lines to print and whether to exit.
   * Invalid input is reported, never fatal.
   */
  async handleLine(line, { confirm = null } = {}) {
    const text = String(line ?? '');
    const trimmed = text.trim();
    if (!trimmed) return { lines: ['Type a number and a value, or /help.'], exit: false };

    if (trimmed.startsWith('/')) {
      const [command, ...rest] = trimmed.split(/\s+/);
      const argument = rest.join(' ');
      switch (command.toLowerCase()) {
        case '/help':
          return { lines: HELP_LINES, exit: false };
        case '/list':
          return { lines: this.listLines(), exit: false };
        case '/show': {
          const entry = this.#lookup(argument);
          if (!argument) return { lines: ['Usage: /show <number>'], exit: false };
          if (!entry) return { lines: [`Unknown setting: ${argument}. Use /list to see the numbers.`], exit: false };
          return { lines: this.describeLines(entry), exit: false };
        }
        case '/reset': {
          if (!argument) return { lines: ['Usage: /reset <number>'], exit: false };
          const result = await this.reset(argument, { confirm });
          return { lines: [result.message], exit: false };
        }
        case '/exit':
        case '/quit':
          return {
            lines: [`Settings saved to ${this.file}. Goodbye.`],
            exit: true,
          };
        default:
          return {
            lines: [`Unknown command ${command}. Try /help, /list, /show <n>, /reset <n> or /exit.`],
            exit: false,
          };
      }
    }

    const match = trimmed.match(/^(\d+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      return {
        lines: ['Format: <number> <value>. Type /help for commands, /list to see the numbers.'],
        exit: false,
      };
    }
    if (match[2] === undefined) {
      return {
        lines: ['Enter a value after the number; use /reset <number> to restore the default.'],
        exit: false,
      };
    }
    const result = await this.assign(match[1], match[2].trim());
    return { lines: [result.message], exit: false };
  }
}

/**
 * Run the numbered editor on a real terminal. Changes are saved as they are
 * entered, so Ctrl+C or EOF never discards a saved value; the terminal is
 * released on every exit path.
 */
export async function runSettingsEditor({
  store,
  makeRegistry,
  input = process.stdin,
  output = process.stdout,
  data = null,
}) {
  const loaded = data ? { data } : await store.read();
  const session = new SettingsSession({
    store,
    makeRegistry,
    data: loaded.data,
    file: store.file,
  });

  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let interrupted = false;
  rl.on('SIGINT', () => {
    interrupted = true;
    rl.close();
  });

  const ask = async (question) => {
    try {
      return await rl.question(question);
    } catch {
      return null;
    }
  };

  output.write(`${session.listLines().join('\n')}\n\n`);
  try {
    for (;;) {
      const line = await ask('settings > ');
      if (line === null) break;
      const result = await session.handleLine(line, {
        confirm: async (question) => {
          const answer = await ask(question);
          return ['y', 'yes'].includes(String(answer ?? '').trim().toLowerCase());
        },
      });
      for (const row of result.lines) output.write(`${row}\n`);
      output.write('\n');
      if (result.exit) break;
    }
  } finally {
    try {
      rl.close();
    } catch {
      // Already closed by SIGINT.
    }
    input.pause?.();
  }
  if (interrupted) output.write('\nSettings closed; every saved change is already on disk.\n');
  return session;
}
