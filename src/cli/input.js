import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';
import { displayWidth } from './width.js';

/** Pastes at least this long are collapsed to a placeholder in the composer. */
export const PASTE_THRESHOLD = 1000;
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

const MOUSE_SEQUENCE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const PLACEHOLDER_RE = /> \[Pasted text #(\d+) [^\]]*\]/g;

/** The visible stand-in for a long paste, e.g. `> [Pasted text #1 3196 chars]`. */
export function formatPastePlaceholder(id, chars) {
  return `> [Pasted text #${id} ${chars} chars]`;
}

/**
 * Session-wide store for pasted text. The composer only shows a placeholder;
 * the original text is kept here and restored when the line is submitted
 * (including lines recalled from readline history and sent again).
 *
 * Ids are monotonic for the whole session, so editing or deleting one
 * placeholder can never renumber another one.
 */
export class PasteRegistry {
  constructor() {
    this.entries = new Map();
    this.nextId = 1;
  }

  add(text) {
    const value = String(text ?? '');
    const id = this.nextId++;
    const chars = [...value].length;
    const entry = { id, text: value, chars };
    this.entries.set(id, entry);
    return { ...entry, placeholder: formatPastePlaceholder(id, chars) };
  }

  get(id) {
    return this.entries.get(Number(id)) || null;
  }

  /** Restore every placeholder still present in the line; unknown ids stay as typed. */
  resolve(line) {
    return String(line ?? '').replace(PLACEHOLDER_RE, (match, rawId) => {
      const entry = this.entries.get(Number(rawId));
      return entry ? entry.text : match;
    });
  }
}

const KEY_SEQUENCES = new Map([
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
  ['\x1b', 'escape'],
]);

/**
 * Sits between the real stdin and readline. It is the only place that can
 * swallow input before readline turns it into text, so it owns:
 *
 *   - bracketed paste detection (a 3 000-character paste never echoes into
 *     the composer; it becomes a placeholder),
 *   - SGR mouse reporting (clicks are routed to the renderer, never typed),
 *   - panel keys (arrows/wheel scroll the open block panel instead of moving
 *     the readline cursor).
 */
export class ComposerInput {
  constructor({ input, registry = new PasteRegistry(), threshold = PASTE_THRESHOLD } = {}) {
    this.input = input;
    this.registry = registry;
    this.threshold = threshold;
    this.buffer = '';
    this.paste = null;
    this.composing = false;
    this.decoder = new StringDecoder('utf8');
    this.escTimer = null;
    this.mouseHandler = null;
    this.overlayKeyHandler = null;
    this.overlayOpen = () => false;
    this.composerEmpty = () => true;
    this.beforeSubmit = null;

    // readline reads from this proxy; stdin is filtered below before it gets here.
    this.proxy = new PassThrough();
    this.proxy.isTTY = Boolean(input?.isTTY);
    this.proxy.setRawMode = (mode) => input?.setRawMode?.(mode);
    this.proxy.columns = input?.columns;
    this.proxy.rows = input?.rows;

    this.onData = (chunk) => this.push(chunk);
    this.onEnd = () => {
      const rest = this.decoder.end();
      if (rest) this.push(rest);
      this.proxy.end();
    };
    input?.on('data', this.onData);
    input?.on('end', this.onEnd);
  }

  dispose() {
    this.input?.off('data', this.onData);
    this.input?.off('end', this.onEnd);
    this.reset();
    this.proxy.end();
    // Attaching a 'data' listener put stdin into flowing mode, and removing it
    // does not undo that. Without pausing here the stream keeps the event loop
    // alive, so `/exit` looked like a hang on a blank screen until Ctrl+C.
    // The next composer re-attaches its listener and resumes it again.
    this.input?.pause?.();
  }

  reset() {
    this.buffer = '';
    this.paste = null;
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
  }

  push(chunk) {
    if (typeof chunk === 'string') this.buffer += chunk;
    else this.buffer += this.decoder.write(chunk);
    this.#drain();
  }

  #forward(text) {
    if (!text) return;
    // Typing while a block panel is open dismisses it: the panel is a modal
    // inspector, and leaving it up while readline redraws a wrapped prompt
    // could make the cursor walk into the panel rows.
    if (this.overlayOpen() && /[^\x00-\x1f]/.test(text)) this.beforeSubmit?.();
    // Terminals without bracketed-paste support hand a paste over as one
    // plain chunk. Treat a very large pure-text chunk as a paste as well, so
    // the composer never has to echo thousands of characters.
    if (this.composing && !text.includes('\x1b') && [...text].length >= this.threshold) {
      const entry = this.registry.add(text);
      this.proxy.write(entry.placeholder);
      return;
    }
    if (this.overlayOpen() && /[\r\n\x03]/.test(text)) this.beforeSubmit?.();
    this.proxy.write(text);
  }

  #drain() {
    while (this.buffer.length > 0) {
      if (this.paste !== null) {
        // Accumulate the payload so an end marker split across stdin chunks
        // (or a paste larger than the chunk size) is still found.
        this.paste += this.buffer;
        this.buffer = '';
        const end = this.paste.indexOf(PASTE_END);
        if (end === -1) return;
        const text = this.paste.slice(0, end);
        this.buffer = this.paste.slice(end + PASTE_END.length);
        this.paste = null;
        this.#handlePaste(text);
        continue;
      }

      const escAt = this.buffer.indexOf('\x1b');
      if (escAt === -1) {
        const text = this.buffer;
        this.buffer = '';
        this.#forward(text);
        return;
      }
      if (escAt > 0) {
        const text = this.buffer.slice(0, escAt);
        this.buffer = this.buffer.slice(escAt);
        this.#forward(text);
        continue;
      }

      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.paste = '';
        continue;
      }

      const mouse = MOUSE_SEQUENCE.exec(this.buffer);
      if (mouse) {
        this.buffer = this.buffer.slice(mouse[0].length);
        this.#handleMouse(mouse);
        continue;
      }

      const sequence = this.#readEscape();
      if (!sequence) {
        this.#armEscapeTimeout();
        return;
      }
      this.buffer = this.buffer.slice(sequence.length);
      this.#handleEscape(sequence);
    }
  }

  /** A complete CSI/SS3/Alt sequence, or null while it is still incomplete. */
  #readEscape() {
    if (this.buffer.length === 1) return null; // could be a lone Esc
    if (this.buffer[1] === '[') {
      for (let index = 2; index < this.buffer.length; index += 1) {
        const code = this.buffer.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) return this.buffer.slice(0, index + 1);
      }
      return null;
    }
    if (this.buffer[1] === 'O') {
      return this.buffer.length < 3 ? null : this.buffer.slice(0, 3);
    }
    return this.buffer.slice(0, 2); // Alt+key
  }

  #armEscapeTimeout() {
    if (this.escTimer) return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (!this.buffer.startsWith('\x1b')) return;
      if (this.buffer.length === 1) {
        this.buffer = '';
        this.#handleEscape('\x1b');
        return;
      }
      // A chunk ended mid-sequence; hand it to readline unchanged rather than
      // swallowing the user's input.
      const rest = this.buffer;
      this.buffer = '';
      this.#forward(rest);
    }, 40);
    this.escTimer.unref?.();
  }

  #handleEscape(sequence) {
    const key = KEY_SEQUENCES.get(sequence);
    if (this.overlayOpen() && key) {
      if (key === 'escape') {
        this.overlayKeyHandler?.('close');
        return;
      }
      const navigation = key === 'up' || key === 'down' || key === 'home' || key === 'end';
      const paging = key === 'pageup' || key === 'pagedown';
      if (paging || (navigation && this.composerEmpty())) {
        this.overlayKeyHandler?.(key);
        return;
      }
    }
    this.#forward(sequence);
  }

  #handleMouse(match) {
    const rawButton = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const release = match[4] === 'm';
    const wheel = (rawButton & 64) === 64 ? ((rawButton & 1) === 1 ? 'down' : 'up') : null;
    this.mouseHandler?.({ button: rawButton & 3, wheel, x, y, release });
  }

  #handlePaste(text) {
    if (!this.composing) return; // no composer on screen: never replay it later
    if ([...text].length >= this.threshold) {
      const entry = this.registry.add(text);
      this.proxy.write(entry.placeholder);
      return;
    }
    this.#forward(text);
  }
}

/** Columns of the visible composer line (ANSI stripped). */
export function composerWidth(prefix, line, cursor = null) {
  const prefixWidth = displayWidth(prefix, { ansi: true });
  const lineWidth = displayWidth(line);
  return {
    total: prefixWidth + lineWidth,
    cursor: prefixWidth + (cursor === null ? lineWidth : displayWidth(String(line).slice(0, cursor))),
  };
}
