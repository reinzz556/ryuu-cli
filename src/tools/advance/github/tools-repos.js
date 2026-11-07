import { defineTool } from '../../../../src/tools/registry.js';
import { ValidationError } from '../../../../src/utils/errors.js';
import {
  assertDestructiveAllowed,
  contentPath,
  limitItems,
  pageQuery,
  pickBranch,
  pickCommit,
  pickRepo,
  refSegment,
  repoBase,
  text,
} from './tool-helpers.js';

const REPO_PROPS = {
  owner: { type: 'string', description: 'Pemilik repository (username atau organisasi GitHub).' },
  repo: { type: 'string', description: 'Nama repository tanpa owner.' },
};

export function createRepoTools(plugin) {
  return [
    defineTool({
      name: 'github_list_repositories',
      description:
        'Daftar repository yang dapat diakses akun terhubung (milik sendiri, collaborator, atau organisasi). Membutuhkan permission Metadata read; repository privat hanya muncul bila instalasi aplikasi mencakupnya.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          visibility: { type: 'string', enum: ['all', 'public', 'private'], description: 'Filter visibilitas. Default all.' },
          affiliation: {
            type: 'string',
            description: 'owner, collaborator, organization_member (boleh digabung dengan koma). Default semua.',
          },
          sort: { type: 'string', enum: ['updated', 'pushed', 'full_name', 'created'], description: 'Urutan hasil.' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Arah urutan.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const query = {
          ...pageQuery(args),
          ...(args.visibility ? { visibility: args.visibility } : {}),
          ...(args.affiliation ? { affiliation: args.affiliation } : {}),
          ...(args.sort ? { sort: args.sort } : {}),
          ...(args.direction ? { direction: args.direction } : {}),
        };
        const repos = await api.paginate('/user/repos', { query, perPage: query.per_page, maxPages: 2, maxItems: 100 });
        return { ok: true, count: repos.length, repositories: limitItems(repos, 100).map(pickRepo) };
      },
    }),

    defineTool({
      name: 'github_get_repository',
      description:
        'Ambil detail satu repository: default branch, visibilitas, bahasa, statistik, permission akun, dan status arsip.',
      risk: 'read',
      schema: { type: 'object', properties: REPO_PROPS, required: ['owner', 'repo'] },
      async handler(args) {
        const api = await plugin.requireClient();
        const repo = await api.get(repoBase(args));
        return { ok: true, repository: pickRepo(repo) };
      },
    }),

    defineTool({
      name: 'github_create_repository',
      description:
        'Buat repository baru untuk akun yang terhubung. Membutuhkan permission Administration write atau scope public_repo/repo. Operasi ini mengubah data dan selalu meminta approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama repository baru.' },
          description: { type: 'string', description: 'Deskripsi singkat.' },
          private: { type: 'boolean', description: 'Repository privat bila true.' },
          auto_init: { type: 'boolean', description: 'Inisialisasi dengan README sehingga branch default langsung ada.' },
          gitignore_template: { type: 'string', description: 'Template .gitignore, contoh: Node.' },
          license_template: { type: 'string', description: 'Template lisensi, contoh: mit.' },
          homepage: { type: 'string', description: 'URL homepage repository.' },
        },
        required: ['name'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const name = String(args.name || '').trim();
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error('Nama repository tidak valid.');
        const body = { name };
        for (const key of ['description', 'auto_init', 'gitignore_template', 'license_template', 'homepage']) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        if (args.private !== undefined) body.private = Boolean(args.private);
        const repo = await api.post('/user/repos', body);
        return { ok: true, repository: pickRepo(repo) };
      },
    }),

    defineTool({
      name: 'github_update_repository',
      description:
        'Ubah metadata repository (deskripsi, homepage, visibilitas, arsip, topik). Membutuhkan permission Administration write. Operasi ini selalu meminta approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          name: { type: 'string', description: 'Nama baru repository.' },
          description: { type: 'string', description: 'Deskripsi baru.' },
          homepage: { type: 'string', description: 'URL homepage baru.' },
          private: { type: 'boolean', description: 'Ubah visibilitas privat/publik.' },
          archived: { type: 'boolean', description: 'Arsipkan atau aktifkan kembali repository.' },
          has_issues: { type: 'boolean', description: 'Aktifkan/nonaktifkan Issues.' },
          has_wiki: { type: 'boolean', description: 'Aktifkan/nonaktifkan Wiki.' },
          default_branch: { type: 'string', description: 'Branch default baru (harus sudah ada).' },
        },
        required: ['owner', 'repo'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = {};
        for (const key of ['name', 'description', 'homepage', 'private', 'archived', 'has_issues', 'has_wiki', 'default_branch']) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        if (Object.keys(body).length === 0) throw new Error('Tidak ada perubahan yang diminta.');
        const repo = await api.patch(repoBase(args), body);
        return { ok: true, repository: pickRepo(repo) };
      },
    }),

    defineTool({
      name: 'github_delete_repository',
      description:
        'Hapus repository secara permanen. Membutuhkan permission Administration write dan hak admin pada repository. Argumen confirm wajib berisi "owner/repo" persis sama; tanpa itu tool menolak. Operasi ini destruktif: selalu meminta approval Ryuu dan diblokir saat confirmDestructive=false. Jangan pernah dipanggil tanpa persetujuan eksplisit pengguna.',
      risk: 'destructive',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          confirm: {
            type: 'string',
            description: 'Tulis ulang "owner/repo" dari repository yang dihapus sebagai konfirmasi eksplisit.',
          },
        },
        required: ['owner', 'repo', 'confirm'],
      },
      async handler(args) {
        await assertDestructiveAllowed(plugin, 'Penghapusan repository');
        const base = repoBase(args);
        const target = base.replace(/^\/repos\//, '');
        const typed = String(args.confirm ?? '').trim();
        if (typed.toLowerCase() !== target.toLowerCase()) {
          throw new ValidationError(
            `Konfirmasi tidak cocok. Untuk menghapus repository ini, argumen confirm harus berisi "${target}".`,
          );
        }
        const api = await plugin.requireClient();
        await api.delete(base);
        return {
          ok: true,
          deleted: target,
          note: 'Repository dihapus permanen. Tindakan ini tidak dapat dibatalkan.',
        };
      },
    }),

    defineTool({
      name: 'github_list_branches',
      description: 'Daftar branch pada repository beserta commit SHA terakhir dan status proteksi.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          protected: { type: 'boolean', description: 'Filter hanya branch terproteksi (true) atau tidak (false).' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const branches = await api.paginate(`${repoBase(args)}/branches`, {
          query: {
            ...pageQuery(args),
            ...(args.protected !== undefined ? { protected: String(args.protected) } : {}),
          },
          maxPages: 2,
          maxItems: 100,
        });
        return { ok: true, count: branches.length, branches: limitItems(branches, 100).map(pickBranch) };
      },
    }),

    defineTool({
      name: 'github_get_branch',
      description: 'Ambil satu branch berdasarkan nama, termasuk SHA commit terakhir dan status proteksinya.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { ...REPO_PROPS, branch: { type: 'string', description: 'Nama branch, contoh: main.' } },
        required: ['owner', 'repo', 'branch'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const branch = await api.get(`${repoBase(args)}/branches/${refSegment(args.branch, 'branch')}`);
        return { ok: true, branch: pickBranch(branch) };
      },
    }),

    defineTool({
      name: 'github_list_commits',
      description:
        'Daftar commit pada branch atau path tertentu. Dapat difilter berdasarkan author dan rentang tanggal ISO 8601.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          sha: { type: 'string', description: 'Branch atau SHA commit awal (default branch default repository).' },
          path: { type: 'string', description: 'Hanya commit yang menyentuh path ini.' },
          author: { type: 'string', description: 'Username GitHub atau email author.' },
          since: { type: 'string', description: 'Batas awal ISO 8601, contoh 2026-01-01T00:00:00Z.' },
          until: { type: 'string', description: 'Batas akhir ISO 8601.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const query = {
          ...pageQuery(args),
          ...(args.sha ? { sha: args.sha } : {}),
          ...(args.path ? { path: args.path } : {}),
          ...(args.author ? { author: args.author } : {}),
          ...(args.since ? { since: args.since } : {}),
          ...(args.until ? { until: args.until } : {}),
        };
        const commits = await api.paginate(`${repoBase(args)}/commits`, { query, maxPages: 2, maxItems: 100 });
        return { ok: true, count: commits.length, commits: limitItems(commits, 100).map(pickCommit) };
      },
    }),

    defineTool({
      name: 'github_get_commit',
      description: 'Ambil satu commit lengkap dengan pesan, author, parent, dan statistik perubahan file.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { ...REPO_PROPS, ref: { type: 'string', description: 'SHA commit, branch, atau tag.' } },
        required: ['owner', 'repo', 'ref'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const commit = await api.get(`${repoBase(args)}/commits/${refSegment(args.ref)}`);
        return {
          ok: true,
          commit: pickCommit(commit),
          files: limitItems(commit.files || [], 50).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })),
        };
      },
    }),

    defineTool({
      name: 'github_get_file_contents',
      description:
        'Baca isi file atau daftar isi folder pada repository. Untuk file teks, isi dikembalikan sudah didekode; file biner atau lebih dari 200 KB hanya mengembalikan metadata.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          path: { type: 'string', description: 'Path file/folder relatif, contoh: src/index.js.' },
          ref: { type: 'string', description: 'Branch, tag, atau SHA. Default branch default repository.' },
        },
        required: ['owner', 'repo', 'path'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const data = await api.get(`${repoBase(args)}/contents/${contentPath(args.path)}`, args.ref ? { ref: args.ref } : null);
        if (Array.isArray(data)) {
          return {
            ok: true,
            type: 'directory',
            count: data.length,
            entries: limitItems(data, 100).map((entry) => ({
              name: entry.name,
              path: entry.path,
              type: entry.type,
              size: entry.size ?? null,
              sha: entry.sha,
            })),
          };
        }
        const base = {
          ok: true,
          type: 'file',
          name: data.name,
          path: data.path,
          sha: data.sha,
          size: data.size,
          html_url: data.html_url || null,
          download_url: data.download_url || null,
        };
        if (data.encoding !== 'base64' || typeof data.content !== 'string') return base;
        if (Number(data.size) > 200_000) {
          return { ...base, truncated: true, note: 'File lebih dari 200 KB; isi tidak didekode.' };
        }
        const buffer = Buffer.from(data.content, 'base64');
        if (buffer.includes(0)) {
          return { ...base, binary: true, note: 'File tampak biner; isi tidak ditampilkan.' };
        }
        return { ...base, content: text(buffer.toString('utf8'), 100_000) };
      },
    }),

    defineTool({
      name: 'github_create_or_update_file',
      description:
        'Buat file baru atau perbarui file yang ada pada satu commit. Untuk memperbarui file, sertakan SHA file saat ini (dari github_get_file_contents). Membutuhkan permission Contents write. Selalu meminta approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          path: { type: 'string', description: 'Path file, contoh: docs/readme.md.' },
          message: { type: 'string', description: 'Pesan commit.' },
          content: { type: 'string', description: 'Isi file sebagai teks biasa (UTF-8).' },
          sha: { type: 'string', description: 'SHA file yang sedang diperbarui; kosongkan untuk file baru.' },
          branch: { type: 'string', description: 'Branch tujuan. Default branch default repository.' },
        },
        required: ['owner', 'repo', 'path', 'message', 'content'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = {
          message: String(args.message),
          content: Buffer.from(String(args.content), 'utf8').toString('base64'),
          ...(args.sha ? { sha: String(args.sha) } : {}),
          ...(args.branch ? { branch: String(args.branch) } : {}),
        };
        const result = await api.put(`${repoBase(args)}/contents/${contentPath(args.path)}`, body);
        return {
          ok: true,
          content: result?.content
            ? { path: result.content.path, sha: result.content.sha, html_url: result.content.html_url }
            : null,
          commit: result?.commit ? { sha: result.commit.sha, message: text(result.commit.message, 500) } : null,
        };
      },
    }),

    defineTool({
      name: 'github_delete_file',
      description:
        'Hapus satu file dari repository dengan commit baru. Membutuhkan SHA file saat ini dan permission Contents write. Operasi destruktif: selalu meminta approval dan dapat diblokir oleh konfigurasi confirmDestructive.',
      risk: 'destructive',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          path: { type: 'string', description: 'Path file yang dihapus.' },
          message: { type: 'string', description: 'Pesan commit penghapusan.' },
          sha: { type: 'string', description: 'SHA file saat ini (wajib).' },
          branch: { type: 'string', description: 'Branch tujuan. Default branch default repository.' },
        },
        required: ['owner', 'repo', 'path', 'message', 'sha'],
      },
      async handler(args) {
        await assertDestructiveAllowed(plugin, 'Penghapusan file');
        const api = await plugin.requireClient();
        const result = await api.delete(`${repoBase(args)}/contents/${contentPath(args.path)}`, {
          message: String(args.message),
          sha: String(args.sha),
          ...(args.branch ? { branch: String(args.branch) } : {}),
        });
        return {
          ok: true,
          commit: result?.commit ? { sha: result.commit.sha, message: text(result.commit.message, 500) } : null,
        };
      },
    }),

    defineTool({
      name: 'github_compare_commits',
      description:
        'Bandingkan dua commit/branch (base...head) dan tampilkan status ahead/behind serta daftar file yang berubah.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          base: { type: 'string', description: 'Branch/tag/SHA awal.' },
          head: { type: 'string', description: 'Branch/tag/SHA akhir.' },
        },
        required: ['owner', 'repo', 'base', 'head'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const ref = `${refSegment(args.base, 'base')}...${refSegment(args.head, 'head')}`;
        const result = await api.get(`${repoBase(args)}/compare/${ref}`);
        return {
          ok: true,
          status: result.status,
          ahead_by: result.ahead_by,
          behind_by: result.behind_by,
          total_commits: result.total_commits,
          commits: limitItems(result.commits || [], 50).map(pickCommit),
          files: limitItems(result.files || [], 100).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })),
        };
      },
    }),
  ];
}
