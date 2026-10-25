import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  FileChangedError,
  NotFoundError,
  PathEscapeError,
  SecretFileError,
  ToolError,
} from '../utils/errors.js';

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.cache',
  '.ryuu',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'logs',
  '.idea',
  '.vscode',
]);

const SAFE_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SECRET_BASENAME_PATTERNS = [
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /^credentials(\.json|\.ya?ml)?$/i,
  /^service-account.*\.json$/i,
  /^(secrets?|tokens?)\.(json|ya?ml|txt|ini)$/i,
];
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/i;
const SECRET_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const CRLF_BYTES = Buffer.from('\r\n');

export function isSecretPath(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  const segments = normalized.split('/');
  const base = segments.at(-1) || '';
  if (SAFE_ENV_TEMPLATES.has(base)) {
    // .env.example is documentation, but never allow it to shadow a real secret.
    return segments.some((segment) => SECRET_DIR_SEGMENTS.has(segment));
  }
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (SECRET_EXTENSIONS.test(base)) return true;
  if (SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) return true;
  if (segments.some((segment) => SECRET_DIR_SEGMENTS.has(segment))) return true;
  return false;
}

export function isIgnoredName(name) {
  return DEFAULT_IGNORED_DIRS.has(name);
}

/**
 * A Workspace is the only directory the agent may read or write.
 * All tool paths are resolved through it; escapes (including symlinks) throw.
 */
export class Workspace {
  constructor(root, { logger } = {}) {
    if (!root) throw new ToolError('Workspace root is required.');
    const absolute = path.resolve(root);
    if (!fs.existsSync(absolute)) throw new ToolError(`Workspace does not exist: ${absolute}`);
    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) throw new ToolError(`Workspace is not a directory: ${absolute}`);
    this.root = fs.realpathSync(absolute);
    this.logger = logger;
  }

  get label() {
    return this.root;
  }

  /** Resolve a user/model supplied path, rejecting traversal and symlink escapes. */
  resolve(inputPath = '.', { mustExist = false } = {}) {
    if (typeof inputPath !== 'string') throw new ToolError('Path must be a string.');
    if (inputPath.includes('\0')) throw new ToolError('Path contains a NUL byte.');
    const requested = inputPath.trim() === '' ? '.' : inputPath.trim();
    const absolute = path.resolve(this.root, requested);
    const rel = path.relative(this.root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PathEscapeError(`Path escapes the workspace: ${inputPath}`, { workspace: this.root, requested });
    }

    // Resolve symlinks on the deepest existing ancestor, then re-check containment.
    let ancestor = absolute;
    const remainder = [];
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      remainder.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    let realAncestor;
    try {
      realAncestor = fs.realpathSync(ancestor);
    } catch (error) {
      throw new ToolError(`Cannot resolve path ${inputPath}: ${error.message}`);
    }
    const realTarget = path.join(realAncestor, ...remainder);
    const realRel = path.relative(this.root, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new PathEscapeError(`Path resolves outside the workspace via a symlink: ${inputPath}`, {
        workspace: this.root,
        resolved: realTarget,
      });
    }

    if (mustExist && remainder.length > 0) {
      throw new NotFoundError(`Path does not exist: ${inputPath}`);
    }

    const relPath = path.relative(this.root, absolute) || '.';
    return { absPath: absolute, realPath: realTarget, relPath: relPath.split(path.sep).join('/') };
  }

  assertNotSecret(relPath) {
    if (isSecretPath(relPath)) {
      throw new SecretFileError(
        `Access to secret file is blocked by policy: ${relPath}. Ryuu never reads or modifies credential files.`,
        { path: relPath },
      );
    }
  }

  /** Resolve a path for reading, enforcing existence, type and secret rules. */
  async resolveFile(inputPath) {
    const resolved = this.resolve(inputPath);
    this.assertNotSecret(resolved.relPath);
    let linkStat;
    try {
      linkStat = await fsp.lstat(resolved.absPath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new NotFoundError(`File not found: ${inputPath}`);
      throw new ToolError(`Cannot stat ${inputPath}: ${error.message}`);
    }
    if (linkStat.isSymbolicLink()) throw new ToolError(`Refusing to follow symlink file: ${inputPath}`);
    if (!linkStat.isFile()) throw new ToolError(`Not a regular file: ${inputPath}`);
    const stat = await fsp.stat(resolved.absPath);
    return { ...resolved, stat };
  }

  /** Read a UTF-8 text file with size and encoding checks. */
  async readText(inputPath, { maxBytes = 262144 } = {}) {
    const { absPath, relPath, stat } = await this.resolveFile(inputPath);
    if (stat.size > maxBytes) {
      throw new ToolError(
        `File is too large to read (${stat.size} bytes > limit ${maxBytes}). Use search_files, or read a specific line range.`,
        { path: relPath, size: stat.size, maxBytes },
      );
    }
    const buffer = await fsp.readFile(absPath);
    if (buffer.includes(0)) throw new ToolError(`File appears to be binary, not text: ${relPath}`);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new ToolError(`File is not valid UTF-8 text: ${relPath}`);
    }
    if (text.includes('\uFFFD')) {
      throw new ToolError(`File contains undecodable characters (encoding is not UTF-8): ${relPath}`);
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return { text, relPath, absPath, size: stat.size, mtimeMs: stat.mtimeMs, eol, lines: text.split(/\r?\n/).length };
  }

  /**
   * Read a line range without loading the whole file into memory.
   *
   * A file above `maxBytes` cannot be read whole, but a range can still be
   * streamed: the file is decoded chunk by chunk, binary and encoding problems
   * are detected exactly as in readText(), only the requested lines are kept,
   * and the total line count is reported so callers can paginate.
   *
   * The returned text is capped at `maxBytes`; `truncated` means there are more
   * lines after `endLine`, and `capped` means the byte cap stopped collection
   * before the requested end.
   */
  async readTextRange(inputPath, { startLine = 1, endLine = null, maxBytes = 262144 } = {}) {
    const { absPath, relPath, stat } = await this.resolveFile(inputPath);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const lastWanted = endLine ?? Infinity;
    const collected = [];
    let collectedBytes = 0;
    let pending = '';
    let pendingBytes = 0;
    let lineNumber = 1;
    let lastReturned = 0;
    let capped = false;
    let sawCRLF = false;
    let carryCR = false;

    const wantsCurrentLine = () => !capped && lineNumber >= startLine && lineNumber <= lastWanted;

    const appendSegment = (segment) => {
      if (!segment || !wantsCurrentLine()) return;
      pending += segment;
      pendingBytes += Buffer.byteLength(segment, 'utf8');
      // One line that cannot fit stops collection instead of buffering an
      // unbounded amount of text.
      if (pendingBytes > maxBytes) {
        pending = '';
        pendingBytes = 0;
        capped = true;
      }
    };

    const completeLine = () => {
      if (wantsCurrentLine()) {
        const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
        const separator = collected.length > 0 ? 1 : 0;
        const bytes = Buffer.byteLength(line, 'utf8') + separator;
        if (collectedBytes + bytes > maxBytes) {
          capped = true;
        } else {
          collected.push(line);
          collectedBytes += bytes;
          lastReturned = lineNumber;
        }
      }
      pending = '';
      pendingBytes = 0;
      lineNumber += 1;
    };

    for await (const chunk of fs.createReadStream(absPath, { highWaterMark: 64 * 1024 })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.includes(0)) throw new ToolError(`File appears to be binary, not text: ${relPath}`);
      if (!sawCRLF) {
        if (buffer.includes(CRLF_BYTES)) sawCRLF = true;
        else if (carryCR && buffer[0] === 0x0a) sawCRLF = true;
      }
      carryCR = buffer[buffer.length - 1] === 0x0d;

      let text;
      try {
        text = decoder.decode(buffer, { stream: true });
      } catch {
        throw new ToolError(`File is not valid UTF-8 text: ${relPath}`);
      }
      let rest = text;
      for (;;) {
        const newline = rest.indexOf('\n');
        if (newline === -1) break;
        appendSegment(rest.slice(0, newline));
        completeLine();
        rest = rest.slice(newline + 1);
      }
      appendSegment(rest);
    }
    try {
      appendSegment(decoder.decode());
    } catch {
      throw new ToolError(`File is not valid UTF-8 text: ${relPath}`);
    }
    completeLine();
    const totalLines = lineNumber - 1;

    if (startLine > totalLines) {
      throw new ToolError(`start_line ${startLine} is beyond the end of ${relPath} (${totalLines} lines).`);
    }
    if (lastReturned < startLine) {
      throw new ToolError(
        `The range starting at line ${startLine} does not fit in ${maxBytes} bytes; one line is larger than the read limit. Raise max_bytes, or use search_files to locate the content.`,
        { path: relPath, maxBytes },
      );
    }

    return {
      text: collected.join('\n'),
      relPath,
      absPath,
      startLine,
      endLine: lastReturned,
      totalLines,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      eol: sawCRLF ? '\r\n' : '\n',
      truncated: lastReturned < totalLines,
      capped,
    };
  }

  /**
   * Write a text file atomically, optionally requiring the file to be unchanged.
   * Preserves CRLF line endings and existing permissions where practical.
   */
  async writeText(inputPath, content, { expectedMtimeMs, atomic = true, allowCreate = true } = {}) {
    const resolved = this.resolve(inputPath);
    this.assertNotSecret(resolved.relPath);
    if (typeof content !== 'string') throw new ToolError('File content must be a string.');

    let existing = null;
    let mode = 0o644;
    try {
      const stat = await fsp.lstat(resolved.absPath);
      if (stat.isDirectory()) throw new ToolError(`Cannot write to a directory: ${resolved.relPath}`);
      if (stat.isSymbolicLink()) throw new ToolError(`Refusing to write through a symlink: ${resolved.relPath}`);
      existing = stat;
      mode = stat.mode & 0o777;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error.code !== 'ENOENT') throw new ToolError(`Cannot stat ${resolved.relPath}: ${error.message}`);
      if (!allowCreate) throw new NotFoundError(`File not found: ${resolved.relPath}`);
    }

    if (expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
      if (!existing) throw new FileChangedError(`File was deleted since it was inspected: ${resolved.relPath}`);
      if (existing.mtimeMs !== expectedMtimeMs) {
        throw new FileChangedError(
          `File changed on disk since it was inspected (mtime ${existing.mtimeMs} != ${expectedMtimeMs}). Re-read it and retry.`,
          { path: resolved.relPath, expected: expectedMtimeMs, actual: existing.mtimeMs },
        );
      }
    }

    let finalContent = content;
    if (existing) {
      const previous = await fsp.readFile(resolved.absPath, 'utf8');
      if (previous.includes('\r\n')) finalContent = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    }

    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    let writtenPath = resolved.absPath;
    if (atomic) {
      const tmp = path.join(path.dirname(resolved.absPath), `.ryuu-tmp-${crypto.randomBytes(6).toString('hex')}`);
      const handle = await fsp.open(tmp, 'wx', mode);
      try {
        await handle.writeFile(finalContent, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fsp.rename(tmp, resolved.absPath);
      } catch (error) {
        await fsp.rm(tmp, { force: true });
        throw new ToolError(`Atomic write failed for ${resolved.relPath}: ${error.message}`);
      }
      writtenPath = resolved.absPath;
    } else {
      await fsp.writeFile(writtenPath, finalContent, { encoding: 'utf8', mode });
    }

    const stat = await fsp.stat(writtenPath);
    return {
      relPath: resolved.relPath,
      absPath: writtenPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      created: !existing,
      lines: finalContent.split(/\r?\n/).length,
    };
  }

  async createText(inputPath, content, { overwrite = false } = {}) {
    const resolved = this.resolve(inputPath);
    this.assertNotSecret(resolved.relPath);
    if (!overwrite && fs.existsSync(resolved.absPath)) {
      throw new ToolError(`File already exists: ${resolved.relPath}. Use write_file to replace it or set overwrite=true.`);
    }
    return this.writeText(inputPath, content);
  }

  async exists(inputPath) {
    try {
      const resolved = this.resolve(inputPath);
      return fs.existsSync(resolved.absPath);
    } catch {
      return false;
    }
  }

  async remove(inputPath) {
    const resolved = this.resolve(inputPath);
    this.assertNotSecret(resolved.relPath);
    let stat;
    try {
      stat = await fsp.lstat(resolved.absPath);
    } catch {
      throw new NotFoundError(`Path not found: ${resolved.relPath}`);
    }
    if (stat.isSymbolicLink()) {
      // Remove the link itself, never its target.
      await fsp.unlink(resolved.absPath);
      return { relPath: resolved.relPath, kind: 'symlink' };
    }
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(resolved.absPath);
      if (entries.length > 0) {
        throw new ToolError(`Directory is not empty: ${resolved.relPath}. Delete files individually.`);
      }
      await fsp.rmdir(resolved.absPath);
      return { relPath: resolved.relPath, kind: 'directory' };
    }
    await fsp.unlink(resolved.absPath);
    return { relPath: resolved.relPath, kind: 'file', size: stat.size };
  }

  async move(fromPath, toPath, { overwrite = false } = {}) {
    const from = this.resolve(fromPath);
    const to = this.resolve(toPath);
    this.assertNotSecret(from.relPath);
    this.assertNotSecret(to.relPath);
    let stat;
    try {
      stat = await fsp.lstat(from.absPath);
    } catch {
      throw new NotFoundError(`Source not found: ${from.relPath}`);
    }
    if (!stat.isFile()) throw new ToolError('move_file only supports regular files.');
    if (!overwrite && fs.existsSync(to.absPath)) {
      throw new ToolError(`Destination already exists: ${to.relPath}`);
    }
    await fsp.mkdir(path.dirname(to.absPath), { recursive: true });
    await fsp.rename(from.absPath, to.absPath);
    return { from: from.relPath, to: to.relPath, size: stat.size };
  }

  /** List a directory with stable ordering, filtering and pagination. */
  async list(inputPath = '.', { limit = 200, offset = 0, filter, includeGenerated = false, includeHidden = false } = {}) {
    const resolved = this.resolve(inputPath);
    let stat;
    try {
      stat = await fsp.stat(resolved.absPath);
    } catch {
      throw new NotFoundError(`Directory not found: ${resolved.relPath}`);
    }
    if (!stat.isDirectory()) throw new ToolError(`Not a directory: ${resolved.relPath}`);

    const matcher = filter ? wildcardToRegExp(filter) : null;
    const entries = await fsp.readdir(resolved.absPath, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.name.startsWith('.ryuu-tmp-')) continue;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const rel = resolved.relPath === '.' ? entry.name : `${resolved.relPath}/${entry.name}`;
      if (!includeGenerated && (isIgnoredName(entry.name) || isSecretPath(rel))) continue;
      if (matcher && !matcher.test(entry.name)) continue;
      let kind = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
      let size = null;
      if (kind === 'file') {
        try {
          size = (await fsp.stat(path.join(resolved.absPath, entry.name))).size;
        } catch {
          size = null;
        }
      }
      items.push({ name: entry.name, path: rel, kind, size });
    }
    items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    const total = items.length;
    const page = items.slice(offset, offset + limit);
    return {
      path: resolved.relPath,
      total,
      offset,
      limit,
      entries: page,
      truncated: offset + page.length < total,
      ignored: includeGenerated ? [] : [...DEFAULT_IGNORED_DIRS].filter((name) => entries.some((e) => e.name === name)),
    };
  }

  /** Bounded recursive tree. */
  async tree(inputPath = '.', { depth = 3, maxEntries = 200, includeGenerated = false } = {}) {
    const root = this.resolve(inputPath);
    const stat = await fsp.stat(root.absPath).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new NotFoundError(`Directory not found: ${root.relPath}`);
    const lines = [`${root.relPath === '.' ? path.basename(this.root) + '/' : root.relPath + '/'}`];
    let count = 0;
    let truncated = false;

    const walk = async (absDir, prefix, level) => {
      if (level > depth) return;
      let entries;
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const rel = path.relative(this.root, path.join(absDir, entry.name)).split(path.sep).join('/');
        if (isSecretPath(rel)) continue;
        if (!includeGenerated && isIgnoredName(entry.name)) continue;
        if (entry.name.startsWith('.ryuu-tmp-')) continue;
        if (count >= maxEntries) {
          truncated = true;
          return;
        }
        const isLast = i === entries.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        lines.push(`${prefix}${branch}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        count += 1;
        if (entry.isDirectory() && level < depth) {
          await walk(path.join(absDir, entry.name), `${prefix}${isLast ? '    ' : '│   '}`, level + 1);
        }
      }
    };

    await walk(root.absPath, '', 1);
    if (truncated) lines.push(`… truncated after ${maxEntries} entries (raise max_entries or narrow the path)`);
    return { path: root.relPath, text: lines.join('\n'), entries: count, truncated };
  }

  /** Metadata about a path (no content). */
  async info(inputPath) {
    const resolved = this.resolve(inputPath);
    this.assertNotSecret(resolved.relPath);
    let stat;
    try {
      stat = await fsp.lstat(resolved.absPath);
    } catch {
      throw new NotFoundError(`Path not found: ${resolved.relPath}`);
    }
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    const result = {
      path: resolved.relPath,
      kind,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      mode: (stat.mode & 0o777).toString(8),
    };
    if (kind === 'symlink') {
      try {
        const real = await fsp.realpath(resolved.absPath);
        result.target = path.relative(this.root, real).split(path.sep).join('/') || '.';
        result.insideWorkspace = !result.target.startsWith('..');
      } catch {
        result.target = '(unresolvable)';
      }
    }
    if (kind === 'file') {
      result.isProbablyText = await looksLikeText(resolved.absPath);
      if (result.isProbablyText && stat.size <= 2 * 1024 * 1024) {
        result.lines = await countLines(resolved.absPath);
      }
    }
    return result;
  }

  /** Relative label for a path, or null if outside. */
  toRelative(absPath) {
    const rel = path.relative(this.root, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }
}

export function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

async function looksLikeText(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function countLines(file) {
  const text = await fsp.readFile(file, 'utf8');
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}
