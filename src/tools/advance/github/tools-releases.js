import { defineTool } from '../../../../src/tools/registry.js';
import { limitItems, pageQuery, pickRelease, repoBase } from './tool-helpers.js';

const REPO_PROPS = {
  owner: { type: 'string', description: 'Pemilik repository.' },
  repo: { type: 'string', description: 'Nama repository.' },
};

export function createReleaseTools(plugin) {
  return [
    defineTool({
      name: 'github_list_releases',
      description: 'Daftar release repository, termasuk draft dan prerelease. Membutuhkan permission Contents read.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const releases = await api.paginate(`${repoBase(args)}/releases`, {
          query: pageQuery(args),
          maxPages: 2,
          maxItems: 100,
        });
        return { ok: true, count: releases.length, releases: limitItems(releases, 100).map(pickRelease) };
      },
    }),

    defineTool({
      name: 'github_get_release',
      description: 'Ambil satu release berdasarkan id numerik GitHub (bukan tag), termasuk catatan rilis dan tautan unduhan.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          release_id: { type: 'integer', minimum: 1, description: 'ID numerik release.' },
        },
        required: ['owner', 'repo', 'release_id'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const release = await api.get(`${repoBase(args)}/releases/${Number(args.release_id)}`);
        return { ok: true, release: pickRelease(release) };
      },
    }),

    defineTool({
      name: 'github_create_release',
      description:
        'Buat release dari tag yang sudah ada atau tag baru pada commit tertentu. Membutuhkan permission Contents write serta approval pengguna.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          tag_name: { type: 'string', description: 'Nama tag, contoh: v1.2.0.' },
          target_commitish: { type: 'string', description: 'Branch atau SHA target bila tag belum ada.' },
          name: { type: 'string', description: 'Judul release.' },
          body: { type: 'string', description: 'Catatan rilis dalam Markdown.' },
          draft: { type: 'boolean', description: 'Simpan sebagai draft.' },
          prerelease: { type: 'boolean', description: 'Tandai sebagai prerelease.' },
          generate_release_notes: { type: 'boolean', description: 'Minta GitHub membuat catatan rilis otomatis.' },
        },
        required: ['owner', 'repo', 'tag_name'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = { tag_name: String(args.tag_name) };
        for (const key of ['target_commitish', 'name', 'body']) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        for (const key of ['draft', 'prerelease', 'generate_release_notes']) {
          if (args[key] !== undefined) body[key] = Boolean(args[key]);
        }
        const release = await api.post(`${repoBase(args)}/releases`, body);
        return { ok: true, release: pickRelease(release) };
      },
    }),
  ];
}
