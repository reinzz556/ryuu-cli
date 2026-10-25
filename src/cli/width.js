/** ANSI control sequences (colours, cursor moves) that take no columns. */
export const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

const ZERO_WIDTH_RE = /[\u0300-\u036f\u0483-\u0489\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;

/** Code point ranges that occupy two terminal columns (CJK, kana, emoji…). */
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Terminal columns for one code point (0 for marks, 2 for wide glyphs). */
export function charWidth(code) {
  if (!code) return 0;
  if (ZERO_WIDTH_RE.test(String.fromCodePoint(code))) return 0;
  for (const [start, end] of WIDE_RANGES) {
    if (code >= start && code <= end) return 2;
  }
  return 1;
}

/**
 * Printable columns of a string. The box border math depends on this: counting
 * characters instead made CJK reasoning lines wrap, so the cursor-up erase
 * walked the wrong number of rows and the screen scrolled itself apart.
 */
export function displayWidth(text, { ansi = false } = {}) {
  const value = ansi ? String(text ?? '').replace(ANSI_SEQUENCE, '') : String(text ?? '');
  let width = 0;
  for (const char of value) width += charWidth(char.codePointAt(0));
  return width;
}
