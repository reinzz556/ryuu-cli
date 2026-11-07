import { defineTool } from '../../../../src/tools/registry.js';
import { limitItems, pageQuery, pickWorkflow, pickWorkflowRun, repoBase } from './tool-helpers.js';

const REPO_PROPS = {
  owner: { type: 'string', description: 'Pemilik repository.' },
  repo: { type: 'string', description: 'Nama repository.' },
};

export function createActionTools(plugin) {
  return [
    defineTool({
      name: 'github_list_workflows',
      description:
        'Daftar GitHub Actions workflow yang terdaftar pada repository. Membutuhkan permission Actions read.',
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
        const result = await api.get(`${repoBase(args)}/actions/workflows`, pageQuery(args));
        const workflows = Array.isArray(result?.workflows) ? result.workflows : [];
        return {
          ok: true,
          total_count: result?.total_count ?? workflows.length,
          workflows: limitItems(workflows, 100).map(pickWorkflow),
        };
      },
    }),

    defineTool({
      name: 'github_list_workflow_runs',
      description:
        'Daftar eksekusi workflow (workflow run), dapat difilter per workflow, branch, event, status, dan aktor. Membutuhkan permission Actions read.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          workflow_id: { type: 'integer', minimum: 1, description: 'ID workflow; kosongkan untuk semua workflow.' },
          branch: { type: 'string', description: 'Filter branch.' },
          event: { type: 'string', description: 'Filter event, contoh: push atau pull_request.' },
          status: {
            type: 'string',
            enum: ['queued', 'in_progress', 'completed', 'success', 'failure', 'cancelled', 'skipped'],
            description: 'Filter status/kesimpulan.',
          },
          actor: { type: 'string', description: 'Filter username pemicu.' },
          per_page: { type: 'integer', minimum: 1, maximum: 100, description: 'Jumlah per halaman (default 30).' },
          page: { type: 'integer', minimum: 1, description: 'Halaman (default 1).' },
        },
        required: ['owner', 'repo'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const base = repoBase(args);
        const path = args.workflow_id
          ? `${base}/actions/workflows/${Number(args.workflow_id)}/runs`
          : `${base}/actions/runs`;
        const result = await api.get(path, {
          ...pageQuery(args),
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.event ? { event: args.event } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.actor ? { actor: args.actor } : {}),
        });
        const runs = Array.isArray(result?.workflow_runs) ? result.workflow_runs : [];
        return {
          ok: true,
          total_count: result?.total_count ?? runs.length,
          runs: limitItems(runs, 100).map(pickWorkflowRun),
        };
      },
    }),

    defineTool({
      name: 'github_get_workflow_run',
      description: 'Ambil detail satu workflow run: status, kesimpulan, commit, aktor, dan tautan ke halaman Actions.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          run_id: { type: 'integer', minimum: 1, description: 'ID workflow run.' },
        },
        required: ['owner', 'repo', 'run_id'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const run = await api.get(`${repoBase(args)}/actions/runs/${Number(args.run_id)}`);
        return { ok: true, run: pickWorkflowRun(run) };
      },
    }),

    defineTool({
      name: 'github_rerun_workflow',
      description:
        'Jalankan ulang seluruh job pada workflow run yang sudah selesai. Membutuhkan permission Actions write; operasi ini selalu meminta approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          run_id: { type: 'integer', minimum: 1, description: 'ID workflow run.' },
          enable_debug_logging: { type: 'boolean', description: 'Aktifkan debug logging pada rerun.' },
        },
        required: ['owner', 'repo', 'run_id'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        await api.post(`${repoBase(args)}/actions/runs/${Number(args.run_id)}/rerun`, {
          ...(args.enable_debug_logging !== undefined
            ? { enable_debug_logging: Boolean(args.enable_debug_logging) }
            : {}),
        });
        return { ok: true, rerun: true, run_id: Number(args.run_id) };
      },
    }),
  ];
}
