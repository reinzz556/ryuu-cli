import { defineTool } from '../../../../src/tools/registry.js';
import { ValidationError } from '../../../../src/utils/errors.js';
import {
  assertDestructiveAllowed,
  ENV_TARGETS,
  envTargets,
  limitOf,
  pickEnv,
  projectRef,
  requiredString,
} from './tool-helpers.js';

/**
 * Tool environment variable Vercel.
 *
 * Nilai (`value`) hanya dikirim MENUJU Vercel. Tidak pernah dikembalikan ke
 * model, dicatat, atau disertakan pada pesan error.
 */
export function createEnvTools(plugin) {
  return [
    defineTool({
      name: 'vercel_list_env',
      description:
        'Daftar environment variable satu project Vercel (key, type, target, branch) TANPA nilai. Minta nama project bila pengguna menyebut project tertentu.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          limit: { type: 'integer', description: 'Jumlah variabel (1-200, default 50).' },
        },
        required: ['project'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const data = await api.get(`/v9/projects/${encodeURIComponent(project)}/env`, {
          limit: limitOf(args, { fallback: 50, max: 200 }),
        });
        const envs = Array.isArray(data?.envs) ? data.envs : Array.isArray(data) ? data : [];
        return {
          ok: true,
          count: envs.length,
          project,
          envs: envs.map(pickEnv).filter(Boolean),
          note: 'Nilai environment variable tidak ditampilkan. Perubahan berlaku setelah deployment baru.',
        };
      },
    }),

    defineTool({
      name: 'vercel_create_env',
      description:
        'Tambahkan environment variable ke project Vercel. Nilai tidak akan ditampilkan kembali. Memerlukan approval; deployment baru diperlukan agar nilai berlaku.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          key: { type: 'string', description: 'Nama variabel, contoh API_URL.' },
          value: { type: 'string', description: 'Nilai rahasia variabel (tidak akan ditampilkan).' },
          target: {
            type: 'array',
            description: 'Target environment: production, preview, development (default semuanya).',
            items: { type: 'string' },
          },
          type: { type: 'string', description: 'plain, encrypted, secret, sensitive (default encrypted).' },
          gitBranch: { type: 'string', description: 'Batasi ke branch (opsional).' },
          comment: { type: 'string', description: 'Komentar (opsional).' },
        },
        required: ['project', 'key', 'value'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const key = requiredString(args.key, 'key', { max: 120 });
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(key)) {
          throw new ValidationError('key environment variable hanya boleh huruf, angka, dan garis bawah.');
        }
        const value = String(args.value ?? '');
        if (!value) throw new ValidationError('value wajib diisi.');
        const type = args.type ? String(args.type).toLowerCase() : 'encrypted';
        if (!['plain', 'encrypted', 'secret', 'sensitive'].includes(type)) {
          throw new ValidationError('type harus plain, encrypted, secret, atau sensitive.');
        }
        const created = await api.post(`/v10/projects/${encodeURIComponent(project)}/env`, {
          key,
          value,
          type,
          target: envTargets(args.target),
          ...(args.gitBranch ? { gitBranch: String(args.gitBranch).slice(0, 200) } : {}),
          ...(args.comment ? { comment: String(args.comment).slice(0, 500) } : {}),
        });
        return {
          ok: true,
          project,
          created: pickEnv(created?.created || created?.env || created),
          note: 'Environment variable dibuat. Jalankan deployment baru agar nilainya berlaku.',
        };
      },
    }),

    defineTool({
      name: 'vercel_update_env',
      description:
        'Perbarui environment variable project Vercel (nilai, target, key, atau tipe). Memerlukan approval; deployment baru diperlukan agar perubahan berlaku.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          envId: { type: 'string', description: 'ID environment variable (dari vercel_list_env).' },
          key: { type: 'string', description: 'Key baru (opsional).' },
          value: { type: 'string', description: 'Nilai baru (opsional, tidak ditampilkan).' },
          target: { type: 'array', description: 'Target baru (opsional).', items: { type: 'string' } },
          type: { type: 'string', description: 'Tipe baru (opsional).' },
          gitBranch: { type: 'string', description: 'Branch baru (opsional).' },
          comment: { type: 'string', description: 'Komentar baru (opsional).' },
        },
        required: ['project', 'envId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const envId = requiredString(args.envId, 'envId', { max: 64 });
        const body = {};
        if (args.key !== undefined) body.key = requiredString(args.key, 'key', { max: 120 });
        if (args.value !== undefined) body.value = String(args.value);
        if (args.target !== undefined) body.target = envTargets(args.target);
        if (args.type !== undefined) body.type = String(args.type).toLowerCase();
        if (args.gitBranch !== undefined) body.gitBranch = String(args.gitBranch).slice(0, 200);
        if (args.comment !== undefined) body.comment = String(args.comment).slice(0, 500);
        if (Object.keys(body).length === 0) throw new ValidationError('Tidak ada field environment variable yang diubah.');
        const updated = await api.patch(
          `/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(envId)}`,
          body,
        );
        return {
          ok: true,
          project,
          updated: pickEnv(updated?.updated || updated?.env || updated),
          note: 'Perubahan tersimpan. Deployment baru diperlukan agar nilai baru dipakai.',
        };
      },
    }),

    defineTool({
      name: 'vercel_delete_env',
      description:
        'Hapus environment variable project Vercel berdasarkan ID atau key. Memerlukan approval; deployment yang ada tidak berubah sampai deployment baru.',
      risk: 'destructive',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          envIdOrKey: { type: 'string', description: 'ID environment variable atau key-nya.' },
        },
        required: ['project', 'envIdOrKey'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        await assertDestructiveAllowed(plugin, 'Penghapusan environment variable');
        const project = projectRef(args.project);
        const target = requiredString(args.envIdOrKey, 'envIdOrKey', { max: 120 });
        const result = await api.delete(
          `/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(target)}`,
        );
        return {
          ok: true,
          project,
          deleted: target,
          result: result || null,
          note: 'Environment variable dihapus. Deployment baru diperlukan agar perubahan berlaku.',
        };
      },
    }),

    defineTool({
      name: 'vercel_get_env_targets',
      description:
        'Kembalikan target environment yang didukung Vercel (production, preview, development) dan target yang benar-benar dipakai environment variable project bila project disebut.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { project: { type: 'string', description: 'Nama atau ID project (opsional).' } },
      },
      async handler(args) {
        const targets = new Set();
        let project = null;
        if (args.project) {
          const api = await plugin.requireClient();
          project = projectRef(args.project);
          const data = await api.get(`/v9/projects/${encodeURIComponent(project)}/env`, { limit: 100 });
          const envs = Array.isArray(data?.envs) ? data.envs : Array.isArray(data) ? data : [];
          for (const env of envs) for (const target of env?.target || []) targets.add(target);
        }
        return {
          ok: true,
          supported: [...ENV_TARGETS],
          ...(project ? { project, inUse: [...targets] } : {}),
          note: 'Perubahan environment variable berlaku setelah deployment baru.',
        };
      },
    }),
  ];
}
