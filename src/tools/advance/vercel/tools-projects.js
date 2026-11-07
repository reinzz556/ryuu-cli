import { defineTool } from '../../../../src/tools/registry.js';
import { ValidationError } from '../../../../src/utils/errors.js';
import { assertDestructiveAllowed, limitOf, pickProject, projectRef, requiredString } from './tool-helpers.js';

const UPDATABLE = [
  'name',
  'framework',
  'buildCommand',
  'installCommand',
  'outputDirectory',
  'rootDirectory',
  'nodeVersion',
  'publicSource',
  'gitForkProtection',
];

/** Tool manajemen project Vercel. */
export function createProjectTools(plugin) {
  return [
    defineTool({
      name: 'vercel_list_projects',
      description:
        'Daftar project Vercel yang dapat diakses integrasi, dengan deployment terbaru dan domain utamanya. Mendukung pencarian nama dan pagination.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Jumlah project (1-100, default 20).' },
          search: { type: 'string', description: 'Filter nama project (opsional).' },
          page: { type: 'integer', description: 'Halaman (dipakai bila backend mendukung cursor; default 1).' },
        },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const search = args.search ? String(args.search).slice(0, 100) : null;
        if (search && /[\\\u0000-\u001f]/.test(search)) throw new ValidationError('search tidak valid.');
        const data = await api.get('/v9/projects', {
          limit: limitOf(args, { fallback: 20, max: 100 }),
          ...(search ? { search } : {}),
        });
        const projects = Array.isArray(data?.projects) ? data.projects : Array.isArray(data) ? data : [];
        return {
          ok: true,
          count: projects.length,
          projects: projects.map(pickProject).filter(Boolean),
          pagination: data?.pagination || null,
        };
      },
    }),

    defineTool({
      name: 'vercel_get_project',
      description:
        'Ambil detail satu project Vercel (framework, node version, deployment terbaru, domain, target produksi/preview).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { project: { type: 'string', description: 'Nama atau ID project Vercel.' } },
        required: ['project'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        return { ok: true, project: pickProject(await api.get(`/v9/projects/${encodeURIComponent(project)}`)) };
      },
    }),

    defineTool({
      name: 'vercel_create_project',
      description:
        'Buat project Vercel baru. Bila sumber Git diberikan, project dihubungkan ke repository tersebut; tanpa itu project kosong dibuat.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama project (huruf kecil, angka, tanda hubung).' },
          framework: { type: 'string', description: 'Framework, contoh nextjs, vite, node (opsional).' },
          rootDirectory: { type: 'string', description: 'Direktori akar monorepo (opsional).' },
          buildCommand: { type: 'string', description: 'Perintah build (opsional).' },
          installCommand: { type: 'string', description: 'Perintah install (opsional).' },
          outputDirectory: { type: 'string', description: 'Direktori output build (opsional).' },
          gitRepository: {
            type: 'object',
            description: 'Repository Git: { type: "github"|"gitlab"|"bitbucket", repo: "owner/repo" }.',
            properties: {
              type: { type: 'string' },
              repo: { type: 'string' },
            },
          },
        },
        required: ['name'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const name = requiredString(args.name, 'name', { max: 100 });
        if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name)) {
          throw new ValidationError('name project harus huruf kecil, angka, titik, garis bawah, atau tanda hubung.');
        }
        const body = { name };
        for (const field of ['framework', 'rootDirectory', 'buildCommand', 'installCommand', 'outputDirectory']) {
          if (args[field]) body[field] = String(args[field]).slice(0, 200);
        }
        if (args.gitRepository) {
          const type = String(args.gitRepository.type || '').toLowerCase();
          const repo = String(args.gitRepository.repo || '');
          if (!['github', 'gitlab', 'bitbucket'].includes(type)) {
            throw new ValidationError('gitRepository.type harus github, gitlab, atau bitbucket.');
          }
          if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
            throw new ValidationError('gitRepository.repo harus berformat owner/repo.');
          }
          body.gitRepository = { type, repo };
        }
        return { ok: true, project: pickProject(await api.post('/v9/projects', body)) };
      },
    }),

    defineTool({
      name: 'vercel_update_project',
      description:
        'Ubah pengaturan project Vercel (nama, framework, perintah build/install, direktori output/root, node version).',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          name: { type: 'string', description: 'Nama baru project.' },
          framework: { type: 'string' },
          buildCommand: { type: 'string' },
          installCommand: { type: 'string' },
          outputDirectory: { type: 'string' },
          rootDirectory: { type: 'string' },
          nodeVersion: { type: 'string', description: 'Contoh 22.x.' },
          publicSource: { type: 'boolean' },
          gitForkProtection: { type: 'boolean' },
        },
        required: ['project'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const body = {};
        for (const field of UPDATABLE) {
          if (args[field] !== undefined && args[field] !== null) body[field] = args[field];
        }
        if (Object.keys(body).length === 0) throw new ValidationError('Tidak ada field yang diubah.');
        return { ok: true, project: pickProject(await api.patch(`/v9/projects/${encodeURIComponent(project)}`, body)) };
      },
    }),

    defineTool({
      name: 'vercel_delete_project',
      description:
        'Hapus project Vercel beserta deployment-nya. Tindakan permanen dan memerlukan approval; konfirmasikan nama project sebelum memanggil.',
      risk: 'destructive',
      schema: {
        type: 'object',
        properties: { project: { type: 'string', description: 'Nama atau ID project yang akan dihapus.' } },
        required: ['project'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        await assertDestructiveAllowed(plugin, 'Penghapusan project');
        const project = projectRef(args.project);
        const result = await api.delete(`/v9/projects/${encodeURIComponent(project)}`);
        return { ok: true, deleted: project, result: result || null };
      },
    }),

    defineTool({
      name: 'vercel_pause_project',
      description:
        'Jeda project Vercel sehingga deployment-nya berhenti melayani. Endpoint pause tidak tercantum pada tabel scope integrasi, jadi Vercel dapat menolak dengan 404/403 — error diteruskan apa adanya.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: { project: { type: 'string', description: 'Nama atau ID project.' } },
        required: ['project'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        return { ok: true, project, paused: true, result: (await api.post(`/v1/projects/${encodeURIComponent(project)}/pause`)) || null };
      },
    }),

    defineTool({
      name: 'vercel_unpause_project',
      description:
        'Aktifkan kembali project Vercel yang dijeda. Sama seperti pause, endpoint ini bergantung dukungan API dan error Vercel diteruskan apa adanya.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: { project: { type: 'string', description: 'Nama atau ID project.' } },
        required: ['project'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        return { ok: true, project, paused: false, result: (await api.post(`/v1/projects/${encodeURIComponent(project)}/unpause`)) || null };
      },
    }),
  ];
}
