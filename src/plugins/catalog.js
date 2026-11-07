/**
 * Katalog plugin GitHub bawaan dan parser sumbernya.
 *
 * Sebuah "plugin" di sini hanyalah kumpulan file panduan (Markdown/teks) dari
 * sebuah repository GitHub. Tidak ada kode yang dijalankan: isinya dibaca
 * sebagai referensi gaya saat plugin diaktifkan, bukan sebagai program.
 *
 * Nama plugin selalu diturunkan dari nama repository dan dibatasi pola yang
 * aman dipakai sebagai nama folder sekaligus nama command (`/<name>`).
 */

import { RyuuError } from '../utils/errors.js';

/** Plugin yang sudah dikenal, bisa dipasang lewat namanya saja. */
export const DEFAULT_PLUGINS = Object.freeze([
  Object.freeze({
    name: 'anti-slop',
    repo: 'miqdadbadjuber/anti-slop',
    description: 'Aturan menyaring UI, teks, dan kode generik hasil AI.',
  }),
  Object.freeze({
    name: 'impeccable',
    repo: 'pbakaus/impeccable',
    description: 'Kosakata desain: polish, critique, audit, penangkal AI slop.',
  }),
  Object.freeze({
    name: 'taste-skill',
    repo: 'Leonxlnx/taste-skill',
    description: 'Skill rasa desain: art direction, bukan halaman generik.',
  }),
  Object.freeze({
    name: 'stop-slop',
    repo: 'hardikpandya/stop-slop',
    description: 'Satu file skill untuk menghapus penanda tulisan AI.',
  }),
  Object.freeze({
    name: 'humanizer',
    repo: 'blader/humanizer',
    description: 'Menghilangkan tanda-tanda tulisan buatan AI.',
  }),
  Object.freeze({
    name: 'no-ai-slop',
    repo: 'petergyang/no-ai-slop',
    description: 'Menghapus 20+ pola AI slop dari tulisan apa pun.',
  }),
  Object.freeze({
    name: 'avoid-ai-writing',
    repo: 'conorbronsdon/avoid-ai-writing',
    description: 'Mengaudit dan menulis ulang konten agar bebas pola tulisan AI.',
  }),
]);

/** Nama plugin dipakai sebagai nama folder dan nama command. */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Entri katalog untuk sebuah nama, atau null. */
export function catalogEntry(name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return DEFAULT_PLUGINS.find((entry) => entry.name === wanted) || null;
}

/** Turunkan nama plugin yang aman dari `owner/repo`. */
export function pluginNameFromRepo(repo) {
  const repoName = String(repo ?? '').split('/')[1] || '';
  const slug = repoName
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40);
  if (!PLUGIN_NAME_PATTERN.test(slug)) {
    throw new RyuuError(`Nama repository "${repoName}" tidak bisa dipakai sebagai nama plugin.`, {
      code: 'PLUGIN_NAME_INVALID',
    });
  }
  return slug;
}

/**
 * Terima nama katalog (`anti-slop`), shorthand `owner/repo`, atau URL GitHub.
 * Mengembalikan `{ name, repo, url, description? }`.
 */
export function parsePluginSource(input) {
  const text = String(input ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!text) {
    throw new RyuuError('Sebutkan nama plugin atau link GitHub-nya.', { code: 'PLUGIN_SOURCE_MISSING' });
  }

  const known = catalogEntry(text);
  if (known) return { ...known, url: `https://github.com/${known.repo}` };

  let repo = null;
  if (/^https?:\/\//i.test(text)) {
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new RyuuError(`Link tidak valid: ${text}`, { code: 'PLUGIN_SOURCE_INVALID' });
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') {
      throw new RyuuError(`Hanya plugin dari GitHub yang didukung, bukan ${parsed.hostname}.`, {
        code: 'PLUGIN_SOURCE_INVALID',
      });
    }
    const segments = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (segments.length < 2) {
      throw new RyuuError(`Link GitHub harus menunjuk satu repository: https://github.com/<owner>/<repo>`, {
        code: 'PLUGIN_SOURCE_INVALID',
      });
    }
    repo = `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`;
  } else {
    const shorthand = text.replace(/\.git$/i, '');
    const parts = shorthand.split('/');
    if (parts.length === 2 && OWNER_PATTERN.test(parts[0]) && OWNER_PATTERN.test(parts[1])) repo = shorthand;
  }

  if (!repo) {
    throw new RyuuError(
      `Tidak mengenali "${text}". Pakai nama bawaan (${DEFAULT_PLUGINS.map((entry) => entry.name).join(', ')}) atau link https://github.com/<owner>/<repo>.`,
      { code: 'PLUGIN_SOURCE_INVALID' },
    );
  }

  const [owner, name] = repo.split('/');
  if (!OWNER_PATTERN.test(owner) || !OWNER_PATTERN.test(name) || name === '.' || name === '..') {
    throw new RyuuError(`Repository tidak valid: ${repo}`, { code: 'PLUGIN_SOURCE_INVALID' });
  }
  return { name: pluginNameFromRepo(repo), repo, url: `https://github.com/${repo}` };
}
