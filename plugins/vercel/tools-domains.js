import { defineTool } from '../../src/tools/registry.js';
import { ValidationError } from '../../src/utils/errors.js';
import {
  assertDestructiveAllowed,
  DNS_TYPES,
  dnsType,
  domainName,
  limitOf,
  pickDnsRecord,
  pickDomain,
  projectRef,
  requiredString,
} from './tool-helpers.js';

/** Tool domain & DNS Vercel. */
export function createDomainTools(plugin) {
  return [
    defineTool({
      name: 'vercel_list_domains',
      description: 'Daftar domain yang terdaftar pada akun/team Vercel beserta status verifikasi dan project terkait.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Jumlah domain (1-100, default 20).' } },
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const data = await api.get('/v5/domains', { limit: limitOf(args, { fallback: 20, max: 100 }) });
        const domains = Array.isArray(data?.domains) ? data.domains : Array.isArray(data) ? data : [];
        return { ok: true, count: domains.length, domains: domains.map(pickDomain).filter(Boolean) };
      },
    }),

    defineTool({
      name: 'vercel_get_domain',
      description: 'Ambil detail satu domain Vercel (verifikasi, redirect, project terkait).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { domain: { type: 'string', description: 'Nama domain, contoh example.com.' } },
        required: ['domain'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const domain = domainName(args.domain);
        return { ok: true, domain: pickDomain(await api.get(`/v6/domains/${encodeURIComponent(domain)}`)) };
      },
    }),

    defineTool({
      name: 'vercel_add_domain',
      description:
        'Hubungkan domain ke project Vercel. Memerlukan approval bila mengubah konfigurasi DNS produksi; periksa record DNS yang diminta setelah pemanggilan.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          domain: { type: 'string', description: 'Nama domain yang ditambahkan.' },
          gitBranch: { type: 'string', description: 'Batasi domain ke branch (opsional).' },
          redirect: { type: 'string', description: 'Domain tujuan redirect (opsional).' },
          redirectStatusCode: { type: 'integer', description: '301, 302, 307, atau 308 (opsional).' },
        },
        required: ['project', 'domain'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const domain = domainName(args.domain);
        const code = args.redirectStatusCode ? Number(args.redirectStatusCode) : null;
        if (code && ![301, 302, 307, 308].includes(code)) {
          throw new ValidationError('redirectStatusCode harus 301, 302, 307, atau 308.');
        }
        const result = await api.post(`/v10/projects/${encodeURIComponent(project)}/domains`, {
          name: domain,
          ...(args.gitBranch ? { gitBranch: String(args.gitBranch).slice(0, 200) } : {}),
          ...(args.redirect ? { redirect: String(args.redirect).slice(0, 253) } : {}),
          ...(code ? { redirectStatusCode: code } : {}),
        });
        return { ok: true, project, domain: pickDomain(result?.domain || result), result: result || null };
      },
    }),

    defineTool({
      name: 'vercel_remove_domain',
      description:
        'Lepaskan domain dari project Vercel. Tindakan permanen dan memerlukan approval; situs pada domain tersebut berhenti dilayani project ini.',
      risk: 'destructive',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          domain: { type: 'string', description: 'Nama domain.' },
        },
        required: ['project', 'domain'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        await assertDestructiveAllowed(plugin, 'Penghapusan domain');
        const project = projectRef(args.project);
        const domain = domainName(args.domain);
        return {
          ok: true,
          project,
          removed: domain,
          result:
            (await api.delete(`/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`)) ||
            null,
        };
      },
    }),

    defineTool({
      name: 'vercel_verify_domain',
      description:
        'Minta Vercel memverifikasi domain project. Mengembalikan status verifikasi terbaru; tidak menghapus atau mengubah DNS secara otomatis.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Nama atau ID project.' },
          domain: { type: 'string', description: 'Nama domain.' },
        },
        required: ['project', 'domain'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const project = projectRef(args.project);
        const domain = domainName(args.domain);
        const result = await api.post(
          `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}/verify`,
        );
        return { ok: true, project, domain, verification: result || null };
      },
    }),

    defineTool({
      name: 'vercel_list_dns_records',
      description: 'Daftar DNS record satu domain Vercel (id, nama, tipe, nilai, TTL).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Nama domain.' },
          limit: { type: 'integer', description: 'Jumlah record (1-200, default 50).' },
        },
        required: ['domain'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const name = domainName(args.domain);
        const data = await api.get(`/v4/domains/${encodeURIComponent(name)}/records`, {
          limit: limitOf(args, { fallback: 50, max: 200 }),
        });
        const records = Array.isArray(data?.records) ? data.records : Array.isArray(data) ? data : [];
        return { ok: true, domain: name, count: records.length, records: records.map(pickDnsRecord).filter(Boolean) };
      },
    }),

    defineTool({
      name: 'vercel_create_dns_record',
      description:
        'Buat DNS record pada domain Vercel. Memerlukan approval karena mengubah DNS; verifikasi nilai sebelum memanggil.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Nama domain.' },
          name: { type: 'string', description: 'Nama record (contoh: www atau @).' },
          type: { type: 'string', description: `Tipe record: ${DNS_TYPES.join(', ')}.` },
          value: { type: 'string', description: 'Nilai record.' },
          ttl: { type: 'integer', description: 'TTL detik (60-86400, opsional).' },
          mxPriority: { type: 'integer', description: 'Prioritas MX (opsional).' },
        },
        required: ['domain', 'name', 'type', 'value'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const domain = domainName(args.domain);
        const name = requiredString(args.name, 'name', { max: 253 });
        if (name.includes('..') || /[\s/]/.test(name)) throw new ValidationError('name DNS record tidak valid.');
        const type = dnsType(args.type);
        const value = requiredString(args.value, 'value', { max: 2048 });
        const result = await api.post(`/v2/domains/${encodeURIComponent(domain)}/records`, {
          name,
          type,
          value,
          ...(args.ttl !== undefined ? { ttl: Math.min(86400, Math.max(60, Number(args.ttl) || 60)) } : {}),
          ...(args.mxPriority !== undefined ? { mxPriority: Number(args.mxPriority) } : {}),
        });
        return { ok: true, domain, record: pickDnsRecord(result?.record || result) };
      },
    }),

    defineTool({
      name: 'vercel_update_dns_record',
      description: 'Perbarui DNS record Vercel berdasarkan ID record. Memerlukan approval.',
      risk: 'write',
      schema: {
        type: 'object',
        properties: {
          recordId: { type: 'string', description: 'ID record (dari vercel_list_dns_records).' },
          name: { type: 'string', description: 'Nama baru (opsional).' },
          type: { type: 'string', description: 'Tipe baru (opsional).' },
          value: { type: 'string', description: 'Nilai baru (opsional).' },
          ttl: { type: 'integer', description: 'TTL baru (opsional).' },
          mxPriority: { type: 'integer', description: 'Prioritas MX baru (opsional).' },
        },
        required: ['recordId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        const recordId = requiredString(args.recordId, 'recordId', { max: 64 });
        const body = {};
        if (args.name !== undefined) body.name = requiredString(args.name, 'name', { max: 253 });
        if (args.type !== undefined) body.type = dnsType(args.type);
        if (args.value !== undefined) body.value = requiredString(args.value, 'value', { max: 2048 });
        if (args.ttl !== undefined) body.ttl = Math.min(86400, Math.max(60, Number(args.ttl) || 60));
        if (args.mxPriority !== undefined) body.mxPriority = Number(args.mxPriority);
        if (Object.keys(body).length === 0) throw new ValidationError('Tidak ada field DNS yang diubah.');
        const result = await api.patch(`/v1/domains/records/${encodeURIComponent(recordId)}`, body);
        return { ok: true, recordId, record: pickDnsRecord(result?.record || result) };
      },
    }),

    defineTool({
      name: 'vercel_delete_dns_record',
      description:
        'Hapus DNS record Vercel. Tindakan permanen dan memerlukan approval; record yang salah dapat memutus domain.',
      risk: 'destructive',
      schema: {
        type: 'object',
        properties: { recordId: { type: 'string', description: 'ID record yang dihapus.' } },
        required: ['recordId'],
      },
      async handler(args) {
        const api = await plugin.requireClient();
        await assertDestructiveAllowed(plugin, 'Penghapusan DNS record');
        const recordId = requiredString(args.recordId, 'recordId', { max: 64 });
        return {
          ok: true,
          recordId,
          deleted: true,
          result: (await api.delete(`/v1/domains/records/${encodeURIComponent(recordId)}`)) || null,
        };
      },
    }),
  ];
}
