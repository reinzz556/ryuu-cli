import { defineTool } from '../../../../src/tools/registry.js';
import { limitItems, pageQuery, pickIssue, repoBase, text } from './tool-helpers.js';

const REPO_PROPS = {
  owner: { type: 'string', description: 'Pemilik repository (username atau organisasi).' },
  repo: { type: 'string', description: 'Nama repository.' },
};

export function createIssueTools(plugin) {
  return [
    defineTool({
      name: 'github_list_issues',
      description:
        'Daftar issue pada repository. Secara default pull request disaring keluar; set include_pull_requests=true bila hasil gabungan memang diinginkan. Membutuhkan permission Issues read.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Status issue. Default open.' },
          labels: { type: 'string', description: 'Daftar label dipisah koma, contoh: bug,urgent.' },
          sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Urutan hasil.' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Arah urutan.' },
          since: { type: 'string', description: 'Hanya issue yang diperbarui setelah tanggal ISO 8601 ini.' },
          creator: { type: 'string', description: 'Filter berdasarkan username pembuat.' },
          assignee: { type: 'string', description: 'Filter berdasarkan username assignee, atau "none".' },
          milestone: { type: 'string', description: 'Nomor milestone, "none", atau "*".' },
          include_pull_requests: { type: 'boolean', description: 'Sertakan pull request dalam hasil. Default false.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const query = {
          ...pageQuery(args),
          state: args.state || 'open',
          ...(args.labels ? { labels: args.labels } : {}),
          ...(args.sort ? { sort: args.sort } : {}),
          ...(args.direction ? { direction: args.direction } : {}),
          ...(args.since ? { since: args.since } : {}),
          ...(args.creator ? { creator: args.creator } : {}),
          ...(args.assignee ? { assignee: args.assignee } : {}),
          ...(args.milestone ? { milestone: args.milestone } : {}),
        };
        const items = await api.paginate(`${repoBase(args)}/issues`, { query, maxPages: 2, maxItems: 100 });
        const filtered = args.include_pull_requests ? items : items.filter((item) => !item.pull_request);
        return {
          ok: true,
          count: filtered.length,
          filtered_pull_requests: items.length - filtered.length,
          issues: limitItems(filtered, 100).map(pickIssue),
        };
      },
    }),

    defineTool({
      name: 'github_get_issue',
      description: 'Ambil satu issue berdasarkan nomor, termasuk label, assignee, isi, dan jumlah komentar.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          issue_number: { type: 'integer', minimum: 1, description: 'Nomor issue.' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const issue = await api.get(`${repoBase(args)}/issues/${Number(args.issue_number)}`);
        return { ok: true, issue: pickIssue(issue) };
      },
    }),

    defineTool({
      name: 'github_create_issue',
      description:
        'Buat issue baru. Membutuhkan permission Issues write. Operasi ini mengubah data dan selalu meminta approval pengguna.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          title: { type: 'string', description: 'Judul issue (wajib).' },
          body: { type: 'string', description: 'Isi issue dalam Markdown.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Label yang dipasang.' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'Username yang ditugaskan.' },
          milestone: { type: 'integer', minimum: 1, description: 'Nomor milestone.' },
        },
        required: ['owner', 'repo', 'title'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = { title: String(args.title) };
        if (args.body !== undefined) body.body = String(args.body);
        if (Array.isArray(args.labels)) body.labels = args.labels.map(String);
        if (Array.isArray(args.assignees)) body.assignees = args.assignees.map(String);
        if (args.milestone !== undefined) body.milestone = Number(args.milestone);
        const issue = await api.post(`${repoBase(args)}/issues`, body);
        return { ok: true, issue: pickIssue(issue) };
      },
    }),

    defineTool({
      name: 'github_update_issue',
      description:
        'Perbarui judul, isi, status, label, assignee, atau milestone sebuah issue. Membutuhkan permission Issues write serta approval pengguna.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          issue_number: { type: 'integer', minimum: 1, description: 'Nomor issue.' },
          title: { type: 'string', description: 'Judul baru.' },
          body: { type: 'string', description: 'Isi baru.' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'Status baru.' },
          state_reason: {
            type: 'string',
            enum: ['completed', 'not_planned', 'reopened'],
            description: 'Alasan penutupan (opsional).',
          },
          labels: { type: 'array', items: { type: 'string' }, description: 'Ganti seluruh label.' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'Ganti seluruh assignee.' },
          milestone: { type: ['integer', 'null'], description: 'Nomor milestone baru atau null untuk menghapus.' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const body = {};
        for (const key of ['title', 'body', 'state', 'state_reason']) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        if (Array.isArray(args.labels)) body.labels = args.labels.map(String);
        if (Array.isArray(args.assignees)) body.assignees = args.assignees.map(String);
        if (args.milestone !== undefined) body.milestone = args.milestone;
        if (Object.keys(body).length === 0) throw new Error('Tidak ada perubahan yang diminta.');
        const issue = await api.patch(`${repoBase(args)}/issues/${Number(args.issue_number)}`, body);
        return { ok: true, issue: pickIssue(issue) };
      },
    }),

    defineTool({
      name: 'github_comment_issue',
      description:
        'Tambahkan komentar pada issue atau pull request. Membutuhkan permission Issues write (untuk PR: Pull requests write) dan approval pengguna.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          issue_number: { type: 'integer', minimum: 1, description: 'Nomor issue atau pull request.' },
          body: { type: 'string', description: 'Isi komentar dalam Markdown.' },
        },
        required: ['owner', 'repo', 'issue_number', 'body'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const comment = await api.post(`${repoBase(args)}/issues/${Number(args.issue_number)}/comments`, {
          body: String(args.body),
        });
        return {
          ok: true,
          comment: {
            id: comment.id,
            user: comment.user?.login || null,
            body: text(comment.body, 2000),
            html_url: comment.html_url || null,
            created_at: comment.created_at || null,
          },
        };
      },
    }),

    defineTool({
      name: 'github_list_issue_comments',
      description: 'Daftar komentar pada sebuah issue atau pull request, terbaru sesuai urutan GitHub.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          issue_number: { type: 'integer', minimum: 1, description: 'Nomor issue atau pull request.' },
          since: { type: 'string', description: 'Hanya komentar setelah tanggal ISO 8601 ini.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const comments = await api.paginate(`${repoBase(args)}/issues/${Number(args.issue_number)}/comments`, {
          query: { ...pageQuery(args), ...(args.since ? { since: args.since } : {}) },
          maxPages: 2,
          maxItems: 100,
        });
        return {
          ok: true,
          count: comments.length,
          comments: limitItems(comments, 100).map((comment) => ({
            id: comment.id,
            user: comment.user?.login || null,
            body: text(comment.body, 2000),
            html_url: comment.html_url || null,
            created_at: comment.created_at || null,
            updated_at: comment.updated_at || null,
          })),
        };
      },
    }),
  ];
}
