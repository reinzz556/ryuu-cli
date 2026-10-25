import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from './registry.js';
import { isIgnoredName, isSecretPath } from '../services/workspace.js';
import { ToolError } from '../utils/errors.js';

const LANGUAGE_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby',
  '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.sh': 'Shell',
  '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML', '.md': 'Markdown',
  '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML', '.sql': 'SQL',
};

const MAX_FILES = 3000;

export async function buildProjectSummary({ workspace }) {
  const summary = {
    workspace: workspace.root,
    name: null,
    version: null,
    description: null,
    packageManager: null,
    scripts: {},
    dependencies: [],
    devDependencies: [],
    engines: null,
    entryPoints: [],
    languages: {},
    modules: [],
    topLevel: [],
    totalFilesScanned: 0,
    hasReadme: false,
    hasTests: false,
    hasGit: false,
    truncated: false,
  };

  try {
    const listing = await workspace.list('.', { limit: 50, includeGenerated: false, includeHidden: true });
    summary.topLevel = listing.entries.map((entry) => `${entry.kind === 'dir' ? 'dir ' : 'file'} ${entry.name}`);
    summary.hasReadme = listing.entries.some((entry) => /^readme(\.(md|txt|rst))?$/i.test(entry.name));
    summary.hasTests = listing.entries.some((entry) => /^(tests?|__tests__|spec)$/i.test(entry.name));
    // Immediate sub-directories of every top-level directory: the module
    // layout the model needs to know (e.g. plugins/<category>/<command>).
    for (const entry of listing.entries) {
      if (entry.kind !== 'dir') continue;
      if (summary.modules.length >= 120) break;
      const children = await workspace.list(entry.name, { limit: 60, includeGenerated: false, includeHidden: false });
      for (const child of children.entries) {
        if (child.kind !== 'dir') continue;
        summary.modules.push(`${entry.name}/${child.name}`);
        if (summary.modules.length >= 120) break;
      }
    }
  } catch {
    // Listing failures are reported by the languages walk below.
  }

  summary.hasGit = await fileExists(path.join(workspace.root, '.git'));

  let pkg = null;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(workspace.root, 'package.json'), 'utf8'));
  } catch {
    pkg = null;
  }
  if (pkg) {
    summary.name = pkg.name || null;
    summary.version = pkg.version || null;
    summary.description = pkg.description || null;
    summary.scripts = pkg.scripts || {};
    summary.dependencies = Object.keys(pkg.dependencies || {}).sort();
    summary.devDependencies = Object.keys(pkg.devDependencies || {}).sort();
    summary.engines = pkg.engines || null;
    summary.packageManager = pkg.packageManager || null;
    summary.entryPoints = [pkg.main, pkg.module, pkg.bin && (typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0])]
      .filter(Boolean);
  }
  if (!summary.packageManager) {
    for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], ['bun.lockb', 'bun']]) {
      if (await fileExists(path.join(workspace.root, file))) {
        summary.packageManager = manager;
        break;
      }
    }
  }

  const stack = [workspace.root];
  let scanned = 0;
  while (stack.length > 0 && scanned < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isIgnoredName(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(workspace.root, path.join(dir, entry.name)).split(path.sep).join('/');
      if (isSecretPath(rel)) continue;
      scanned += 1;
      if (scanned >= MAX_FILES) {
        summary.truncated = true;
        break;
      }
      const language = LANGUAGE_BY_EXT[path.extname(entry.name).toLowerCase()];
      if (language) summary.languages[language] = (summary.languages[language] || 0) + 1;
    }
  }
  summary.totalFilesScanned = scanned;
  summary.languages = Object.fromEntries(
    Object.entries(summary.languages).sort((a, b) => b[1] - a[1]),
  );
  return summary;
}

async function fileExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export function createProjectTools({ workspace }) {
  return [
    defineTool({
      name: 'project_summary',
      description:
        'Summarize the project from real files: manifests, scripts, dependencies, entry points, language mix, top-level layout, tests and Git presence. Use this instead of guessing.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Subdirectory to summarize (default workspace root).' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        if (args.path && args.path !== '.') {
          const resolved = workspace.resolve(args.path);
          const stat = await fsp.stat(resolved.absPath).catch(() => null);
          if (!stat) throw new ToolError(`Path not found: ${args.path}`);
          if (!stat.isDirectory()) throw new ToolError('project_summary expects a directory.');
        }
        return buildProjectSummary({ workspace });
      },
    }),
  ];
}
