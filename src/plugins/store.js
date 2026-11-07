/**
 * Penyimpan plugin GitHub milik sebuah workspace.
 *
 * Lokasi: `<workspace>/.ryuu/plugins/<nama>/` — satu folder per plugin, plus
 * `manifest.json` yang mencatat asal repository, file yang diambil, dan status
 * aktif. Yang disimpan hanya file panduan (`.md`, `.markdown`, `.mdx`, `.txt`);
 * tidak ada kode dari repository yang disalin atau dijalankan.
 *
 * Instalasi sengaja tidak mengunduh zipball: beberapa repo panduan berukuran
 * ratusan MB. Satu permintaan API mengambil daftar file, lalu file panduan
 * diambil satu per satu dari raw.githubusercontent.com (tanpa batas laju API).
 *
 * Semua fungsi menerima `fetchImpl` agar bisa diuji tanpa jaringan.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RyuuError } from '../utils/errors.js';
import { stateDirFor } from '../services/preferences.js';
import { PLUGIN_NAME_PATTERN, parsePluginSource } from './catalog.js';

export const PLUGIN_MANIFEST_VERSION = 1;
/** Batas ukuran panduan yang disimpan per plugin. */
export const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
/** Batas jumlah file panduan per plugin. */
export const MAX_PLUGIN_FILES = 24;
/** Satu file panduan yang lebih besar dari ini dipotong. */
export const MAX_SINGLE_FILE_BYTES = 512 * 1024;
/** Batas total panduan yang disuntikkan ke prompt satu task. */
export const MAX_GUIDANCE_CHARS = 7000;
/** Batas panduan dari satu plugin di dalam prompt. */
export const MAX_PLUGIN_GUIDANCE_CHARS = 4000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const API_ROOT = 'https://api.github.com';
const RAW_ROOT = 'https://raw.githubusercontent.com';
const TEXT_FILE = /\.(md|markdown|mdx|txt)$/i;
const PREFERRED_NAMES = ['skill.md', 'agents.md', 'claude.md', 'readme.md'];
const SKIPPED_NAMES = /^(changelog|contributing|code_of_conduct|license|security|privacy|terms|pull_request_template|issue_template)\.(md|markdown|mdx|txt)$/i;
const SKIPPED_PREFIXES = ['.github/', '.git/', 'node_modules/', 'tests/', 'test/', 'examples/', 'fixtures/'];

/** Folder induk semua plugin untuk workspace ini. */
export function pluginsRoot(workspace) {
  return path.join(stateDirFor(workspace), 'plugins');
}

/** Folder satu plugin. */
export function pluginDir(workspace, name) {
  assertPluginName(name);
  return path.join(pluginsRoot(workspace), name);
}

/** File manifest. */
export function manifestFile(workspace) {
  return path.join(pluginsRoot(workspace), 'manifest.json');
}

function assertPluginName(name) {
  if (!PLUGIN_NAME_PATTERN.test(String(name ?? ''))) {
    throw new RyuuError(`Nama plugin tidak valid: ${name}`, { code: 'PLUGIN_NAME_INVALID' });
  }
}

function emptyManifest() {
  return { version: PLUGIN_MANIFEST_VERSION, plugins: {} };
}

function normalizeManifest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyManifest();
  const plugins = data.plugins && typeof data.plugins === 'object' && !Array.isArray(data.plugins) ? data.plugins : {};
  return { version: PLUGIN_MANIFEST_VERSION, plugins };
}

/**
 * Baca manifest. Manifest yang rusak diperlakukan sebagai kosong — sama seperti
 * preferences.json — supaya satu file rusak tidak mengunci seluruh command.
 */
export async function readManifest(workspace, { logger = null } = {}) {
  const file = manifestFile(workspace);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyManifest();
    throw new RyuuError(`Tidak bisa membaca manifest plugin ${file}: ${error.message}`, {
      code: 'PLUGIN_MANIFEST_UNREADABLE',
      cause: error,
    });
  }
  try {
    return normalizeManifest(JSON.parse(text));
  } catch (error) {
    logger?.warn?.('plugin manifest is not valid JSON', { file, error: error.message });
    return emptyManifest();
  }
}

async function writeManifest(workspace, manifest) {
  const file = manifestFile(workspace);
  const data = normalizeManifest(manifest);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
  return data;
}

/** Semua plugin terpasang, terurut menurut nama. */
export async function listPlugins(workspace, options = {}) {
  const manifest = await readManifest(workspace, options);
  return Object.values(manifest.plugins).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

/** Satu plugin terpasang, atau null. */
export async function getPlugin(workspace, name, options = {}) {
  const manifest = await readManifest(workspace, options);
  return manifest.plugins[String(name ?? '').trim().toLowerCase()] || null;
}

/** Pilih file panduan yang layak diambil dari daftar isi repository. */
export function selectGuidanceFiles(tree) {
  const blobs = (Array.isArray(tree) ? tree : []).filter((entry) => {
    if (!entry || entry.type !== 'blob') return false;
    const name = String(entry.path || '');
    if (!TEXT_FILE.test(name)) return false;
    if (SKIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
    if (SKIPPED_NAMES.test(name.split('/').pop() || '')) return false;
    return true;
  });
  const dirOf = (entryPath) => {
    const index = entryPath.lastIndexOf('/');
    return index === -1 ? '' : entryPath.slice(0, index);
  };
  // Folder yang berisi SKILL.md adalah inti paket: file di sekitarnya
  // (reference/, docs/) lebih berharga daripada dokumen generik di root.
  const skillDirs = new Set(
    blobs.filter((entry) => (entry.path.split('/').pop() || '').toLowerCase() === 'skill.md').map((entry) => dirOf(entry.path)),
  );
  const insideSkillDir = (entryPath) => {
    const dir = dirOf(entryPath);
    for (const root of skillDirs) {
      if (root === '' ? true : dir === root || dir.startsWith(`${root}/`)) return true;
    }
    return false;
  };
  const score = (entryPath) => {
    const parts = entryPath.split('/');
    const base = (parts[parts.length - 1] || '').toLowerCase();
    if (base === 'skill.md') return parts.length;
    if (insideSkillDir(entryPath)) return 1_000 + parts.length;
    const preferred = PREFERRED_NAMES.indexOf(base);
    if (preferred !== -1) return 2_000 + preferred * 100 + parts.length;
    return 4_000 + parts.length;
  };
  const seen = new Set();
  return blobs
    .slice()
    .sort((left, right) => score(left.path) - score(right.path) || left.path.localeCompare(right.path))
    .filter((entry) => {
      // Repository skill sering menyimpan salinan untuk tiap agen
      // (.agent/, .claude/, .cursor/, …) atau README di tiap paket. Untuk
      // dokumen utama, satu salinan terdekat root sudah cukup; slot sisanya
      // dipakai file referensi yang benar-benar berbeda.
      const base = (entry.path.split('/').pop() || entry.path).toLowerCase();
      if (!PREFERRED_NAMES.includes(base)) return true;
      // Salinan untuk agen berbeda (`.agent/`, `.claude/`, `.cursor/`, …)
      // menunjuk paket yang sama; paket berbeda (skills/a, skills/b) tetap
      // diambil semuanya.
      // `…/skills/<nama>/SKILL.md` menunjuk skill yang sama walau dibungkus
      // folder distribusi berbeda; dedupe memakai nama skill-nya.
      const dir = dirOf(entry.path);
      const skill = /(?:^|\/)skills\/([^/]+)$/.exec(dir);
      const key = `${base}\u0000${skill ? `skills/${skill[1]}` : dir.replace(/^\.[^/]+\//, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PLUGIN_FILES);
}

function fetchImplFor(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return (...args) => globalThis.fetch(...args);
  throw new RyuuError('Runtime ini tidak menyediakan fetch; plugin GitHub tidak bisa diunduh.', {
    code: 'PLUGIN_FETCH_UNAVAILABLE',
  });
}

async function fetchTree({ repo, fetch, token = null }) {
  const res = await fetch(`${API_ROOT}/repos/${repo}/git/trees/HEAD?recursive=1`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ryuu-cli',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (res.status === 403 || res.status === 429) {
    throw new RyuuError(
      `GitHub membatasi permintaan (HTTP ${res.status}). Coba lagi nanti atau set GITHUB_TOKEN untuk kuota lebih besar.`,
      { code: 'PLUGIN_RATE_LIMITED' },
    );
  }
  if (!res.ok) {
    throw new RyuuError(`GitHub menolak ${repo} (HTTP ${res.status}). Pastikan repository-nya publik.`, {
      code: 'PLUGIN_DOWNLOAD_FAILED',
    });
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.tree)) {
    throw new RyuuError(`Daftar isi ${repo} tidak bisa dibaca.`, { code: 'PLUGIN_DOWNLOAD_FAILED' });
  }
  return data.tree;
}

async function fetchGuidanceFile({ repo, filePath, fetch }) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${RAW_ROOT}/${repo}/HEAD/${encoded}`, {
    headers: { 'user-agent': 'ryuu-cli' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return text.length > MAX_SINGLE_FILE_BYTES ? text.slice(0, MAX_SINGLE_FILE_BYTES) : text;
}

function safeTarget(root, relative) {
  const target = path.resolve(root, relative);
  const check = path.relative(root, target);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) {
    throw new RyuuError(`Path panduan keluar dari folder plugin: ${relative}`, { code: 'PLUGIN_PATH_INVALID' });
  }
  return target;
}

/**
 * Pasang plugin dari GitHub. Plugin baru selalu mulai dalam keadaan nonaktif,
 * supaya panduannya tidak masuk ke prompt sebelum pengguna mengaktifkannya.
 */
export async function installPlugin({ workspace, source, fetchImpl = null, token = process.env.GITHUB_TOKEN || null, now = () => new Date() } = {}) {
  const target = parsePluginSource(source);
  const manifest = await readManifest(workspace);
  if (manifest.plugins[target.name]) {
    throw new RyuuError(`Plugin ${target.name} sudah terpasang. Lepas dulu dengan /plugin uninstall ${target.name}.`, {
      code: 'PLUGIN_EXISTS',
    });
  }

  const fetch = fetchImplFor(fetchImpl);
  const tree = await fetchTree({ repo: target.repo, fetch, token });
  const candidates = selectGuidanceFiles(tree);
  if (candidates.length === 0) {
    throw new RyuuError(`${target.repo} tidak berisi file panduan Markdown/teks.`, { code: 'PLUGIN_EMPTY' });
  }

  const files = [];
  const seenHashes = new Set();
  let bytes = 0;
  for (const entry of candidates) {
    if (bytes >= MAX_PLUGIN_BYTES) break;
    const content = await fetchGuidanceFile({ repo: target.repo, filePath: entry.path, fetch });
    if (!content) continue;
    // Paket yang sama sering disalin ke beberapa folder distribusi; isi yang
    // identik tidak perlu disimpan dua kali.
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    const remaining = MAX_PLUGIN_BYTES - bytes;
    const clipped = content.length > remaining ? content.slice(0, remaining) : content;
    files.push({ path: entry.path, content: clipped });
    bytes += clipped.length;
  }
  if (files.length === 0) {
    throw new RyuuError(`Tidak ada file panduan yang berhasil diunduh dari ${target.repo}.`, {
      code: 'PLUGIN_DOWNLOAD_FAILED',
    });
  }

  const dir = pluginDir(workspace, target.name);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const abs = safeTarget(dir, file.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
    await fsp.writeFile(abs, file.content, { mode: 0o600 });
  }

  const entry = {
    name: target.name,
    repo: target.repo,
    url: target.url,
    description: target.description || null,
    installed_at: now().toISOString(),
    enabled: false,
    files: files.map((file) => file.path),
    bytes,
  };
  manifest.plugins[entry.name] = entry;
  await writeManifest(workspace, manifest);
  return { ...entry, dir };
}

/** Lepas plugin dan hapus foldernya. */
export async function uninstallPlugin({ workspace, name } = {}) {
  const key = String(name ?? '').trim().toLowerCase();
  assertPluginName(key);
  const manifest = await readManifest(workspace);
  const entry = manifest.plugins[key];
  if (!entry) {
    throw new RyuuError(`Plugin ${key} belum terpasang. Lihat /plugin list.`, { code: 'PLUGIN_NOT_INSTALLED' });
  }
  await fsp.rm(pluginDir(workspace, key), { recursive: true, force: true });
  delete manifest.plugins[key];
  await writeManifest(workspace, manifest);
  return entry;
}

/** Aktifkan atau nonaktifkan plugin yang sudah terpasang. */
export async function setPluginEnabled({ workspace, name, enabled } = {}) {
  const key = String(name ?? '').trim().toLowerCase();
  assertPluginName(key);
  const manifest = await readManifest(workspace);
  const entry = manifest.plugins[key];
  if (!entry) {
    throw new RyuuError(`Plugin ${key} belum terpasang. Pasang dulu: /plugin install ${key}.`, {
      code: 'PLUGIN_NOT_INSTALLED',
    });
  }
  entry.enabled = Boolean(enabled);
  manifest.plugins[key] = entry;
  await writeManifest(workspace, manifest);
  return entry;
}

async function readPluginBody(workspace, entry, limit) {
  const dir = pluginDir(workspace, entry.name);
  const parts = [];
  let used = 0;
  for (const relative of entry.files || []) {
    if (used >= limit) break;
    let text;
    try {
      const abs = safeTarget(dir, relative);
      text = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const remaining = limit - used;
    const chunk = text.length > remaining ? `${text.slice(0, remaining)}\n[…]` : text;
    parts.push(chunk.trim());
    used += chunk.length;
  }
  return parts.join('\n\n').trim();
}

/**
 * Panduan dari semua plugin yang aktif, siap disisipkan ke task brief.
 *
 * Teks ini berasal dari repository pihak ketiga: ia dipakai sebagai referensi
 * gaya, bukan sebagai instruksi baru bagi agent.
 */
export async function readGuidance({ workspace, maxChars = MAX_GUIDANCE_CHARS, logger = null } = {}) {
  const entries = (await listPlugins(workspace, { logger })).filter((entry) => entry.enabled);
  if (entries.length === 0) return '';
  const sections = [];
  let used = 0;
  for (const entry of entries) {
    if (used >= maxChars) break;
    const limit = Math.min(MAX_PLUGIN_GUIDANCE_CHARS, maxChars - used);
    const body = await readPluginBody(workspace, entry, limit);
    if (!body) continue;
    const section = `### ${entry.name} — github.com/${entry.repo}\n${body}`;
    sections.push(section);
    used += section.length;
  }
  const text = sections.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[…]` : text;
}
