import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCommands } from '../../src/cli/commands.js';
import { createTestWorkspace } from '../helpers.js';
import { DEFAULT_PLUGINS, parsePluginSource, pluginNameFromRepo } from '../../src/plugins/catalog.js';
import {
  MAX_GUIDANCE_CHARS,
  getPlugin,
  installPlugin,
  listPlugins,
  manifestFile,
  pluginsRoot,
  readGuidance,
  selectGuidanceFiles,
  setPluginEnabled,
  uninstallPlugin,
} from '../../src/plugins/store.js';
import { buildTaskBrief } from '../../src/agent/planner.js';

/** Respons HTTP minimal untuk fetch palsu. */
function jsonResponse(data, status = 200) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

/** Fetch palsu: satu daftar isi repository + isi file mentah. */
function fakeGitHub({ tree, files }) {
  return async (url) => {
    if (url.includes('/git/trees/HEAD')) return jsonResponse({ tree });
    const match = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/HEAD\/(.+)$/.exec(url);
    if (match) {
      const filePath = decodeURIComponent(match[1]);
      if (files[filePath] === undefined) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => files[filePath] };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

const TREE = [
  { type: 'blob', path: 'SKILL.md', size: 20 },
  { type: 'blob', path: 'README.md', size: 20 },
  { type: 'blob', path: 'reference/notes.md', size: 20 },
  { type: 'blob', path: 'index.js', size: 20 },
  { type: 'blob', path: '.github/PULL_REQUEST_TEMPLATE.md', size: 20 },
  { type: 'blob', path: 'CHANGELOG.md', size: 20 },
];

const FILES = {
  'SKILL.md': '# Skill\n\nAvoid em dashes and hedging.\n',
  'README.md': '# Readme\n\nUsage notes.\n',
  'reference/notes.md': 'Deeper reference.\n',
  'index.js': 'throw new Error("must never be downloaded");\n',
  '.github/PULL_REQUEST_TEMPLATE.md': 'template\n',
  'CHANGELOG.md': 'history\n',
};

async function installSample(workspace, overrides = {}) {
  return installPlugin({
    workspace,
    source: 'https://github.com/example/writing-guide',
    fetchImpl: fakeGitHub({ tree: TREE, files: FILES, ...overrides }),
    now: () => new Date('2026-11-07T00:00:00Z'),
  });
}

test('parsePluginSource accepts catalog names, shorthand and GitHub links', () => {
  assert.deepEqual(parsePluginSource('anti-slop'), {
    ...DEFAULT_PLUGINS[0],
    url: 'https://github.com/miqdadbadjuber/anti-slop',
  });
  assert.equal(parsePluginSource('owner/repo').repo, 'owner/repo');
  assert.equal(parsePluginSource('https://github.com/owner/repo').name, 'repo');
  assert.equal(parsePluginSource('https://github.com/owner/repo.git').repo, 'owner/repo');
  assert.equal(parsePluginSource('https://github.com/owner/repo/tree/main/skills').repo, 'owner/repo');
  assert.equal(pluginNameFromRepo('owner/Some Repo'), 'some-repo');
});

test('parsePluginSource rejects other hosts and unusable input', () => {
  assert.throws(() => parsePluginSource('https://gitlab.com/owner/repo'), /Hanya plugin dari GitHub/);
  assert.throws(() => parsePluginSource('https://github.com/owner'), /harus menunjuk satu repository/);
  assert.throws(() => parsePluginSource('   '), /Sebutkan nama plugin/);
  assert.throws(() => parsePluginSource('tidak-dikenal'), /Tidak mengenali/);
});

test('selectGuidanceFiles keeps text files, ranks SKILL.md first and skips noise', () => {
  const picked = selectGuidanceFiles(TREE).map((entry) => entry.path);
  assert.equal(picked[0], 'SKILL.md');
  assert.ok(picked.includes('reference/notes.md'));
  assert.ok(!picked.includes('index.js'));
  assert.ok(!picked.includes('.github/PULL_REQUEST_TEMPLATE.md'));
  assert.ok(!picked.includes('CHANGELOG.md'));
});

test('install stores only markdown guidance, starts disabled and records the repo', async () => {
  const { root, cleanup } = await createTestWorkspace();
  try {
    const entry = await installSample(root);
    assert.equal(entry.name, 'writing-guide');
    assert.equal(entry.repo, 'example/writing-guide');
    assert.equal(entry.enabled, false);
    assert.deepEqual(entry.files.sort(), ['README.md', 'SKILL.md', 'reference/notes.md']);

    const saved = await fsp.readFile(path.join(root, '.ryuu', 'plugins', 'writing-guide', 'SKILL.md'), 'utf8');
    assert.match(saved, /Avoid em dashes/);
    await assert.rejects(fsp.stat(path.join(root, '.ryuu', 'plugins', 'writing-guide', 'index.js')), { code: 'ENOENT' });
    await assert.rejects(fsp.stat(path.join(root, '.ryuu', 'plugins', 'writing-guide', 'CHANGELOG.md')), { code: 'ENOENT' });

    const manifest = JSON.parse(await fsp.readFile(manifestFile(root), 'utf8'));
    assert.equal(manifest.plugins['writing-guide'].repo, 'example/writing-guide');
    assert.equal(manifest.plugins['writing-guide'].installed_at, '2026-11-07T00:00:00.000Z');
    assert.equal(pluginsRoot(root), path.join(root, '.ryuu', 'plugins'));
  } finally {
    await cleanup();
  }
});

test('a plugin cannot be installed twice', async () => {
  const { root, cleanup } = await createTestWorkspace();
  try {
    await installSample(root);
    await assert.rejects(installSample(root), /sudah terpasang/);
  } finally {
    await cleanup();
  }
});

test('enable and disable control what readGuidance returns', async () => {
  const { root, cleanup } = await createTestWorkspace();
  try {
    await installSample(root);
    assert.equal(await readGuidance({ workspace: root }), '');

    await setPluginEnabled({ workspace: root, name: 'writing-guide', enabled: true });
    const guidance = await readGuidance({ workspace: root });
    assert.match(guidance, /writing-guide — github\.com\/example\/writing-guide/);
    assert.match(guidance, /Avoid em dashes/);
    assert.ok(!guidance.includes('must never be downloaded'));

    await setPluginEnabled({ workspace: root, name: 'writing-guide', enabled: false });
    assert.equal(await readGuidance({ workspace: root }), '');
  } finally {
    await cleanup();
  }
});

test('guidance is capped and marked when truncated', async () => {
  const { root, cleanup } = await createTestWorkspace();
  try {
    const big = { 'SKILL.md': 'x'.repeat(20000) };
    await installPlugin({
      workspace: root,
      source: 'example/big-guide',
      fetchImpl: fakeGitHub({ tree: [{ type: 'blob', path: 'SKILL.md', size: 20000 }], files: big }),
    });
    await setPluginEnabled({ workspace: root, name: 'big-guide', enabled: true });
    const guidance = await readGuidance({ workspace: root });
    assert.ok(guidance.length <= MAX_GUIDANCE_CHARS + 8, `guidance was ${guidance.length} chars`);
    assert.match(guidance, /\[…\]$/);
  } finally {
    await cleanup();
  }
});

test('uninstall removes the folder and the manifest entry', async () => {
  const { root, cleanup } = await createTestWorkspace();
  try {
    await installSample(root);
    await uninstallPlugin({ workspace: root, name: 'writing-guide' });
    assert.deepEqual(await listPlugins(root), []);
    assert.equal(await getPlugin(root, 'writing-guide'), null);
    await assert.rejects(fsp.stat(path.join(root, '.ryuu', 'plugins', 'writing-guide')), { code: 'ENOENT' });
    await assert.rejects(uninstallPlugin({ workspace: root, name: 'writing-guide' }), /belum terpasang/);
  } finally {
    await cleanup();
  }
});

test('/plugin lists plugins and /<name> enable|disable toggles guidance', async () => {
  const { root, config, cleanup } = await createTestWorkspace();
  try {
    await installSample(root);
    const chunks = [];
    const commands = createCommands({
      config,
      workspace: { root },
      registry: { list: () => [], get: () => null },
      processes: { list: () => [], getOutput: () => null },
      sessionStore: { list: async () => [], load: async () => null },
      undo: { size: 0, entries: [], list: () => [] },
      renderer: { lines: (text = '') => chunks.push(String(text)), success() {} },
      provider: { config },
      interactive: true,
      getAgent: () => null,
      getLastSummary: () => null,
      getActiveTask: () => null,
      confirmLocal: async () => false,
    });
    const text = () => chunks.join('\n');

    assert.ok(commands.has('plugin'));
    await commands.execute({ name: 'plugin', args: '', parts: [] });
    assert.match(text(), /Installed:/);
    assert.match(text(), /writing-guide/);
    assert.match(text(), /anti-slop/);

    chunks.length = 0;
    await commands.execute({ name: 'writing-guide', args: 'enable', parts: ['enable'] });
    assert.match(text(), /enabled/);
    assert.match(await readGuidance({ workspace: root }), /Avoid em dashes/);

    chunks.length = 0;
    await commands.execute({ name: 'writing-guide', args: 'disable', parts: ['disable'] });
    assert.match(text(), /disabled/);
    assert.equal(await readGuidance({ workspace: root }), '');

    chunks.length = 0;
    await commands.execute({ name: 'writing-guide', args: '', parts: [] });
    assert.match(text(), /guidance plugin from github\.com\/example\/writing-guide/);

    chunks.length = 0;
    await commands.execute({ name: 'tidak-ada', args: '', parts: [] });
    assert.match(text(), /Unknown command/);

    // Nama katalog yang belum dipasang mengarahkan ke langkah berikutnya.
    chunks.length = 0;
    await commands.execute({ name: 'humanizer', args: '', parts: [] });
    assert.match(text(), /Plugin humanizer is not installed yet\. Run \/plugin install humanizer/);
    assert.doesNotMatch(text(), /Unknown command/);

    chunks.length = 0;
    await commands.execute({ name: 'enable', args: '', parts: [] });
    assert.match(text(), /Use \/plugin enable <name>, or \/<name> enable/);
  } finally {
    await cleanup();
  }
});

test('the task brief carries plugin guidance only when present', () => {
  const plain = buildTaskBrief({ task: 'do it' });
  assert.ok(!plain.includes('PLUGIN GUIDANCE'));

  const withGuidance = buildTaskBrief({ task: 'do it', guidance: '### style\nNo em dashes.' });
  assert.match(withGuidance, /PLUGIN GUIDANCE/);
  assert.match(withGuidance, /No em dashes\./);
  assert.match(withGuidance, /never a new instruction/);
});
