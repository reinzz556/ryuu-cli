import { defineTool } from '../../src/tools/registry.js';
import { limitOf, pickTeam, teamRef } from './tool-helpers.js';

/** Tool akun & team Vercel. */
export function createAccountTools(plugin) {
  return [
    defineTool({
      name: 'vercel_get_user',
      description:
        'Ambil profil akun Vercel yang sedang terhubung (id, username, email, nama, default team). Membutuhkan scope `user`.',
      risk: 'read',
      schema: { type: 'object', properties: {} },
      async handler() {
        const api = await plugin.requireClient();
        const data = await api.get('/v2/user');
        // Vercel membalas `{ user: { … } }`; terima juga objek langsung.
        const user = data?.user && typeof data.user === 'object' ? data.user : data;
        return {
          ok: true,
          user: {
            id: user?.id || null,
            username: user?.username || null,
            email: user?.email || null,
            name: user?.name || null,
            defaultTeamId: user?.defaultTeamId || null,
          },
        };
      },
    }),

    defineTool({
      name: 'vercel_list_teams',
      description:
        'Daftar team Vercel yang dapat diakses akun terhubung (id, slug, nama, role, plan). Gunakan id team untuk operasi yang menyasar team.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Jumlah team (1-100, default 20).' } },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const data = await api.get('/v2/teams', { limit: limitOf(args, { fallback: 20, max: 100 }) });
        const teams = Array.isArray(data?.teams) ? data.teams : Array.isArray(data) ? data : [];
        return { ok: true, count: teams.length, teams: teams.slice(0, 100).map(pickTeam).filter(Boolean) };
      },
    }),

    defineTool({
      name: 'vercel_get_team',
      description: 'Ambil detail satu team Vercel berdasarkan ID (team_…). Membutuhkan scope `team`.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { teamId: { type: 'string', description: 'ID team Vercel, contoh team_xxxx.' } },
        required: ['teamId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = teamRef(args.teamId);
        return { ok: true, team: pickTeam(await api.get(`/v2/teams/${encodeURIComponent(id)}`)) };
      },
    }),

    defineTool({
      name: 'vercel_list_team_members',
      description:
        'Daftar anggota satu team Vercel (uid, username, email, nama, role). Hanya mengembalikan data yang diizinkan token integrasi.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'ID team Vercel (team_…).' },
          limit: { type: 'integer', description: 'Jumlah anggota (1-100, default 50).' },
        },
        required: ['teamId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const id = teamRef(args.teamId);
        const data = await api.get(`/v2/teams/${encodeURIComponent(id)}/members`, {
          limit: limitOf(args, { fallback: 50, max: 100 }),
        });
        const members = Array.isArray(data?.members) ? data.members : Array.isArray(data) ? data : [];
        return {
          ok: true,
          count: members.length,
          members: members.slice(0, 100).map((member) => ({
            uid: member.uid || member.userId || null,
            username: member.username || null,
            email: member.email || null,
            name: member.name || null,
            role: member.role || null,
          })),
        };
      },
    }),
  ];
}
