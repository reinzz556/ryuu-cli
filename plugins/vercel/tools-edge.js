import { defineTool } from '../../src/tools/registry.js';
import { ValidationError } from '../../src/utils/errors.js';
import { assertDestructiveAllowed, edgeConfigRef, limitOf, pickEdgeConfig, requiredString } from './tool-helpers.js';

const OPERATIONS = ['create', 'update', 'upsert', 'delete'];

/** Tool Edge Config Vercel. */
export function createEdgeTools(plugin) {
  return [
    defineTool({
      name: 'vercel_list_edge_configs',
      description: 'Daftar Edge Config pada akun/team Vercel (id, slug, waktu dibuat/diubah).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Jumlah Edge Config (1-100, default 20).' } },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const data = await api.get('/v1/edge-config', { limit: limitOf(args, { fallback: 20, max: 100 }) });
        const configs = Array.isArray(data?.edgeConfigs)
          ? data.edgeConfigs
          : Array.isArray(data?.configs)
            ? data.configs
            : Array.isArray(data)
              ? data
              : [];
        return { ok: true, count: configs.length, edgeConfigs: configs.map(pickEdgeConfig).filter(Boolean) };
      },
    }),

    defineTool({
      name: 'vercel_get_edge_config',
      description: 'Ambil detail satu Edge Config Vercel berdasarkan ID (ecfg_…).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { edgeConfigId: { type: 'string', description: 'ID Edge Config (ecfg_…).' } },
        required: ['edgeConfigId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = edgeConfigRef(args.edgeConfigId);
        return { ok: true, edgeConfig: pickEdgeConfig(await api.get(`/v1/edge-config/${encodeURIComponent(id)}`)) };
      },
    }),

    defineTool({
      name: 'vercel_create_edge_config',
      description: 'Buat Edge Config baru dengan slug unik. Mengembalikan ID untuk operasi selanjutnya.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'Slug Edge Config (huruf kecil, angka, tanda hubung).' } },
        required: ['slug'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const slug = requiredString(args.slug, 'slug', { max: 64 });
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
          throw new ValidationError('slug Edge Config harus huruf kecil, angka, atau tanda hubung.');
        }
        return { ok: true, edgeConfig: pickEdgeConfig(await api.post('/v1/edge-config', { slug })) };
      },
    }),

    defineTool({
      name: 'vercel_update_edge_config',
      description:
        'Ubah slug Edge Config Vercel. Endpoint PATCH /v1/edge-config/{id} tidak tercantum pada REST reference publik; error Vercel diteruskan apa adanya bila tidak didukung.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          edgeConfigId: { type: 'string', description: 'ID Edge Config (ecfg_…).' },
          slug: { type: 'string', description: 'Slug baru.' },
        },
        required: ['edgeConfigId', 'slug'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = edgeConfigRef(args.edgeConfigId);
        const slug = requiredString(args.slug, 'slug', { max: 64 });
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new ValidationError('slug Edge Config tidak valid.');
        const result = await api.patch(`/v1/edge-config/${encodeURIComponent(id)}`, { slug });
        return { ok: true, edgeConfig: pickEdgeConfig(result?.edgeConfig || result) };
      },
    }),

    defineTool({
      name: 'vercel_delete_edge_config',
      description: 'Hapus Edge Config Vercel. Tindakan permanen dan memerlukan approval.',
      risk: 'destructive',
      schema: {
        type: 'object',
        properties: { edgeConfigId: { type: 'string', description: 'ID Edge Config (ecfg_…).' } },
        required: ['edgeConfigId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        await assertDestructiveAllowed(plugin, 'Penghapusan Edge Config');
        const id = edgeConfigRef(args.edgeConfigId);
        return {
          ok: true,
          edgeConfigId: id,
          deleted: true,
          result: (await api.delete(`/v1/edge-config/${encodeURIComponent(id)}`)) || null,
        };
      },
    }),

    defineTool({
      name: 'vercel_get_edge_config_items',
      description: 'Baca seluruh item (key/value) satu Edge Config Vercel.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { edgeConfigId: { type: 'string', description: 'ID Edge Config (ecfg_…).' } },
        required: ['edgeConfigId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = edgeConfigRef(args.edgeConfigId);
        const data = await api.get(`/v1/edge-config/${encodeURIComponent(id)}/items`);
        const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
        return { ok: true, edgeConfigId: id, count: items.length, items: items.slice(0, 200) };
      },
    }),

    defineTool({
      name: 'vercel_update_edge_config_items',
      description:
        'Terapkan perubahan item Edge Config dalam satu batch (create/update/upsert/delete). Memerlukan approval karena memengaruhi pembacaan Edge Config di runtime.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          edgeConfigId: { type: 'string', description: 'ID Edge Config (ecfg_…).' },
          items: {
            type: 'array',
            description: 'Daftar perubahan: [{ operation, key, value? }].',
            items: {
              type: 'object',
              properties: {
                operation: { type: 'string' },
                key: { type: 'string' },
                value: {},
              },
            },
          },
        },
        required: ['edgeConfigId', 'items'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = edgeConfigRef(args.edgeConfigId);
        if (!Array.isArray(args.items) || args.items.length === 0) {
          throw new ValidationError('items wajib berisi minimal satu perubahan.');
        }
        if (args.items.length > 100) throw new ValidationError('Maksimum 100 item per batch.');
        const items = args.items.map((entry) => {
          const operation = String(entry?.operation || 'upsert').toLowerCase();
          const key = requiredString(entry?.key, 'items[].key', { max: 200 });
          if (!OPERATIONS.includes(operation)) {
            throw new ValidationError(`operation tidak valid: ${operation} (pilihan: ${OPERATIONS.join(', ')}).`);
          }
          if (operation !== 'delete' && entry?.value === undefined) {
            throw new ValidationError(`value wajib untuk operation ${operation} pada key ${key}.`);
          }
          return { operation, key, ...(operation === 'delete' ? {} : { value: entry.value }) };
        });
        const result = await api.patch(`/v1/edge-config/${encodeURIComponent(id)}/items`, { items });
        return { ok: true, edgeConfigId: id, applied: items.length, result: result || null };
      },
    }),
  ];
}
