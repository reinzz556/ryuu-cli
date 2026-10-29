import { Chalk } from 'chalk';
import { PASTE_END, PASTE_START, PasteRegistry } from './input.js';
import { charWidth, displayWidth } from './width.js';
import { renderMarkdown } from './markdown.js';
import { readVersion } from '../utils/version.js';
import { copyToClipboard } from '../services/clipboard.js';
import {
  cleanModelTokens,
  cleanReasoning,
  commandOutputLines,
  formatSeconds,
  formatTokens,
  wrapText,
} from './renderer.js';

/**
 * Full-screen, retained-mode UI (`--tui`).
 *
 * The classic Renderer appends lines to the terminal's scrollback and forgets
 * them. Here the conversation is a data structure: every task, reasoning pass,
 * tool output and answer is an item with a stable id, and each frame is drawn
 * from that model. Expanding a block is a flag on the item, so any number of
 * blocks can be open at once and old ones stay openable for the whole session.
 */

const PREVIEW_LINES = 5;
/** Kept code for a copy target; OSC 52 payloads are capped at the same size. */
const MAX_CODE_COPY_CHARS = 100_000;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * One colour per kind of line, so a glance tells blocks apart:
 * prose white, Markdown accents and tables sky blue, tool names yellow,
 * reasoning green, failures red. This palette is the only place colours live.
 */
const PALETTE = {
  white: '#e2e8f0',
  sky: '#38bdf8',
  yellow: '#fbbf24',
  green: '#4ade80',
  red: '#ef4444',
  redSoft: '#fca5a5',
  gray: '#9ca3af',
  violet: '#a78bfa',
  amber: '#f59e0b',
  orange: '#fb923c',
  pink: '#f472b6',
  blue: '#60a5fa',
};

/** Status bar colours: every phase reads differently. */
const PHASE_COLORS = {
  thinking: PALETTE.violet,
  working: PALETTE.yellow,
  retrying: PALETTE.amber,
  reconnecting: PALETTE.orange,
};

/** `ryuu` in the composer: pink → violet → blue. */
const PROMPT_GRADIENT = [
  [244, 114, 182],
  [167, 139, 250],
  [96, 165, 250],
];

/** The banner wordmark keeps the classic cyan → violet → pink sweep. */
const WORDMARK_GRADIENT = [
  [34, 211, 238],
  [167, 139, 250],
  [244, 114, 182],
];

/** Dividers between blocks: pink → violet → sky blue. */
const RULE_GRADIENT = [
  [244, 114, 182],
  [167, 139, 250],
  [56, 189, 248],
];

const WORDMARK = [
  '██████╗ ██╗   ██╗██╗   ██╗██╗   ██╗',
  '██╔══██╗╚██╗ ██╔╝██║   ██║██║   ██║',
  '██████╔╝ ╚████╔╝ ██║   ██║██║   ██║',
  '██╔══██╗  ╚██╔╝  ██║   ██║██║   ██║',
  '██║  ██║   ██║   ╚██████╔╝╚██████╔╝',
  '╚═╝  ╚═╝   ╚═╝    ╚═════╝  ╚═════╝',
];

const WORDMARK_COMPACT = ['╦═╗ ╦ ╦ ╦ ╦', '╠╦╝ ╚╦╝ ╚╦╝', '╩╚═  ╩   ╩'];

/** Cut a styled line to `width` columns without splitting an ANSI sequence. */
export function clipLine(text, width) {
  const value = String(text ?? '');
  if (displayWidth(value, { ansi: true }) <= width) return value;
  let output = '';
  let used = 0;
  let index = 0;
  while (index < value.length) {
    if (value[index] === '\x1b') {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(value.slice(index));
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    const code = value.codePointAt(index);
    const char = String.fromCodePoint(code);
    const size = charWidth(code);
    if (used + size > Math.max(0, width - 1)) break;
    output += char;
    used += size;
    index += char.length;
  }
  return `${output}\x1b[0m…`;
}

/** Paint `text` with a multi-stop colour gradient, one colour per character. */
export function gradient(c, text, stops) {
  const chars = [...String(text ?? '')];
  if (chars.length === 0) return '';
  const span = Math.max(1, chars.length - 1);
  return chars
    .map((char, index) => {
      const position = (index / span) * (stops.length - 1);
      const from = Math.min(stops.length - 2, Math.floor(position));
      const local = position - from;
      const rgb = stops[from].map((start, channel) =>
        Math.round(start + (stops[from + 1][channel] - start) * local),
      );
      return c.hex(`#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`)(char);
    })
    .join('');
}

const ANSI_TOKEN = /\x1b\[[0-?]*[ -/]*[@-~]/y;

/**
 * Wrap styled text to `width` columns without cutting escape sequences, and
 * re-open the colours that were active at the break so wrapped rows keep them.
 */
export function wrapAnsi(text, width) {
  const max = Math.max(8, Math.floor(width));
  const output = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    if (!rawLine) {
      output.push('');
      continue;
    }
    const tokens = [];
    for (let index = 0; index < rawLine.length; ) {
      if (rawLine[index] === '\x1b') {
        ANSI_TOKEN.lastIndex = index;
        const match = ANSI_TOKEN.exec(rawLine);
        if (match) {
          tokens.push({ ansi: match[0] });
          index = ANSI_TOKEN.lastIndex;
          continue;
        }
      }
      const code = rawLine.codePointAt(index);
      const char = String.fromCodePoint(code);
      tokens.push({ char, width: Math.max(1, charWidth(code)) });
      index += char.length;
    }

    let line = [];
    let used = 0;
    let style = '';
    let lineStyle = '';

    const flush = () => {
      if (line.length === 0) return;
      let end = line.length;
      while (end > 0 && line[end - 1].char === ' ') end -= 1;
      const body = line
        .slice(0, end)
        .map((token) => token.ansi ?? token.char)
        .join('');
      output.push(`${lineStyle}${body}${style ? '\x1b[0m' : ''}`);
      line = [];
      used = 0;
      lineStyle = style;
    };

    for (const token of tokens) {
      if (token.ansi) {
        line.push(token);
        style = /^\x1b\[(?:0|)m$/.test(token.ansi) ? '' : `${style}${token.ansi}`.slice(-320);
        continue;
      }
      if (used + token.width > max) {
        let breakAt = -1;
        for (let index = line.length - 1; index >= 0; index -= 1) {
          if (line[index].char === ' ') {
            breakAt = index;
            break;
          }
        }
        if (breakAt > 0 && token.char !== ' ') {
          const carry = line.slice(breakAt + 1);
          line = line.slice(0, breakAt);
          flush();
          line = carry;
          used = carry.reduce((sum, item) => sum + (item.width || 0), 0);
        } else {
          flush();
          if (token.char === ' ') continue;
        }
      }
      line.push(token);
      used += token.width;
    }
    flush();
  }
  return output;
}

function bannerTop(title, meta, width, c) {
  let label = title;
  let metaText = meta;
  let head = ` ╭─ ${label} `;
  let tail = metaText ? ` ${metaText} ─╮` : '─╮';
  // Narrow terminals drop the version, then shrink the title, instead of
  // spilling past the right edge.
  if (width - displayWidth(head) - displayWidth(tail) < 1) {
    metaText = '';
    tail = '─╮';
  }
  if (width - displayWidth(head) - displayWidth(tail) < 1) {
    label = clipLine(label, Math.max(4, width - 9)).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    head = ` ╭─ ${label} `;
  }
  const fill = Math.max(1, width - displayWidth(head) - displayWidth(tail));
  return (
    ` ${c.hex(PALETTE.sky)('╭─')} ${c.bold(c.hex(PALETTE.white)(label))} ` +
    `${c.dim('─'.repeat(fill))}` +
    `${metaText ? c.hex(PALETTE.gray)(` ${metaText} `) : ''}${c.hex(PALETTE.sky)('─╮')}`
  );
}

function bannerMid(title, width, c) {
  const head = ` ├─ ${title} `;
  const fill = Math.max(1, width - displayWidth(head) - 2);
  return (
    ` ${c.hex(PALETTE.sky)('├─')} ${c.bold(c.hex(PALETTE.white)(title))} ` +
    `${c.dim('─'.repeat(fill))}${c.hex(PALETTE.sky)('─┤')}`
  );
}

function bannerBottom(width, c) {
  return ` ${c.hex(PALETTE.sky)(`╰${'─'.repeat(Math.max(1, width - 3))}╯`)}`;
}

function bannerRow(content, width, c) {
  const inner = Math.max(4, width - 4);
  const clipped = displayWidth(content, { ansi: true }) > inner ? clipLine(content, inner) : content;
  const pad = Math.max(0, inner - displayWidth(clipped, { ansi: true }));
  return ` ${c.hex(PALETTE.sky)('│')} ${clipped}${' '.repeat(pad)}${c.hex(PALETTE.sky)('│')}`;
}

/** The opening frame: wordmark, tagline and telemetry, all width-aware. */
export function bannerRows(header = {}, width, { c } = {}) {
  const rows = [];
  const inner = Math.max(6, width - 4);
  const paint = (name, text) => c.hex(PALETTE[name])(String(text));
  rows.push(bannerTop('◢ RYUU // AGENT OS', `v${header.version}`, width, c));
  rows.push(bannerRow('', width, c));

  const art = inner >= 44 ? WORDMARK : inner >= 16 ? WORDMARK_COMPACT : null;
  if (art) {
    const artWidth = Math.max(...art.map((line) => line.length));
    const pad = Math.max(0, Math.floor((inner - artWidth) / 2));
    for (const line of art) {
      rows.push(bannerRow(`${' '.repeat(pad)}${gradient(c, line, WORDMARK_GRADIENT)}`, width, c));
    }
  } else {
    rows.push(bannerRow(` ${c.bold(gradient(c, 'RYUU', WORDMARK_GRADIENT))}`, width, c));
  }
  rows.push(bannerRow('', width, c));

  const tagline = 'autonomous coding intelligence · NVIDIA';
  if (inner >= tagline.length) {
    rows.push(
      bannerRow(c.dim(`${' '.repeat(Math.floor((inner - tagline.length) / 2))}${tagline}`), width, c),
    );
    rows.push(bannerRow('', width, c));
  }

  rows.push(bannerMid('◆ TELEMETRY', width, c));
  const fields = [
    ['model', header.model || '—'],
    ['workspace', header.workspace || '—'],
    ['runtime', header.node ? `Node.js ${header.node} · ${process.platform}` : '—'],
    ['access', `${header.approvalPolicy || 'ask'} · shell is not a sandbox`],
  ];
  if (header.logFile) fields.push(['log', header.logFile]);
  const valueWidth = Math.max(8, inner - 11);
  for (const [label, value] of fields) {
    const wrapped = wrapText(String(value ?? ''), valueWidth);
    rows.push(bannerRow(`${paint('sky', label.padEnd(10))} ${wrapped[0] || ''}`, width, c));
    for (const extra of wrapped.slice(1)) rows.push(bannerRow(`${' '.repeat(11)}${extra}`, width, c));
  }
  rows.push(bannerBottom(width, c));
  const hint =
    'type a task · /help commands · !cmd shell · click a prompt or code block to copy · PgUp/PgDn scroll';
  for (const line of wrapText(hint, Math.max(10, width - 2))) rows.push(` ${paint('gray', line)}`);
  return rows;
}

/** The conversation model: ordered items, each with a stable id. */
export class Transcript {
  constructor() {
    this.items = [];
    this.byId = new Map();
    this.nextId = 1;
  }

  add(entry) {
    const item = { id: this.nextId, expanded: false, version: 0, collapsible: false, ...entry };
    this.nextId += 1;
    this.items.push(item);
    this.byId.set(item.id, item);
    return item;
  }

  get(id) {
    return this.byId.get(Number(id)) || null;
  }

  list() {
    return this.items.slice();
  }

  toggle(id) {
    const item = this.get(id);
    if (!item || !item.collapsible) return false;
    item.expanded = !item.expanded;
    item.version += 1;
    return true;
  }

  expand(id, open = true) {
    const item = this.get(id);
    if (!item || !item.collapsible) return false;
    item.expanded = Boolean(open);
    item.version += 1;
    return true;
  }

  collapseAll() {
    let changed = false;
    for (const item of this.items) {
      if (!item.expanded) continue;
      item.expanded = false;
      item.version += 1;
      changed = true;
    }
    return changed;
  }

  message(text, kind = 'info') {
    return this.add({ kind, text: String(text ?? ''), version: 0 });
  }

  task(task, meta = '') {
    return this.add({ kind: 'task', text: String(task ?? ''), meta, version: 0 });
  }

  banner(header = {}) {
    return this.add({ kind: 'banner', header: { ...header }, version: 0 });
  }

  plan(steps = []) {
    return this.add({ kind: 'plan', steps: steps.slice(0, 12), version: 0 });
  }

  reasoningStart() {
    return this.add({ kind: 'reasoning', text: '', chars: 0, active: true, collapsible: true });
  }

  reasoningAppend(item, text) {
    if (!item || !text) return;
    item.text += text;
    item.chars = item.text.length;
    item.version += 1;
  }

  reasoningEnd(item, { partial = false } = {}) {
    if (!item) return;
    item.active = false;
    item.partial = Boolean(partial);
    item.version += 1;
  }

  answerStart() {
    return this.add({ kind: 'answer', text: '', version: 0 });
  }

  answerAppend(item, text) {
    if (!item || !text) return;
    item.text += text;
    item.version += 1;
  }

  command({ argv = [], stdout = '', stderr = '', exitCode = null, status = '', processId = null, timedOut = false, truncated = false, expanded = false } = {}) {
    const command = Array.isArray(argv) ? argv.join(' ') : String(argv ?? '');
    const { lines, dropped } = commandOutputLines(stdout, stderr);
    return this.add({
      kind: 'command',
      command,
      output: lines,
      dropped,
      exitCode,
      status,
      processId,
      timedOut: Boolean(timedOut),
      truncated: Boolean(truncated),
      expanded: Boolean(expanded),
      collapsible: true,
    });
  }

  shell({ command, stdout = '', stderr = '', exitCode = null, durationMs = 0, truncated = false, signal = null, error = null } = {}) {
    const { lines, dropped } = commandOutputLines(stdout, stderr);
    return this.add({
      kind: 'shell',
      command,
      output: lines,
      dropped,
      exitCode,
      durationMs,
      truncated: Boolean(truncated),
      signal,
      error,
      expanded: true,
      collapsible: true,
    });
  }
}

function exitLabel(item) {
  if (Number.isInteger(item.exitCode)) return `exit ${item.exitCode}`;
  if (item.timedOut) return 'timed out';
  if (item.signal) return `signal ${item.signal}`;
  return item.status || 'no exit';
}

/** Rows of one item, cached until its content or the width changes. */
export function itemRows(item, width, { c, color }) {
  const key = `${item.version}|${width}|${item.expanded ? 1 : 0}`;
  if (item._cache?.key === key) return item._cache.rows;
  const rows = buildRows(item, width, { c, color });
  item._cache = { key, rows };
  return rows;
}

function buildRows(item, width, { c, color }) {
  const rows = [];
  const id = item.id;
  const paint = (name, text) => c.hex(PALETTE[name] || PALETTE.white)(String(text));
  const chevron = item.collapsible ? (item.expanded ? '▾' : '▸') : '·';
  const inner = Math.max(10, width - 2);
  const dim = (text) => paint('gray', text);
  // Headers wrap too: a long session id or summary must never be cut off.
  const pushHeader = (text) => {
    for (const line of wrapAnsi(text, width - 2)) rows.push(` ${line}`);
  };
  const pushWrapped = (text, prefix, paintName, { dimmed = false } = {}) => {
    for (const line of wrapAnsi(text, inner - prefix.trimEnd().length)) {
      rows.push(`${prefix}${dimmed ? c.dim(paint(paintName, line)) : paint(paintName, line)}`);
    }
  };

  if (item.kind === 'banner') return bannerRows(item.header, width, { c, color });

  if (item.kind === 'task') {
    const head =
      `${paint('violet', '▸')} ${c.bold(paint('violet', 'TASK'))}` +
      `${item.meta ? ` ${dim(item.meta)}` : ''}`;
    // The chip is the visible button; the whole task block is the hit target.
    // It shrinks to the glyph alone before the header is allowed to wrap.
    const headWidth = displayWidth(head, { ansi: true });
    const chipLabel = [' ⧉ copy ', ' ⧉ '].find((label) => width - 1 - headWidth - displayWidth(label) >= 1);
    if (chipLabel) {
      const room = width - 1 - headWidth - displayWidth(chipLabel);
      rows.push(` ${head}${' '.repeat(room)}${c.bgHex('#1e293b')(paint('gray', chipLabel))}`);
    } else {
      for (const line of wrapAnsi(head, width - 1)) rows.push(` ${line}`);
    }
    for (const line of wrapText(cleanModelTokens(item.text), inner - 2)) {
      rows.push(`   ${c.bold(paint('white', line))}`);
    }
    return rows;
  }

  if (item.kind === 'plan') {
    pushHeader(`${paint('violet', '◆')} ${c.bold(paint('violet', 'PLAN'))}`);
    for (const step of item.steps || []) pushWrapped(step, '   ', 'sky');
    return rows;
  }

  if (item.kind === 'reasoning') {
    const wrapped = wrapText(cleanReasoning(item.text || '').trim(), inner - 2);
    const hidden = Math.max(0, wrapped.length - PREVIEW_LINES);
    const shown = item.expanded ? wrapped : wrapped.slice(-PREVIEW_LINES);
    const status = [
      `${formatTokens(item.chars || 0)} chars`,
      item.active ? 'live' : null,
      item.partial ? 'partial' : null,
      item.expanded ? 'click to collapse' : 'click to expand',
    ]
      .filter(Boolean)
      .join(' · ');
    pushHeader(
      `${paint('white', chevron)} ${paint('green', '◈')} ${c.bold(paint('white', `reasoning #${id}`))} ` +
        paint('white', `· ${status}`),
    );
    if (shown.length === 0) rows.push(`   ${dim('(no reasoning text)')}`);
    for (const line of shown) rows.push(`   ${paint('green', line)}`);
    if (!item.expanded && hidden > 0) {
      rows.push(`   ${dim(`… ${hidden} more line(s) · click or /expand ${id}`)}`);
    }
    return rows;
  }

  if (item.kind === 'command' || item.kind === 'shell') {
    const head = item.kind === 'shell' ? 'shell' : 'run_command';
    const failed =
      Number.isInteger(item.exitCode) && item.exitCode !== 0
        ? true
        : Boolean(item.error || item.signal || item.timedOut);
    const meta = [exitLabel(item), `${item.output.length} line(s)`];
    if (item.dropped > 0) meta.push(`${item.dropped} dropped`);
    const name = failed ? c.bold(paint('red', head)) : c.bold(paint('yellow', head));
    pushHeader(`${paint('sky', chevron)} ${name} ${dim(`#${id} · ${meta.join(' · ')}`)}`);
    const commandLines = wrapAnsi(item.command, inner - 4);
    rows.push(`   ${paint('sky', '$')} ${paint('sky', commandLines[0] || '')}`);
    for (const extra of commandLines.slice(1)) rows.push(`     ${paint('sky', extra)}`);
    if (item.output.length === 0) rows.push(`   ${dim('(no output)')}`);
    const body = item.expanded ? item.output : item.output.slice(-PREVIEW_LINES);
    for (const row of body) {
      const tone = row.stream === 'stderr' || failed ? 'redSoft' : 'gray';
      for (const line of wrapAnsi(row.text, inner - 4)) {
        rows.push(
          `   ${row.stream === 'stderr' ? paint('redSoft', '! ') : ''}${c.dim(paint(tone, line))}`,
        );
      }
    }
    const hidden = item.output.length - body.length;
    if (!item.expanded && hidden > 0) {
      rows.push(`   ${dim(`… ${hidden} more line(s) · click or /expand ${id}`)}`);
    }
    if (item.truncated) rows.push(`   ${dim('capture truncated')}`);
    if (item.error) for (const line of wrapAnsi(`error: ${item.error}`, inner - 2)) rows.push(`   ${paint('redSoft', line)}`);
    return rows;
  }

  if (item.kind === 'answer') {
    // Every block carries a small label, like reasoning does, so white response
    // text is never mistaken for the tail of a tool or a notice.
    pushHeader(`${paint('violet', '◆')} ${c.bold(paint('white', 'response'))}`);
    // Assistant prose: white text, sky-blue Markdown accents and tables.
    // Every rendered row of a fenced code block is remembered so a click on its
    // `⧉ copy` chip (or anywhere in the block) copies exactly that code.
    const copies = new Map();
    const lines = renderMarkdown(item.text || '', {
      width: Math.max(20, width - 2),
      c,
      color,
      base: (text) => paint('white', text),
      accent: (text) => paint('sky', text),
      onCodeBlock: ({ lang, code, start, end }) => {
        const target = { lang, code: String(code ?? '').slice(0, MAX_CODE_COPY_CHARS) };
        for (let row = start; row <= end; row += 1) copies.set(row, target);
      },
    });
    for (const line of lines) rows.push(line ? ` ${line}` : '');
    if (copies.size > 0) rows.copies = copies;
    return rows;
  }

  if (item.kind === 'tool') {
    const failed = item.ok === false;
    const mark = failed ? paint('red', '✕') : paint('green', '✓');
    const name = failed ? c.bold(paint('red', item.name)) : paint('yellow', item.name);
    if (failed) {
      pushHeader(`${mark} ${name}${item.durationMs ? ` ${dim(`· ${formatSeconds(item.durationMs)}`)}` : ''}`);
      pushWrapped(item.summary || 'tool failed', '   ', 'redSoft', { dimmed: true });
    } else {
      const detail = [formatSeconds(item.durationMs), item.summary].filter(Boolean).join(' · ');
      pushHeader(`${mark} ${name}${detail ? ` ${dim(`· ${detail}`)}` : ''}`);
    }
    return rows;
  }

  if (item.kind === 'error') {
    pushHeader(`${paint('red', '✕')} ${c.bold(paint('red', 'runtime fault'))}${item.code ? paint('red', ` · ${item.code}`) : ''}`);
    pushWrapped(item.text || '', '   ', 'redSoft');
    return rows;
  }

  // Info, notices and raw command output arrive pre-styled; wrap, never clip.
  for (const line of wrapAnsi(String(item.text ?? ''), inner)) rows.push(line ? ` ${line}` : '');
  return rows;
}

/**
 * The divider drawn between two blocks of a different kind: a full-width rule in
 * the pink → violet → sky-blue sweep, so it reads as a boundary rather than text.
 */
export function blockRule(width, c) {
  return ` ${gradient(c, '─'.repeat(Math.max(4, width - 2)), RULE_GRADIENT)}`;
}

/** The label that opens a run of tool calls, e.g. `⚙ Using tools · 3 calls`. */
export function toolHeader(count, { c } = {}) {
  const label = c.bold(gradient(c, '⚙ Using tools', RULE_GRADIENT));
  return ` ${label} ${c.dim(`· ${count} call${count === 1 ? '' : 's'}`)}`;
}

/**
 * Flatten every item into screen rows, each tagged with its item id.
 *
 * Blocks are separated by a blank row plus a gradient rule so a change of kind
 * (white answer, green reasoning, yellow tool) is obvious. Consecutive tool calls
 * are one block: they share a single `Using tools` header and no divider.
 */
export function layoutTranscript(transcript, width, opts) {
  const rows = [];
  let previous = null;
  for (let index = 0; index < transcript.items.length; index += 1) {
    const item = transcript.items[index];
    const itemLines = itemRows(item, width, opts);
    if (itemLines.length === 0) continue;
    const continuesToolBlock = previous?.kind === 'tool' && item.kind === 'tool';
    if (rows.length > 0 && !continuesToolBlock) {
      rows.push({ text: '', itemId: null });
      rows.push({ text: blockRule(width, opts.c), itemId: null });
    }
    if (item.kind === 'tool' && !continuesToolBlock) {
      let calls = 0;
      for (let look = index; look < transcript.items.length && transcript.items[look].kind === 'tool'; look += 1) {
        calls += 1;
      }
      rows.push({ text: toolHeader(calls, opts), itemId: null });
    }
    for (let row = 0; row < itemLines.length; row += 1) {
      rows.push({ text: itemLines[row], itemId: item.id, copy: itemLines.copies?.get(row) ?? null });
    }
    previous = item;
  }
  return rows;
}

class AltScreen {
  constructor({ output }) {
    this.output = output;
    this.previous = [];
  }

  enter() {
    this.output.write('\x1b[?1049h\x1b[2J');
  }

  leave() {
    this.output.write('\x1b[?1049l');
  }

  clear() {
    this.previous = [];
    this.output.write('\x1b[2J');
  }

  /** Write only the rows that changed, then park the cursor in the composer. */
  draw(lines, cursor) {
    let out = '\x1b[?25l';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (this.previous[index] === line) continue;
      out += `\x1b[${index + 1};1H${line}\x1b[K`;
      this.previous[index] = line;
    }
    // A shrinking frame (a one-row composer after a three-row one) must not
    // leave stale rows behind.
    if (this.previous.length > lines.length) {
      for (let index = lines.length; index < this.previous.length; index += 1) {
        out += `\x1b[${index + 1};1H\x1b[K`;
      }
      this.previous.length = lines.length;
    }
    out += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
    this.output.write(out);
  }
}

/**
 * The `--tui` app: renderer + prompt + input loop in one object.
 *
 * It implements the same interface as Renderer + PromptSession, so `createApp`
 * only has to choose which pair to build.
 */
export class Tui {
  constructor({ input, output, version = readVersion(), color = null, onSigint = null } = {}) {
    this.input = input;
    this.output = output;
    this.version = version;
    this.onSigint = onSigint;
    this.terminal = Boolean(input?.isTTY && output?.isTTY);
    this.color = color === false ? false : Boolean(this.terminal);
    const depth = typeof output?.getColorDepth === 'function' ? output.getColorDepth() : 1;
    // Truecolor when the terminal says so, so the palette keeps its exact hues.
    this.c = new Chalk({ level: this.color ? (depth >= 24 ? 3 : depth >= 8 ? 2 : 1) : 0 });
    this.transcript = new Transcript();
    this.registry = new PasteRegistry();
    this.screen = new AltScreen({ output: this.output });
    this.header = { version, model: '', workspace: '', provider: '', approvalPolicy: '', node: '', logFile: null };

    this.questionText = '';
    this.composer = { text: '', cursor: 0 };
    this.history = [];
    this.historyIndex = 0;
    this.historyDraft = '';
    this.modal = null;
    this.askWaiter = null;
    this.lineQueue = [];
    this.status = {
      phase: null,
      startedAt: 0,
      step: null,
      maxSteps: null,
      tool: '',
      promptTokens: 0,
      completionTokens: 0,
      frame: 0,
      output: '',
    };
    this.taskActive = false;
    this.toast = null;
    this.streamedAny = false;
    this.reasoningItem = null;
    this.answerItem = null;
    this.scroll = 0;
    this.maxScroll = 0;
    this.lastTotal = 0;
    this.viewport = 1;
    this.clickMap = [];
    this.copyMap = [];
    this.closed = false;
    this.frameTimer = null;
    this.buffer = '';
    this.paste = null;
    this.escTimer = null;

    this.onData = (chunk) => this.push(chunk);
    this.onResize = () => {
      this.screen.clear();
      this.forceRender();
    };
    this.ticker = setInterval(() => {
      if (this.closed) return;
      if (this.toast && Date.now() > this.toast.until) {
        this.toast = null;
        this.requestRender();
        return;
      }
      if (!this.status.phase) return;
      this.status.frame += 1;
      this.requestRender();
    }, 120);
    this.ticker.unref?.();

    if (this.terminal) {
      this.screen.enter();
      this.output.write('\x1b[?2004h\x1b[?1000h\x1b[?1006h');
      try {
        this.input.setRawMode?.(true);
        this.input.resume?.();
      } catch {
        // A non-standard stream may refuse raw mode; rendering still works.
      }
      this.input.on('data', this.onData);
      this.output.on('resize', this.onResize);
      this.forceRender();
    }
  }

  // ── prompt / ask ─────────────────────────────────────────────────────────

  /** Painter: every colour in the TUI comes from PALETTE through here. */
  paint(name, text) {
    return this.c.hex(PALETTE[name] || PALETTE.white)(String(text ?? ''));
  }

  prompt() {
    return 'ryuu > ';
  }

  async ask(question) {
    this.questionText = String(question ?? '');
    this.requestRender();
    if (this.lineQueue.length > 0) return this.lineQueue.shift();
    return new Promise((resolve) => {
      this.askWaiter = resolve;
    });
  }

  async confirm(question) {
    const previous = this.questionText;
    this.questionText = String(question ?? '');
    this.modal = { resolve: null };
    this.requestRender();
    const answer = await new Promise((resolve) => {
      this.modal.resolve = resolve;
    });
    this.modal = null;
    this.questionText = previous;
    this.requestRender();
    const text = String(answer ?? '').trim().toLowerCase();
    if (text === 'y' || text === 'yes') return { answer: text, value: true };
    if (text === 'a') return { answer: text, value: true, all: true };
    return { answer: text || 'n', value: false };
  }

  // Unused by the TUI (it is the prompt), kept for interface parity.
  metrics() {
    return { active: false, rows: 0, cursorRow: 0 };
  }

  repaint() {}

  resetCursor() {}

  setPromptController() {}

  reset() {
    if (this.modal) {
      const modal = this.modal;
      this.modal = null;
      modal.resolve('');
    }
    this.composer = { text: '', cursor: 0 };
    this.requestRender();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (this.ticker) clearInterval(this.ticker);
    if (this.escTimer) clearTimeout(this.escTimer);
    this.screen.clear();
    this.output.write('\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h');
    this.screen.leave();
    this.input?.off?.('data', this.onData);
    this.output?.off?.('resize', this.onResize);
    try {
      this.input?.setRawMode?.(false);
    } catch {
      // ignore
    }
    // The stream was resumed in the constructor; pausing it lets the process
    // exit on its own after /exit instead of hanging on a blank screen.
    this.input?.pause?.();
    if (this.modal) {
      const modal = this.modal;
      this.modal = null;
      modal.resolve(null);
    }
    if (this.askWaiter) {
      const waiter = this.askWaiter;
      this.askWaiter = null;
      waiter(null);
    }
  }

  // ── renderer interface ───────────────────────────────────────────────────

  banner({ version, model, provider, workspace, node, approvalPolicy, logFile = null } = {}) {
    this.header = {
      version: version || this.version,
      model,
      provider,
      workspace,
      node,
      approvalPolicy,
      logFile,
    };
    this.transcript.banner(this.header);
    this.requestRender();
  }

  lines(text = '') {
    this.transcript.message(text);
    this.requestRender();
  }

  info(message) {
    this.transcript.message(` ${this.paint('sky', '◇')} ${this.paint('white', message)}`);
    this.requestRender();
  }

  success(message) {
    this.transcript.message(` ${this.paint('green', '✓')} ${this.paint('green', message)}`);
    this.requestRender();
  }

  warn(message) {
    this.transcript.message(` ${this.paint('amber', '▲')} ${this.paint('amber', message)}`);
    this.requestRender();
  }

  warning({ message } = {}) {
    this.warn(message || '');
  }

  muted(message) {
    this.transcript.message(` ${this.paint('gray', message)}`);
    this.requestRender();
  }

  error({ error } = {}) {
    this.transcript.add({
      kind: 'error',
      code: error?.code || 'ERROR',
      text: error?.message || String(error || 'Unknown error'),
      version: 0,
    });
    this.status.phase = null;
    this.requestRender();
  }

  taskStart({ task, sessionId, maxSteps }) {
    this.taskActive = true;
    this.answerItem = null;
    this.streamedAny = false;
    this.reasoningItem = null;
    this.status.startedAt = Date.now();
    this.status.step = 0;
    this.status.maxSteps = maxSteps || null;
    this.status.promptTokens = 0;
    this.status.completionTokens = 0;
    this.status.tool = '';
    this.transcript.task(task, `session ${sessionId} · ${maxSteps ? `max ${maxSteps} steps` : '∞ autonomous'}`);
    this.requestRender();
  }

  stepStart({ step, maxSteps }) {
    this.status.step = step;
    this.status.maxSteps = maxSteps || null;
    this.requestRender();
  }

  plan({ plan } = {}) {
    if (!plan) return;
    this.transcript.plan(String(plan).split('\n').filter(Boolean));
    this.requestRender();
  }

  thinkingStart({ step = null, maxSteps = null } = {}) {
    if (step !== null) this.status.step = step;
    if (maxSteps !== null) this.status.maxSteps = maxSteps;
    this.setPhase('thinking');
  }

  thinkingEnd({ durationMs = 0, firstTokenMs = null, usage = null } = {}) {
    if (usage) {
      this.status.promptTokens = usage.prompt ?? this.status.promptTokens;
      this.status.completionTokens = usage.completion ?? this.status.completionTokens;
    }
    const bits = [`${formatSeconds(durationMs)}`];
    if (firstTokenMs !== null && firstTokenMs !== undefined) bits.push(`first token ${formatSeconds(firstTokenMs)}`);
    if (usage) bits.push(`${formatTokens(usage.prompt)}↑ ${formatTokens(usage.completion)}↓`);
    this.transcript.message(` ${this.paint('sky', '◇')} ${this.paint('gray', `model · ${bits.join(' · ')}`)}`);
    this.requestRender();
  }

  workingStart({ tool = '', step = null, maxSteps = null } = {}) {
    if (step !== null) this.status.step = step;
    if (maxSteps !== null) this.status.maxSteps = maxSteps;
    this.status.tool = tool || '';
    this.setPhase('working');
  }

  workingEnd() {}

  progress({ step = null, maxSteps = null, promptTokens = null, completionTokens = null } = {}) {
    if (step !== null) this.status.step = step;
    if (maxSteps !== null) this.status.maxSteps = maxSteps;
    if (Number.isFinite(promptTokens)) this.status.promptTokens = promptTokens;
    if (Number.isFinite(completionTokens)) this.status.completionTokens = completionTokens;
    this.requestRender();
  }

  processOutput({ text = '' } = {}) {
    const line = String(text).trim().split('\n').pop();
    if (line) this.status.output = line.slice(-120);
    this.requestRender();
  }

  heartbeat({ phase = 'retry', attempt = 0, maxAttempts = 0, delayMs = 0, code = '', message = '' } = {}) {
    // Heartbeat notices are bold sky blue: transport news, not a fault.
    const beat = (text) => this.c.bold(this.paint('sky', text));
    if (phase === 'restored') {
      this.transcript.message(` ${beat('♥ link restored — the run continues')}`);
      this.setPhase('working');
      return;
    }
    if (phase === 'degraded') {
      this.transcript.message(` ${beat(`♥ ${code || 'degraded'}${message ? ` · ${message}` : ''}`)}`);
      this.setPhase('working');
      return;
    }
    const cap = Number(maxAttempts) > 0 ? `/${maxAttempts}` : ' (unlimited)';
    const what = code === 'EMPTY_RESPONSE' ? 'empty response' : 'reconnecting';
    this.transcript.message(
      ` ${beat(`♥ heartbeat · ${what} · attempt ${attempt}${cap} in ${formatSeconds(delayMs)}`)}`,
    );
    this.setPhase(code === 'EMPTY_RESPONSE' ? 'retrying' : 'reconnecting');
  }

  /** True when `item` is still the newest block (nothing was added after it). */
  isTail(item) {
    return Boolean(item) && this.transcript.items[this.transcript.items.length - 1] === item;
  }

  reasoningDelta({ text } = {}) {
    if (!text) return;
    if (this.reasoningItem && !this.isTail(this.reasoningItem)) this.reasoningItem = null;
    if (!this.reasoningItem) this.reasoningItem = this.transcript.reasoningStart();
    this.transcript.reasoningAppend(this.reasoningItem, text);
    this.requestRender();
  }

  reasoningEnd({ partial = false } = {}) {
    if (!this.reasoningItem) return;
    this.transcript.reasoningEnd(this.reasoningItem, { partial });
    this.reasoningItem = null;
    this.requestRender();
  }

  contentDelta({ text } = {}) {
    if (!text) return;
    // Another block (tool, plan, heartbeat note…) may have been added after the
    // open answer, which happens on every step that streams text and then calls
    // tools. Appending to the old block made the answer grow *above* those
    // blocks and look buried; a fresh block keeps the transcript chronological.
    if (this.answerItem && !this.isTail(this.answerItem)) this.answerItem = null;
    if (!this.answerItem) this.answerItem = this.transcript.answerStart();
    this.streamedAny = true;
    this.transcript.answerAppend(this.answerItem, text);
    this.requestRender();
  }

  answerEnd() {
    this.answerItem = null;
  }

  /** True once any text streamed during this task (survives a closed block). */
  streamedResponse() {
    return this.streamedAny;
  }

  note({ text } = {}) {
    if (!text) return;
    this.transcript.message(` ${this.paint('gray', text)}`);
    this.requestRender();
  }

  toolStart({ name = '', detail = '' } = {}) {
    this.status.tool = name;
    this.requestRender();
  }

  toolEnd({ name = '', ok = true, durationMs = 0, summary = '' } = {}) {
    this.status.tool = '';
    this.transcript.add({ kind: 'tool', name, ok, durationMs, summary, version: 0 });
    this.requestRender();
  }

  toolDenied({ name = '', reason = '' } = {}) {
    this.transcript.message(
      ` ${this.paint('amber', '⛔')} ${this.paint('amber', `${name} denied${reason ? ` · ${reason}` : ''}`)}`,
    );
    this.requestRender();
  }

  fileDiff({ kind = 'edit', path = '', diff = '', added = 0, removed = 0 } = {}) {
    const lines = [` ${this.paint('sky', '▲')} ${this.paint('gray', `${kind} ${path} · +${added} −${removed}`)}`];
    for (const line of String(diff).split('\n').slice(0, 30)) {
      const tone = line.startsWith('+') ? this.paint('green', line) : line.startsWith('-') ? this.paint('redSoft', line) : this.paint('gray', line);
      lines.push(`   ${tone}`);
    }
    this.transcript.message(lines.join('\n'));
    this.requestRender();
  }

  approvalRequest({ tool = '', risk = '', preview = '', reasons = [] } = {}) {
    const lines = [
      ` ${this.paint('amber', '▲')} ${this.c.bold(this.paint('amber', `approval needed · ${tool}`))} ${this.paint('gray', `(${risk})`)}`,
    ];
    for (const line of String(preview || '').split('\n').slice(0, 12)) lines.push(`   ${this.paint('gray', line)}`);
    if (reasons?.length) lines.push(`   ${this.paint('gray', reasons.join(' · '))}`);
    this.transcript.message(lines.join('\n'));
    this.requestRender();
  }

  commandOutput(payload = {}) {
    this.transcript.command(payload);
    this.requestRender();
  }

  shellResult({ command, cwd = '', stdout = '', stderr = '', exitCode = null, durationMs = 0, truncated = false, signal = null, error = null } = {}) {
    this.transcript.shell({ command, cwd, stdout, stderr, exitCode, durationMs, truncated, signal, error });
    this.requestRender();
  }

  webSearchStatus() {}

  stopActivity() {
    this.status.phase = null;
    this.status.tool = '';
    this.requestRender();
  }

  final(summary = {}) {
    this.taskActive = false;
    this.status.phase = null;
    this.status.tool = '';
    if (summary.finalText && !this.streamedResponse()) {
      this.transcript.add({ kind: 'answer', text: summary.finalText, version: 0 });
    }
    const tokens = summary.tokenUsage || {};
    const done = String(summary.status || 'completed') === 'completed';
    const tone = done ? 'green' : 'red';
    const lines = [
      ` ${this.paint(tone, done ? '◆' : '✕')} ${this.c.bold(this.paint(tone, String(summary.status || 'completed')))} ` +
        this.paint(
          'gray',
          `· ${summary.steps ?? 0} step(s) · ${formatSeconds(summary.durationMs)} · ` +
            `${formatTokens(tokens.prompt)}↑ ${formatTokens(tokens.completion)}↓`,
        ),
      `   ${this.paint('gray', `changed: ${summary.changedFiles?.length ? summary.changedFiles.slice(0, 8).join(', ') : 'none'}`)}`,
    ];
    if (summary.error) lines.push(`   ${this.paint('redSoft', `${summary.error.code}: ${summary.error.message}`)}`);
    this.transcript.message(lines.join('\n'));
    this.requestRender();
  }

  goodbye() {
    this.transcript.message(` ${this.paint('gray', 'session closed · see you in the next run')}`);
    this.requestRender();
  }

  // ── clipboard ────────────────────────────────────────────────────────────

  /** Short-lived confirmation shown in the status bar. */
  notify(text) {
    this.toast = { text, until: Date.now() + 2600 };
    this.requestRender();
  }

  /** Copy one prompt block to the terminal clipboard (OSC 52). */
  copyItem(item) {
    if (!item) return { ok: false, reason: 'no-task', chars: 0 };
    const result = copyToClipboard(item.text, { output: this.output });
    this.notify(
      result.ok
        ? `⧉ copied prompt #${item.id} · ${result.chars} chars`
        : 'clipboard blocked by this terminal (OSC 52)',
    );
    return result;
  }

  /** Copy one rendered fenced code block to the terminal clipboard. */
  copyCode({ lang = '', code = '' } = {}) {
    const result = copyToClipboard(String(code ?? ''), { output: this.output });
    const label = lang ? `${lang} code block` : 'code block';
    this.notify(
      result.ok
        ? `⧉ copied ${label} · ${result.chars} chars`
        : 'clipboard blocked by this terminal (OSC 52)',
    );
    return result;
  }

  /** Copy a sent prompt; `which` counts back from the newest (0 = latest). */
  copyTask(which = 0) {
    const tasks = this.transcript.items.filter((item) => item.kind === 'task');
    if (tasks.length === 0) {
      this.notify('no prompt to copy yet');
      return { ok: false, reason: 'no-task', chars: 0 };
    }
    const depth = Math.max(0, Math.min(Math.trunc(Number(which) || 0), tasks.length - 1));
    return this.copyItem(tasks[tasks.length - 1 - depth]);
  }

  // ── expandable blocks (commands use these) ───────────────────────────────

  hasBlock(id) {
    return Boolean(this.transcript.get(id));
  }

  listBlocks() {
    return this.transcript.list();
  }

  isBlockViewOpen() {
    return this.transcript.items.some((item) => item.expanded);
  }

  blockListText() {
    const items = this.transcript.items.filter((item) => item.collapsible);
    if (items.length === 0) return '  No blocks yet. Reasoning and shell/run_command output are listed here.';
    return [
      '  Expandable blocks (click one, or /expand <id>):',
      ...items.map((item) =>
        item.kind === 'reasoning'
          ? `  #${String(item.id).padEnd(3)} reasoning    ${item.chars || item.text.length} chars`
          : `  #${String(item.id).padEnd(3)} ${item.kind.padEnd(12)} ${item.command} · ${exitLabel(item)} · ${item.output.length} line(s)`,
      ),
    ].join('\n');
  }

  openBlockView(id) {
    const ok = this.transcript.expand(id, true);
    if (ok) this.requestRender();
    return ok;
  }

  toggleBlock(id) {
    const exists = Boolean(this.transcript.get(id));
    const ok = this.transcript.toggle(id);
    if (ok) this.requestRender();
    return { exists, open: Boolean(this.transcript.get(id)?.expanded) };
  }

  closeBlockView() {
    const changed = this.transcript.collapseAll();
    if (changed) this.requestRender();
    return changed;
  }

  scrollBlockView() {
    return false;
  }

  handleBlockViewKey() {
    return false;
  }

  handleMouse() {
    return false;
  }

  // ── input ────────────────────────────────────────────────────────────────

  setPhase(phase) {
    if (!this.status.phase) this.status.startedAt = Date.now();
    this.status.phase = phase;
    this.requestRender();
  }

  requestRender() {
    if (!this.terminal || this.closed || this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.render();
    }, 40);
    this.frameTimer.unref?.();
  }

  forceRender() {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.render();
  }

  render() {
    if (!this.terminal || this.closed) return;
    const width = Math.max(24, Number(this.output.columns) || 80);
    const height = Math.max(8, Number(this.output.rows) || 24);
    const headerRows = 1;
    const statusRows = 1;
    const composer = this.composerLines(width);
    const composerRows = composer.rows.length;
    const viewport = Math.max(1, height - headerRows - composerRows - statusRows);
    const rows = layoutTranscript(this.transcript, Math.max(10, width - 1), { c: this.c, color: this.color });
    const total = rows.length;
    if (this.scroll > 0 && total !== this.lastTotal) this.scroll += total - this.lastTotal;
    const maxScroll = Math.max(0, total - viewport);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    this.maxScroll = maxScroll;
    this.lastTotal = total;
    this.viewport = viewport;

    const end = total - this.scroll;
    const start = Math.max(0, end - viewport);
    const visible = rows.slice(start, end);
    this.clickMap = visible.map((row) => row.itemId);
    this.copyMap = visible.map((row) => row.copy ?? null);

    const frame = [clipLine(this.headerLine(width), width)];
    for (let index = 0; index < viewport; index += 1) {
      const row = visible[index];
      frame.push(row ? clipLine(row.text, width) : '');
    }
    for (const line of composer.rows) frame.push(clipLine(line, width));
    frame.push(clipLine(this.statusLine(width), width));

    this.screen.draw(frame, { row: headerRows + viewport + composer.row, col: composer.col });
  }

  headerLine(width) {
    const left =
      ` ${gradient(this.c, '◈', PROMPT_GRADIENT)} ` +
      `${this.c.bold(gradient(this.c, 'ryuu', PROMPT_GRADIENT))} ${this.paint('gray', `v${this.header.version}`)}`;
    const right = this.paint(
      'gray',
      [this.header.model, this.header.workspace].filter(Boolean).join(' · '),
    );
    const room = width - displayWidth(left, { ansi: true }) - displayWidth(right, { ansi: true }) - 2;
    // A narrow terminal keeps the identity and drops the meta instead of clipping.
    if (room < 12) return `${left} `;
    return `${left}${' '.repeat(room)}${right} `;
  }

  /**
   * The input line: a pink → blue `ryuu` prompt, gray text, and soft wrapping
   * so a long task stays readable across rows instead of scrolling off.
   */
  composerLines(width) {
    const rows = [];
    const question =
      this.questionText && this.questionText !== this.prompt() ? String(this.questionText).trim() : '';
    if (question) {
      for (const line of wrapAnsi(this.paint('white', question), Math.max(10, width - 2))) {
        rows.push(` ${line}`);
      }
    }

    const promptPlain = 'ryuu > ';
    const promptWidth = displayWidth(promptPlain);
    const prompt = `${gradient(this.c, 'ryuu', PROMPT_GRADIENT)} ${this.paint('gray', '>')} `;
    const avail = Math.max(8, width - promptWidth - 1);
    const chars = Array.from(this.composer.text);
    const cursor = Math.max(0, Math.min(this.composer.cursor, chars.length));

    // Greedy word wrap: break at the last space when the row has one, so a
    // task reads as words instead of being cut mid-token.
    const spans = [];
    let start = 0;
    let used = 0;
    let space = -1;
    for (let index = 0; index < chars.length; index += 1) {
      const size = Math.max(1, charWidth(chars[index].codePointAt(0)));
      if (used + size > avail) {
        if (space > start) {
          spans.push({ start, end: space });
          start = space + 1;
          used = 0;
          space = -1;
          for (let inner = start; inner < index; inner += 1) {
            if (chars[inner] === ' ') space = inner;
            used += Math.max(1, charWidth(chars[inner].codePointAt(0)));
          }
        } else {
          spans.push({ start, end: index });
          start = index;
          used = 0;
          space = -1;
        }
      }
      if (chars[index] === ' ') space = index;
      used += size;
    }
    spans.push({ start, end: chars.length });

    const cellAt = (target) => {
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        if (target <= span.end) {
          let col = 0;
          for (let at = span.start; at < Math.min(target, span.end); at += 1) {
            col += Math.max(1, charWidth(chars[at].codePointAt(0)));
          }
          return { row: index, col };
        }
      }
      const last = spans[spans.length - 1];
      let col = 0;
      for (let at = last.start; at < chars.length; at += 1) {
        col += Math.max(1, charWidth(chars[at].codePointAt(0)));
      }
      return { row: spans.length - 1, col };
    };

    const empty = chars.length === 0;
    const lines = spans.map((span) =>
      empty ? 'describe a task · /help · !cmd' : chars.slice(span.start, span.end).join(''),
    );
    lines.forEach((line, index) => {
      const prefix = index === 0 ? prompt : ' '.repeat(promptWidth);
      const body = this.paint('gray', line);
      rows.push(`${prefix}${empty ? this.c.dim(body) : body}`);
    });

    const cell = empty ? { row: 0, col: 0 } : cellAt(cursor);
    return {
      rows,
      row: rows.length - lines.length + cell.row,
      col: Math.min(width - 1, promptWidth + cell.col),
    };
  }

  statusLine(width) {
    const sep = this.paint('gray', ' · ');
    const parts = [];
    if (this.modal) {
      parts.push(this.paint('pink', 'approval · y/n/a'));
    } else if (this.status.phase) {
      const glyph = SPINNER[this.status.frame % SPINNER.length];
      const tone = PHASE_COLORS[this.status.phase] || PALETTE.sky;
      parts.push(
        `${this.c.hex(tone)(glyph)} ${this.c.hex(tone)(this.status.phase)} ` +
          `${this.paint('gray', formatSeconds(Date.now() - this.status.startedAt))}`,
      );
    } else {
      parts.push(this.paint('sky', '● ready'));
    }
    if (this.status.step) {
      parts.push(
        this.paint('blue', `step ${this.status.step}${this.status.maxSteps ? `/${this.status.maxSteps}` : ''}`),
      );
    }
    if (this.status.tool) parts.push(this.paint('yellow', this.status.tool));
    if (this.toast && Date.now() <= this.toast.until) parts.push(this.paint('green', this.toast.text));
    if (this.status.promptTokens || this.status.completionTokens) {
      parts.push(
        this.paint(
          'green',
          `${formatTokens(this.status.promptTokens)}↑ ${formatTokens(this.status.completionTokens)}↓`,
        ),
      );
    }
    const left = ` ${parts.join(sep)}`;
    const rightBits = [];
    if (this.scroll > 0) rightBits.push(this.paint('white', `scrolled ${this.scroll} · PgDn`));
    rightBits.push(this.paint('gray', 'Enter send · !cmd shell · PgUp scroll'));
    const right = `${rightBits.join(sep)} `;
    const room = width - displayWidth(left, { ansi: true }) - displayWidth(right, { ansi: true });
    if (room < 2) return clipLine(`${left} `, width);
    return `${left}${' '.repeat(room)}${right}`;
  }

  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.drain();
  }

  drain() {
    for (;;) {
      if (!this.buffer) return;
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
        this.insertPaste(text);
        continue;
      }
      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.paste = '';
        continue;
      }
      if (this.buffer[0] === '\x1b') {
        if (!this.handleEscape()) {
          this.armEscape();
          return;
        }
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
      this.handleControl(char);
    }
  }

  armEscape() {
    if (this.escTimer) return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.buffer === '\x1b') {
        this.buffer = '';
        this.handleKey('escape');
      }
    }, 40);
    this.escTimer.unref?.();
  }

  handleEscape() {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer);
    if (mouse) {
      this.buffer = this.buffer.slice(mouse[0].length);
      this.handleMouseReport(mouse);
      return true;
    }
    const keys = [
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
    for (const [sequence, name] of keys) {
      if (!this.buffer.startsWith(sequence)) continue;
      this.buffer = this.buffer.slice(sequence.length);
      this.handleKey(name);
      return true;
    }
    const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(this.buffer);
    if (csi) {
      this.buffer = this.buffer.slice(csi[0].length);
      return true;
    }
    if (this.buffer.length === 1) return false;
    this.buffer = this.buffer.slice(2); // Alt+key: ignored
    return true;
  }

  handleMouseReport(match) {
    const button = Number(match[1]);
    const y = Number(match[3]);
    const release = match[4] === 'm';
    if ((button & 64) === 64) {
      this.scrollBy((button & 1) === 0 ? 3 : -3);
      return;
    }
    if (release || (button & 3) !== 0) return;
    const index = y - 2; // one header row, 1-based screen row
    if (index < 0 || index >= this.viewport) return;
    // A code block is a copy target, exactly like a sent prompt: the chip is
    // only a label, the whole block is the hit area.
    const copyTarget = this.copyMap?.[index];
    if (copyTarget) {
      this.copyCode(copyTarget);
      return;
    }
    const id = this.clickMap[index];
    if (!id) return;
    const item = this.transcript.get(id);
    // A sent prompt is a copy target, not a foldable block.
    if (item?.kind === 'task') {
      this.copyItem(item);
      return;
    }
    this.transcript.toggle(id);
    this.requestRender();
  }

  handleControl(char) {
    if (char === '\r' || char === '\n') return this.submit();
    if (char === '\x7f' || char === '\x08') return this.backspace();
    if (char === '\x03') {
      this.composer = { text: '', cursor: 0 };
      this.onSigint?.();
      return this.requestRender();
    }
    if (char === '\x04') {
      if (!this.composer.text) this.onSigint?.();
      return this.requestRender();
    }
    if (char === '\x01') return this.setCursor(0);
    if (char === '\x05') return this.setCursor(this.composerChars().length);
    if (char === '\x0b') {
      this.composer.text = this.composerChars().slice(0, this.composer.cursor).join('');
      return this.requestRender();
    }
    if (char === '\x15') {
      this.composer = { text: '', cursor: 0 };
      return this.requestRender();
    }
    if (char === '\x19') return this.copyTask(0); // Ctrl+Y: copy the last prompt
    if (char === '\x17') return this.deleteWord();
    if (char === '\x0c') return this.forceRender();
    if (char === '\t') return this.insertText('  ');
    return undefined;
  }

  handleKey(name) {
    const chars = this.composerChars();
    if (name === 'left') return this.setCursor(this.composer.cursor - 1);
    if (name === 'right') return this.setCursor(this.composer.cursor + 1);
    if (name === 'home') return this.setCursor(0);
    if (name === 'end') return this.setCursor(chars.length);
    if (name === 'delete') {
      if (this.composer.cursor >= chars.length) return this.requestRender();
      this.composer.text = [...chars.slice(0, this.composer.cursor), ...chars.slice(this.composer.cursor + 1)].join('');
      return this.requestRender();
    }
    if (name === 'up') return this.historyPrev();
    if (name === 'down') return this.historyNext();
    if (name === 'pageup') return this.scrollBy(this.viewport - 2);
    if (name === 'pagedown') return this.scrollBy(-(this.viewport - 2));
    if (name === 'escape') {
      if (this.isBlockViewOpen()) {
        this.transcript.collapseAll();
        return this.requestRender();
      }
      this.scroll = 0;
      return this.requestRender();
    }
    return undefined;
  }

  scrollBy(delta) {
    this.scroll = Math.max(0, Math.min(this.scroll + delta, this.maxScroll));
    this.requestRender();
  }

  composerChars() {
    return Array.from(this.composer.text);
  }

  setCursor(index) {
    this.composer.cursor = Math.max(0, Math.min(index, this.composerChars().length));
    this.requestRender();
  }

  insertText(text) {
    if (!text) return;
    const clean = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, ' ');
    const chars = this.composerChars();
    const cursor = this.composer.cursor;
    this.composer.text = [...chars.slice(0, cursor), ...Array.from(clean), ...chars.slice(cursor)].join('');
    this.composer.cursor = cursor + Array.from(clean).length;
    this.requestRender();
  }

  insertPaste(text) {
    const value = String(text ?? '');
    if ([...value].length >= 1000) {
      const entry = this.registry.add(value);
      this.insertText(entry.placeholder);
      return;
    }
    this.insertText(value);
  }

  backspace() {
    const chars = this.composerChars();
    if (this.composer.cursor <= 0) return;
    this.composer.text = [...chars.slice(0, this.composer.cursor - 1), ...chars.slice(this.composer.cursor)].join('');
    this.composer.cursor -= 1;
    this.requestRender();
  }

  deleteWord() {
    const chars = this.composerChars();
    let index = this.composer.cursor;
    while (index > 0 && /\s/.test(chars[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(chars[index - 1])) index -= 1;
    this.composer.text = [...chars.slice(0, index), ...chars.slice(this.composer.cursor)].join('');
    this.composer.cursor = index;
    this.requestRender();
  }

  historyPrev() {
    if (this.history.length === 0) return this.requestRender();
    if (this.historyIndex === this.history.length) this.historyDraft = this.composer.text;
    this.historyIndex = Math.max(0, this.historyIndex - 1);
    this.composer = { text: this.history[this.historyIndex] || '', cursor: Array.from(this.history[this.historyIndex] || '').length };
    this.requestRender();
  }

  historyNext() {
    if (this.history.length === 0) return this.requestRender();
    this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    const text = this.historyIndex === this.history.length ? this.historyDraft : this.history[this.historyIndex];
    this.composer = { text: text || '', cursor: Array.from(text || '').length };
    this.requestRender();
  }

  submit() {
    const raw = this.composer.text;
    const trimmed = raw.trim();
    if (!trimmed && !this.modal) return this.requestRender();
    if (trimmed) {
      this.history.push(raw);
      this.historyIndex = this.history.length;
      this.historyDraft = '';
    }
    this.composer = { text: '', cursor: 0 };
    const line = this.registry.resolve(raw);
    if (this.modal) {
      const modal = this.modal;
      this.modal = null;
      modal.resolve(line);
      this.requestRender();
      return;
    }
    if (this.askWaiter) {
      const waiter = this.askWaiter;
      this.askWaiter = null;
      waiter(line);
    } else {
      this.lineQueue.push(line);
    }
    this.requestRender();
  }
}
