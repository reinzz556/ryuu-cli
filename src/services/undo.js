import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FileChangedError, ToolError } from '../utils/errors.js';

/**
 * Undo records exact before/after snapshots for file operations performed by
 * this agent session. /undo only reverts when the file still matches the
 * recorded after-state; it refuses otherwise instead of clobbering user edits.
 *
 * Snapshots live under .ryuu/undo (gitignored) and never include secret files,
 * which the workspace tool layer blocks before an undo record can be created.
 */
export class UndoManager {
  constructor({ workspace, dir = null, logger = null, maxEntries = 40 } = {}) {
    this.workspace = workspace;
    this.dir = dir;
    this.logger = logger;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.sessionId = null;
  }

  reset(sessionId) {
    this.sessionId = sessionId;
    this.entries = [];
  }

  record(entry) {
    this.entries.push({ ...entry, at: new Date().toISOString() });
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.#persist();
  }

  list() {
    return this.entries.map((entry, index) => ({
      index,
      kind: entry.kind,
      path: entry.path,
      to: entry.to,
      at: entry.at,
    }));
  }

  get size() {
    return this.entries.length;
  }

  last() {
    return this.entries.at(-1) || null;
  }

  async revertLast() {
    const entry = this.last();
    if (!entry) throw new ToolError('Nothing to undo in this session.');
    await this.revert(entry);
    this.entries.pop();
    this.#persist();
    return entry;
  }

  /** Revert a recorded change after checking the file has not changed again. */
  async revert(entry) {
    switch (entry.kind) {
      case 'write': {
        const current = await this.#readCurrent(entry.path);
        if (current !== entry.after) {
          throw new FileChangedError(`${entry.path} changed after the agent edit; refusing to overwrite. Inspect it or use git.`);
        }
        if (entry.before === null) {
          await this.workspace.remove(entry.path);
        } else {
          await this.workspace.writeText(entry.path, entry.before);
        }
        break;
      }
      case 'delete': {
        if (await this.workspace.exists(entry.path)) {
          throw new FileChangedError(`${entry.path} exists again; refusing to overwrite it with the deleted snapshot.`);
        }
        await this.workspace.writeText(entry.path, entry.before);
        break;
      }
      case 'move': {
        if (!(await this.workspace.exists(entry.to))) {
          throw new FileChangedError(`Moved file is missing: ${entry.to}. Cannot move it back.`);
        }
        await this.workspace.move(entry.to, entry.path, { overwrite: false });
        break;
      }
      default:
        throw new ToolError(`Unknown undo entry kind: ${entry.kind}`);
    }
    this.logger?.info('undo applied', { kind: entry.kind, path: entry.path });
    return entry;
  }

  async #readCurrent(relPath) {
    try {
      const file = await this.workspace.readText(relPath);
      return file.text;
    } catch (error) {
      if (error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  #persist() {
    if (!this.dir || !this.sessionId) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(this.dir, `${this.sessionId}.tmp`);
      fs.writeFileSync(tmp, `${JSON.stringify(this.entries, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, path.join(this.dir, `${this.sessionId}.json`));
    } catch (error) {
      this.logger?.warn('failed to persist undo stack', { error: error.message });
    }
  }

  async load(sessionId) {
    if (!this.dir) return 0;
    this.sessionId = sessionId;
    try {
      const raw = await fsp.readFile(path.join(this.dir, `${sessionId}.json`), 'utf8');
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed) ? parsed : [];
      return this.entries.length;
    } catch {
      this.entries = [];
      return 0;
    }
  }
}
