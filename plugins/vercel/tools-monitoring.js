import { defineTool } from '../../src/tools/registry.js';
import { ValidationError } from '../../src/utils/errors.js';
import { deploymentRef, limitOf, pickCheck, requiredString } from './tool-helpers.js';

const CHECK_STATUS = ['running', 'succeeded', 'failed'];
const CHECK_CONCLUSIONS = ['succeeded', 'failed', 'skipped', 'canceled'];

/**
 * Tool monitoring: deployment checks, webhook, dan billing (read-only).
 * Log dan event deployment didefinisikan di `tools-deployments.js` agar nama
 * tool tidak duplikat di registry.
 */
export function createMonitoringTools(plugin) {
  return [
    defineTool({
      name: 'vercel_list_deployment_checks',
      description: 'Daftar deployment check (status gate) satu deployment Vercel.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { deployment: { type: 'string', description: 'ID deployment (dpl_…).' } },
        required: ['deployment'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = deploymentRef(args.deployment);
        const data = await api.get(`/v1/deployments/${encodeURIComponent(id)}/checks`);
        const checks = Array.isArray(data?.checks) ? data.checks : Array.isArray(data) ? data : [];
        return { ok: true, deploymentId: id, count: checks.length, checks: checks.map(pickCheck).filter(Boolean) };
      },
    }),

    defineTool({
      name: 'vercel_create_deployment_check',
      description:
        'Buat deployment check baru pada deployment Vercel (nama, blocking, detailsUrl). Memerlukan scope deployment-check dan approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'ID deployment (dpl_…).' },
          name: { type: 'string', description: 'Nama check.' },
          blocking: { type: 'boolean', description: 'Apakah check memblokir promosi (default false).' },
          detailsUrl: { type: 'string', description: 'URL detail check (opsional).' },
        },
        required: ['deployment', 'name'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = deploymentRef(args.deployment);
        const name = requiredString(args.name, 'name', { max: 100 });
        const body = {
          name,
          blocking: args.blocking === true,
          ...(args.detailsUrl ? { detailsUrl: requiredString(args.detailsUrl, 'detailsUrl', { max: 500 }) } : {}),
        };
        return { ok: true, check: pickCheck(await api.post(`/v1/deployments/${encodeURIComponent(id)}/checks`, body)) };
      },
    }),

    defineTool({
      name: 'vercel_update_deployment_check',
      description:
        'Perbarui status/conclusion deployment check Vercel. Memerlukan approval karena dapat membuka atau memblokir promosi.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          deployment: { type: 'string', description: 'ID deployment (dpl_…).' },
          checkId: { type: 'string', description: 'ID check.' },
          status: { type: 'string', description: `Status: ${CHECK_STATUS.join(', ')}.` },
          conclusion: { type: 'string', description: `Conclusion: ${CHECK_CONCLUSIONS.join(', ')} (opsional).` },
          output: { type: 'string', description: 'Ringkasan output (opsional).' },
          detailsUrl: { type: 'string', description: 'URL detail (opsional).' },
          blocking: { type: 'boolean', description: 'Ubah sifat blocking (opsional).' },
        },
        required: ['deployment', 'checkId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const deployment = deploymentRef(args.deployment);
        const checkId = requiredString(args.checkId, 'checkId', { max: 64 });
        const body = {};
        if (args.status !== undefined) {
          const status = String(args.status).toLowerCase();
          if (!CHECK_STATUS.includes(status)) throw new ValidationError(`status harus ${CHECK_STATUS.join(', ')}.`);
          body.status = status;
        }
        if (args.conclusion !== undefined) {
          const conclusion = String(args.conclusion).toLowerCase();
          if (!CHECK_CONCLUSIONS.includes(conclusion)) {
            throw new ValidationError(`conclusion harus ${CHECK_CONCLUSIONS.join(', ')}.`);
          }
          body.conclusion = conclusion;
        }
        if (args.output !== undefined) body.output = String(args.output).slice(0, 4000);
        if (args.detailsUrl !== undefined) body.detailsUrl = String(args.detailsUrl).slice(0, 500);
        if (args.blocking !== undefined) body.blocking = Boolean(args.blocking);
        if (Object.keys(body).length === 0) throw new ValidationError('Tidak ada field check yang diubah.');
        const result = await api.patch(
          `/v1/deployments/${encodeURIComponent(deployment)}/checks/${encodeURIComponent(checkId)}`,
          body,
        );
        return { ok: true, check: pickCheck(result?.check || result) };
      },
    }),

    defineTool({
      name: 'vercel_list_webhooks',
      description: 'Daftar webhook Vercel yang terdaftar pada akun/team (URL, event, project).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Jumlah webhook (1-100, default 20).' } },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const data = await api.get('/v1/webhooks', { limit: limitOf(args, { fallback: 20, max: 100 }) });
        const webhooks = Array.isArray(data?.webhooks) ? data.webhooks : Array.isArray(data) ? data : [];
        return {
          ok: true,
          count: webhooks.length,
          webhooks: webhooks.slice(0, 100).map((hook) => ({
            id: hook?.id || null,
            url: hook?.url || null,
            events: Array.isArray(hook?.events) ? hook.events : [],
            projectIds: Array.isArray(hook?.projectIds) ? hook.projectIds : [],
            createdAt: hook?.createdAt ?? null,
          })),
        };
      },
    }),

    defineTool({
      name: 'vercel_get_billing',
      description:
        'Baca ringkasan tagihan/pemakaian Vercel (read-only). Tidak ada operasi pembayaran atau perubahan billing yang diekspos.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Jumlah entri (1-100, default 20).' } },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const data = await api.get('/v1/billing/charges', { limit: limitOf(args, { fallback: 20, max: 100 }) });
        const charges = Array.isArray(data?.charges) ? data.charges : Array.isArray(data) ? data : [];
        return {
          ok: true,
          readOnly: true,
          count: charges.length,
          charges: charges.slice(0, 100),
          note: 'Billing hanya-baca. Perubahan pembayaran harus dilakukan di dashboard Vercel.',
        };
      },
    }),
  ];
}
