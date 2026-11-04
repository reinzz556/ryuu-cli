import { Chalk } from 'chalk';

/**
 * Welcome banner — minimal, futuristik, lebar-aware.
 *
 * Satu sumber untuk renderer (mode baris) dan TUI: logo "R" dengan gradasi
 * vertikal pink → biru langit, diikuti identitas dan telemetri nyata.
 *
 * Aturan:
 *  - semua nilai berasal dari pemanggil (versi, workspace, model, access, log);
 *  - tidak ada dependency baru (chalk sudah dipakai project);
 *  - TrueColor dipakai bila terminal mendukung; chalk menurunkan warnanya ke
 *    256/16 warna secara otomatis, dan level 0 menghasilkan teks polos;
 *  - setiap baris dipotong ke lebar terminal supaya tidak pernah "membungkus"
 *    frame menjadi rusak.
 */

/** Gradasi vertikal: pink (atas) → biru langit (bawah). */
export const BANNER_GRADIENT = Object.freeze({
  top: [244, 114, 182],
  bottom: [56, 189, 248],
});

/** Logo "R" futuristik (7 baris, 9 kolom) dengan batang tegak tebal 2 kolom. */
export const BANNER_LOGO = Object.freeze([
  '▄▄▄▄▄▄▄▄ ',
  '██▀▀▀▀██▄',
  '██    ▀██',
  '██▄▄▄▄██▀',
  '██▀▀██▄  ',
  '██    ██▄',
  '▀▀     ▀▀',
]);

const osLabel = (platform = process.platform) =>
  platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : String(platform);

/** Ambil level warna chalk (0 none, 1 basic, 2 256, 3 truecolor). */
export function colorLevel(c) {
  if (!c) return 0;
  const level = Number(c.level);
  if (Number.isFinite(level)) return Math.max(0, Math.min(3, level));
  return 0;
}

const mix = (from, to, ratio) =>
  from.map((start, index) => Math.round(start + (to[index] - start) * ratio));

const toHex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;

/**
 * Warnai logo baris demi baris (gradasi vertikal).
 * level ≥ 2 → gradasi penuh (TrueColor/256), level 1 → satu warna aksen,
 * level 0 → tanpa ANSI sama sekali.
 */
export function paintLogo(c) {
  const level = colorLevel(c);
  if (level === 0) return BANNER_LOGO.slice();
  if (level === 1) return BANNER_LOGO.map((row) => c.magenta(row));
  const span = Math.max(1, BANNER_LOGO.length - 1);
  return BANNER_LOGO.map((row, index) => c.hex(toHex(mix(BANNER_GRADIENT.top, BANNER_GRADIENT.bottom, index / span)))(row));
}

/** Potong teks polos ke `max` kolom; null bila tidak ada ruang. */
function cut(value, max) {
  const text = String(value ?? '');
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

/** Baris identitas: versi selalu dari pemanggil, bukan hardcode. */
export function bannerIdentity(header = {}) {
  const rows = [
    { kind: 'title', value: `Ryuu CLI v${header.version || 'dev'}` },
    { kind: 'field', label: 'workspace', value: header.workspace || '—' },
    {
      kind: 'field',
      label: 'runtime',
      value: header.node ? `Node.js ${header.node} · ${osLabel(header.platform)}` : '—',
    },
    { kind: 'field', label: 'model', value: header.model || '—' },
    { kind: 'field', label: 'access', value: header.approvalPolicy || 'ask' },
  ];
  if (header.logFile) rows.push({ kind: 'field', label: 'log', value: header.logFile });
  return rows;
}

/**
 * Susun banner.
 *
 * @param {object} header { version, workspace, model, node, approvalPolicy, logFile, platform }
 * @param {object} options { width, c }
 * @returns {string[]} baris siap cetak (masing-masing ≤ width kolom)
 */
export function bannerLines(header = {}, { width = 80, c = null } = {}) {
  const limit = Math.max(12, Math.floor(Number(width) || 80));
  const identity = bannerIdentity(header);
  const labelWidth = Math.max(...identity.filter((row) => row.kind === 'field').map((row) => row.label.length));
  const paint = c || new Chalk({ level: 0 });
  const dim = (text) => (colorLevel(c) > 0 ? paint.dim(text) : text);
  const bold = (text) => (colorLevel(c) > 0 ? paint.bold(text) : text);

  // Terminal sempit: logo dilepas, satu glyph aksen menggantikan identitas.
  if (limit < 40) {
    const lines = [];
    const title = identity[0];
    // Potong teks polos lebih dulu agar escape sequence tidak ikut terpotong.
    const plainTitle = cut(`◢ ${title.value}`, limit - 2);
    if (plainTitle.startsWith('◢') && colorLevel(c) > 0) {
      lines.push(`  ${paint.hex(toHex(BANNER_GRADIENT.top))('◢')}${bold(plainTitle.slice(1))}`);
    } else {
      lines.push(`  ${bold(plainTitle)}`);
    }
    for (const row of identity.slice(1)) {
      const valueWidth = limit - 2 - row.label.length - 2;
      lines.push(`  ${dim(row.label.padEnd(row.label.length))}  ${cut(row.value, valueWidth)}`);
    }
    return lines;
  }

  const logo = paintLogo(c);
  const logoWidth = Math.max(...BANNER_LOGO.map((row) => row.length));
  const indent = 2;
  const textStart = indent + logoWidth + 2;
  const lines = [];
  for (let index = 0; index < identity.length; index += 1) {
    const row = identity[index];
    const art = logo[index] || ' '.repeat(logoWidth);
    let text;
    if (row.kind === 'title') {
      text = bold(cut(row.value, limit - textStart));
    } else {
      const valueWidth = limit - textStart - labelWidth - 2;
      text = `${dim(row.label.padEnd(labelWidth))}  ${cut(row.value, valueWidth)}`;
    }
    const line = `${' '.repeat(indent)}${art}${' '.repeat(logoWidth - BANNER_LOGO[index].length + 2)}${text}`;
    lines.push(line.replace(/\s+$/, ''));
  }
  // Logo lebih tinggi dari identitas: baris tersisa tetap memakai gradasi.
  for (let index = identity.length; index < logo.length; index += 1) {
    lines.push(`${' '.repeat(indent)}${logo[index]}`.replace(/\s+$/, ''));
  }
  return lines;
}

/** Petunjuk singkat di bawah banner (dipisah agar bisa dimatikan). */
export function bannerHint({ width = 80, c = null, compact = false } = {}) {
  const text = compact
    ? 'type a task · /help · /exit'
    : 'type a task · /help commands · !cmd shell · click a prompt or code block to copy · PgUp/PgDn scroll';
  const limit = Math.max(12, Math.floor(Number(width) || 80));
  const plain = cut(text, limit - 2);
  const paint = c || new Chalk({ level: 0 });
  return colorLevel(c) > 0 ? ` ${paint.hex('#94a3b8')(plain)}` : ` ${plain}`;
}
