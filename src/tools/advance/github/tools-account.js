import { defineTool } from '../../../../src/tools/registry.js';
import { pickUser } from './tool-helpers.js';

export function createAccountTools(plugin) {
  return [
    defineTool({
      name: 'github_get_me',
      description:
        'Ambil profil akun GitHub yang sedang terhubung (login, nama, tipe akun, jumlah repository publik, tautan profil). Memerlukan user access token dengan scope read:user.',
      risk: 'read',
      schema: { type: 'object', properties: {} },
      async handler() {
        const api = await plugin.requireClient();
        const user = await api.get('/user');
        return { ok: true, account: pickUser(user) };
      },
    }),

    defineTool({
      name: 'github_get_user',
      description:
        'Ambil profil publik pengguna atau organisasi GitHub lain berdasarkan username. Tidak mengembalikan data privat pemilik akun.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Username GitHub, contoh: torvalds atau github.' },
        },
        required: ['username'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const username = String(args.username || '').trim();
        if (!/^[A-Za-z0-9-]{1,39}$/.test(username)) {
          throw new Error('username GitHub tidak valid.');
        }
        const user = await api.get(`/users/${encodeURIComponent(username)}`);
        return { ok: true, user: pickUser(user) };
      },
    }),

    defineTool({
      name: 'github_get_rate_limit',
      description:
        'Periksa sisa kuota GitHub REST API untuk token yang terhubung (core, search, graphql) beserta waktu reset. Gunakan sebelum operasi massal.',
      risk: 'read',
      schema: { type: 'object', properties: {} },
      async handler() {
        const api = await plugin.requireClient();
        const rate = await api.rateLimit();
        const resources = rate?.resources || {};
        return {
          ok: true,
          rate_limit: {
            core: resources.core || null,
            search: resources.search || null,
            graphql: resources.graphql || null,
          },
          documentation: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
        };
      },
    }),
  ];
}
