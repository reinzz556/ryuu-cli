import { ValidationError } from '../../src/utils/errors.js';
import { VercelPluginError } from './errors.js';

/**
 * Pembantu bersama untuk definisi tool Vercel.
 *
 * Selain validasi, fungsi di sini membatasi data yang dikirim ke model: list
 * dipotong, teks panjang diringkas, dan nilai environment variable TIDAK
 * PERNAH diteruskan.
 */

export const TEAM_RE = /^team_[A-Za-z0-9]{6,40}$/;
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const DEPLOYMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,120}$/;
export const DOMAIN_RE = /^(?=.{3,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
export const EDGE_RE = /^ecfg_[A-Za-z0-9]{6,64}$/;
export const ENV_TARGETS = ['production', 'preview', 'development'];
export const DNS_TYPES = ['A', 'AAAA', 'ALIAS', 'CAA', 'CNAME', 'MX', 'NS', 'SRV', 'TXT'];

export function requiredString(value, field, { max = 200 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) throw new ValidationError(`${field} wajib diisi.`);
  if (text.length > max) throw new ValidationError(`${field} terlalu panjang (maksimum ${max} karakter).`);
  return text;
}

export function projectRef(value, field = 'project') {
  const text = requiredString(value, field, { max: 100 });
  if (!PROJECT_RE.test(text) || text === '.' || text === '..') {
    throw new ValidationError(`${field} tidak valid: gunakan nama atau ID project Vercel tanpa spasi/garis miring.`);
  }
  return text;
}

export function deploymentRef(value, field = 'deployment') {
  const text = requiredString(value, field, { max: 120 });
  if (!DEPLOYMENT_RE.test(text) || text.includes('..')) {
    throw new ValidationError(`${field} tidak valid: gunakan ID deployment Vercel (dpl_…).`);
  }
  return text;
}

export function domainName(value, field = 'domain') {
  const text = requiredString(value, field, { max: 253 }).toLowerCase();
  if (!DOMAIN_RE.test(text) || text.includes('..')) {
    throw new ValidationError(`${field} tidak valid: gunakan nama domain seperti example.com.`);
  }
  return text;
}

export function teamRef(value, field = 'teamId') {
  const text = requiredString(value, field, { max: 60 });
  if (!TEAM_RE.test(text)) throw new ValidationError(`${field} tidak valid: gunakan ID Vercel berformat team_xxx.`);
  return text;
}

export function edgeConfigRef(value, field = 'edgeConfigId') {
  const text = requiredString(value, field, { max: 64 });
  if (!EDGE_RE.test(text)) throw new ValidationError(`${field} tidak valid: gunakan ID berformat ecfg_xxx.`);
  return text;
}

export function envTargets(value) {
  if (value === undefined || value === null) return ['production', 'preview', 'development'];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const targets = list.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const invalid = targets.filter((target) => !ENV_TARGETS.includes(target));
  if (invalid.length) {
    throw new ValidationError(`target environment tidak valid: ${invalid.join(', ')} (pilihan: ${ENV_TARGETS.join(', ')}).`);
  }
  if (!targets.length) throw new ValidationError('target environment tidak boleh kosong.');
  return targets;
}

export function dnsType(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (!DNS_TYPES.includes(text)) {
    throw new ValidationError(`tipe DNS tidak valid: gunakan ${DNS_TYPES.join(', ')}.`);
  }
  return text;
}

export function limitOf(args = {}, { fallback = 20, max = 100 } = {}) {
  const value = Number(args.limit);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(max, value);
}

export function text(value, max = 500) {
  const raw = value === null || value === undefined ? '' : String(value);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** Batasi item yang dikirim ke model. */
export function limitItems(items, max = 50) {
  return (Array.isArray(items) ? items : []).slice(0, max);
}

export function pickProject(project) {
  if (!project || typeof project !== 'object') return null;
  return {
    id: project.id || null,
    name: project.name || null,
    framework: project.framework || null,
    nodeVersion: project.nodeVersion || null,
    createdAt: project.createdAt ?? null,
    updatedAt: project.updatedAt ?? null,
    latestDeployments: limitItems(
      (project.latestDeployments || []).map((deployment) => ({
        id: deployment?.id || null,
        url: deployment?.url || null,
        readyState: deployment?.readyState || null,
        target: deployment?.target || null,
        createdAt: deployment?.createdAt ?? null,
      })),
      5,
    ),
    domains: limitItems(
      (project.domains || []).map((domain) => ({
        name: domain?.name || null,
        verified: Boolean(domain?.verified),
      })),
      20,
    ),
  };
}

export function pickDeployment(deployment) {
  if (!deployment || typeof deployment !== 'object') return null;
  return {
    id: deployment.id || deployment.uid || null,
    name: deployment.name || null,
    url: deployment.url || null,
    projectId: deployment.projectId || null,
    target: deployment.target || null,
    readyState: deployment.readyState || deployment.state || null,
    source: deployment.source || null,
    createdAt: deployment.createdAt ?? null,
    buildingAt: deployment.buildingAt ?? null,
    ready: deployment.ready ?? null,
    creator: deployment.creator?.username || null,
    meta: deployment.meta
      ? {
          githubCommitRef: deployment.meta.githubCommitRef || null,
          githubCommitSha: deployment.meta.githubCommitSha || null,
          githubCommitMessage: text(deployment.meta.githubCommitMessage, 300) || null,
        }
      : null,
    alias: limitItems(deployment.alias, 10),
  };
}

export function pickTeam(team) {
  if (!team || typeof team !== 'object') return null;
  return {
    id: team.id || null,
    slug: team.slug || null,
    name: team.name || null,
    role: team.role || null,
    plan: team.plan || null,
  };
}

/** Metadata environment variable TANPA nilai. */
export function pickEnv(env) {
  if (!env || typeof env !== 'object') return null;
  return {
    id: env.id || null,
    key: env.key || null,
    type: env.type || null,
    target: Array.isArray(env.target) ? env.target : [],
    gitBranch: env.gitBranch || null,
    createdAt: env.createdAt ?? null,
    updatedAt: env.updatedAt ?? null,
  };
}

export function pickDomain(domain) {
  if (!domain || typeof domain !== 'object') return null;
  return {
    name: domain.name || null,
    apexName: domain.apexName || null,
    projectId: domain.projectId || null,
    verified: Boolean(domain.verified),
    verification: domain.verification || null,
    redirect: domain.redirect || null,
    updatedAt: domain.updatedAt ?? null,
  };
}

export function pickDnsRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    id: record.id || null,
    name: record.name || null,
    type: record.type || null,
    value: record.value || null,
    ttl: record.ttl ?? null,
    mxPriority: record.mxPriority ?? null,
    priority: record.priority ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}

export function pickEdgeConfig(config) {
  if (!config || typeof config !== 'object') return null;
  return {
    id: config.id || null,
    slug: config.slug || null,
    createdAt: config.createdAt ?? null,
    updatedAt: config.updatedAt ?? null,
  };
}

export function pickCheck(check) {
  if (!check || typeof check !== 'object') return null;
  return {
    id: check.id || null,
    deploymentId: check.deploymentId || null,
    name: check.name || null,
    status: check.status || null,
    conclusion: check.conclusion || null,
    blocking: Boolean(check.blocking),
    detailsUrl: check.detailsUrl || null,
    output: check.output || null,
    updatedAt: check.updatedAt ?? null,
  };
}

/** Operasi destruktif bisa dimatikan lewat `/vercel config set confirmDestructive false`. */
export async function assertDestructiveAllowed(plugin, action) {
  const settings = await plugin.loadConfig();
  if (!settings.confirmDestructive) {
    throw new VercelPluginError(
      `${action} diblokir karena confirmDestructive=false. Aktifkan lagi dengan /vercel config set confirmDestructive true.`,
      { code: 'VERCEL_DESTRUCTIVE_BLOCKED' },
    );
  }
}
