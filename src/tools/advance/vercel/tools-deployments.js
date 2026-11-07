import { defineTool } from '../../../../src/tools/registry.js';
import { ValidationError } from '../../../../src/utils/errors.js';
import {
  assertDestructiveAllowed,
  deploymentRef,
  limitOf,
  pickDeployment,
  projectRef,
  requiredString,
  text,
} from './tool-helpers.js';

/** Validasi sumber deployment: Git atau daftar file. Tidak pernah "nama saja". */
function deploymentSource(args) {
  if (args.gitSource) {
    const type = String(args.gitSource.type || '').toLowerCase();
    const ref = String(args.gitSource.ref || '').trim();
    if (!['github', 'gitlab', 'bitbucket'].includes(type)) {
      throw new ValidationError('gitSource.type harus github, gitlab, atau bitbucket.');
    }
    const repo = String(args.gitSource.repo || '').trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      throw new ValidationError('gitSource.repo harus berformat owner/repo.');
    }
    if (!ref || ref.length > 200 || ref.includes('..')) throw new ValidationError('gitSource.ref tidak valid.');
    return {
      gitSource: {
        type,
        repo,
        ref,
        ...(args.gitSource.sha ? { sha: String(args.gitSource.sha).slice(0, 64) } : {}),
      },
    };
  }
  if (Array.isArray(args.files) && args.files.length > 0) {
    if (args.files.length > 100) throw new ValidationError('Maksimum 100 file per deployment.');
    const files = args.files.map((entry) => {
      const file = String(entry?.file ?? '').trim();
      if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').some((part) => part === '..')) {
        throw new ValidationError('Path file deployment tidak valid.');
      }
      if (typeof entry?.data !== 'string') throw new ValidationError(`data untuk ${file} harus string (base64/teks).`);
      return { file, data: entry.data };
    });
    return { files };
  }
  throw new ValidationError(
    'Deployment membutuhkan sumber yang valid: gitSource { type, repo, ref } atau files [{ file, data }]. ' +
      'Nama project saja tidak cukup menurut API Vercel.',
  );
}

/** Tool deployment Vercel. */
export function createDeploymentTools(plugin) {
  return [
    defineTool({
      name: 'vercel_list_deployments',
      description:
        'Daftar deployment Vercel (terbaru lebih dulu) dengan status, target, commit, dan URL. Filter berdasarkan project atau target.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'ID atau nama project (opsional).' },
          target: { type: 'string', description: 'production atau preview (opsional).' },
          state: { type: 'string', description: 'READY, ERROR, BUILDING, QUEUED, CANCELED (opsional).' },
          limit: { type: 'integer', description: 'Jumlah deployment (1-100, default 20).' },
        },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const projectId = args.projectId ? projectRef(args.projectId, 'projectId') : null;
        const target = args.target ? String(args.target).toLowerCase() : null;
        if (target && !['production', 'preview'].includes(target)) throw new ValidationError('target tidak valid.');
        const data = await api.get('/v6/deployments', {
          limit: limitOf(args, { fallback: 20, max: 100 }),
          ...(projectId ? { projectId } : {}),
          ...(target ? { target } : {}),
          ...(args.state ? { state: String(args.state).toUpperCase().slice(0, 30) } : {}),
        });
        const deployments = Array.isArray(data?.deployments) ? data.deployments : Array.isArray(data) ? data : [];
        return {
          ok: true,
          count: deployments.length,
          deployments: deployments.map(pickDeployment).filter(Boolean),
          pagination: data?.pagination || null,
        };
      },
    }),

    defineTool({
      name: 'vercel_get_deployment',
      description: 'Ambil detail satu deployment Vercel berdasarkan ID (dpl_…).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { deployment: { type: 'string', description: 'ID deployment (dpl_…).' } },
        required: ['deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = deploymentRef(args.deployment);
        return { ok: true, deployment: pickDeployment(await api.get(`/v13/deployments/${encodeURIComponent(id)}`)) };
      },
    }),

    defineTool({
      name: 'vercel_create_deployment',
      description:
        'Buat deployment Vercel dari sumber yang valid: gitSource (repository + ref) atau files (upload). Nama project saja DITOLAK karena API Vercel membutuhkan sumber. Deployment ke production memerlukan approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama project/deployment di Vercel.' },
          project: { type: 'string', description: 'Project tujuan (opsional; default sama dengan name).' },
          target: { type: 'string', description: 'production, staging, atau preview (default preview).' },
          gitSource: {
            type: 'object',
            description: 'Sumber Git: { type, repo, ref, sha? }.',
            properties: {
              type: { type: 'string' },
              repo: { type: 'string' },
              ref: { type: 'string' },
              sha: { type: 'string' },
            },
          },
          files: {
            type: 'array',
            description: 'Daftar file [{ file, data }] bila deployment tidak memakai Git.',
            items: {
              type: 'object',
              properties: { file: { type: 'string' }, data: { type: 'string' } },
            },
          },
          regions: { type: 'array', description: 'Region opsional.', items: { type: 'string' } },
        },
        required: ['name'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const name = requiredString(args.name, 'name', { max: 100 });
        const target = args.target ? String(args.target).toLowerCase() : 'preview';
        if (!['production', 'staging', 'preview'].includes(target)) {
          throw new ValidationError('target harus production, staging, atau preview.');
        }
        const source = deploymentSource(args);
        const body = {
          name,
          ...(args.project ? { project: projectRef(args.project) } : {}),
          target,
          ...source,
          ...(Array.isArray(args.regions) && args.regions.length
            ? { regions: args.regions.slice(0, 10).map((region) => String(region).slice(0, 20)) }
            : {}),
        };
        const deployment = pickDeployment(await api.post('/v13/deployments', body));
        return {
          ok: true,
          deployment,
          note:
            target === 'production'
              ? 'Deployment production dibuat; trafik produksi baru berpindah setelah build selesai (atau setelah promote).'
              : 'Deployment dibuat sebagai preview.',
        };
      },
    }),

    defineTool({
      name: 'vercel_cancel_deployment',
      description:
        'Batalkan deployment Vercel yang masih berjalan. Memerlukan approval karena menghentikan proses build.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: { deployment: { type: 'string', description: 'ID deployment (dpl_…).' } },
        required: ['deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = deploymentRef(args.deployment);
        return { ok: true, deployment: id, cancelled: true, result: (await api.patch(`/v12/deployments/${encodeURIComponent(id)}/cancel`)) || null };
      },
    }),

    defineTool({
      name: 'vercel_delete_deployment',
      description:
        'Hapus deployment Vercel. Tindakan permanen dan memerlukan approval; deployment produksi dapat memengaruhi situs.',
      risk: 'destructive',
      schema: {
        type: 'object',
        properties: { deployment: { type: 'string', description: 'ID deployment (dpl_…).' } },
        required: ['deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        await assertDestructiveAllowed(plugin, 'Penghapusan deployment');
        const id = deploymentRef(args.deployment);
        return { ok: true, deployment: id, deleted: true, result: (await api.delete(`/v13/deployments/${encodeURIComponent(id)}`)) || null };
      },
    }),

    defineTool({
      name: 'vercel_get_deployment_events',
      description:
        'Ambil event build/runtime satu deployment Vercel (urutan waktu, tipe, teks, level). Berguna untuk memahami langkah build.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'ID deployment (dpl_…).' },
          limit: { type: 'integer', description: 'Jumlah event (1-500, default 100).' },
        },
        required: ['deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = deploymentRef(args.deployment);
        const data = await api.get(`/v2/deployments/${encodeURIComponent(id)}/events`, {
          direction: 'forward',
          follow: 0,
          limit: limitOf(args, { fallback: 100, max: 500 }),
        });
        const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
        return {
          ok: true,
          count: events.length,
          events: events.slice(0, 200).map((event) => ({
            type: event?.type || null,
            created: event?.created ?? null,
            level: event?.level || event?.payload?.level || null,
            text: text(event?.text || event?.payload?.text, 1500) || null,
          })),
        };
      },
    }),

    defineTool({
      name: 'vercel_get_deployment_logs',
      description:
        'Baca log satu deployment Vercel (events build/runtime). Gunakan onlyProblems=true untuk hanya error/warning. Nilai environment variable tidak pernah disertakan.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'ID deployment (dpl_…).' },
          limit: { type: 'integer', description: 'Jumlah baris (1-500, default 100).' },
          onlyProblems: { type: 'boolean', description: 'Hanya tampilkan error/warning (default false).' },
        },
        required: ['deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = deploymentRef(args.deployment);
        const bound = limitOf(args, { fallback: 100, max: 500 });
        const data = await api.get(`/v2/deployments/${encodeURIComponent(id)}/events`, {
          direction: 'forward',
          follow: 0,
          limit: bound,
        });
        const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
        let logs = events
          .map((event) => ({
            created: event?.created ?? event?.date ?? null,
            level: event?.level || event?.payload?.level || null,
            text: text(event?.text || event?.payload?.text, 2000) || null,
          }))
          .filter((event) => event.text);
        if (args.onlyProblems === true) {
          logs = logs.filter((event) => ['error', 'warning', 'warn'].includes(String(event.level || '').toLowerCase()));
        }
        return {
          ok: true,
          deploymentId: id,
          count: logs.length,
          logs: logs.slice(0, bound),
          truncated: events.length >= bound,
        };
      },
    }),

    defineTool({
      name: 'vercel_promote_deployment',
      description:
        'Promosikan deployment ke produksi tanpa rebuild (POST /v10/projects/{project}/promote/{deployment}). Memerlukan approval karena mengubah trafik produksi.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          deployment: { type: 'string', description: 'ID deployment yang dipromosikan.' },
        },
        required: ['project', 'deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const deployment = deploymentRef(args.deployment);
        const result = await api.post(
          `/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(deployment)}`,
        );
        return { ok: true, promoted: deployment, project, result: result || null };
      },
    }),

    defineTool({
      name: 'vercel_rollback_deployment',
      description:
        'Rollback produksi project ke deployment sebelumnya (POST /v9/projects/{project}/rollback/{deployment}). Memerlukan approval; endpoint ini tidak tercantum pada REST reference publik sehingga error Vercel diteruskan apa adanya.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          deployment: { type: 'string', description: 'ID deployment tujuan rollback.' },
        },
        required: ['project', 'deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const deployment = deploymentRef(args.deployment);
        const result = await api.post(
          `/v9/projects/${encodeURIComponent(project)}/rollback/${encodeURIComponent(deployment)}`,
        );
        return { ok: true, rolledBackTo: deployment, project, result: result || null };
      },
    }),
  ];
}
