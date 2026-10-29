import { Chalk } from 'chalk';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_AT = /\x1b\[[0-?]*[ -/]*[@-~]/y;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
const TOKEN_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*|_[^_\n]+_)/;

const CODE_TOKEN_RE = /(\/\/.*|#.*|\/\*.*?\*\/|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b(?:const|let|var|function|return|if|else|for|while|import|from|export|default|class|extends|new|async|await|try|catch|finally|throw|def|fn|pub|struct|impl|use|mod|package|func|type|interface|select|go|defer|map|range|switch|case|break|continue|true|false|null|undefined|None|True|False|and|or|not|in|is)\b)/g;

const CYAN = '#22d3ee';
const CYAN_LIGHT = '#67e8f9';
const GREEN = '#86efac';
const AMBER = '#fbbf24';
const VIOLET = '#c4b5fd';
const SLATE = '#94a3b8';

function visibleLength(text) {
  return String(text ?? '').replace(ANSI_RE, '').length;
}

function toChalk(c, color) {
  if (!color) return new Chalk({ level: 0 });
  return c || new Chalk({ level: 1 });
}

/**
 * The accent colour used for rules, tables, headings, links and list markers.
 * Callers pass a chalk colour function (e.g. `c.hex('#38bdf8')`) to theme the
 * whole document; the default keeps the classic cyan look.
 */
function toAccent(accent, c, fallback = CYAN) {
  if (typeof accent === 'function') return accent;
  return (text) => c.hex(fallback)(text);
}

/** Remove model-provided ANSI escapes and unsafe control characters. */
function sanitize(text) {
  return String(text ?? '')
    .replace(ANSI_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '');
}

function plainInline(atom) {
  const value = String(atom ?? '');
  if (/^\*\*[\s\S]+\*\*$/.test(value) || /^__[\s\S]+__$/.test(value)) return value.slice(2, -2);
  if (/^`[\s\S]+`$/.test(value)) return value.slice(1, -1);
  if (/^~~[\s\S]+~~$/.test(value)) return value.slice(2, -2);
  const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) return link[1] === link[2] ? link[1] : `${link[1]} (${link[2]})`;
  if (/^\*[^*\n]+\*$/.test(value) || /^_[^_\n]+_$/.test(value)) return value.slice(1, -1);
  return value;
}

/**
 * Paint one inline Markdown atom. `base` is an optional chalk style (e.g.
 * `c.white`) applied to plain and style-wrapped atoms, so a caller can set the
 * default text colour without losing to mid-line ANSI resets.
 */
function paintInline(atom, c, base = null, accent = null) {
  const value = String(atom ?? '');
  const plain = (text) => (base ? base(text) : text);
  const accentPaint = toAccent(accent, c, CYAN_LIGHT);
  if (/^\*\*[\s\S]+\*\*$/.test(value) || /^__[\s\S]+__$/.test(value)) {
    return plain(c.bold(value.slice(2, -2)));
  }
  if (/^`[\s\S]+`$/.test(value)) {
    return c.bgHex('#1e293b')(accentPaint(value.slice(1, -1)));
  }
  if (/^~~[\s\S]+~~$/.test(value)) {
    return plain(c.strikethrough(value.slice(2, -2)));
  }
  const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    const label = c.underline(accentPaint(link[1]));
    return link[1] === link[2] ? label : `${label}${c.dim(` (${link[2]})`)}`;
  }
  if (/^\*[^*\n]+\*$/.test(value) || /^_[^_\n]+_$/.test(value)) {
    return plain(c.italic(value.slice(1, -1)));
  }
  return plain(value);
}

function splitWords(segment) {
  return String(segment).split(/(\s+)/).filter((part) => part !== '');
}

/** Break a long token at a natural boundary when one exists. */
function splitLongPlain(text, width) {
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > width) {
    const window = remaining.slice(0, width);
    const boundary = Math.max(
      window.lastIndexOf('/'),
      window.lastIndexOf('.'),
      window.lastIndexOf('-'),
      window.lastIndexOf('_'),
    );
    const cut = boundary > 0 && boundary < width - 1 ? boundary + 1 : width;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitAtoms(text) {
  const atoms = [];
  let last = 0;
  for (const match of String(text).matchAll(INLINE_RE)) {
    if (match.index > last) atoms.push(...splitWords(String(text).slice(last, match.index)));
    atoms.push(match[0]);
    last = match.index + match[0].length;
  }
  if (last < text.length) atoms.push(...splitWords(String(text).slice(last)));
  return atoms;
}

/** Apply inline Markdown without wrapping. */
export function renderInline(text, c, base = null, accent = null) {
  return splitAtoms(text).map((atom) => paintInline(atom, c, base, accent)).join('');
}

/** Wrap inline Markdown to a visible width, preserving styles. */
export function wrapInline(text, width, c, base = null, accent = null) {
  const max = Math.max(1, width);
  const atoms = splitAtoms(text);
  const lines = [];
  let line = '';
  let used = 0;

  for (const atom of atoms) {
    if (/^\s+$/.test(atom)) {
      if (!line) continue;
      if (used + 1 > max) {
        lines.push(line);
        line = '';
        used = 0;
        continue;
      }
      line += ' ';
      used += 1;
      continue;
    }
    const painted = paintInline(atom, c, base, accent);
    const plain = plainInline(atom);
    if (plain.length > max) {
      if (line) {
        lines.push(line);
        line = '';
        used = 0;
      }
      const chunks = splitLongPlain(plain, max);
      for (const chunk of chunks.slice(0, -1)) lines.push(chunk);
      line = chunks[chunks.length - 1] || '';
      used = line.length;
      continue;
    }
    if (used > 0 && used + plain.length > max) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += painted;
    used += plain.length;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

/** Truncate a styled line without cutting an ANSI escape sequence. */
function truncateStyled(text, width, c) {
  const value = String(text ?? '');
  if (visibleLength(value) <= width) return value;
  let output = '';
  let visible = 0;
  let index = 0;
  while (index < value.length && visible < width - 1) {
    if (value[index] === '\x1b') {
      ANSI_AT.lastIndex = index;
      const match = ANSI_AT.exec(value);
      if (match) {
        output += match[0];
        index = ANSI_AT.lastIndex;
        continue;
      }
    }
    output += value[index];
    visible += 1;
    index += 1;
  }
  return `${output}${c.dim('…')}${c.level > 0 ? '\x1b[0m' : ''}`;
}

function padStyled(text, width, align, c) {
  const padding = Math.max(0, width - visibleLength(text));
  if (padding === 0) return text;
  if (align === 'right') return `${' '.repeat(padding)}${text}`;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${text}${' '.repeat(padding - left)}`;
  }
  return `${text}${' '.repeat(padding)}`;
}

function splitRow(line) {
  let value = String(line).trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .map((cell) => cell.replace(/\u0000/g, '|').trim());
}

function parseTable(lines, start) {
  if (start + 1 >= lines.length) return null;
  if (!String(lines[start]).includes('|') || !String(lines[start + 1]).includes('|')) return null;
  const header = splitRow(lines[start]);
  const separator = splitRow(lines[start + 1]);
  if (header.length === 0 || header.length !== separator.length) return null;
  const aligns = [];
  for (const cell of separator) {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    if (value.startsWith(':') && value.endsWith(':')) aligns.push('center');
    else if (value.endsWith(':')) aligns.push('right');
    else aligns.push('left');
  }
  const rows = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index];
    if (!String(line).includes('|') || !String(line).trim()) break;
    const cells = splitRow(line);
    if (cells.length !== header.length) break;
    rows.push(cells);
    index += 1;
  }
  return { header, aligns, rows, next: index };
}

function renderVerticalTable(header, rows, { width, c, base = null, accent = null }) {
  const output = [];
  const inner = Math.max(8, width - 4);
  const paint = toAccent(accent, c);
  output.push(paint(`╭─ table ${'─'.repeat(Math.max(1, width - 10))}╮`));
  for (const row of rows) {
    for (let index = 0; index < header.length; index += 1) {
      const label = truncateStyled(renderInline(header[index] || `column ${index + 1}`, c, base, paint), inner, c);
      const value = renderInline(row[index] || '', c, base, paint);
      output.push(`${paint('│')} ${c.bold(label)}`);
      for (const line of wrapInline(value, inner, c, base, paint)) {
        output.push(`${paint('│')}   ${truncateStyled(line, inner, c)}`);
      }
    }
    output.push(paint('│'));
  }
  output.push(paint(`╰${'─'.repeat(Math.max(1, width - 2))}╯`));
  return output;
}

/** Fit a Markdown table into the available width. */
export function renderTable(header, aligns, rows, { width, c, base = null, accent = null }) {
  const columns = header.length;
  if (columns === 0) return [];
  const paint = toAccent(accent, c);
  const natural = [];
  for (let index = 0; index < columns; index += 1) {
    const candidates = [header[index] || '', ...rows.map((row) => row[index] || '')];
    const longest = Math.max(
      3,
      ...candidates.map((cell) => visibleLength(renderInline(cell, c, base, paint))),
    );
    natural.push(Math.min(32, longest));
  }

  const borderWidth = 3 * columns + 1;
  const budget = width - borderWidth;
  if (budget < columns * 3) {
    return renderVerticalTable(header, rows, { width, c, base, accent: paint });
  }

  const widths = natural.map((value) => Math.max(3, value));
  let total = widths.reduce((sum, value) => sum + value, 0);
  while (total > budget) {
    let widest = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if (widths[index] > widths[widest]) widest = index;
    }
    if (widths[widest] <= 3) break;
    widths[widest] -= 1;
    total -= 1;
  }
  if (total > budget) return renderVerticalTable(header, rows, { width, c, base, accent: paint });

  const wrapCell = (cell, colWidth) =>
    wrapInline(cell || '', colWidth, c, base, paint).map((line) => truncateStyled(line, colWidth, c));
  const headerLines = widths.map((colWidth, index) => wrapCell(header[index], colWidth));
  const bodyLines = rows.map((row) =>
    widths.map((colWidth, index) => wrapCell(row[index] || '', colWidth)),
  );
  const border = (left, middle, right) =>
    paint(`${left}${widths.map((colWidth) => '─'.repeat(colWidth + 2)).join(middle)}${right}`);

  const output = [border('╭', '┬', '╮')];
  const pushRow = (cells, isHeader) => {
    const height = Math.max(...cells.map((lines) => lines.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const rendered = cells.map((lines, column) => {
        const content = lines[lineIndex] ?? '';
        const padded = padStyled(content, widths[column], aligns[column], c);
        return isHeader ? c.bold(padded) : padded;
      });
      output.push(`${paint('│')} ${rendered.join(` ${paint('│')} `)} ${paint('│')}`);
    }
  };

  pushRow(headerLines, true);
  output.push(border('├', '┼', '┤'));
  for (const row of bodyLines) pushRow(row, false);
  output.push(border('╰', '┴', '╯'));
  return output;
}

function highlightCode(line, lang, c, color) {
  if (!color) return line;
  if (/^\+\+\+|^---/.test(line)) return c.bold(line);
  if (/^@@/.test(line)) return c.hex(CYAN_LIGHT)(line);
  if (/^\+(?!\+\+)/.test(line)) return c.hex(GREEN)(line);
  if (/^-(?!--)/.test(line)) return c.hex('#f87171')(line);
  if (/^diff --git/.test(line)) return c.bold(c.hex(CYAN)(line));

  let output = '';
  let last = 0;
  for (const match of line.matchAll(CODE_TOKEN_RE)) {
    output += line.slice(last, match.index);
    const token = match[0];
    if (/^(\/\/|#|\/\*)/.test(token)) output += c.dim(token);
    else if (/^['"`]/.test(token)) output += c.hex(GREEN)(token);
    else if (/^\d/.test(token)) output += c.hex(AMBER)(token);
    else output += c.hex(VIOLET)(token);
    last = match.index + token.length;
  }
  output += line.slice(last);
  return output;
}

function renderCodeBlock(lines, lang, { width, c, color, accent = null, copy = true }) {
  const label = lang ? ` ${lang} ` : ' code ';
  // The chip is the visible `⧉ copy` button: the TUI and the line renderer
  // register the whole block as its hit target. It shrinks away on a block too
  // narrow to read as a button instead of eating the whole rule.
  const chip = copy ? ' ⧉ copy ' : '';
  const showChip = Boolean(chip) && width - 2 - visibleLength(label) - visibleLength(chip) >= 4;
  const rule = Math.max(1, width - 2 - visibleLength(label) - (showChip ? visibleLength(chip) : 0));
  const paint = toAccent(accent, c);
  const chipPaint = showChip ? c.bgHex('#1e293b')(c.hex(SLATE)(chip)) : '';
  const output = [
    `${paint('╭─')}${c.bold(label)}${c.dim('─'.repeat(rule))}${chipPaint}`,
  ];
  const body = lines.length > 0 ? lines : [''];
  const codeWidth = Math.max(8, width - 2);
  for (const line of body) {
    const chunks = [];
    for (let index = 0; index < line.length; index += codeWidth) {
      chunks.push(line.slice(index, index + codeWidth));
    }
    if (chunks.length === 0) chunks.push('');
    for (const chunk of chunks) {
      output.push(`${paint('│')} ${highlightCode(chunk, lang, c, color)}`);
    }
  }
  output.push(paint(`╰${'─'.repeat(Math.max(1, width - 2))}`));
  return output;
}

function isHorizontalRule(line) {
  return /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  if (!line.trim()) return true;
  if (/^\s*```/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (isHorizontalRule(line)) return true;
  if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) return true;
  if (parseTable(lines, index)) return true;
  return false;
}

/**
 * Render a Markdown message for a terminal.
 *
 * @param {string} text
 * @param {object} options
 * @param {number} [options.width] visible columns available
 * @param {object} [options.c] chalk instance
 * @param {boolean} [options.color] paint ANSI styles
 * @param {Function} [options.base] default inline style
 * @param {Function} [options.accent] accent paint for rules and tables
 * @param {boolean} [options.copy] show the `⧉ copy` chip on code blocks
 * @param {Function} [options.onCodeBlock] receives `{ lang, code, start, end }`
 *   where `start`/`end` are the rendered row range of the block, so a caller
 *   can make that range a clipboard hit target
 * @returns {string[]} lines without a trailing newline and without outer indent
 */
export function renderMarkdown(
  text,
  { width = 80, c = null, color = true, base = null, accent = null, copy = true, onCodeBlock = null } = {},
) {
  const chalk = toChalk(c, color);
  const paint = toAccent(accent, chalk);
  const lines = sanitize(text).split('\n');
  const output = [];
  let index = 0;

  const pushBlank = () => {
    if (output.length > 0 && output[output.length - 1] !== '') output.push('');
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      pushBlank();
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+#.-]*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      pushBlank();
      const start = output.length;
      output.push(...renderCodeBlock(code, fence[1], { width, c: chalk, color, accent: paint, copy }));
      if (typeof onCodeBlock === 'function') {
        onCodeBlock({ lang: fence[1], code: code.join('\n'), start, end: output.length - 1 });
      }
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      pushBlank();
      output.push(...renderTable(table.header, table.aligns, table.rows, { width, c: chalk, base, accent: paint }));
      index = table.next;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const prefix = level === 1 ? '◆ ' : level === 2 ? '◇ ' : '· ';
      const content = truncateStyled(renderInline(heading[2], chalk, base, paint), Math.max(4, width - 2), chalk);
      output.push(`${paint(prefix)}${chalk.bold(content)}`);
      if (level === 1) output.push(chalk.dim('─'.repeat(width)));
      index += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      pushBlank();
      output.push(chalk.dim('─'.repeat(width)));
      pushBlank();
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      pushBlank();
      for (const wrapped of wrapInline(quote.join(' '), Math.max(4, width - 2), chalk, base, paint)) {
        output.push(`${paint('│')} ${chalk.dim(chalk.italic(truncateStyled(wrapped, width - 2, chalk)))}`);
      }
      continue;
    }

    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      const indent = list[1].replace(/\t/g, '  ');
      const marker = list[2];
      const ordered = /^\d/.test(marker);
      const checkbox = list[3].match(/^\[([ xX])\]\s+(.*)$/);
      const textContent = checkbox ? checkbox[2] : list[3];
      const bullet = checkbox
        ? (checkbox[1].toLowerCase() === 'x' ? chalk.hex(GREEN)('✓') : chalk.dim('○'))
        : (ordered ? paint(marker) : paint('▸'));
      const prefixWidth = indent.length + 2;
      const wrapped = wrapInline(textContent, Math.max(4, width - prefixWidth), chalk, base, paint);
      output.push(`${indent}${bullet} ${wrapped[0] || ''}`);
      for (const continuation of wrapped.slice(1)) {
        output.push(`${' '.repeat(prefixWidth)}${continuation}`);
      }
      index += 1;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    pushBlank();
    for (const wrapped of wrapInline(paragraph.join(' '), width, chalk, base, paint)) {
      output.push(wrapped);
    }
  }

  while (output.length > 0 && output[output.length - 1] === '') output.pop();
  return output;
}
