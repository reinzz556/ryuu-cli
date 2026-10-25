import { defineTool } from './registry.js';
import { createUnifiedDiff, diffStats } from '../services/diff.js';
import { ToolError } from '../utils/errors.js';

const pathSchema = { type: 'string', minLength: 1, maxLength: 4096, description: 'Path relative to the workspace root.' };

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const MAX_WRITE_CHARS = 1_000_000;

function assertContentSize(content) {
  if (content.length > MAX_WRITE_CHARS) {
    throw new ToolError(`Content is too large (${content.length} chars, max ${MAX_WRITE_CHARS}). Split the change into smaller files.`);
  }
}

function previewDiff(relPath, before, after) {
  const diff = createUnifiedDiff(before, after, { oldLabel: `a/${relPath}`, newLabel: `b/${relPath}` });
  if (!diff) return `(no changes) ${relPath} is already up to date`;
  const stats = diffStats(before, after);
  return `${diff}\n\n(${stats.added} added, ${stats.removed} removed)`;
}

/**
 * @param {object} deps
 * @param {import('../services/workspace.js').Workspace} deps.workspace
 * @param {object} deps.config
 */
export function createFilesystemTools({ workspace, config }) {
  async function computeEdit({ path: target, old_text: original, new_text: replacement, replace_all = false }) {
    const file = await workspace.readText(target, { maxBytes: config.maxFileBytes });
    if (original === replacement) throw new ToolError('old_text and new_text are identical; nothing to change.');
    let occurrences = 0;
    let index = file.text.indexOf(original);
    while (index !== -1) {
      occurrences += 1;
      index = file.text.indexOf(original, index + original.length);
    }
    if (occurrences === 0) {
      throw new ToolError(
        `old_text was not found in ${file.relPath}. Re-read the file and copy the exact text (including indentation).`,
      );
    }
    if (occurrences > 1 && !replace_all) {
      throw new ToolError(
        `old_text matches ${occurrences} locations in ${file.relPath}. Include more surrounding context or set replace_all=true.`,
      );
    }
    const after = replace_all
      ? file.text.split(original).join(replacement)
      : file.text.slice(0, file.text.indexOf(original)) +
        replacement +
        file.text.slice(file.text.indexOf(original) + original.length);
    return { file, after, occurrences };
  }

  return [
    defineTool({
      name: 'list_files',
      description: 'List files and directories inside the workspace. Supports substring/wildcard filtering and pagination. Secret files and generated directories are excluded by default.',
      risk: 'read',
      schema: objectSchema({
        path: { ...pathSchema, description: 'Directory to list (default workspace root).' },
        filter: { type: 'string', maxLength: 200, description: 'Optional case-insensitive name filter; * and ? wildcards allowed.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum entries to return (default 200).' },
        offset: { type: 'integer', minimum: 0, maximum: 100000, description: 'Pagination offset.' },
        include_generated: { type: 'boolean', description: 'Include node_modules, .git, dist, etc. (usually not needed).' },
      }),
      handler: async (args) => workspace.list(args.path || '.', {
        limit: Math.min(args.limit ?? 200, 500),
        offset: args.offset ?? 0,
        filter: args.filter,
        includeGenerated: args.include_generated ?? false,
        includeHidden: args.include_generated ?? false,
      }),
    }),

    defineTool({
      name: 'tree',
      description: 'Show a bounded directory tree of the workspace.',
      risk: 'read',
      schema: objectSchema({
        path: { ...pathSchema, description: 'Directory to print (default workspace root).' },
        depth: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum depth (default 3).' },
        max_entries: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum entries (default 200).' },
        include_generated: { type: 'boolean' },
      }),
      handler: async (args) => workspace.tree(args.path || '.', {
        depth: args.depth ?? 3,
        maxEntries: Math.min(args.max_entries ?? 200, 2000),
        includeGenerated: args.include_generated ?? false,
      }),
    }),

    defineTool({
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the workspace. Refuses secret files, binary files, and invalid encodings. A full read refuses files above the configured size limit; with start_line/end_line the requested range is streamed, so it also works for files above that limit.',
      risk: 'read',
      schema: objectSchema({
        path: pathSchema,
        start_line: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to return (inclusive).' },
        max_bytes: { type: 'integer', minimum: 1, maximum: 5 * 1024 * 1024, description: 'Per-call read/output limit.' },
      }, ['path']),
      handler: async (args) => {
        const maxBytes = Math.min(args.max_bytes ?? config.maxFileBytes, config.maxFileBytes);
        const startLine = args.start_line ?? 1;
        const endLine = args.end_line ?? null;
        if (endLine !== null && endLine < startLine) {
          throw new ToolError('end_line must be greater than or equal to start_line.');
        }

        // A requested range is streamed: only those lines are decoded and kept,
        // so the size limit no longer blocks reading part of a large file.
        if (args.start_line !== undefined || args.end_line !== undefined) {
          const range = await workspace.readTextRange(args.path, { startLine, endLine, maxBytes });
          return {
            path: range.relPath,
            start_line: range.startLine,
            end_line: range.endLine,
            total_lines: range.totalLines,
            size: range.size,
            eol: range.eol === '\r\n' ? 'CRLF' : 'LF',
            truncated: range.truncated,
            ...(range.capped
              ? { note: `The requested range exceeds the ${maxBytes}-byte read limit; read a narrower range for the rest.` }
              : {}),
            text: range.text,
          };
        }

        const file = await workspace.readText(args.path, { maxBytes });
        const lines = file.text.split(/\r?\n/);
        if (startLine > lines.length && lines.length > 0) {
          throw new ToolError(`start_line ${startLine} is beyond the end of ${file.relPath} (${lines.length} lines).`);
        }
        const end = Math.min(endLine ?? lines.length, lines.length);
        const slice = lines.slice(startLine - 1, end);
        return {
          path: file.relPath,
          start_line: startLine,
          end_line: end,
          total_lines: lines.length,
          size: file.size,
          eol: file.eol === '\r\n' ? 'CRLF' : 'LF',
          truncated: end < lines.length,
          text: slice.join('\n'),
        };
      },
    }),

    defineTool({
      name: 'file_info',
      description: 'Report metadata for a workspace path: kind, size, timestamps, line count, text/binary hint.',
      risk: 'read',
      schema: objectSchema({ path: pathSchema }, ['path']),
      handler: async (args) => workspace.info(args.path),
    }),

    defineTool({
      name: 'create_file',
      description: 'Create a new text file in the workspace. Fails if the file already exists unless overwrite=true.',
      risk: 'write',
      schema: objectSchema({
        path: pathSchema,
        content: { type: 'string', maxLength: MAX_WRITE_CHARS },
        overwrite: { type: 'boolean', description: 'Replace an existing file (default false).' },
      }, ['path', 'content']),
      preview: async (args) => {
        let before = '';
        try {
          const existing = await workspace.readText(args.path, { maxBytes: config.maxFileBytes });
          if (!args.overwrite) return `File already exists: ${args.path}. create_file would fail; use edit_file or write_file.`;
          before = existing.text;
        } catch {
          before = '';
        }
        return previewDiff(args.path, before, args.content);
      },
      handler: async (args) => {
        assertContentSize(args.content);
        return workspace.createText(args.path, args.content, { overwrite: args.overwrite ?? false });
      },
    }),

    defineTool({
      name: 'write_file',
      description: 'Write a complete text file, replacing existing content. Provide expected_mtime_ms from a previous read/info call to prevent silently overwriting concurrent edits.',
      risk: 'write',
      schema: objectSchema({
        path: pathSchema,
        content: { type: 'string', maxLength: MAX_WRITE_CHARS },
        expected_mtime_ms: { type: 'number', description: 'If set, abort when the file mtime differs.' },
      }, ['path', 'content']),
      preview: async (args) => {
        let before = '';
        try {
          before = (await workspace.readText(args.path, { maxBytes: config.maxFileBytes })).text;
        } catch {
          before = '';
        }
        return previewDiff(args.path, before, args.content);
      },
      handler: async (args) => {
        assertContentSize(args.content);
        return workspace.writeText(args.path, args.content, { expectedMtimeMs: args.expected_mtime_ms });
      },
    }),

    defineTool({
      name: 'edit_file',
      description: 'Apply a targeted text replacement. old_text must match exactly (including indentation); it must be unique unless replace_all=true. Returns the resulting diff and new mtime. Refuses to overwrite concurrent edits.',
      risk: 'write',
      schema: objectSchema({
        path: pathSchema,
        old_text: { type: 'string', minLength: 1, maxLength: 100000 },
        new_text: { type: 'string', maxLength: 100000 },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        expected_mtime_ms: { type: 'number', description: 'Abort if the file changed since this mtime.' },
      }, ['path', 'old_text', 'new_text']),
      preview: async (args) => {
        const { file, after } = await computeEdit(args);
        return previewDiff(file.relPath, file.text, after);
      },
      handler: async (args) => {
        assertContentSize(args.new_text);
        const { file, after, occurrences } = await computeEdit(args);
        const written = await workspace.writeText(args.path, after, {
          expectedMtimeMs: args.expected_mtime_ms ?? file.mtimeMs,
        });
        return {
          path: written.relPath,
          occurrences,
          bytes_written: written.size,
          lines: written.lines,
          mtime_ms: written.mtimeMs,
          diff: createUnifiedDiff(file.text, after, { oldLabel: `a/${written.relPath}`, newLabel: `b/${written.relPath}`, maxLines: 200 }),
        };
      },
    }),

    defineTool({
      name: 'diff_file',
      description: 'Show a unified diff without writing anything. Compares the current file against proposed new content, or against provided old/new text.',
      risk: 'read',
      schema: objectSchema({
        path: pathSchema,
        new_text: { type: 'string', maxLength: MAX_WRITE_CHARS, description: 'Proposed full file content.' },
        old_text: { type: 'string', maxLength: MAX_WRITE_CHARS, description: 'Optional explicit old content; defaults to the file on disk.' },
      }, ['path']),
      handler: async (args) => {
        let before = args.old_text;
        if (before === undefined) {
          before = (await workspace.readText(args.path, { maxBytes: config.maxFileBytes })).text;
        }
        if (args.new_text === undefined) throw new ToolError('new_text is required.');
        const diff = createUnifiedDiff(before, args.new_text, { oldLabel: `a/${args.path}`, newLabel: `b/${args.path}` });
        return { path: args.path, diff: diff || '(no changes)', stats: diffStats(before, args.new_text) };
      },
    }),

    defineTool({
      name: 'move_file',
      description: 'Move or rename a file inside the workspace. Requires approval.',
      risk: 'destructive',
      schema: objectSchema({
        from: pathSchema,
        to: pathSchema,
        overwrite: { type: 'boolean' },
      }, ['from', 'to']),
      preview: async (args) => `Move ${args.from} -> ${args.to}${args.overwrite ? ' (may overwrite destination)' : ''}`,
      handler: async (args) => workspace.move(args.from, args.to, { overwrite: args.overwrite ?? false }),
    }),

    defineTool({
      name: 'delete_file',
      description: 'Delete a single file or an empty directory inside the workspace. Requires approval. Never follows symlinks.',
      risk: 'destructive',
      schema: objectSchema({
        path: pathSchema,
        confirm: { type: 'boolean', description: 'Must be true; a second explicit acknowledgement.' },
      }, ['path', 'confirm']),
      preview: async (args) => {
        if (args.confirm !== true) return `delete_file requires confirm=true for ${args.path}`;
        try {
          const info = await workspace.info(args.path);
          return `Delete ${info.kind} ${info.path} (${info.size} bytes)`;
        } catch {
          return `Delete ${args.path} (path not found)`;
        }
      },
      handler: async (args) => {
        if (args.confirm !== true) throw new ToolError('delete_file requires confirm=true.');
        return workspace.remove(args.path);
      },
    }),
  ];
}
