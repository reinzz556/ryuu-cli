/**
 * Copying to the terminal clipboard with OSC 52.
 *
 * The sequence is written to the tty, so the copy happens in the terminal
 * emulator (or terminal multiplexer) rather than through an OS command: it works
 * over SSH, needs no `pbcopy`/`xclip`/`clip.exe`, and touches no other process.
 * Terminals that ignore OSC 52 simply do nothing, which is why callers report the
 * result instead of assuming the clipboard changed.
 */

/** Terminals cap OSC 52 payloads (xterm's default is ~75k of base64). */
const MAX_CHARS = 100_000;

/** The raw sequence for `text`, or null when there is nothing to copy. */
export function clipboardPayload(text, { limit = MAX_CHARS } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) return null;
  const kept = value.length > limit ? value.slice(0, limit) : value;
  return {
    sequence: `\x1b]52;c;${Buffer.from(kept, 'utf8').toString('base64')}\x1b\\`,
    chars: [...kept].length,
    truncated: kept.length < value.length,
  };
}

/**
 * Put `text` on the clipboard. Returns `{ ok, chars, truncated, reason }`; a
 * failure is reported, never thrown, because a copy must not break a session.
 */
export function copyToClipboard(text, { output = process.stdout } = {}) {
  const payload = clipboardPayload(text);
  if (!payload) return { ok: false, reason: 'empty', chars: 0 };
  if (!output || output.isTTY === false || !output.write) {
    return { ok: false, reason: 'no-tty', chars: 0 };
  }
  output.write(payload.sequence);
  return { ok: true, chars: payload.chars, truncated: payload.truncated };
}
