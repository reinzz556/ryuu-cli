import { Chalk } from 'chalk';
import { renderInline, renderMarkdown } from './markdown.js';
import { ANSI_SEQUENCE, charWidth, displayWidth } from './width.js';
import { copyToClipboard } from '../services/clipboard.js';

const MAX_REASONING_CHARS = 2_000_000;
const ANSI_AT = /\x1b\[[0-?]*[ -/]*[@-~]/y;
/** Rows shown in the live reasoning/response boxes. */
const PREVIEW_LINES = 5;
/** Rows of captured command output shown in the closed block. */
const COMMAND_PREVIEW_LINES = 5;
/** Output kept for the expandable command view; one huge log cannot pin memory. */
const MAX_COMMAND_OUTPUT_CHARS = 200_000;

const PALETTE = {
  cyan: '#22d3ee',
  blue: '#60a5fa',
  violet: '#a78bfa',
  pink: '#f472b6',
  green: '#4ade80',
  amber: '#fbbf24',
  yellow: '#fbbf24',
  red: '#f87171',
  slate: '#94a3b8',
  white: '#e2e8f0',
};

const STATUS_STYLE = {
  completed: { label: 'completed', color: 'green' },
  cancelled: { label: 'cancelled', color: 'yellow' },
  failed: { label: 'failed', color: 'red' },
  'step-limit': { label: 'step limit reached', color: 'yellow' },
};

const ERROR_HINTS = {
  AUTH_INVALID: 'Check NVIDIA_API_KEY in your environment or .env, then run `ryuu --doctor --live`.',
  AUTH_FORBIDDEN: 'Verify this API key has access to the selected model on build.nvidia.com.',
  MODEL_NOT_FOUND: 'Check NVIDIA_MODEL and NVIDIA_BASE_URL (must end with /v1).',
  RATE_LIMIT: 'Free NVIDIA endpoints have provider-side quotas. Wait, reduce context, or switch models.',
  TOOLS_UNSUPPORTED: 'This model may not support OpenAI-style tool calling. Set NVIDIA_MODEL to a tool-capable model.',
  CONTEXT_LENGTH: 'Start a new session or use a smaller task; AGENT_MAX_CONTEXT_CHARS controls local compaction.',
  PROVIDER_NETWORK: 'Check network/DNS access to the NVIDIA API and any proxy settings.',
  PROVIDER_TIMEOUT: 'Increase AGENT_REQUEST_TIMEOUT_MS or reduce the task size.',
  TASK_TIMEOUT: 'Increase AGENT_MAX_TASK_DURATION_MS or split the task.',
  CONFIG_INVALID: 'Fix .env (see .env.example) and restart.',
  STREAM_INTERRUPTED: 'Partial output was kept and not retried. Re-run the task if it was incomplete.',
  INVALID_TOOL_ARGUMENTS: 'A tool call in the conversation was not valid JSON; it was repaired and the request was retried.',
};

/**
 * Model chat-template control tokens that some providers leak into visible
 * text (`<|channel>thought`, `<channel|>`, `<start_of_turn>`, `</tool_call>`,
 * `<|repo_name|>`, …). They are protocol, not content.
 */
const MODEL_TOKEN_RE =
  /<\|[^|\n<>]{1,48}\|?>|<[a-z][a-z0-9_]{0,20}\|>|<\/?[a-z][a-z0-9_]{1,24}>|<@[a-z_]{1,24}>/gi;

export function cleanModelTokens(text) {
  return String(text ?? '').replace(MODEL_TOKEN_RE, '');
}

/** Remove ANSI/control sequences and leaked template tokens from reasoning. */
export function cleanReasoning(text) {
  return cleanModelTokens(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Hard-wrap text to a visible width (no ANSI involved; clean the text first). */
export function wrapText(text, width) {
  const wrapped = [];
  for (const line of String(text || '').split('\n')) {
    if (!line) {
      wrapped.push('');
      continue;
    }
    let current = '';
    let used = 0;
    for (const char of line) {
      const size = charWidth(char.codePointAt(0));
      if (used + size > width && current) {
        wrapped.push(current);
        current = '';
        used = 0;
      }
      current += char;
      used += size;
    }
    wrapped.push(current);
  }
  return wrapped;
}

/**
 * Split captured stdout/stderr into displayable rows: ANSI and control bytes
 * are stripped (they would break the box width math), blank tail rows dropped,
 * and only the last MAX_COMMAND_OUTPUT_CHARS characters kept — the tail is what
 * matters after a failure, and the discarded count is reported to the user.
 */
export function commandOutputLines(stdout, stderr) {
  const rows = [];
  const push = (text, stream) => {
    const streamRows = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => ({
        stream,
        text: line.replace(ANSI_SEQUENCE, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''),
      }));
    // The trailing newline of one stream must not become a blank row between
    // it and the other stream, but blank lines inside the output are kept.
    while (streamRows.length > 0 && streamRows[streamRows.length - 1].text === '') streamRows.pop();
    rows.push(...streamRows);
  };
  push(stdout, 'stdout');
  push(stderr, 'stderr');
  let chars = 0;
  let start = rows.length;
  while (start > 0 && chars + rows[start - 1].text.length + 1 <= MAX_COMMAND_OUTPUT_CHARS) {
    start -= 1;
    chars += rows[start].text.length + 1;
  }
  return { lines: rows.slice(start), dropped: start };
}

export function formatSeconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

export function formatTokens(count) {
  const value = Number(count || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * 
 * Live region pacing. Every streamed token used to redraw the whole reasoning
 * box, which pushed megabytes through the terminal (and the SSH channel) for a
 * long reasoning pass. Redraws are now coalesced to a frame budget, and each
 * frame only touches the tail of the text it can actually show.
 */
const RENDER_INTERVAL_MS = 80;
/** Diff rows printed per file change (the rest is summarised). */
const MAX_DIFF_LINES = 24;
/** Animation tick for the always-on activity line (10 fps). */
const STATUS_INTERVAL_MS = 100;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Renderer {
  constructor({ stdout = process.stdout, stderr = process.stderr, color = null, plain = false, debug = false } = {}) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.plain = plain || !stdout.isTTY;
    this.color = color === null ? !this.plain && !process.env.NO_COLOR : Boolean(color);
    const depth = typeof stdout.getColorDepth === 'function' ? stdout.getColorDepth() : 1;
    this.c = new Chalk({ level: this.color ? (depth >= 24 ? 3 : depth >= 8 ? 2 : 1) : 0 });
    this.debug = debug;
    this.ansi = Boolean(stdout.isTTY && !this.plain && this.color);
    this.reasoning = { text: '', active: false, blockId: null };
    // Prompts are kept so `/copy` can put one back on the clipboard without
    // asking the user to select text across wrapped output.
    this.tasks = [];
    // Final-answer stream: printed directly as plain text (no box, no erase).
    // `pending` holds the current line that has not been flushed yet.
    this.answer = { text: '', active: false, pending: '', block: null };
    // Rows of the one in-place live region (reasoning box and/or activity
    // line). The cursor always rests on the region's first row, so every frame
    // clears and repaints from a fixed anchor.
    this.liveLines = 0;
    // Every reasoning pass and every captured run_command output is kept here
    // with a stable id, so it can be opened again long after it was printed.
    // `screenLines` mirrors the printed transcript so a click can be mapped
    // back to the block it landed on (wrapped rows included).
    this.blocks = new Map();
    this.nextBlockId = 1;
    this.blockView = null;
    this.promptController = null;
    // True while the live prompt has been erased so transcript output can be
    // written in its place; #closeScreen puts it back below the output.
    this.promptParked = false;
    this.screenLines = [];
    this.screenPartial = '';
    this.screenPartialBlock = null;
    // The terminal reflows on resize, so the row math for an open panel is no
    // longer trustworthy; drop the panel state instead of erasing the wrong rows.
    if (typeof stdout.on === 'function') {
      stdout.on('resize', () => {
        this.blockView = null;
      });
    }
    // Coalesced redraw timer for the box content (never one frame per token).
    this.frameTimer = null;
    // Always-on activity line: thinking → reasoning → working. It carries the
    // whole run state (step, tool i/n, tokens, first-token latency), not just a
    // spinner, so a slow model can never look like an opaque "working".
    this.status = {
      active: false,
      phase: null,
      startedAt: 0,
      taskStartedAt: 0,
      extra: '',
      step: null,
      maxSteps: null,
      tool: '',
      toolIndex: 0,
      toolTotal: 0,
      promptTokens: 0,
      completionTokens: 0,
      firstTokenMs: null,
      output: [],
      frame: 0,
      timer: null,
      outputTimer: null,
    };
  }

  #write(line = '') {
    if (this.blockView) this.closeBlockView();
    // Take the prompt and the live region off screen: the region can only be
    // erased from its own first row, and the prompt sits below it.
    const prompt = this.#openScreen();
    // Anything printed while an answer line is still buffered goes AFTER it:
    // the stream must never be split mid-sentence by a plan/tool/step line.
    if (this.answer.pending) this.#flushAnswer({ force: true });
    if (this.answer.block) {
      // Interleaving output closes any open streamed block so it renders here,
      // above the other output, instead of detached below it.
      this.#renderBlock(this.answer.block);
      this.answer.block = null;
    }
    const text = String(line ?? '');
    this.#trackScreen(`${text}\n`);
    this.stdout.write(`${text}\n`);
    // Draw the activity line (and the reasoning box) under the new output.
    this.#paintAfterWrite();
    this.#closeScreen(prompt);
  }

  /**
   * Mirror printed text into the click map. Each logical line remembers the
   * block it belongs to; wrapped rows are counted when a click needs a row.
   */
  #trackScreen(text, blockId = null) {
    const value = String(text ?? '');
    if (!value) return;
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) !== 10) continue;
      this.screenLines.push({
        text: this.screenPartial + value.slice(start, index),
        blockId: this.screenPartialBlock ?? blockId,
      });
      this.screenPartial = '';
      this.screenPartialBlock = null;
      start = index + 1;
    }
    if (start < value.length) {
      if (!this.screenPartial) this.screenPartialBlock = blockId;
      this.screenPartial += value.slice(start);
    }
  }

  #terminalColumns() {
    return Math.max(20, Number(this.stdout.columns) || 80);
  }

  #terminalRows() {
    return Math.max(10, Number(this.stdout.rows) || 40);
  }

  #screenRowsFor(text) {
    const width = displayWidth(text, { ansi: true });
    return Math.max(1, Math.ceil(width / this.#terminalColumns()));
  }

  #screenRowCount() {
    let rows = 0;
    for (const line of this.screenLines) rows += this.#screenRowsFor(line.text);
    if (this.screenPartial) rows += this.#screenRowsFor(this.screenPartial);
    return rows;
  }

  /** Block id printed on the given absolute transcript row, or null. */
  #blockAtRow(row) {
    let cursor = 0;
    for (const line of this.screenLines) {
      const height = this.#screenRowsFor(line.text);
      if (row < cursor + height) return line.blockId ?? null;
      cursor += height;
    }
    return null;
  }

  #icon(symbol, fallback) {
    return this.color ? symbol : fallback;
  }

  #paint(name, text) {
    return this.c.hex(PALETTE[name] || PALETTE.white)(String(text));
  }

  #visibleLength(text) {
    return displayWidth(text, { ansi: true });
  }

  #width() {
    const columns = Number(this.stdout.columns) || 92;
    // Never draw wider than the terminal: a box wider than the window wraps
    // every row, which made the cursor-up erase miscount and shred the screen.
    return Math.max(24, Math.min(columns - 2, 92));
  }

  #innerWidth() {
    return this.#width() - 6;
  }

  /** Trim to a visible column budget without cutting ANSI escape sequences. */
  #clip(text, max) {
    const value = String(text ?? '');
    if (this.#visibleLength(value) <= max) return value;
    let output = '';
    let width = 0;
    let index = 0;
    while (index < value.length) {
      if (value[index] === '\x1b') {
        ANSI_AT.lastIndex = index;
        const match = ANSI_AT.exec(value);
        if (match) {
          output += match[0];
          index = ANSI_AT.lastIndex;
          continue;
        }
      }
      const code = value.codePointAt(index);
      const char = String.fromCodePoint(code);
      const size = charWidth(code);
      if (width + size > Math.max(0, max - 1)) break;
      output += char;
      width += size;
      index += char.length;
    }
    return `${output}${this.c.dim('…')}${this.color ? '\x1b[0m' : ''}`;
  }

  /** Fit plain text into a column budget (wide glyphs count as two). */
  #fit(text, max) {
    const value = String(text ?? '');
    if (displayWidth(value) <= max) return value;
    let output = '';
    let width = 0;
    for (const char of value) {
      const size = charWidth(char.codePointAt(0));
      if (width + size > Math.max(0, max - 1)) break;
      output += char;
      width += size;
    }
    return `${output}…`;
  }

  /** Cyan → violet → pink character gradient. */
  #grad(text) {
    const value = String(text ?? '');
    if (!this.color || !value) return value;
    const stops = [
      [34, 211, 238],
      [167, 139, 250],
      [244, 114, 182],
    ];
    const chars = [...value];
    const span = Math.max(1, chars.length - 1);
    return chars
      .map((char, index) => {
        const position = (index / span) * (stops.length - 1);
        const from = Math.min(stops.length - 2, Math.floor(position));
        const local = position - from;
        const rgb = stops[from].map((start, channel) =>
          Math.round(start + (stops[from + 1][channel] - start) * local));
        return this.c.hex(`#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`)(char);
      })
      .join('');
  }

  #top(title, meta = '') {
    const width = this.#width();
    const lead = '  ';
    let safeTitle = this.#fit(title, Math.max(4, width - 14));
    let shownMeta = meta;
    let leftPlain = `╭─ ${safeTitle} `;
    let rightPlain = shownMeta ? ` ${shownMeta} ─╮` : '─╮';
    let fill = width - lead.length - displayWidth(leftPlain) - displayWidth(rightPlain);
    if (fill < 1 && shownMeta) {
      shownMeta = '';
      rightPlain = '─╮';
      fill = width - lead.length - displayWidth(leftPlain) - displayWidth(rightPlain);
    }
    if (fill < 1) {
      safeTitle = this.#fit(safeTitle, Math.max(4, width - 10));
      leftPlain = `╭─ ${safeTitle} `;
      fill = Math.max(1, width - lead.length - displayWidth(leftPlain) - displayWidth(rightPlain));
    }
    return (
      `${lead}${this.#paint('cyan', '╭─ ')}${this.c.bold(this.#paint('white', safeTitle))}${this.#paint('cyan', ' ')}` +
      `${this.c.dim('─'.repeat(fill))}` +
      `${shownMeta ? this.c.dim(` ${shownMeta} `) : ''}${this.#paint('cyan', '─╮')}`
    );
  }

  #mid(title = '') {
    const width = this.#width();
    if (!title) {
      return `  ${this.#paint('cyan', '├')}${this.c.dim('─'.repeat(width - 4))}${this.#paint('cyan', '┤')}`;
    }
    const leftPlain = `├─ ${title} `;
    const fill = Math.max(1, width - 2 - leftPlain.length - 2);
    return (
      `  ${this.#paint('cyan', '├─ ')}${this.c.bold(title)}${this.#paint('cyan', ' ')}` +
      `${this.c.dim('─'.repeat(fill))}${this.#paint('cyan', '─┤')}`
    );
  }

  #bottom() {
    return `  ${this.#paint('cyan', `╰${'─'.repeat(this.#width() - 4)}╯`)}`;
  }

  #row(content = '') {
    const inner = this.#innerWidth();
    const clipped = this.#clip(String(content ?? '').replace(/\r?\n/g, ' '), inner);
    const padding = Math.max(0, inner - this.#visibleLength(clipped));
    return `  ${this.#paint('cyan', '│')} ${clipped}${' '.repeat(padding)} ${this.#paint('cyan', '│')}`;
  }

  /**
   * Render an assistant message: Markdown, tables and code blocks.
   * `base` sets the default text colour (response text is painted white so it
   * reads differently from task/command lines).
   */
  #markdown(text, { base = null } = {}) {
    if (!text) return;
    const width = Math.max(24, this.#width() - 4);
    for (const line of renderMarkdown(cleanModelTokens(text), { width, c: this.c, color: this.color, base })) {
      this.#write(line ? `  ${line}` : '');
    }
  }

  /** Copy a sent prompt to the clipboard; `which` counts back from the newest. */
  copyTask(which = 0) {
    if (this.tasks.length === 0) return { ok: false, reason: 'no-task', chars: 0 };
    const depth = Math.max(0, Math.min(Math.trunc(Number(which) || 0), this.tasks.length - 1));
    const task = this.tasks[this.tasks.length - 1 - depth];
    const result = copyToClipboard(task, { output: this.stdout });
    if (result.ok) this.info(`Copied ${result.chars} chars of the prompt to the clipboard (OSC 52).`);
    else this.warn('Clipboard copy needs an interactive terminal that supports OSC 52.');
    return result;
  }

  /** The interactive prompt prefix. */
  prompt() {
    if (this.plain) return 'ryuu> ';
    return `  ${this.#grad('◈')} ${this.c.bold(this.#grad('ryuu'))} ${this.c.dim('▸')} `;
  }

  /** Print pre-formatted text (used by slash commands). */
  lines(text = '') {
    for (const line of String(text).split('\n')) this.#write(line);
  }

  banner({ version, model, provider, workspace, node, approvalPolicy, logFile }) {
    const c = this.c;
    if (this.plain) {
      this.#write(`Ryuu Agent CLI v${version}`);
      this.#write(`provider: ${provider}`);
      this.#write(`model: ${model}`);
      this.#write(`workspace: ${workspace}`);
      this.#write(`node: ${node}`);
      this.#write(`approval: ${approvalPolicy}`);
      this.#write(`log: ${logFile || '(disabled)'}`);
      this.#write('');
      return;
    }

    const inner = this.#innerWidth();
    const wordmark = [
      '██████╗ ██╗   ██╗██╗   ██╗██╗   ██╗',
      '██╔══██╗╚██╗ ██╔╝██║   ██║██║   ██║',
      '██████╔╝ ╚████╔╝ ██║   ██║██║   ██║',
      '██╔══██╗  ╚██╔╝  ██║   ██║██║   ██║',
      '██║  ██║   ██║   ╚██████╔╝╚██████╔╝',
      '╚═╝  ╚═╝   ╚═╝    ╚═════╝  ╚═════╝',
    ];
    const wordmarkWidth = Math.max(...wordmark.map((line) => line.length));
    const tagline = 'autonomous coding intelligence · NVIDIA';
    this.#write('');
    this.#write(this.#top('◢ RYUU // AGENT OS', `v${version}`));
    this.#write(this.#row(''));
    for (const line of wordmark) {
      const pad = Math.max(0, Math.floor((inner - wordmarkWidth) / 2));
      this.#write(this.#row(`${' '.repeat(pad)}${this.#grad(line)}`));
    }
    this.#write(this.#row(''));
    this.#write(
      this.#row(c.dim(`${' '.repeat(Math.max(0, Math.floor((inner - tagline.length) / 2)))}${tagline}`)),
    );
    this.#write(this.#row(''));
    this.#write(this.#mid('◆ TELEMETRY'));
    this.#write(this.#row(`${this.#paint('cyan', 'model'.padEnd(10))} ${c.bold(this.#fit(model, inner - 12))}`));
    this.#write(this.#row(`${this.#paint('cyan', 'workspace'.padEnd(10))} ${this.#fit(workspace, inner - 12)}`));
    this.#write(
      this.#row(`${this.#paint('cyan', 'runtime'.padEnd(10))} ${c.dim(`Node.js ${node} · ${process.platform}`)}`),
    );
    this.#write(
      this.#row(`${this.#paint('cyan', 'access'.padEnd(10))} ${c.dim(`${approvalPolicy} · shell is not a sandbox`)}`),
    );
    if (logFile) {
      this.#write(this.#row(`${this.#paint('cyan', 'log'.padEnd(10))} ${c.dim(this.#fit(logFile, inner - 12))}`));
    }
    this.#write(this.#bottom());
    this.#write(
      c.dim(
        this.#width() >= 66
          ? '  click a block or /expand N   !cmd shell   ⌃C cancel   /help commands   /exit quit'
          : '  click block · /expand N · !cmd · ⌃C · /help · /exit',
      ),
    );
    this.#write('');
  }

  info(message) {
    this.#write(`${this.#paint('cyan', this.#icon('◇', '·'))} ${this.c.dim(message)}`);
  }

  success(message) {
    this.#write(`${this.#paint('green', this.#icon('✓', '[ok]'))} ${message}`);
  }

  warn(message) {
    this.#write(`${this.#paint('amber', this.#icon('▲', '[warn]'))} ${this.#paint('amber', message)}`);
  }

  muted(message) {
    this.#write(this.c.dim(message));
  }

  taskStart({ task, sessionId, maxSteps }) {
    this.stopActivity();
    this.tasks.push(String(task ?? ''));
    if (this.tasks.length > 25) this.tasks.shift();
    this.answer = { text: '', active: false, pending: '', block: null };
    this.status.taskStartedAt = Date.now();
    this.status.step = 0;
    this.status.maxSteps = maxSteps || null;
    this.status.promptTokens = 0;
    this.status.completionTokens = 0;
    this.status.firstTokenMs = null;
    this.status.output = [];
    if (this.plain) {
      this.#write('');
      this.#write(`${this.#icon('◆', '>')} Task ${task.length > 160 ? `${task.slice(0, 160)}…` : task}`);
      this.#write(`  session ${sessionId} · ${maxSteps ? `max ${maxSteps} steps` : 'unlimited steps'}`);
      return;
    }
    const limit = maxSteps ? `max ${maxSteps} steps` : '∞ autonomous';
    this.#write('');
    this.#write(this.#top('◢ task uplink', `session ${sessionId}`));
    this.#write(this.#row(''));
    this.#write(
      this.#row(
        `${this.#paint('blue', '▸')} ${this.c.bold(this.c.hex(PALETTE.blue)(this.#fit(task, this.#innerWidth() - 4)))}`,
      ),
    );
    this.#write(this.#row(this.c.dim(`${limit} · approval-gated · live telemetry`)));
    this.#write(this.#bottom());
  }

  plan({ plan }) {
    if (!plan) return;
    const text = cleanModelTokens(plan);
    if (this.plain) {
      this.#write('');
      this.#write('  Plan');
      for (const line of text.split('\n').slice(0, 12)) this.#write(this.c.dim(`  ${line}`));
      return;
    }
    this.#write('');
    this.#write(`  ${this.#paint('violet', '◆')} ${this.c.bold('PLAN')} ${this.c.dim('· proposed sequence')}`);
    for (const line of text.split('\n').slice(0, 12)) {
      const match = line.match(/^(\s*)(\d+[.)]|[-*])\s+(.*)$/);
      if (match) {
        this.#write(
          `  ${this.c.dim('│')} ${this.#paint('cyan', match[2].padStart(3, ' '))} ${this.#fit(match[3], this.#innerWidth())}`,
        );
      } else {
        this.#write(`  ${this.c.dim('│')} ${this.c.dim(this.#fit(line.trim(), this.#innerWidth()))}`);
      }
    }
  }

  stepStart({ step, maxSteps }) {
    const label = maxSteps ? `step ${step}/${maxSteps}` : `step ${step}`;
    if (this.plain) {
      this.#write('');
      this.#write(`── ${label} ${'─'.repeat(Math.max(0, 40 - label.length))}`);
      return;
    }
    const tag = `STEP ${String(step).padStart(2, '0')}`;
    const meta = maxSteps ? `${step}/${maxSteps}` : '∞ autonomous';
    this.#write('');
    this.#write(`  ${this.#grad('◢')} ${this.c.bold(tag)} ${this.c.dim('·')} ${this.c.dim(meta)}`);
    this.#write(this.c.dim(`  ${'╌'.repeat(this.#width() - 4)}`));
  }

  /**
   * The always-on activity line at the bottom of the chat UI. Exactly one
   * phase is shown at a time:
   *   thinking  — the model thinks in the background (no visible output yet)
   *   reasoning — its reasoning stream is being displayed in the box above
   *   working   — everything else: assembling tool calls, running commands,
   *               approvals, streaming the answer
   */
  /** Human verb for the tool that is currently running. */
  #activityVerb(name) {
    if (!name) return '';
    if (/^(create_file|write_file|edit_file)$/.test(name)) return 'writing';
    if (name === 'read_file' || name === 'file_info' || name === 'diff_file') return 'reading';
    if (name === 'run_command') return 'running';
    if (name === 'start_process' || name === 'stop_process') return 'process';
    if (name === 'search_files' || name === 'list_files' || name === 'tree') return 'scanning';
    return 'working';
  }

  /**
   * The activity line: phase and elapsed time, then as much real telemetry as
   * fits — step, total run time, the tool being used and how many are queued,
   * live token counts and the first-token latency.
   */
  #statusText() {
    const s = this.status;
    const glyph = SPINNER_FRAMES[s.frame % SPINNER_FRAMES.length];
    const phase = s.phase || 'working';
    const phaseElapsed = formatSeconds(Date.now() - s.startedAt);
    const headPlain = `  ${glyph} ${phase} · ${phaseElapsed}`;
    const details = [];
    if (s.step) details.push(s.maxSteps ? `step ${s.step}/${s.maxSteps}` : `step ${s.step}`);
    if (s.taskStartedAt) details.push(`total ${formatSeconds(Date.now() - s.taskStartedAt)}`);
    if (s.tool) {
      const label = `${this.#activityVerb(s.tool)} ${s.tool}`;
      const target = s.extra ? ` ${this.#fit(s.extra, 28)}` : '';
      details.push(s.toolTotal > 1 ? `${label}${target} (${s.toolIndex}/${s.toolTotal})` : `${label}${target}`);
    } else if (s.extra) {
      details.push(s.extra);
    }
    if (s.promptTokens || s.completionTokens) {
      details.push(`${formatTokens(s.promptTokens)}↑ ${formatTokens(s.completionTokens)}↓ tok`);
    }
    if (s.phase === 'thinking' && s.firstTokenMs !== null && s.firstTokenMs !== undefined) {
      details.push(`first token ${formatSeconds(s.firstTokenMs)}`);
    }

    const room = Math.max(10, this.#width() - 2);
    let used = displayWidth(headPlain);
    const shown = [];
    for (const detail of details) {
      const left = room - used - 3;
      if (left < 8) break;
      const fitted = this.#fit(detail, left);
      if (!fitted) break;
      shown.push(fitted);
      used += displayWidth(fitted) + 3;
    }
    const coloredHead = `  ${this.#paint('cyan', glyph)} ${this.c.bold(phase)} ${this.c.dim(`· ${phaseElapsed}`)}`;
    return coloredHead + shown.map((detail) => this.c.dim(` · ${detail}`)).join('');
  }

  #startTicker() {
    if (!this.ansi || this.status.timer) return;
    this.status.timer = setInterval(() => {
      if (!this.status.active) return;
      this.status.frame += 1;
      if (this.liveLines > 0) this.#updateStatusRow();
      else this.#paintLive();
    }, STATUS_INTERVAL_MS);
    this.status.timer.unref?.();
  }

  #stopTicker() {
    if (!this.status.timer) return;
    clearInterval(this.status.timer);
    this.status.timer = null;
  }

  /** Switch the activity line to a phase (starting the clock on first use). */
  #setPhase(phase, extra = '') {
    if (!this.ansi) return;
    const s = this.status;
    // The clock measures the current phase, not the whole task: a long
    // `thinking` pass followed by `working · 0.3s · run_command` reads correctly.
    if (!s.active || s.phase !== phase) {
      s.startedAt = Date.now();
      s.frame = 0;
    }
    s.active = true;
    s.phase = phase;
    s.extra = extra;
    this.#startTicker();
    this.#paintLive();
  }

  /** Stop the activity line and take the live region off screen. */
  stopActivity() {
    this.status.active = false;
    this.status.phase = null;
    this.status.extra = '';
    this.status.tool = '';
    this.status.toolIndex = 0;
    this.status.toolTotal = 0;
    this.status.output = [];
    this.#stopTicker();
    this.#cancelFrame();
    if (this.status.outputTimer) {
      clearTimeout(this.status.outputTimer);
      this.status.outputTimer = null;
    }
    if (this.liveLines > 0) this.#clearLive();
  }

  thinkingStart({ step = null, maxSteps = null } = {}) {
    this.status.step = step ?? this.status.step;
    this.status.maxSteps = maxSteps ?? this.status.maxSteps;
    this.status.tool = '';
    this.status.toolIndex = 0;
    this.status.toolTotal = 0;
    this.status.firstTokenMs = null;
    this.#setPhase('thinking');
  }

  workingStart({ tool = '', step = null, maxSteps = null, toolCalls = 0 } = {}) {
    this.status.step = step ?? this.status.step;
    this.status.maxSteps = maxSteps ?? this.status.maxSteps;
    this.status.tool = tool || '';
    this.status.toolTotal = toolCalls || 0;
    this.status.toolIndex = 0;
    this.#setPhase('working', tool || '');
  }

  /**
   * Live telemetry from the agent: token counts, first-token latency and the
   * step counter, pushed while the model is still working. Without this the
   * activity line could only say "thinking", which is exactly the complaint.
   */
  progress({ step = null, maxSteps = null, promptTokens = null, completionTokens = null, firstTokenMs = null } = {}) {
    const s = this.status;
    if (step !== null) s.step = step;
    if (maxSteps !== null) s.maxSteps = maxSteps;
    if (Number.isFinite(promptTokens)) s.promptTokens = promptTokens;
    if (Number.isFinite(completionTokens)) s.completionTokens = completionTokens;
    if (firstTokenMs !== null && firstTokenMs !== undefined) s.firstTokenMs = firstTokenMs;
    if (!this.ansi || !s.active) return;
    this.#paintLive();
  }

  /**
   * Live stdout/stderr tail for a running command. The ProcessManager already
   * emits this data; the agent used to drop it until the process exited.
   */
  processOutput({ text = '', stream = 'stdout' } = {}) {
    if (!text || this.plain) return;
    const clean = String(text)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const rows = clean
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-2)
      .map((line) => this.#fit(`${stream === 'stderr' ? '!' : '›'} ${line}`, Math.max(8, this.#width() - 4)));
    if (rows.length === 0) return;
    const output = [...this.status.output, ...rows].slice(-2);
    this.status.output = output;
    this.#queueOutputPaint();
  }

  /** Coalesce command-output repaints: never one full redraw per data chunk. */
  #queueOutputPaint() {
    if (!this.ansi || this.status.outputTimer) return;
    this.status.outputTimer = setTimeout(() => {
      this.status.outputTimer = null;
      if (this.status.active) this.#paintLive();
    }, 150);
    this.status.outputTimer.unref?.();
  }

  /**
   * Heartbeat: proof that the agent is alive while it recovers.
   *
   *   retry    — the provider link dropped; a reconnect is in progress
   *   restored — the link is back and the run continues
   *   degraded — the model's response was broken and has been repaired
   *
   * The activity line keeps spinning in every phase, so a long reconnect
   * never looks like a frozen terminal.
   */
  heartbeat({ phase = 'retry', attempt = 0, maxAttempts = 0, delayMs = 0, code = '', message = '' } = {}) {
    const detail = String(message || '').replace(/\s+/g, ' ').trim();
    if (phase === 'retry') {
      const seconds = (Number(delayMs || 0) / 1000).toFixed(1);
      // maxAttempts 0 means "no cap": say so instead of printing 0 or ?.
      const cap = Number(maxAttempts) > 0 ? `/${maxAttempts}` : ' (unlimited)';
      const emptyTurn = code === 'EMPTY_RESPONSE';
      const what = emptyTurn ? 'empty response' : 'reconnecting';
      const label = `${what} · attempt ${attempt}${cap} in ${seconds}s`;
      // The label already says what happened for an empty turn; printing the
      // internal EMPTY_RESPONSE code there reads like a fatal fault.
      const shownCode = emptyTurn ? '' : code;
      this.#setPhase(emptyTurn ? 'retrying' : 'reconnecting', emptyTurn ? '' : code || '');
      if (this.plain) {
        this.#write(this.c.dim(`  [heartbeat] ${label}${shownCode ? ` · ${shownCode}` : ''}`));
        return;
      }
      this.#write(
        `  ${this.#paint('amber', '♥')} ${this.c.bold('heartbeat')} ${this.c.dim(`· ${label}`)}${shownCode ? this.c.dim(` · ${shownCode}`) : ''}`,
      );
      return;
    }
    if (phase === 'restored') {
      this.#setPhase('working');
      if (this.plain) {
        this.#write(this.c.dim(`  [heartbeat] link restored after ${attempt} attempt(s)`));
        return;
      }
      this.#write(
        `  ${this.#paint('green', '♥')} ${this.c.bold('heartbeat')} ${this.c.dim(`· link restored after ${attempt} attempt(s)`)}`,
      );
      return;
    }
    // degraded: the response was repaired, the agent keeps working
    this.#setPhase('working', code || '');
    if (this.plain) {
      this.#write(this.c.dim(`  [heartbeat] ${code || 'degraded'}${detail ? ` · ${detail}` : ''}`));
      return;
    }
    this.#write(
      `  ${this.#paint('amber', '♥')} ${this.c.bold('heartbeat')} ${this.c.dim(`· ${code || 'degraded'}`)}${detail ? this.c.dim(` · ${this.#fit(detail, this.#innerWidth() - 24)}`) : ''}`,
    );
  }

  /** Rows of the reasoning box (empty when no reasoning is streaming). */
  #previewBoxLines({ id = null, live = false } = {}) {
    // No clock in the header: the activity line below already carries the
    // elapsed time, and it is the only thing that animates every tick.
    const title = id ? `◈ reasoning stream #${id}` : '◈ reasoning stream';
    return [
      this.#top(title, live ? 'live' : '▸ closed'),
      ...this.#previewLines().map((line) => this.#row(this.c.dim(line))),
      this.#bottom(),
    ];
  }

  #liveBox() {
    if (!this.ansi || !this.reasoning.active) return [];
    return this.#previewBoxLines({ id: this.reasoning.blockId, live: true });
  }

  /** Every row of the live region: reasoning box, command tail, activity line. */
  #liveRegionLines() {
    const lines = this.#liveBox();
    if (this.status.active) {
      for (const row of this.status.output) lines.push(`  ${this.c.dim(row)}`);
      lines.push(this.#statusText());
    }
    return lines;
  }

  /**
   * Paint the whole live region (box + activity line) and leave the cursor on
   * its first row, so the next frame always redraws from the same anchor.
   *
   * The composer prompt stays visible during a task, so every screen change
   * parks it first and puts it back afterwards. Lines typed while the agent
   * works therefore never land inside the reasoning box.
   */
  #paintLive() {
    if (!this.ansi || this.blockView) return;
    const prompt = this.#openScreen();
    const lines = this.#liveRegionLines();
    if (lines.length > 0) {
      for (const line of lines) this.stdout.write(`${line}\n`);
      this.stdout.write(`\x1b[${lines.length}A\r`);
      this.liveLines = lines.length;
    }
    this.#closeScreen(prompt);
  }

  /** Animate only the last row of the region (the activity line). */
  #updateStatusRow() {
    if (!this.ansi || !this.status.active || this.liveLines <= 0) return;
    if (this.blockView) return;
    const prompt = this.#parkPrompt();
    const down = this.liveLines - 1;
    const move = down > 0 ? `\x1b[${down}B` : '';
    const back = down > 0 ? `\x1b[${down}A` : '';
    this.stdout.write(`${move}\r\x1b[2K${this.#statusText()}${back}\r`);
    this.#closeScreen(prompt);
  }

  /** Raw answer output: takes the region down, then restores it underneath. */
  #answerWrite(text) {
    const prompt = this.#openScreen();
    this.#trackScreen(text);
    this.stdout.write(text);
    this.#paintAfterWrite();
    this.#closeScreen(prompt);
  }

  #paintAfterWrite() {
    if (!this.ansi) return;
    if (!this.reasoning.active && !this.status.active) return;
    this.#paintLive();
  }

  /** Tail of the reasoning text (clean), bounded so a frame is O(viewport). */
  #reasoningTail(chars) {
    const text = cleanReasoning(this.reasoning.text);
    return text.length <= chars ? text : Array.from(text).slice(-chars).join('');
  }

  /** Last PREVIEW_LINES wrapped lines, padded so the box keeps a fixed height. */
  #previewLines() {
    const width = this.#innerWidth();
    // Only the tail can ever be shown, so only the tail is wrapped. Wrapping
    // the whole transcript on every token was the quadratic hot spot that
    // starved the terminal during long reasoning passes.
    const tail = this.#reasoningTail(width * (PREVIEW_LINES + 2) * 2);
    const lines = wrapText(tail, width).slice(-PREVIEW_LINES);
    while (lines.length < PREVIEW_LINES) lines.unshift('');
    return lines.map((line) => this.#fit(line, width));
  }

  /**
   * Take the live region off screen. The prompt is parked first and redrawn
   * afterwards, so it keeps its place under whatever was printed.
   */
  #clearLive() {
    if (!this.ansi || this.liveLines <= 0) {
      this.liveLines = 0;
      return;
    }
    const prompt = this.#openScreen();
    this.#closeScreen(prompt);
  }

  // ── prompt parking ───────────────────────────────────────────────────────

  /**
   * Erase the live prompt (if one is on screen) and leave the cursor on the
   * row where new output belongs: the top of the live region, or the prompt's
   * first row when nothing is painted under it. Returns the prompt state so
   * #closeScreen can draw it again.
   */
  #openScreen() {
    if (this.blockView && !this.promptParked) this.closeBlockView();
    if (this.promptParked) {
      // Nested write inside a frame that already took the screen: the cursor
      // rests on the live region's first row, so clear downwards from here.
      if (this.liveLines > 0) {
        this.stdout.write('\r\x1b[0J');
        this.liveLines = 0;
      }
      return null;
    }
    const prompt = this.#promptState();
    if (prompt) {
      this.promptParked = true;
      const up = prompt.cursorRow;
      this.stdout.write(`${up > 0 ? `\x1b[${up}A` : ''}\r\x1b[0J`);
    }
    if (this.liveLines > 0) {
      this.stdout.write(`\x1b[${this.liveLines}A\r\x1b[0J`);
      this.liveLines = 0;
    }
    return prompt;
  }

  /** Erase only the prompt and stop on the live region's first row. */
  #parkPrompt() {
    const prompt = this.promptParked ? null : this.#promptState();
    if (!prompt) return null;
    this.promptParked = true;
    const up = prompt.cursorRow;
    this.stdout.write(`${up > 0 ? `\x1b[${up}A` : ''}\r\x1b[0J`);
    if (this.liveLines > 0) this.stdout.write(`\x1b[${this.liveLines}A`);
    return prompt;
  }

  /** Redraw the prompt below the live region (no-op when none was parked). */
  #closeScreen(prompt) {
    if (!prompt) return;
    this.promptParked = false;
    if (this.liveLines > 0) this.stdout.write(`\x1b[${this.liveLines}B`);
    this.stdout.write('\r');
    this.promptController?.resetCursor?.();
    this.promptController?.repaint?.();
  }

  /** Coalesce box content redraws instead of one full box per token. */
  #scheduleFrame() {
    if (!this.ansi || this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      if (this.reasoning.active) this.#paintLive();
    }, RENDER_INTERVAL_MS);
    this.frameTimer.unref?.();
  }

  #cancelFrame() {
    if (!this.frameTimer) return;
    clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  /** Live provider reasoning: a closed five-line box that keeps its block id. */
  reasoningDelta({ text } = {}) {
    if (!text) return;
    const st = this.reasoning;
    if (this.answer.active) this.answerEnd();
    const starting = !st.active;
    if (starting) {
      st.active = true;
      st.text = '';
      st.blockId = this.#createBlock({ kind: 'reasoning', text: '', chars: 0, active: true }).id;
    }
    if (st.text.length < MAX_REASONING_CHARS) st.text += text;
    if (this.plain) return;
    // The phase switch paints the first frame (nothing can look frozen), later
    // tokens only mark the box dirty for the next coalesced frame.
    if (starting) this.#setPhase('reasoning');
    else this.#scheduleFrame();
  }

  /**
   * Finish the live reasoning region. The five-row preview stays as the step
   * record, and the complete text stays in the block registry so `/expand`
   * can show it again at any time.
   */
  reasoningEnd({ logFile = null, partial = false } = {}) {
    const st = this.reasoning;
    if (!st.active) return;
    const chars = st.text.length;
    const block = st.blockId ? this.blocks.get(st.blockId) : null;
    if (block) {
      block.text = cleanReasoning(st.text);
      block.chars = chars;
      block.active = false;
    }
    const record = this.ansi ? this.#previewBoxLines({ id: st.blockId }) : [];
    st.active = false;
    st.blockId = null;
    st.text = '';
    this.#cancelFrame();
    if (record.length > 0) this.#printLines(record, block?.id ?? null);
    if (chars > 0) {
      const suffix = `${chars} chars${partial ? ' · partial' : ''}`;
      const hint = block ? ` · click or /expand ${block.id}` : '';
      const line = this.plain
        ? this.c.dim(`  reasoning ${suffix}`)
        : `  ${this.#paint('violet', '◈')} ${this.c.dim(`reasoning ${suffix}${hint}`)}`;
      if (block) this.#printLines([line], block.id);
      else this.#write(line);
    }
  }

  /** Live final-answer text: printed directly as it streams — no box. */
  contentDelta({ text } = {}) {
    if (!text || this.plain) return;
    if (this.reasoning.active) this.reasoningEnd({});
    const st = this.answer;
    if (!st.active) {
      st.active = true;
      st.text = '';
      st.pending = '';
      st.block = null;
      this.thinkingEnd();
      this.#write('');
    }
    if (st.text.length < MAX_REASONING_CHARS) {
      const clean = String(text).replace(/\r\n?/g, '\n');
      st.text += clean;
      st.pending += clean;
      this.#flushAnswer();
    }
  }

  /**
   * Emit the completed logical lines of the pending answer, keeping the rest
   * for later. `force` also flushes the trailing partial line — used when other
   * output is about to be printed so the stream is never split mid-sentence.
   * Only newline boundaries are handled here: display wrapping happens per
   * line inside #answerRow, so table/code rows are never cut before the block
   * detector sees them (a wrapped table row would break the table in half).
   */
  #flushAnswer({ force = false } = {}) {
    const st = this.answer;
    let newlineAt;
    while ((newlineAt = st.pending.indexOf('\n')) !== -1) {
      this.#answerRow(st.pending.slice(0, newlineAt));
      st.pending = st.pending.slice(newlineAt + 1);
    }
    if (force && st.pending) {
      this.#answerRow(st.pending);
      st.pending = '';
    }
  }

  /** Word-boundary wrap that keeps `**bold**`/`code` spans balanced. */
  #wrapProse(text) {
    const width = Math.max(24, this.#width() - 2);
    const balanced = (value) =>
      (value.match(/\*\*/g) || []).length % 2 === 0 && (value.match(/`/g) || []).length % 2 === 0;
    const lines = [];
    let rest = String(text ?? '');
    while (displayWidth(rest) > width) {
      // Cut by columns, not by character count: CJK/emoji are two columns each
      // and counting them as one would overflow the terminal line.
      let used = 0;
      let cut = 0;
      for (const char of rest) {
        const size = charWidth(char.codePointAt(0));
        if (used + size > width) break;
        used += size;
        cut += char.length;
      }
      // Break at the last space that still fits the column budget, never past
      // it: clamping to a space beyond the cut would split a `**bold**` span.
      for (let index = rest.lastIndexOf(' ', cut - 1); index > 0; index = rest.lastIndexOf(' ', index - 1)) {
        if (balanced(rest.slice(0, index))) {
          cut = index;
          break;
        }
      }
      if (cut <= 0) break;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ +/, '');
    }
    lines.push(rest);
    return lines;
  }

  /** One streamed answer logical line: block detection first, then rendering. */
  #answerRow(line) {
    // Raw write on purpose: #write flushes the answer first, and this IS the
    // answer — routing through it would recurse.
    const clean = cleanModelTokens(line);
    const st = this.answer;

    // Fenced code blocks accumulate until the closing fence, then render as
    // a highlighted block (identical to the final-response renderer).
    if (st.block?.type === 'code') {
      st.block.lines.push(clean);
      if (/^\s*```/.test(clean) && st.block.lines.length > 1) {
        this.#renderBlock(st.block);
        st.block = null;
      }
      return;
    }
    if (/^\s*```/.test(clean)) {
      st.block = { type: 'code', lines: [clean] };
      return;
    }
    // Pipe tables accumulate UNWRAPPED: real rows are often far wider than
    // the screen, and the block renderer wraps their cells width-aware.
    // Wrapping a row here would split it mid-cell and break the table into
    // fragments separated by stray text.
    if (/^\s*\|/.test(clean)) {
      if (st.block?.type === 'table') st.block.lines.push(clean);
      else st.block = { type: 'table', lines: [clean] };
      return;
    }
    if (st.block?.type === 'table') {
      this.#renderBlock(st.block);
      st.block = null;
    }

    if (!clean.trim()) {
      this.#answerWrite('\n');
      return;
    }
    // Horizontal rules become a dim divider instead of literal dashes.
    if (/^\s*---+\s*$/.test(clean)) {
      const width = Math.min(60, Math.max(24, this.#width() - 4));
      this.#answerWrite(`  ${this.c.dim('─'.repeat(width))}\n`);
      return;
    }
    // Blockquotes lose their `>` marker and render dim/quoted.
    const quoted = clean.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      for (const display of this.#wrapProse(quoted[1])) {
        this.#answerWrite(`  ${this.c.dim(display)}\n`);
      }
      return;
    }
    // ATX headers (`### title`) lose their hashes and render bold instead:
    // the strip markers are presentation the model expects us to consume.
    // Prose wraps at word boundaries so inline tokens survive.
    const header = clean.match(/^\s*#{1,6}\s+(.*)$/);
    const body = header ? header[1] : clean;
    const base = header
      ? (text) => this.c.bold(this.#paint('white', text))
      : (text) => this.#paint('white', text);
    for (const display of this.#wrapProse(body)) {
      this.#answerWrite(`  ${renderInline(display, this.c, base)}\n`);
    }
  }

  /** Render an accumulated streamed block (table or fenced code) via the block renderer. */
  #renderBlock(block) {
    let text = block.lines.join('\n');
    if (block.type === 'code' && !/^\s*```[^\n]*\n[\s\S]*\n\s*```\s*$/.test(text)) {
      text += '\n```'; // the stream ended mid-fence: close it so it renders
    }
    const width = Math.max(24, this.#width() - 4);
    for (const line of renderMarkdown(text, { width, c: this.c, color: this.color, base: (item) => this.#paint('white', item) })) {
      this.#answerWrite(line ? `  ${line}\n` : '\n');
    }
  }

  /** Flush the trailing partial line; the answer is plain text and is never erased. */
  answerEnd() {
    const st = this.answer;
    if (!st.active) return;
    st.active = false;
    if (st.pending) {
      this.#answerRow(st.pending);
      st.pending = '';
    }
    if (st.block) {
      this.#renderBlock(st.block); // the stream ended inside a block: render it
      st.block = null;
    }
  }

  /** True only when the streamed answer was actually drawn as a live box. */
  streamedResponse() {
    return Boolean(this.ansi && (this.answer.active || this.answer.text.length > 0));
  }

  /**
   * The response arrived: one line of real telemetry about that model call —
   * latency, tokens, time to first token, and whether it was cut off.
   */
  thinkingEnd({ durationMs, firstTokenMs = null, usage = null, finishReason = null, truncated = false } = {}) {
    // Keep the activity line alive as `working` until the next phase (reasoning,
    // tools or the answer) takes over.
    if (this.status.active) this.#setPhase('working');
    if (durationMs === undefined) return;
    const prompt = Number.isFinite(usage?.prompt) ? usage.prompt : null;
    const completion = Number.isFinite(usage?.completion) ? usage.completion : null;
    if (prompt !== null) this.status.promptTokens = prompt;
    if (completion !== null) this.status.completionTokens = completion;
    if (this.plain) {
      const extra = firstTokenMs !== null && firstTokenMs !== undefined ? ` · first token ${firstTokenMs}ms` : '';
      this.#write(this.c.dim(`  (model responded in ${durationMs}ms${extra})`));
      return;
    }
    const parts = [formatSeconds(durationMs)];
    if (prompt !== null || completion !== null) parts.push(`${formatTokens(prompt)}↑ ${formatTokens(completion)}↓ tok`);
    if (firstTokenMs !== null && firstTokenMs !== undefined) parts.push(`first token ${formatSeconds(firstTokenMs)}`);
    if (truncated || finishReason === 'length') parts.push('truncated at the token cap');
    this.#write(`  ${this.c.dim('◇')} ${this.c.dim(`model ${parts.join(' · ')}`)}`);
  }

  workingEnd({ durationMs } = {}) {
    // Tools finished; the next step switches the line back to `thinking`.
    if (this.plain && durationMs !== undefined) {
      this.#write(this.c.dim(`  (model responded in ${durationMs}ms)`));
    }
  }

  note({ text }) {
    if (!text) return;
    const clean = cleanModelTokens(text).trim().replace(/\s+/g, ' ');
    const clipped = clean.length > 240 ? `${clean.slice(0, 240)}…` : clean;
    if (this.plain) {
      this.#write(this.c.dim(`  ${clipped}`));
    } else {
      this.#write(`  ${this.c.dim('│')} ${this.#paint('white', clipped)}`);
    }
  }

  toolStart({ name, args, index = 0, total = 0, detail = '' }) {
    if (this.reasoning.active) this.reasoningEnd({});
    if (this.answer.active) this.answerEnd();
    // Running a tool is exactly the `working` phase the user asked for.
    this.status.tool = name;
    this.status.toolIndex = index;
    this.status.toolTotal = total;
    this.status.extra = String(detail || '').slice(0, 120);
    this.#setPhase('working', this.status.extra);
    let argsPreview = '';
    try {
      argsPreview = JSON.stringify(args ?? {});
    } catch {
      argsPreview = '{}';
    }
    if (argsPreview.length > 160) argsPreview = `${argsPreview.slice(0, 160)}…`;
    if (this.plain) {
      this.#write(`  ${this.#icon('→', '>')} ${name} ${this.c.dim(argsPreview)}`);
      return;
    }
    this.#write(
      `  ${this.c.dim('│')} ${this.#paint('violet', '◆')} ${this.c.bold(this.c.hex(PALETTE.blue)(name))} ${this.c.dim(this.#fit(argsPreview, this.#innerWidth() - 20))}`,
    );
  }

  toolEnd({ name, ok, durationMs, summary, cached = false }) {
    this.status.tool = '';
    this.status.toolIndex = 0;
    this.status.toolTotal = 0;
    this.status.extra = '';
    // The command box below carries the output from here on; keeping the live
    // tail would print the same two lines twice.
    this.status.output = [];
    const duration = durationMs !== undefined && !cached ? `${durationMs}ms` : '';
    const detail = summary ? String(summary).replace(/\s+/g, ' ').slice(0, 220) : '';
    if (cached) {
      if (this.plain) {
        this.#write(this.c.dim(`  [cached] ${name} · ${detail}`));
        return;
      }
      this.#write(`  ${this.c.dim('│')} ${this.#paint('cyan', '↺')} ${this.c.hex(PALETTE.blue)(name)} ${this.c.dim(`· ${detail}`)}`);
      return;
    }
    if (this.plain) {
      const symbol = ok ? this.c.green('[ok]') : this.c.red('[fail]');
      this.#write(
        `  ${symbol} ${name}${duration ? this.c.dim(` ${duration}`) : ''}${detail ? this.c.dim(` · ${detail}`) : ''}`,
      );
      return;
    }
    const symbol = ok ? this.#paint('green', '✓') : this.#paint('red', '✕');
    const stats = [duration, detail].filter(Boolean).join(' · ');
    this.#write(
      `  ${this.c.dim('│')} ${symbol} ${this.c.hex(PALETTE.blue)(name)}${stats ? ` ${this.c.dim(`· ${stats}`)}` : ''}`,
    );
  }

  /**
   * Compact multi-provider fallback report for one web search.
   *
   *   │ ◇ WEB SEARCH
   *   │ ├─ You.com       ✕ timeout
   *   │ ├─ Firecrawl     ✓ berhasil
   *   │ └─ Hasil pencarian diteruskan ke agent
   *
   * Only the final state is printed: one block per search, not one line per
   * attempt, so a slow provider cannot flood the terminal. Stack traces stay
   * in the debug log.
   */
  webSearchStatus(event = {}) {
    if (!event || event.phase !== 'done' || !Array.isArray(event.rows) || event.rows.length === 0) return;
    const rows = event.rows;
    const symbols = {
      ok: ['✓', '[ok]'],
      failed: ['✕', '[fail]'],
      empty: ['○', '[empty]'],
      skipped: ['!', '[skip]'],
      standby: ['○', '[wait]'],
    };
    const colors = { ok: 'green', failed: 'red', empty: 'amber', skipped: 'amber', standby: 'dim' };
    if (this.plain) {
      const parts = rows.map((row) => {
        const state = symbols[row.status]?.[1] || row.status;
        const ms = row.durationMs ? ` ${row.durationMs}ms` : '';
        return `${row.label}: ${state}${row.reason && row.status !== 'standby' ? ` (${row.reason})` : ''}${ms}`;
      });
      this.#write(this.c.dim(`  [web] ${parts.join(' · ')}`));
      return;
    }
    const line = (row, last) => {
      const [symbol] = symbols[row.status] || ['○'];
      const paint = colors[row.status] === 'dim' ? this.c.dim : (text) => this.#paint(colors[row.status] || 'white', text);
      const reason = row.status === 'standby' ? '' : row.reason ? ` ${this.c.dim(row.reason)}` : '';
      const ms = row.durationMs ? this.c.dim(` ${row.durationMs}ms`) : '';
      return `  ${this.c.dim('│')} ${this.c.dim(last ? '└─' : '├─')} ${this.#paint('white', row.label.padEnd(12))} ${paint(symbol)}${reason}${ms}`;
    };
    this.#write(`  ${this.c.dim('│')} ${this.#paint('violet', '◇')} ${this.c.bold(this.#paint('cyan', 'WEB SEARCH'))}`);
    rows.forEach((row, index) => this.#write(line(row, index === rows.length - 1)));
    const footer = event.ok
      ? event.provider
        ? 'Hasil pencarian diteruskan ke agent'
        : 'Tidak ada hasil; agent lanjut tanpa sumber web'
      : 'Tidak ada provider yang berhasil; agent dapat melanjutkan tanpa pencarian web';
    this.#write(`  ${this.c.dim('│')} ${this.c.dim('└─')} ${this.c.dim(footer)}`);
  }

  /**
   * Show the exact lines a write changed, unified-diff style, so the user can
   * audit the edit and cancel + re-task if it is wrong.
   *
   *   • Edit src/agent/agent.js  (+12 −3)
   *     -       tokenUsage: session.tokenUsage,
   *     +       metrics: {
   */
  fileDiff({ kind = 'edit', path: relPath = '', diff = '', added = 0, removed = 0, from = null, to = null } = {}) {
    const label = kind === 'create' ? 'Create' : kind === 'write' ? 'Write' : kind === 'delete' ? 'Delete' : kind === 'move' ? 'Move' : 'Edit';
    const target = kind === 'move' && from ? `${from} -> ${to}` : relPath;
    if (!target) return;
    const stats = kind === 'move' || kind === 'delete' ? '' : `${this.c.green(`+${added}`)} ${this.c.red(`−${removed}`)}`;
    const heading = `  ${this.#paint('violet', '•')} ${this.c.bold(label)} ${this.c.hex(PALETTE.blue)(this.#fit(target, this.#innerWidth() - 18))}`;
    if (this.plain) {
      this.#write(`  • ${label} ${target}${stats ? ` (+${added} -${removed})` : ''}`);
    } else {
      this.#write(stats ? `${heading}  ${this.c.dim('(')}${stats}${this.c.dim(')')}` : heading);
    }
    if (!diff) return;

    const rows = String(diff).split('\n');
    const shown = [];
    let hidden = 0;
    for (const row of rows) {
      if (row.startsWith('---') || row.startsWith('+++')) continue;
      if (shown.length >= MAX_DIFF_LINES) {
        hidden += 1;
        continue;
      }
      shown.push(row);
    }
    const width = Math.max(20, this.#width() - 6);
    for (const row of shown) {
      const marker = row.startsWith('+') ? '+' : row.startsWith('-') ? '-' : row.startsWith('@@') ? '@' : ' ';
      const body = marker === '@' ? row : row.slice(1);
      const clipped = this.#fit(body, width);
      if (marker === '@') {
        this.#write(this.plain ? `    ${clipped}` : `    ${this.c.dim(clipped)}`);
      } else if (this.plain) {
        this.#write(`    ${marker}${clipped}`);
      } else if (marker === '+') {
        this.#write(`    ${this.c.green('+')}${this.c.green(clipped)}`);
      } else if (marker === '-') {
        this.#write(`    ${this.c.red('-')}${this.c.red(clipped)}`);
      } else {
        this.#write(`    ${this.c.dim(` ${clipped}`)}`);
      }
    }
    if (hidden > 0) {
      this.#write(this.c.dim(`    … ${hidden} more diff line(s)`));
    }
  }

  toolDenied({ name, reason }) {
    if (this.plain) {
      this.#write(`  [denied] ${name} ${this.c.dim(`· ${reason}`)}`);
      return;
    }
    this.#write(
      `  ${this.c.dim('│')} ${this.#paint('amber', '⊘')} ${this.c.hex(PALETTE.blue)(name)} ${this.c.dim(`· ${reason}`)}`,
    );
  }

  approvalRequest({ tool, risk, preview, reasons, critical }) {
    // Never leave the activity line running under an interactive y/N prompt.
    this.stopActivity();
    const tone = critical ? 'red' : 'amber';
    if (this.plain) {
      this.#write('');
      this.#write(`${critical ? '[!]' : '[approval]'} Approval required · ${tool} · risk: ${risk}${critical ? ' · CRITICAL' : ''}`);
      if (reasons?.length) {
        for (const reason of reasons) this.#write(this.c.dim(`  - ${reason}`));
      }
      if (preview) {
        this.#write(this.c.dim('  ┌─ preview ' + '─'.repeat(40)));
        for (const line of String(preview).split('\n').slice(0, 60)) this.#write(`  │ ${line}`);
        const total = String(preview).split('\n').length;
        if (total > 60) this.#write(this.c.dim(`  │ … (${total - 60} more lines)`));
        this.#write(this.c.dim(`  └${'─'.repeat(49)}`));
      }
      return;
    }

    this.#write('');
    this.#write(this.#top(`${critical ? '▲' : '◆'} approval required`, `${tool} · risk: ${risk}`));
    this.#write(this.#row(`${this.#paint('cyan', 'gate'.padEnd(10))} ${critical ? this.#paint('red', 'CRITICAL') : 'interactive consent'}`));
    if (reasons?.length) {
      for (const reason of reasons) this.#write(this.#row(`${this.#paint('amber', '·')} ${reason}`));
    }
    if (preview) {
      this.#write(this.#mid('preview'));
      const lines = String(preview).split('\n');
      for (const line of lines.slice(0, 60)) this.#write(`  ${this.#paint('cyan', '│')} ${line}`);
      if (lines.length > 60) this.#write(`  ${this.#paint('cyan', '│')} ${this.c.dim(`… (${lines.length - 60} more lines)`)}`);
    }
    this.#write(this.#bottom());
    this.#write(`  ${this.#paint(tone, '▸')} ${this.c.dim('Review the exact action above before approving.')}`);
    this.#write('');
  }

  /**
   * Show what a command printed, as a closed block with a stable id:
   *
   *   ╭─ ⌘ run_command #5 · exit 0 ─────────────────────╮
   *   │ $ npm test                                      │
   *   ├─ output ────────────────────────────────────────┤
   *   │ … the last 5 lines …                            │
   *   ╰─────────────────────────────────────────────────╯
   *   4 more line(s) · click or /expand 5 · /logs p1
   *
   * The complete captured output stays in the block registry, so a click on
   * the block (or `/expand 5`) can show all of it at any later time.
   */
  commandOutput({ argv = [], stdout = '', stderr = '', exitCode = null, status = '', processId = null, timedOut = false, truncated = false } = {}) {
    const command = Array.isArray(argv) ? argv.join(' ') : String(argv ?? '');
    if (!command) return;
    const { lines, dropped } = commandOutputLines(stdout, stderr);
    const block = this.#createBlock({
      kind: 'command',
      command,
      lines,
      dropped,
      exitCode,
      status,
      processId,
      timedOut: Boolean(timedOut),
      truncated: Boolean(truncated),
    });
    if (this.plain) {
      this.#write(`  $ ${command}`);
      const shown = lines.slice(-20);
      const hidden = lines.length - shown.length + dropped;
      for (const row of shown) this.#write(`  ${row.stream === 'stderr' ? `! ${row.text}` : row.text}`);
      if (hidden > 0) {
        this.#write(this.c.dim(`  … ${hidden} more line(s)${processId ? ` · /logs ${processId}` : ''}`));
      }
      return;
    }
    this.#drawCommandBlock(block);
  }

  /** Rows of the closed command preview box. */
  #commandBoxLines(block) {
    const total = block.lines.length + block.dropped;
    const shown = block.lines.slice(-COMMAND_PREVIEW_LINES);
    const hidden = total - shown.length;
    const exit = block.exitCode === null || block.exitCode === undefined
      ? block.timedOut ? 'timed out' : block.status || ''
      : `exit ${block.exitCode}`;
    const inner = this.#innerWidth();
    const rows = [
      this.#top(`⌘ run_command #${block.id}${exit ? ` · ${exit}` : ''}`, '▸ closed'),
      this.#row(this.c.bold(this.c.hex(PALETTE.blue)(this.#fit(`$ ${block.command}`, inner)))),
      this.#mid('output'),
    ];
    if (shown.length === 0) {
      rows.push(this.#row(this.c.dim('(no output)')));
    } else {
      for (const row of shown) {
        const text = row.stream === 'stderr' ? `! ${row.text}` : row.text;
        rows.push(this.#row(row.stream === 'stderr' ? this.c.dim(this.c.red(text)) : this.c.dim(text)));
      }
    }
    rows.push(this.#bottom());
    const parts = [];
    if (hidden > 0) parts.push(`${hidden} more line(s)`);
    if (block.truncated) parts.push('capture truncated');
    parts.push(`click or /expand ${block.id}`);
    if (block.processId) parts.push(`/logs ${block.processId}`);
    rows.push(this.c.dim(`  ${parts.join(' · ')}`));
    return rows;
  }

  /** Print the command block and keep every row addressable for clicks. */
  #drawCommandBlock(block) {
    this.#printLines(this.#commandBoxLines(block), block.id);
  }

  /**
   * Output of a shell command the user typed (`/bash`, `!cmd`). Unlike a model
   * tool call this is printed in full, not as a five-line preview: the user ran
   * it and already knows what it is.
   */
  shellResult({ command, stdout = '', stderr = '', exitCode = null, durationMs = 0, truncated = false, signal = null, error = null } = {}) {
    const { lines, dropped } = commandOutputLines(stdout, stderr);
    const rows = [''];
    if (this.plain) rows.push(`$ ${command}`);
    else rows.push(`  ${this.#paint('blue', '$')} ${this.c.bold(this.c.hex(PALETTE.blue)(String(command ?? '')))}`);
    if (lines.length === 0) rows.push('  (no output)');
    for (const row of lines) {
      const text = row.stream === 'stderr' ? `! ${row.text}` : row.text;
      if (this.plain) rows.push(text);
      else rows.push(row.stream === 'stderr' ? this.c.dim(this.c.red(text)) : this.c.dim(text));
    }
    const exit = Number.isInteger(exitCode) ? `exit ${exitCode}` : signal ? `signal ${signal}` : 'exit ?';
    const bits = [exit, formatSeconds(durationMs)];
    if (dropped > 0) bits.push(`${dropped} line(s) dropped by the capture limit`);
    if (truncated) bits.push('capture truncated');
    if (error) bits.push(`error: ${error}`);
    rows.push(this.c.dim(`  ${bits.join(' · ')}`));
    rows.push('');
    this.#printLines(rows);
  }

  /** Print rows and keep them in the click map (used by expandable blocks). */
  #printLines(lines, blockId = null) {
    const prompt = this.#openScreen();
    for (const line of lines) {
      this.#trackScreen(`${line}\n`, blockId);
      this.stdout.write(`${line}\n`);
    }
    this.#paintAfterWrite();
    this.#closeScreen(prompt);
  }

  // ── expandable blocks ─────────────────────────────────────────────────────

  /**
   * The app hands the renderer a way to measure and repaint the live prompt.
   * The block panel is drawn directly above that prompt, so opening and
   * closing it never rewrites the transcript above.
   */
  setPromptController(controller) {
    this.promptController = controller || null;
  }

  #createBlock(data) {
    const block = { id: this.nextBlockId, ...data };
    this.nextBlockId += 1;
    this.blocks.set(block.id, block);
    return block;
  }

  hasBlock(id) {
    return this.blocks.has(Number(id));
  }

  listBlocks() {
    return [...this.blocks.values()].sort((a, b) => a.id - b.id);
  }

  /** Human-readable block index for `/expand` without an argument. */
  blockListText() {
    const blocks = this.listBlocks();
    if (blocks.length === 0) return '  No blocks yet. Reasoning and run_command output are listed here.';
    const rows = blocks.map((block) => {
      if (block.kind === 'reasoning') {
        const chars = block.chars ?? String(block.text || '').length;
        return `  #${String(block.id).padEnd(3)} reasoning    ${chars} chars`;
      }
      return `  #${String(block.id).padEnd(3)} run_command  ${block.command} · exit ${block.exitCode ?? '?'} · ${block.lines.length} line(s)`;
    });
    return ['  Expandable blocks (click one, or /expand <id>):', ...rows].join('\n');
  }

  isBlockViewOpen() {
    return Boolean(this.blockView);
  }

  #promptState() {
    const state = this.promptController?.metrics?.();
    return state?.active ? state : null;
  }

  /** Complete content of a block, wrapped for the panel. */
  #blockContent(block) {
    const inner = this.#innerWidth();
    if (block.kind === 'reasoning') {
      const text = cleanReasoning(block.text || '');
      const rows = wrapText(text, inner).map((line) => ({ text: line, tone: 'muted' }));
      return {
        title: `▾ ◈ reasoning #${block.id}`,
        meta: `${block.chars ?? [...text].length} chars · open`,
        rows: rows.length > 0 ? rows : [{ text: '', tone: 'muted' }],
      };
    }
    const rows = [];
    for (const line of wrapText(`$ ${block.command}`, inner)) rows.push({ text: line, tone: 'command' });
    rows.push({ text: '', tone: 'muted' });
    if (block.lines.length === 0) rows.push({ text: '(no output)', tone: 'muted' });
    for (const row of block.lines) {
      const prefix = row.stream === 'stderr' ? '! ' : '';
      for (const line of wrapText(`${prefix}${row.text}`, inner)) {
        rows.push({ text: line, tone: row.stream === 'stderr' ? 'stderr' : 'muted' });
      }
    }
    if (block.dropped > 0) {
      rows.push({ text: `… ${block.dropped} line(s) dropped by the capture limit`, tone: 'muted' });
    }
    if (block.truncated) rows.push({ text: 'capture truncated', tone: 'muted' });
    const exit = block.exitCode === null || block.exitCode === undefined
      ? block.timedOut ? 'timed out' : block.status || 'no exit'
      : `exit ${block.exitCode}`;
    return {
      title: `▾ ⌘ run_command #${block.id}`,
      meta: `${block.lines.length} line(s) · ${exit} · open`,
      rows,
    };
  }

  /** Rows of the open panel, bounded to the terminal so it can always close. */
  #panelLines() {
    const view = this.blockView;
    const block = view ? this.blocks.get(view.id) : null;
    if (!view || !block) return [];
    const { title, meta, rows } = this.#blockContent(block);
    const prompt = this.#promptState();
    const promptRows = prompt?.rows || 0;
    const maxBody = Math.max(1, this.#terminalRows() - promptRows - 4);
    view.body = Math.max(1, Math.min(maxBody, rows.length));
    view.maxScroll = Math.max(0, rows.length - view.body);
    view.scroll = Math.min(Math.max(0, view.scroll), view.maxScroll);
    const visible = rows.slice(view.scroll, view.scroll + view.body);
    const lines = [this.#top(title, meta)];
    for (const row of visible) {
      const paint = row.tone === 'stderr'
        ? (text) => this.c.dim(this.c.red(text))
        : row.tone === 'command'
          ? (text) => this.c.bold(this.c.hex(PALETTE.blue)(text))
          : (text) => this.c.dim(text);
      lines.push(this.#row(paint(row.text)));
    }
    lines.push(this.#bottom());
    const from = rows.length > 0 ? view.scroll + 1 : 0;
    const to = view.scroll + visible.length;
    const scrollHint = view.maxScroll > 0 ? ' · ↑↓/PgUp/PgDn/wheel' : '';
    lines.push(this.c.dim(`  ${from}-${to} of ${rows.length} line(s)${scrollHint} · Esc or click to close`));
    return lines;
  }

  #drawBlockView() {
    const view = this.blockView;
    if (!view) return;
    const prompt = this.#promptState();
    const up = view.rows + (prompt ? prompt.cursorRow : 0);
    this.stdout.write(up > 0 ? `\x1b[${up}A\r` : '\r');
    const lines = this.#panelLines();
    for (const line of lines) this.stdout.write(`\x1b[2K${line}\n`);
    view.rows = lines.length;
    if (prompt) {
      this.promptController?.resetCursor?.();
      this.promptController?.repaint?.();
    }
  }

  openBlockView(id) {
    const key = Number(id);
    const block = this.blocks.get(key);
    if (!block) return false;
    if (this.plain || !this.ansi) {
      this.#printBlockPlain(block);
      return true;
    }
    if (this.liveLines > 0) this.#clearLive();
    if (this.blockView) {
      if (this.blockView.id === key) return true;
      this.#eraseBlockView();
    }
    this.blockView = { id: key, scroll: 0, rows: 0, body: 0, maxScroll: 0 };
    this.#drawBlockView();
    return true;
  }

  /** Click/command toggle; returns whether the block exists and is now open. */
  toggleBlock(id) {
    const key = Number(id);
    if (!this.blocks.has(key)) return { exists: false, open: false };
    if (this.blockView?.id === key) {
      this.closeBlockView();
      return { exists: true, open: false };
    }
    this.openBlockView(key);
    return { exists: true, open: Boolean(this.blockView) };
  }

  closeBlockView() {
    if (!this.blockView) return false;
    this.#eraseBlockView();
    return true;
  }

  #eraseBlockView() {
    const view = this.blockView;
    if (!view) return;
    this.blockView = null;
    if (view.rows <= 0) return;
    const prompt = this.#promptState();
    const up = view.rows + (prompt ? prompt.cursorRow : 0);
    if (up > 0) this.stdout.write(`\x1b[${up}A\r`);
    if (prompt) {
      this.promptController?.resetCursor?.();
      this.promptController?.repaint?.();
    } else this.stdout.write('\x1b[0J');
  }

  scrollBlockView(delta) {
    const view = this.blockView;
    if (!view) return false;
    const next = Math.max(0, Math.min(view.scroll + Number(delta || 0), view.maxScroll || 0));
    if (next === view.scroll) return true;
    view.scroll = next;
    this.#drawBlockView();
    return true;
  }

  handleBlockViewKey(key) {
    const view = this.blockView;
    if (!view) return false;
    const body = Math.max(1, view.body || 1);
    switch (key) {
      case 'close':
        return this.closeBlockView();
      case 'up':
        return this.scrollBlockView(-1);
      case 'down':
        return this.scrollBlockView(1);
      case 'pageup':
        return this.scrollBlockView(-body);
      case 'pagedown':
        return this.scrollBlockView(body);
      case 'home':
        view.scroll = 0;
        this.#drawBlockView();
        return true;
      case 'end':
        view.scroll = view.maxScroll || 0;
        this.#drawBlockView();
        return true;
      default:
        return false;
    }
  }

  /**
   * Open/close the block under a mouse click. Only rows that are still in the
   * transcript can be clicked; `/expand <id>` covers the ones scrolled away.
   */
  handleMouse(event = {}) {
    if (!this.ansi || this.plain || !event || this.promptParked) return false;
    const prompt = this.#promptState();
    if (!prompt) return false;
    if (event.wheel) {
      if (!this.blockView) return false;
      return this.scrollBlockView(event.wheel === 'up' ? -3 : 3);
    }
    if (event.button !== 0 || event.release) return false;

    const transcriptRows = this.#screenRowCount();
    const panelRows = this.blockView?.rows || 0;
    const total = transcriptRows + panelRows + prompt.rows;
    const viewportTop = Math.max(0, total - this.#terminalRows());
    const absolute = viewportTop + Math.max(0, Number(event.y) - 1);

    if (this.blockView && absolute >= transcriptRows && absolute < transcriptRows + panelRows) {
      this.closeBlockView();
      return true;
    }
    if (absolute < 0 || absolute >= transcriptRows) return false;
    const id = this.#blockAtRow(absolute);
    if (!id) return false;
    if (this.blockView?.id === id) {
      this.closeBlockView();
      return true;
    }
    this.openBlockView(id);
    return true;
  }

  #printBlockPlain(block) {
    this.#write('');
    this.#write(`  #${block.id} ${block.kind === 'reasoning' ? 'reasoning' : `run_command · ${block.command}`}`);
    if (block.kind === 'reasoning') {
      for (const line of String(block.text || '').split('\n')) this.#write(this.c.dim(`  ${line}`));
      return;
    }
    for (const row of block.lines) this.#write(`  ${row.stream === 'stderr' ? `! ${row.text}` : row.text}`);
  }

  toolResult() {
    // The activity feed already shows the summary; full output is sent to the model.
  }

  warning({ message }) {
    this.warn(message);
  }

  error({ error }) {
    if (this.reasoning.active) this.reasoningEnd({ partial: true });
    if (this.answer.active) this.answerEnd();
    this.stopActivity();
    if (this.plain) {
      this.#write('');
      this.#write(this.c.red(`[error] ${error?.message || 'Unknown error'}`));
      if (error?.code) this.#write(this.c.dim(`  code: ${error.code}${error.status ? ` · HTTP ${error.status}` : ''}`));
      const plainHint = ERROR_HINTS[error?.code];
      if (plainHint) this.#write(this.c.yellow(`  hint: ${plainHint}`));
      if (this.debug && error?.stack) this.#write(this.c.dim(error.stack));
      return;
    }

    this.#write('');
    this.#write(this.#top('✕ runtime fault', error?.code || 'ERROR'));
    this.#write(this.#row(this.#paint('red', this.c.bold(this.#fit(error?.message || 'Unknown error', this.#innerWidth())))));
    if (error?.code) {
      this.#write(this.#row(`${this.#paint('cyan', 'code'.padEnd(10))} ${error.code}${error.status ? ` · HTTP ${error.status}` : ''}`));
    }
    const hint = ERROR_HINTS[error?.code];
    if (hint) this.#write(this.#row(`${this.#paint('amber', 'hint'.padEnd(10))} ${hint}`));
    this.#write(this.#bottom());
    if (this.debug && error?.stack) {
      this.#write(this.c.dim(error.stack));
    }
  }

  #finalPlain(summary) {
    const style = STATUS_STYLE[summary.status] || { label: summary.status, color: 'white' };
    const c = this.c;
    this.#write('');
    this.#write(c.cyan(`══ summary ${'═'.repeat(45)}`));
    if (summary.finalText) {
      this.#write('');
      this.#markdown(summary.finalText, { base: (text) => this.#paint('white', text) });
    }
    this.#write('');
    this.#write(
      `${c.bold('status')} ${c[style.color](style.label)}${c.dim(` · ${summary.steps} step(s) · ${(summary.durationMs / 1000).toFixed(1)}s`)}`,
    );

    this.#write(`${c.bold('changed files')} ${summary.changedFiles.length > 0 ? '' : c.dim('none')}`);
    for (const file of summary.changedFiles.slice(0, 30)) this.#write(c.green(`  + ${file}`));
    if (summary.changedFiles.length > 30) this.#write(c.dim(`  … ${summary.changedFiles.length - 30} more`));

    if (summary.commands.length > 0) {
      this.#write(c.bold('commands'));
      for (const cmd of summary.commands.slice(-15)) {
        const argv = Array.isArray(cmd.argv) ? cmd.argv.join(' ') : String(cmd.argv);
        const ok = cmd.exitCode === 0;
        this.#write(`  ${ok ? c.green('✔') : c.red('✖')} ${c.hex(PALETTE.blue)(argv)} ${c.dim(`· exit ${cmd.exitCode ?? '?'} · ${cmd.durationMs ?? '?'}ms${cmd.timedOut ? ' · timed out' : ''}`)}`);
      }
    }

    if (summary.tests.length > 0) {
      const passed = summary.tests.filter((test) => test.passed).length;
      this.#write(`${c.bold('tests')} ${passed}/${summary.tests.length} passed ${c.dim('(inferred from command exit codes)')}`);
    } else {
      this.#write(`${c.bold('tests')} ${c.dim('none run')}`);
    }

    if (summary.runningProcesses?.length) {
      this.#write(c.bold('running processes'));
      for (const proc of summary.runningProcesses) this.#write(`  ${c.cyan('●')} ${proc.id} ${proc.label ? c.dim(proc.label) : ''}`);
    }

    if (summary.issues.length > 0) {
      this.#write(c.yellow(`${c.bold('issues')} (${summary.issues.length})`));
      for (const issue of summary.issues.slice(-10)) this.#write(c.yellow(`  - ${issue}`));
    } else {
      this.#write(`${c.bold('issues')} ${c.dim('none recorded')}`);
    }

    this.#write(
      c.dim(
        `tokens ${summary.tokenUsage.prompt} prompt / ${summary.tokenUsage.completion} completion · approvals ${summary.approvals.approved} approved / ${summary.approvals.denied} denied` +
          (summary.undoCount ? ` · /undo available (${summary.undoCount})` : ''),
      ),
    );
    if (summary.metrics) {
      const m = summary.metrics;
      this.#write(
        c.dim(
          `model ${m.modelCalls ?? 0} call(s) · avg ${formatSeconds(m.avgRequestMs ?? 0)}` +
            (m.firstTokenMs !== null && m.firstTokenMs !== undefined ? ` · first token ${formatSeconds(m.firstTokenMs)}` : '') +
            (m.cachedReads ? ` · ${m.cachedReads} read(s) reused` : ''),
        ),
      );
    }
    if (summary.logFile) this.#write(c.dim(`log ${summary.logFile}`));
    this.#write('');
  }

  final(summary) {
    if (this.reasoning.active) this.reasoningEnd({ partial: summary.status !== 'completed' });
    this.stopActivity();
    // The streamed answer already printed as plain text; never print it twice.
    const streamed = this.streamedResponse();
    if (this.answer.active) this.answerEnd();
    if (this.plain) {
      this.#finalPlain(summary);
      return;
    }

    const style = STATUS_STYLE[summary.status] || { label: summary.status, color: 'white' };
    const c = this.c;
    const seconds = formatSeconds(summary.durationMs);
    const totalTokens = formatTokens(summary.tokenUsage.total);
    const approved = summary.approvals?.approved ?? 0;
    const denied = summary.approvals?.denied ?? 0;

    this.#write('');
    this.#write(this.#top('◈ summary // run complete', `${style.label} · ${seconds}`));
    this.#write(
      this.#row(
        `${this.#paint(style.color, '●')} ${c.bold(style.label.toUpperCase())}   ` +
          `${c.dim('steps')} ${summary.steps}   ${c.dim('tokens')} ${totalTokens}   ` +
          `${c.dim('approvals')} ${approved}/${denied}`,
      ),
    );
    if (summary.metrics) {
      const m = summary.metrics;
      const parts = [`${m.modelCalls ?? 0} model call(s)`, `avg ${formatSeconds(m.avgRequestMs ?? 0)}`];
      if (m.firstTokenMs !== null && m.firstTokenMs !== undefined) parts.push(`first token ${formatSeconds(m.firstTokenMs)}`);
      if (m.cachedReads) parts.push(`${m.cachedReads} read(s) reused from the worklog`);
      this.#write(this.#row(c.dim(parts.join(' · '))));
    }
    this.#write(this.#bottom());

    if (summary.finalText && !streamed) {
      this.#write('');
      this.#write(`  ${this.#paint('violet', '◆')} ${this.c.bold(this.#paint('white', 'RESPONSE'))}`);
      this.#write('');
      this.#markdown(summary.finalText, { base: (text) => this.#paint('white', text) });
    }

    this.#write('');
    this.#write(this.#top('◈ evidence'));
    if (summary.changedFiles.length > 0) {
      this.#write(this.#row(`${this.#paint('green', '▲ changes')} ${c.dim(`(${summary.changedFiles.length})`)}`));
      for (const file of summary.changedFiles.slice(0, 20)) {
        this.#write(this.#row(`  ${this.#paint('green', '+')} ${file}`));
      }
      if (summary.changedFiles.length > 20) {
        this.#write(this.#row(c.dim(`  … ${summary.changedFiles.length - 20} more`)));
      }
    } else {
      this.#write(this.#row(`${c.dim('changes')} ${c.dim('none')}`));
    }

    if (summary.commands.length > 0) {
      this.#write(this.#mid(`commands (${summary.commands.length})`));
      for (const cmd of summary.commands.slice(-12)) {
        const argv = Array.isArray(cmd.argv) ? cmd.argv.join(' ') : String(cmd.argv);
        const ok = cmd.exitCode === 0;
        this.#write(
          this.#row(              `${ok ? this.#paint('green', '✓') : this.#paint('red', '✕')} ${c.hex(PALETTE.blue)(argv)} ` +
              `${c.dim(`· exit ${cmd.exitCode ?? '?'} · ${cmd.durationMs ?? '?'}ms${cmd.timedOut ? ' · timed out' : ''}`)}`,
          ),
        );
      }
    }

    if (summary.tests.length > 0) {
      const passed = summary.tests.filter((test) => test.passed).length;
      this.#write(this.#row(`${this.#paint(passed === summary.tests.length ? 'green' : 'amber', 'tests')} ${passed}/${summary.tests.length} passed ${c.dim('(inferred)')}`));
    } else {
      this.#write(this.#row(`${c.dim('tests')} ${c.dim('none run')}`));
    }

    if (summary.runningProcesses?.length) {
      for (const proc of summary.runningProcesses) {
        this.#write(this.#row(`${this.#paint('cyan', '●')} ${proc.id} ${c.dim(proc.label || '')}`));
      }
    }

    if (summary.issues.length > 0) {
      this.#write(this.#mid(`issues (${summary.issues.length})`));
      for (const issue of summary.issues.slice(-8)) {
        this.#write(this.#row(`${this.#paint('amber', '▲')} ${issue}`));
      }
    } else {
      this.#write(this.#row(`${c.dim('issues')} ${c.dim('none recorded')}`));
    }
    this.#write(this.#bottom());

    this.#write(
      c.dim(
        `  tokens ${summary.tokenUsage.prompt} prompt / ${summary.tokenUsage.completion} completion` +
          (summary.undoCount ? ` · /undo available (${summary.undoCount})` : '') +
          (summary.logFile ? ` · log ${summary.logFile}` : ''),
      ),
    );
    this.#write('');
  }

  goodbye() {
    if (this.plain) {
      this.#write(this.c.dim('Goodbye.'));
      return;
    }
    this.#write('');
    this.#write(`  ${this.#grad('◈')} ${this.c.dim('session closed · see you in the next run')}`);
    this.#write('');
  }
}
