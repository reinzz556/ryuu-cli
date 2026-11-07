import { defineTool } from '../../../../src/tools/registry.js';
import { assertDestructiveAllowed, limitItems, pageQuery, pickPull, repoBase, text } from './tool-helpers.js';

const REPO_PROPS = {
  owner: { type: 'string', description: 'Pemilik repository.' },
  repo: { type: 'string', description: 'Nama repository.' },
};

export function createPullTools(plugin) {
  return [
    defineTool({
      name: 'github_list_pull_requests',
      description:
        'Daftar pull request pada repository dengan filter status, branch, dan urutan. Membutuhkan permission Pull requests read.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Status PR. Default open.' },
          head: { type: 'string', description: 'Filter berdasarkan branch sumber, format owner:branch.' },
          base: { type: 'string', description: 'Filter berdasarkan branch tujuan.' },
          sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'], description: 'Urutan hasil.' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Arah urutan.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const pulls = await api.paginate(`${repoBase(args)}/pulls`, {
          query: {
            ...pageQuery(args),
            state: args.state || 'open',
            ...(args.head ? { head: args.head } : {}),
            ...(args.base ? { base: args.base } : {}),
            ...(args.sort ? { sort: args.sort } : {}),
            ...(args.direction ? { direction: args.direction } : {}),
          },
          maxPages: 2,
          maxItems: 100,
        });
        return { ok: true, count: pulls.length, pull_requests: limitItems(pulls, 100).map(pickPull) };
      },
    }),

    defineTool({
      name: 'github_get_pull_request',
      description:
        'Ambil detail satu pull request: branch asal/tujuan, status merge, jumlah file berubah, dan isi deskripsi.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          pull_number: { type: 'integer', minimum: 1, description: 'Nomor pull request.' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const pull = await api.get(`${repoBase(args)}/pulls/${Number(args.pull_number)}`);
        return { ok: true, pull_request: pickPull(pull) };
      },
    }),

    defineTool({
      name: 'github_create_pull_request',
      description:
        'Buat pull request baru dari branch head ke branch base. Membutuhkan permission Pull requests write dan Contents read. Selalu meminta approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          title: { type: 'string', description: 'Judul pull request.' },
          head: { type: 'string', description: 'Branch sumber, contoh: feature/login atau owner:feature/login.' },
          base: { type: 'string', description: 'Branch tujuan, contoh: main.' },
          body: { type: 'string', description: 'Deskripsi dalam Markdown.' },
          draft: { type: 'boolean', description: 'Buat sebagai draft.' },
          maintainer_can_modify: { type: 'boolean', description: 'Izinkan maintainer mengubah branch head.' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = {
          title: String(args.title),
          head: String(args.head),
          base: String(args.base),
          ...(args.body !== undefined ? { body: String(args.body) } : {}),
          ...(args.draft !== undefined ? { draft: Boolean(args.draft) } : {}),
          ...(args.maintainer_can_modify !== undefined
            ? { maintainer_can_modify: Boolean(args.maintainer_can_modify) }
            : {}),
        };
        const pull = await api.post(`${repoBase(args)}/pulls`, body);
        return { ok: true, pull_request: pickPull(pull) };
      },
    }),

    defineTool({
      name: 'github_update_pull_request',
      description:
        'Perbarui judul, deskripsi, status, atau branch tujuan pull request. Membutuhkan permission Pull requests write serta approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          pull_number: { type: 'integer', minimum: 1, description: 'Nomor pull request.' },
          title: { type: 'string', description: 'Judul baru.' },
          body: { type: 'string', description: 'Deskripsi baru.' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'Status baru.' },
          base: { type: 'string', description: 'Branch tujuan baru.' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = {};
        for (const key of ['title', 'body', 'state', 'base']) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        if (Object.keys(body).length === 0) throw new Error('Tidak ada perubahan yang diminta.');
        const pull = await api.patch(`${repoBase(args)}/pulls/${Number(args.pull_number)}`, body);
        return { ok: true, pull_request: pickPull(pull) };
      },
    }),

    defineTool({
      name: 'github_merge_pull_request',
      description:
        'Merge pull request. Operasi berdampak besar: butuh permission Pull requests write, selalu meminta approval, dan dapat diblokir oleh confirmDestructive. Sertakan sha bila ingin memastikan head belum berubah.',
      risk: 'destructive',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          pull_number: { type: 'integer', minimum: 1, description: 'Nomor pull request.' },
          merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Metode merge.' },
          commit_title: { type: 'string', description: 'Judul commit merge.' },
          commit_message: { type: 'string', description: 'Pesan commit merge.' },
          sha: { type: 'string', description: 'Head SHA yang diharapkan (opsional, untuk keamanan).' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      async handler(args) {
        await assertDestructiveAllowed(plugin, 'Merge pull request');
        const api = await plugin.requireClient();
        const body = {};
        for (const key of ['merge_method', 'commit_title', 'commit_message', 'sha']) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        const result = await api.put(`${repoBase(args)}/pulls/${Number(args.pull_number)}/merge`, body);
        return {
          ok: Boolean(result?.merged),
          merged: Boolean(result?.merged),
          message: text(result?.message, 500),
          sha: result?.sha || null,
        };
      },
    }),

    defineTool({
      name: 'github_list_pull_request_files',
      description: 'Daftar file yang berubah pada sebuah pull request beserta jumlah baris ditambah/dihapus.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          pull_number: { type: 'integer', minimum: 1, description: 'Nomor pull request.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const files = await api.paginate(`${repoBase(args)}/pulls/${Number(args.pull_number)}/files`, {
          query: pageQuery(args),
          maxPages: 3,
          maxItems: 300,
        });
        return {
          ok: true,
          count: files.length,
          files: limitItems(files, 300).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: text(file.patch, 4000),
          })),
        };
      },
    }),

    defineTool({
      name: 'github_review_pull_request',
      description:
        'Kirim review pada pull request: APPROVE, REQUEST_CHANGES, atau COMMENT, dengan komentar per baris opsional. Membutuhkan permission Pull requests write dan approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          pull_number: { type: 'integer', minimum: 1, description: 'Nomor pull request.' },
          body: { type: 'string', description: 'Ringkasan review.' },
          event: {
            type: 'string',
            enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
            description: 'Jenis review.',
          },
          comments: {
            type: 'array',
            maxItems: 50,
            description: 'Komentar per baris: path, position (atau line), dan body.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                position: { type: 'integer', minimum: 1 },
                line: { type: 'integer', minimum: 1 },
                body: { type: 'string' },
              },
              required: ['path', 'body'],
            },
          },
        },
        required: ['owner', 'repo', 'pull_number', 'event'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = { event: String(args.event) };
        if (args.body !== undefined) body.body = String(args.body);
        if (Array.isArray(args.comments)) {
          body.comments = args.comments.slice(0, 50).map((comment) => ({
            path: String(comment.path),
            body: String(comment.body),
            ...(comment.position !== undefined ? { position: Number(comment.position) } : {}),
            ...(comment.line !== undefined ? { line: Number(comment.line) } : {}),
          }));
        }
        if (body.event === 'REQUEST_CHANGES' && !body.body) {
          throw new Error('Review REQUEST_CHANGES membutuhkan body.');
        }
        const review = await api.post(`${repoBase(args)}/pulls/${Number(args.pull_number)}/reviews`, body);
        return {
          ok: true,
          review: {
            id: review.id,
            user: review.user?.login || null,
            state: review.state,
            body: text(review.body, 2000),
            html_url: review.html_url || null,
            submitted_at: review.submitted_at || null,
          },
        };
      },
    }),
  ];
}
