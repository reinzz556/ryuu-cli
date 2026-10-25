import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from './registry.js';
import { isIgnoredName, isSecretPath } from '../services/workspace.js';
import { ToolError } from '../utils/errors.js';

const MAX_VISITED = 20000;
const MAX_FILES = 5000;
const MAX_LINE_PREVIEW = 240;

/**
 * Build the search service. Bounded in every dimension so a large repository
 * cannot hang the agent or flood the context window.
 */
export function createSearchService({ workspace, config, logger = null }) {
  return async function searchFiles({
    query,
    target = 'both',
    path: startPath = '.',
    regex = false,
    caseSensitive = false,
    maxResults,
    includeGenerated = false,
  }) {
    if (typeof query !== 'string' || query.length === 0) throw new ToolError('query must be a non-empty string.');
    const limit = Math.max(1, Math.min(maxResults ?? config.maxSearchResults, config.maxSearchResults));
    const root = workspace.resolve(startPath || '.');
    let rootStat;
    try {
      rootStat = await fsp.stat(root.absPath);
    } catch {
      throw new ToolError(`Search path not found: ${root.relPath}`);
    }

    let matcher;
    if (regex) {
      try {
        matcher = new RegExp(query, `${caseSensitive ? '' : 'i'}g`);
      } catch (error) {
        throw new ToolError(`Invalid regular expression: ${error.message}`);
      }
    } else {
      matcher = null;
    }

    const matches = [];
    let visited = 0;
    let filesScanned = 0;
    let directories = 0;
    let truncated = false;
    const warnings = [];

    const matchText = (text) => {
      if (matcher) {
        matcher.lastIndex = 0;
        return matcher.test(text);
      }
      return caseSensitive ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase());
    };

    const searchContent = async (absFile, relFile, size) => {
      if (size > config.maxFileBytes) {
        warnings.push(`Skipped large file (${size} bytes): ${relFile}`);
        return;
      }
      let buffer;
      try {
        buffer = await fsp.readFile(absFile);
      } catch (error) {
        warnings.push(`Unreadable file: ${relFile} (${error.code || error.message})`);
        return;
      }
      if (buffer.includes(0)) return;
      const text = new TextDecoder('utf-8').decode(buffer);
      if (text.includes('\uFFFD')) {
        warnings.push(`Skipped non-UTF-8 file: ${relFile}`);
        return;
      }
      filesScanned += 1;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index];
        if (!matchText(line)) continue;
        let column = 1;
        if (matcher) {
          matcher.lastIndex = 0;
          const found = matcher.exec(line);
          column = (found?.index ?? 0) + 1;
        } else {
          const found = caseSensitive ? line.indexOf(query) : line.toLowerCase().indexOf(query.toLowerCase());
          column = (found < 0 ? 0 : found) + 1;
        }
        const preview = line.length > MAX_LINE_PREVIEW ? `${line.slice(0, MAX_LINE_PREVIEW)}…` : line;
        matches.push({ type: 'content', file: relFile, line: index + 1, column, text: preview });
      }
    };

    const consider = async (absFile, relFile, size) => {
      if (matches.length >= limit) {
        truncated = true;
        return;
      }
      if (target === 'name' || target === 'both') {
        if (matchText(path.basename(relFile))) {
          matches.push({ type: 'name', file: relFile, size });
        }
      }
      if ((target === 'content' || target === 'both') && matches.length < limit) {
        await searchContent(absFile, relFile, size);
      }
    };

    if (rootStat.isFile()) {
      const rel = root.relPath;
      if (!isSecretPath(rel)) await consider(root.absPath, rel, rootStat.size);
    } else if (rootStat.isDirectory()) {
      const stack = [{ abs: root.absPath, rel: root.relPath }];
      outer: while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
          entries = await fsp.readdir(dir.abs, { withFileTypes: true });
        } catch (error) {
          warnings.push(`Unreadable directory: ${dir.rel} (${error.code || error.message})`);
          continue;
        }
        directories += 1;
        for (const entry of entries) {
          visited += 1;
          if (visited > MAX_VISITED) {
            truncated = true;
            break outer;
          }
          const rel = dir.rel === '.' ? entry.name : `${dir.rel}/${entry.name}`;
          if (isSecretPath(rel)) continue;
          if (!includeGenerated && isIgnoredName(entry.name)) continue;
          if (entry.name.startsWith('.ryuu-tmp-')) continue;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            stack.push({ abs: path.join(dir.abs, entry.name), rel });
            continue;
          }
          if (!entry.isFile()) continue;
          if (filesScanned >= MAX_FILES) {
            truncated = true;
            break outer;
          }
          let stat;
          try {
            stat = await fsp.stat(path.join(dir.abs, entry.name));
          } catch {
            continue;
          }
          await consider(path.join(dir.abs, entry.name), rel, stat.size);
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    logger?.debug('search complete', { query: query.slice(0, 80), matches: matches.length, visited });
    return {
      query: regex ? `/${query}/` : query,
      target,
      root: root.relPath,
      matches,
      count: matches.length,
      truncated,
      limits: { maxResults: limit, visited, maxVisited: MAX_VISITED, filesScanned, maxFiles: MAX_FILES, directories },
      warnings: warnings.slice(0, 10),
    };
  };
}

export function createSearchTools({ workspace, config, logger }) {
  const searchFiles = createSearchService({ workspace, config, logger });
  return [
    defineTool({
      name: 'search_files',
      description:
        'Search file names and/or text contents in the workspace. Skips secret files, binaries, generated directories and oversized files. Results are bounded; refine the path or query when truncated.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500, description: 'Literal text or regular expression.' },
          target: { type: 'string', enum: ['content', 'name', 'both'], description: 'What to search (default both).' },
          path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Directory to search (default workspace root).' },
          regex: { type: 'boolean', description: 'Interpret query as a regular expression.' },
          case_sensitive: { type: 'boolean' },
          max_results: { type: 'integer', minimum: 1, maximum: 500 },
          include_generated: { type: 'boolean', description: 'Include node_modules/.git/dist (default false).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args) => searchFiles({
        query: args.query,
        target: args.target ?? 'both',
        path: args.path ?? '.',
        regex: args.regex ?? false,
        caseSensitive: args.case_sensitive ?? false,
        maxResults: args.max_results,
        includeGenerated: args.include_generated ?? false,
      }),
    }),
  ];
}
