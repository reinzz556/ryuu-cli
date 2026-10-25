import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ComposerInput, PasteRegistry, composerWidth } from './input.js';

const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
const MOUSE_MODE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_MODE_OFF = '\x1b[?1000l\x1b[?1006l';

/**
 * Thin wrapper around readline/promises.
 *
 * In a terminal it filters stdin first: long pastes become composer
 * placeholders, mouse clicks are routed to the renderer, and keys that belong
 * to an open block panel never reach the line buffer. It can be reset after
 * Ctrl+C so a pending approval question does not swallow the next command.
 *
 * One read is armed for the whole session instead of one per question. That is
 * what lets the composer stay on screen while a task streams: the line typed
 * during a run is delivered to the REPL (or to a pending approval), never lost
 * and never turned into a second prompt for the model.
 */
export class PromptSession {
  constructor({ input = stdin, output = stdout, onSigint = null, mouse = true } = {}) {
    this.input = input;
    this.output = output;
    this.onSigint = onSigint;
    this.terminal = Boolean(input.isTTY && output.isTTY);
    // Mouse reporting is only useful (and only harmless) when the renderer can
    // draw the clickable blocks. It swallows the wheel on the main screen, so
    // plain/no-colour runs keep the terminal's native scrolling.
    this.mouse = Boolean(mouse && this.terminal);
    this.registry = new PasteRegistry();
    this.questionText = '';
    // True from the first question until close: the composer is on screen, so
    // the renderer can park and redraw it around streaming output.
    this.pending = false;
    // One rl.question at a time, always aimed at the current prompt text.
    this.reading = false;
    this.drawnQuestion = null;
    // Lines for the REPL, modal questions (approvals) and lines typed while
    // nobody was waiting yet.
    this.consumers = [];
    this.claimers = [];
    this.lineQueue = [];
    this.closed = false;
    this.composer = null;
    this.rl = null;

    // Hooks wired by the app: mouse/panel control and panel state.
    this.onMouse = null;
    this.onOverlayKey = null;
    this.isOverlayOpen = () => false;
    this.onBeforeSubmit = null;

    this.exitHandler = () => this.#writeModes(false);
    if (this.terminal) {
      process.once('exit', this.exitHandler);
      this.#writeModes(true);
    }
    this.#create();
  }

  #writeModes(enabled) {
    if (!this.terminal || !this.output) return;
    const mouse = this.mouse ? (enabled ? MOUSE_MODE_ON : MOUSE_MODE_OFF) : '';
    this.output.write(enabled ? `${PASTE_MODE_ON}${mouse}` : `${mouse}${PASTE_MODE_OFF}`);
  }

  #create() {
    this.composer?.dispose();
    this.composer = null;
    this.reading = false;
    this.drawnQuestion = null;

    if (this.terminal) {
      this.composer = new ComposerInput({ input: this.input, registry: this.registry });
      this.composer.overlayOpen = () => Boolean(this.isOverlayOpen?.());
      this.composer.composerEmpty = () => !this.rl?.line;
      this.composer.mouseHandler = (event) => this.onMouse?.(event);
      this.composer.overlayKeyHandler = (key) => this.onOverlayKey?.(key);
      this.composer.beforeSubmit = () => this.onBeforeSubmit?.();
      this.composer.composing = this.pending;
    }

    const input = this.composer?.proxy || this.input;
    this.rl = readline.createInterface({
      input,
      output: this.output,
      terminal: this.terminal,
    });
    if (this.onSigint) {
      this.rl.on('SIGINT', () => this.onSigint());
    }
    this.#ensureReading();
  }

  /** Keep exactly one read in flight for as long as the composer is wanted. */
  #ensureReading() {
    if (!this.rl || this.closed || this.reading || !this.pending) return;
    const rl = this.rl;
    this.reading = true;
    this.drawnQuestion = this.questionText;
    rl.question(this.questionText).then(
      (line) => {
        if (rl !== this.rl) return; // the interface was reset meanwhile
        this.reading = false;
        this.#dispatch(line);
        this.#ensureReading();
      },
      () => {
        if (rl !== this.rl) return;
        this.reading = false;
        this.#ensureReading();
      },
    );
  }

  /**
   * Route a submitted line. An approval (or any modal question) owns the next
   * line; otherwise the REPL gets it, or it waits in the queue when the REPL is
   * busy running a command.
   */
  #dispatch(line) {
    const waiter = this.claimers.shift() || this.consumers.shift();
    if (waiter) waiter(line);
    else this.lineQueue.push(line);
  }

  #drainQueue() {
    while (this.consumers.length > 0 && this.lineQueue.length > 0) {
      this.consumers.shift()(this.lineQueue.shift());
    }
  }

  #claimLine() {
    return new Promise((resolve) => {
      this.claimers.push(resolve);
    });
  }

  #settleClaims(answer) {
    for (const resolve of this.claimers.splice(0)) resolve(answer);
  }

  /** Show `questionText`, redrawing the prompt when the text changed. */
  #syncPrompt() {
    if (!this.rl || this.drawnQuestion === this.questionText) return;
    this.drawnQuestion = this.questionText;
    this.rl.setPrompt(this.questionText);
    if (this.reading) this.rl.prompt(true);
  }

  /** Ask a question; returns null when the interface is closed/cancelled. */
  async ask(question) {
    this.questionText = String(question ?? '');
    this.pending = true;
    if (this.composer) this.composer.composing = true;
    this.#ensureReading();
    this.#syncPrompt();
    const answer = await new Promise((resolve) => {
      this.consumers.push(resolve);
      this.#drainQueue();
    });
    if (answer === null || answer === undefined) return null;
    return this.registry.resolve(answer);
  }

  /**
   * A modal question (approval). It takes the next submitted line, even while
   * the REPL is between asks, and never starts a second readline read.
   */
  async confirm(question) {
    const previous = this.questionText;
    this.questionText = String(question ?? '');
    this.pending = true;
    this.#ensureReading();
    this.#syncPrompt();
    const answer = await this.#claimLine();
    this.questionText = previous;
    this.drawnQuestion = null;
    this.#syncPrompt();
    if (answer === null || answer === undefined) return { answer: 'cancel', value: false };
    const text = String(answer).trim().toLowerCase();
    if (text === 'y' || text === 'yes') return { answer: text, value: true };
    if (text === 'a') return { answer: text, value: true, all: true };
    return { answer: text, value: false };
  }

  /**
   * Rows and cursor row of the prompt currently on screen. The block panel is
   * drawn above it and transcript output is written in its place, so both need
   * to know exactly how far the prompt reaches.
   */
  metrics() {
    if (!this.terminal || !this.pending || !this.rl || !this.reading) {
      return { active: false, rows: 0, cursorRow: 0 };
    }
    const width = Math.max(20, Number(this.output.columns) || 80);
    const line = this.rl.line || '';
    const { total, cursor } = composerWidth(this.questionText, line, this.rl.cursor);
    const rows = Math.max(1, Math.ceil(total / width));
    const cursorRow = Math.min(rows - 1, Math.floor(cursor / width));
    return { active: true, rows, cursorRow };
  }

  /** Redraw the prompt in place; readline clears everything below it first. */
  repaint() {
    if (!this.terminal || !this.pending || !this.rl || !this.reading) return;
    this.rl.prompt(true);
  }

  /**
   * The renderer moved the cursor to the prompt's first row itself, so readline
   * must not move up again from its old cursor position.
   */
  resetCursor() {
    if (this.rl) this.rl.prevRows = 0;
  }

  reset() {
    this.#settleClaims('');
    this.reading = false;
    this.drawnQuestion = null;
    try {
      this.rl?.close();
    } catch {
      // Ignore: the interface may already be closed.
    }
    this.#create();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#writeModes(false);
    if (this.exitHandler) process.off('exit', this.exitHandler);
    // Nothing may stay blocked on a line once the session is over.
    this.#settleClaims(null);
    for (const resolve of this.consumers.splice(0)) resolve(null);
    this.lineQueue.length = 0;
    try {
      this.rl?.close();
    } catch {
      // Ignore double close.
    }
    this.rl = null;
    this.reading = false;
    this.composer?.dispose();
    this.composer = null;
    // Release stdin so the event loop can drain: `/exit` must return to the
    // shell instead of leaving the process waiting for one more key.
    this.input?.pause?.();
  }
}
