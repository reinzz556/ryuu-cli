import fsp from 'node:fs/promises';
import path from 'node:path';

import { syncPluginTools, unregisterPluginTools } from '../index.js';
import { openBrowser } from './auth.js';
import { exampleVercelConfig } from './config.js';
import { VERCEL_CODES } from './errors.js';
import { deploymentRef, domainName, envTargets, projectRef, requiredString, teamRef } from './tool-helpers.js';

/**
 * Handler `/vercel`.
 *
 * Command memakai parser Ryuu yang sudah ada (`define` di cli/commands.js);
 * modul ini hanya memformat keluaran dan memanggil manager/API. Tidak ada
 * token atau secret yang pernah dicetak.
 */

const USAGE = [
  'Vercel Integration',
  '',
  'Autentikasi:',
  '  /vercel login [--no-browser]   hubungkan akun lewat OAuth Vercel',
  '  /vercel logout                 putuskan akun Vercel',
  '  /vercel status',
  '',
  'Akun & team:',
  '  /vercel account',
  '  /vercel teams [--limit n]',
  '  /vercel team <team_id>',
  '',
  'Project:',
  '  /vercel projects [--search nama] [--limit n]',
  '  /vercel project <nama>',
  '  /vercel project create <nama> [--framework nextjs] [--git owner/repo] [--type github]',
  '  /vercel project delete <id> [--yes]',
  '',
  'Deployment:',
  '  /vercel deployments [project] [--target production] [--limit n]',
  '  /vercel deployment <id>',
  '  /vercel deploy <project> --git owner/repo --ref main [--target production]',
  '  /vercel deploy <project> --file ./index.html [--file ./app.js]',
  '  /vercel cancel <id> | /vercel promote <id> [--project p] | /vercel rollback <id> [--project p]',
  '',
  'Environment variable:',
  '  /vercel env list <project>',
  '  /vercel env add <project> <KEY> <value> [--target production,preview]',
  '  /vercel env update <project> <env_id> [--value baru] [--target production]',
  '  /vercel env remove <project> <env_id|KEY> [--yes]',
  '',
  'Domain & DNS:',
  '  /vercel domains',
  '  /vercel domain add <project> <domain> | remove <project> <domain> | verify <project> <domain>',
  '  /vercel dns list <domain>',
  '  /vercel dns add <domain> <TYPE> <name> <value> [--ttl 3600]',
  '  /vercel dns update <record_id> [--value v] [--ttl n]',
  '  /vercel dns remove <record_id> [--yes]',
  '',
  'Edge Config:',
  '  /vercel edge list | get <id> | create <slug> | update <id> <slug> | delete <id>',
  '  /vercel edge items <id>',
  '  /vercel edge set <id> <key> <value>',
  '',
  'Monitoring:',
  '  /vercel logs <deployment_id> [--problems] [--limit n]',
  '  /vercel events <deployment_id>',
  '  /vercel checks <deployment_id>',
  '',
  'Integrasi:',
  '  /vercel configure [--open]     halaman Configure resmi (configurationId)',
  '  /vercel test                   diagnostik read-only',
  '  /vercel enable | disable',
  '  /vercel config [show] | config set <key> <value>',
].join('\n');

function tokenize(args) {
  const out = [];
  let current = '';
  let quote = null;
  for (const char of String(args ?? '')) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** Parse posisional + flag (`--flag value`, `--flag=value`, `--file` berulang). */
function parseArgs(parts) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith('--')) {
      positional.push(part);
      continue;
    }
    const eq = part.indexOf('=');
    const key = (eq >= 0 ? part.slice(2, eq) : part.slice(2)).toLowerCase();
    if (!key) continue;
    let value = eq >= 0 ? part.slice(eq + 1) : undefined;
    if (value === undefined) {
      const next = parts[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    if (key === 'file') {
      flags.file = Array.isArray(flags.file) ? [...flags.file, value] : [value];
    } else {
      flags[key] = value;
    }
  }
  return { positional, flags };
}

const stamp = (value) => {
  if (!value) return '(tidak tersedia)';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').slice(0, 19);
};

function boolFlag(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function numericFlag(value, fallback, max = 100) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function pickTarget(flags) {
  const target = flags.target ? String(flags.target).toLowerCase() : 'preview';
  if (!['production', 'staging', 'preview'].includes(target)) {
    throw new Error('--target harus production, staging, atau preview.');
  }
  return target;
}

const projectArg = (value, fallback) => projectRef(value || fallback || '', 'project');

/** Blok yang dicetak saat file konfigurasi baru dibuat otomatis. */
export function formatConfigCreated({ path: file, config }) {
  return [
    'KONFIGURASI VERCEL DIBUAT OTOMATIS',
    `  File           : ${file}`,
    `  enabled        : ${config?.enabled ? 'true' : 'false'}`,
    `  defaultProject : ${config?.defaultProject || '(belum diatur)'}`,
    `  backend        : ${config?.backend || '(default)'}`,
    '  Client Secret dan token Vercel tidak disimpan di CLI.',
    '',
    'Ubah dengan: /vercel config set <key> <value>',
  ].join('\n');
}

/** Blok diagnostik saat file konfigurasi ada tetapi tidak valid. */
export function formatConfigFailure({ path: file, error }) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  const reason = details.reason || error?.message || 'penyebab tidak diketahui';
  const example = JSON.stringify(exampleVercelConfig(), null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return [
    'KONFIGURASI VERCEL TIDAK VALID',
    `  File     : ${file || details.path || '(tidak diketahui)'}`,
    `  Masalah  : ${reason}`,
    '  Perintah ini tidak dijalankan agar tidak memakai pengaturan yang salah.',
    '',
    'Cara memperbaiki:',
    '  1. Edit file di atas agar berisi objek JSON yang valid, atau',
    '  2. Hapus file tersebut — Ryuu akan membuat ulang otomatis pada /vercel berikutnya.',
    '',
    'Contoh isi yang valid:',
    example,
  ].join('\n');
}

export function createVercelCommand({ plugin, registry, confirm = null, openBrowser: shouldOpen = true, showCode = null }) {
  return async function vercelCommand(args, print) {
    const parts = tokenize(args);
    const sub = (parts[0] || '').toLowerCase();
    const { positional, flags } = parseArgs(parts.slice(1));
    // URL dicetak sebagai blok berbingkai dengan tombol `⧉ copy` (sama seperti
    // /github login); tanpa renderer interaktif, teksnya dicetak apa adanya.
    const emitCode = typeof showCode === 'function' ? showCode : (block) => print(`\n${block.text}\n`);

    // Preflight: konfigurasi dibuat otomatis bila belum ada, dan masalahnya
    // ditampilkan langsung di terminal sebelum subcommand apa pun berjalan.
    const configPath = plugin.pathsInfo?.configFile;
    const diagnostic =
      typeof plugin.configDiagnostic === 'function'
        ? await plugin.configDiagnostic().catch((error) => ({ ok: false, path: configPath, error }))
        : await Promise.resolve()
            .then(() => plugin.loadConfig())
            .then((config) => ({ ok: true, path: configPath, config }))
            .catch((error) => ({ ok: false, path: configPath, error }));
    if (!diagnostic.ok) {
      print(formatConfigFailure(diagnostic));
      return;
    }
    if (diagnostic.created) print(formatConfigCreated(diagnostic));
    const defaultProject = diagnostic.config?.defaultProject || null;

    if (!sub || sub === 'help' || sub === '?') {
      print(USAGE);
      return;
    }

    try {
      if (sub === 'login') {
        await plugin.login({
          print,
          showCode,
          openBrowser: shouldOpen && !boolFlag(flags['no-browser']),
          confirmReplace: confirm ? (question) => confirm(question) : null,
        });
        if (await plugin.isEnabled()) await syncPluginTools(plugin, registry);
        return;
      }

      if (sub === 'logout') {
        const info = await plugin.authInfo().catch(() => ({ connected: false }));
        if (!info.connected) {
          print('Belum ada akun Vercel yang terhubung. Tidak ada yang perlu diputus.');
          return;
        }
        if (confirm && !(await confirm('Putuskan koneksi Vercel dan hapus kredensial lokal? [y/N] '))) {
          print('Logout dibatalkan. Kredensial tidak diubah.');
          return;
        }
        unregisterPluginTools(plugin, registry);
        await plugin.logout({ print });
        return;
      }

      if (sub === 'enable') {
        const result = await plugin.enable();
        const count = await syncPluginTools(plugin, registry);
        print(`Integrasi Vercel diaktifkan. ${count} tool terdaftar untuk AI Agent.`);
        print(`  ${result.tools.join(', ')}`);
        print('Operasi destruktif tetap meminta approval Ryuu.');
        return;
      }

      if (sub === 'disable') {
        const removed = unregisterPluginTools(plugin, registry);
        await plugin.disable();
        print(
          `Integrasi Vercel dinonaktifkan (${removed} tool dilepas dari AI Agent). ` +
            'Akun dan token di backend tetap tersimpan.',
        );
        return;
      }

      if (sub === 'status') {
        print(await formatStatus(plugin, registry));
        return;
      }

      if (sub === 'config') {
        const action = (positional[0] || 'show').toLowerCase();
        if (action === 'show') {
          const view = await plugin.configView();
          const width = Math.max(...Object.keys(view.lines).map((key) => key.length));
          print(
            [
              'KONFIGURASI VERCEL (NON-RAHASIA)',
              ...Object.entries(view.lines).map(([key, value]) => `  ${key.padEnd(width)}  ${value}`),
              '',
              `  Lokasi config   : ${plugin.pathsInfo.configFile}`,
              `  Lokasi kredensial: ${plugin.pathsInfo.credentialFile}`,
              '',
              'Ubah dengan: /vercel config set <key> <value>',
              'Key: enabled, autoRefresh, confirmDestructive, defaultTeam, defaultProject',
            ].join('\n'),
          );
          return;
        }
        if (action === 'set') {
          if (positional.length < 3) {
            print('Usage: /vercel config set <key> <value>');
            return;
          }
          const key = positional[1];
          const value = positional.slice(2).join(' ');
          const parsed = await plugin.setConfig(key, value);
          print(`Konfigurasi diperbarui: ${key} = ${parsed === null ? '(kosong)' : String(parsed)}`);
          if (key === 'enabled') {
            if (parsed === true) {
              const count = await syncPluginTools(plugin, registry);
              print(`${count} tool Vercel ${count > 0 ? 'terdaftar' : 'belum dapat didaftarkan (pastikan sudah login)'}.`);
            } else {
              print(`${unregisterPluginTools(plugin, registry)} tool Vercel dilepas dari AI Agent.`);
            }
          }
          return;
        }
        print('Usage: /vercel config [show] | /vercel config set <key> <value>');
        return;
      }

      if (sub === 'test') {
        print('Menjalankan pemeriksaan Vercel (read-only)…');
        const result = await plugin.test();
        print(
          [
            'DIAGNOSTIK VERCEL',
            ...(result.report || []).map(
              (row) => `  ${row.ok ? '[✓]' : '[!]'} ${String(row.label).padEnd(26)} ${row.detail || ''}`,
            ),
            '',
            result.ok ? 'Semua pemeriksaan berhasil.' : 'Ada pemeriksaan yang gagal.',
            'Tidak ada resource Vercel yang dibuat, diubah, atau dihapus oleh test ini.',
          ].join('\n'),
        );
        return;
      }

      if (sub === 'configure') {
        const url = await plugin.configureUrl();
        print('Halaman konfigurasi integrasi:');
        emitCode({ label: 'konfigurasi url', text: url });
        if (boolFlag(flags.open)) {
          print(shouldOpen && openBrowser(url) ? 'Halaman dibuka di browser.' : 'Buka URL di atas secara manual.');
        }
        return;
      }

      // Semua subcommand berikut membutuhkan koneksi aktif.
      const api = await plugin.requireClient();
      const config = await plugin.loadConfig();

      if (sub === 'account') {
        const account = await plugin.account();
        print(
          [
            'AKUN VERCEL',
            `  Username      : ${account.username ? `@${account.username}` : '(tidak tersedia)'}`,
            `  Nama          : ${account.name || '(tidak tersedia)'}`,
            `  Email         : ${account.email || '(tidak tersedia)'}`,
            `  Configuration : ${account.configuration?.id || '(akun tanpa configuration)'}`,
            `  Team          : ${account.configuration?.teamId || '(tidak tersedia)'}`,
            `  Status        : ${account.connected ? 'terhubung' : 'perlu login ulang'}`,
            `  Integrasi     : ${(await plugin.isEnabled()) ? 'aktif' : 'nonaktif'}`,
            account.remoteError ? `  Catatan       : backend account gagal — ${account.remoteError}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      if (sub === 'teams') {
        const data = await api.get('/v2/teams', { limit: numericFlag(flags.limit, 20) });
        const teams = Array.isArray(data?.teams) ? data.teams : Array.isArray(data) ? data : [];
        if (!teams.length) {
          print('Tidak ada team Vercel yang terlihat untuk akun ini.');
          return;
        }
        print(
          ['TEAM VERCEL', ...teams.map((team) => `  ${String(team.slug || team.id).padEnd(24)} ${team.name || ''} · ${team.role || '?'} · ${team.id}`)].join('\n'),
        );
        return;
      }

      if (sub === 'team') {
        const id = teamRef(positional[0]);
        const team = await api.get(`/v2/teams/${encodeURIComponent(id)}`);
        print(
          [
            'DETAIL TEAM',
            `  ID     : ${team.id}`,
            `  Slug   : ${team.slug || '(tidak tersedia)'}`,
            `  Nama   : ${team.name || '(tidak tersedia)'}`,
            `  Plan   : ${team.plan || '(tidak tersedia)'}`,
            `  Dibuat : ${stamp(team.createdAt)}`,
          ].join('\n'),
        );
        return;
      }

      if (sub === 'projects') {
        const data = await api.get('/v9/projects', {
          limit: numericFlag(flags.limit, 20),
          ...(flags.search ? { search: String(flags.search).slice(0, 100) } : {}),
        });
        const projects = Array.isArray(data?.projects) ? data.projects : Array.isArray(data) ? data : [];
        if (!projects.length) {
          print('Tidak ada project Vercel yang terlihat.');
          return;
        }
        print(
          [
            'PROJECT VERCEL',
            ...projects.map((project) => {
              const latest = project.latestDeployments?.[0];
              return `  ${String(project.name).padEnd(28)} ${String(project.framework || '-').padEnd(12)} ${latest ? `${latest.readyState || '?'} · ${latest.url || latest.id}` : '(belum ada deployment)'}`;
            }),
          ].join('\n'),
        );
        return;
      }

      if (sub === 'project') {
        const action = (positional[0] || '').toLowerCase();
        if (action === 'create') {
          const name = requiredString(positional[1], 'nama project', { max: 100 });
          const body = { name };
          if (flags.framework) body.framework = String(flags.framework);
          if (flags.root) body.rootDirectory = String(flags.root);
          if (flags.git) {
            const [repo] = String(flags.git).includes('/') ? [String(flags.git)] : [null];
            if (!repo) throw new Error('--git harus berformat owner/repo.');
            const type = String(flags.type || 'github').toLowerCase();
            if (!['github', 'gitlab', 'bitbucket'].includes(type)) throw new Error('--type harus github, gitlab, bitbucket.');
            body.gitRepository = { type, repo };
          }
          const created = await api.post('/v9/projects', body);
          print(`Project dibuat: ${created.name} (${created.id})`);
          return;
        }
        if (action === 'delete') {
          const target = projectRef(positional[1]);
          if (!boolFlag(flags.yes) && confirm && !(await confirm(`Hapus project Vercel "${target}" beserta deployment-nya? [y/N] `))) {
            print('Dibatalkan. Project tidak diubah.');
            return;
          }
          await api.delete(`/v9/projects/${encodeURIComponent(target)}`);
          print(`Project dihapus: ${target}`);
          return;
        }
        const name = projectArg(action);
        const project = await api.get(`/v9/projects/${encodeURIComponent(name)}`);
        print(
          [
            `PROJECT ${project.name}`,
            `  ID           : ${project.id}`,
            `  Framework    : ${project.framework || '(tidak tersedia)'}`,
            `  Node         : ${project.nodeVersion || '(tidak tersedia)'}`,
            `  Root         : ${project.rootDirectory || '.'}`,
            `  Build        : ${project.buildCommand || '(default)'}`,
            `  Output       : ${project.outputDirectory || '(default)'}`,
            `  Dibuat       : ${stamp(project.createdAt)}`,
            `  Domain       : ${(project.domains || []).map((domain) => domain.name).join(', ') || '(belum ada)'}`,
            `  Deployment   : ${(project.latestDeployments || []).length} terbaru terlihat`,
          ].join('\n'),
        );
        for (const deployment of project.latestDeployments || []) {
          print(`    · ${deployment.readyState || '?'} ${deployment.url || deployment.id} (${stamp(deployment.createdAt)})`);
        }
        return;
      }

      if (sub === 'deployments') {
        const project = positional[0] ? projectRef(positional[0]) : defaultProject;
        const target = flags.target ? String(flags.target).toLowerCase() : null;
        if (target && !['production', 'preview'].includes(target)) throw new Error('--target harus production atau preview.');
        const data = await api.get('/v6/deployments', {
          limit: numericFlag(flags.limit, 20),
          ...(project ? { projectId: project } : {}),
          ...(target ? { target } : {}),
        });
        const deployments = Array.isArray(data?.deployments) ? data.deployments : Array.isArray(data) ? data : [];
        if (!deployments.length) {
          print('Tidak ada deployment yang cocok.');
          return;
        }
        print(
          [
            'DEPLOYMENT VERCEL',
            ...deployments.map(
              (deployment) =>
                `  ${String(deployment.readyState || '?').padEnd(10)} ${String(deployment.target || '-').padEnd(11)} ${deployment.url || deployment.id} · ${stamp(deployment.createdAt)}`,
            ),
          ].join('\n'),
        );
        return;
      }

      if (sub === 'deployment') {
        const id = deploymentRef(positional[0]);
        const deployment = await api.get(`/v13/deployments/${encodeURIComponent(id)}`);
        print(
          [
            'DETAIL DEPLOYMENT',
            `  ID        : ${deployment.id || deployment.uid || id}`,
            `  Status    : ${deployment.readyState || deployment.state || '?'}`,
            `  Target    : ${deployment.target || '(tidak tersedia)'}`,
            `  URL       : ${deployment.url || '(tidak tersedia)'}`,
            `  Project   : ${deployment.projectId || '(tidak tersedia)'}`,
            `  Sumber    : ${deployment.source || '(tidak tersedia)'}`,
            `  Commit    : ${deployment.meta?.githubCommitRef || '-'} ${deployment.meta?.githubCommitSha?.slice(0, 7) || ''}`,
            `  Pesan     : ${deployment.meta?.githubCommitMessage || '(tidak tersedia)'}`,
            `  Dibuat    : ${stamp(deployment.createdAt)}`,
            `  Selesai   : ${stamp(deployment.ready)}`,
            `  Alias     : ${(deployment.alias || []).join(', ') || '(belum ada)'}`,
          ].join('\n'),
        );
        return;
      }

      if (sub === 'deploy') {
        const name = requiredString(positional[0], 'nama project', { max: 100 });
        const target = pickTarget(flags);
        let source = null;
        if (flags.git) {
          const repo = String(flags.git);
          if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('--git harus berformat owner/repo.');
          const type = String(flags.type || 'github').toLowerCase();
          if (!['github', 'gitlab', 'bitbucket'].includes(type)) throw new Error('--type harus github, gitlab, bitbucket.');
          const ref = String(flags.ref || 'main');
          source = { gitSource: { type, repo, ref } };
        } else if (Array.isArray(flags.file) && flags.file.length) {
          if (flags.file.length > 100) throw new Error('Maksimum 100 file per deployment.');
          const files = [];
          for (const file of flags.file) {
            const absolute = path.resolve(String(file));
            const data = await fsp.readFile(absolute);
            files.push({ file: path.basename(absolute), data: data.toString('base64') });
          }
          source = { files };
        } else {
          throw new Error(
            'Deployment membutuhkan sumber: --git owner/repo --ref main, atau --file <path> (boleh berulang).',
          );
        }
        const body = { name, target, ...source };
        if (flags.project) body.project = projectRef(flags.project);
        const started = await api.post('/v13/deployments', body);
        print(
          [
            `Deployment dimulai: ${started.id || started.uid || '(id tidak terbaca)'}`,
            `  Status : ${started.readyState || started.state || 'QUEUED'}`,
            `  Target : ${started.target || target}`,
            `  URL    : ${started.url || '(menyusul setelah build)'}`,
            '',
            'Pantau dengan /vercel logs <id> atau /vercel deployment <id>.',
          ].join('\n'),
        );
        return;
      }

      if (sub === 'cancel') {
        const id = deploymentRef(positional[0]);
        if (confirm && !boolFlag(flags.yes) && !(await confirm(`Batalkan deployment ${id}? [y/N] `))) {
          print('Dibatalkan.');
          return;
        }
        await api.patch(`/v12/deployments/${encodeURIComponent(id)}/cancel`);
        print(`Deployment dibatalkan: ${id}`);
        return;
      }

      if (sub === 'promote' || sub === 'rollback') {
        const id = deploymentRef(positional[0]);
        const project = projectArg(flags.project, defaultProject);
        const verb = sub === 'promote' ? 'Promosikan' : 'Rollback';
        if (confirm && !boolFlag(flags.yes) && !(await confirm(`${verb} project ${project} ke deployment ${id}? [y/N] `))) {
          print('Dibatalkan.');
          return;
        }
        const endpoint =
          sub === 'promote'
            ? `/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(id)}`
            : `/v9/projects/${encodeURIComponent(project)}/rollback/${encodeURIComponent(id)}`;
        await api.post(endpoint);
        print(`${sub === 'promote' ? 'Deployment dipromosikan' : 'Rollback dijalankan'}: ${project} → ${id}`);
        return;
      }

      if (sub === 'env') {
        const action = (positional[0] || 'list').toLowerCase();
        if (action === 'list') {
          const project = projectArg(positional[1], defaultProject);
          const data = await api.get(`/v9/projects/${encodeURIComponent(project)}/env`, {
            limit: numericFlag(flags.limit, 100, 200),
          });
          const envs = Array.isArray(data?.envs) ? data.envs : Array.isArray(data) ? data : [];
          print(
            [
              `ENVIRONMENT VARIABLE · ${project}`,
              ...(envs.length
                ? envs.map(
                    (env) => `  ${String(env.key).padEnd(28)} ${String(env.type || '-').padEnd(10)} ${(env.target || []).join(',')}`,
                  )
                : ['  (belum ada environment variable)']),
              '',
              'Nilai tidak ditampilkan. Perubahan berlaku setelah deployment baru.',
            ].join('\n'),
          );
          return;
        }
        if (action === 'add') {
          const project = projectArg(positional[1], defaultProject);
          const key = requiredString(positional[2], 'KEY', { max: 120 });
          const value = String(positional[3] ?? '');
          if (!value) throw new Error('Usage: /vercel env add <project> <KEY> <value>');
          if (confirm && !(await confirm(`Tambahkan ${key} ke ${project}? Nilai tidak akan ditampilkan lagi. [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          const created = await api.post(`/v10/projects/${encodeURIComponent(project)}/env`, {
            key,
            value,
            type: flags.type ? String(flags.type).toLowerCase() : 'encrypted',
            target: envTargets(flags.target),
          });
          print(`Environment variable dibuat: ${created?.created?.key || key} pada ${project}`);
          print('Jalankan deployment baru agar nilainya berlaku.');
          return;
        }
        if (action === 'update') {
          const project = projectArg(positional[1], defaultProject);
          const envId = requiredString(positional[2], 'env_id', { max: 64 });
          const body = {};
          if (flags.value !== undefined) body.value = String(flags.value);
          if (flags.key !== undefined) body.key = String(flags.key);
          if (flags.target !== undefined) body.target = envTargets(flags.target);
          if (flags.type !== undefined) body.type = String(flags.type).toLowerCase();
          if (Object.keys(body).length === 0) throw new Error('Tidak ada perubahan: sertakan --value/--target/--key/--type.');
          if (confirm && !(await confirm(`Perbarui environment variable ${envId} pada ${project}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          await api.patch(`/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(envId)}`, body);
          print(`Environment variable diperbarui: ${envId}. Deployment baru diperlukan agar berlaku.`);
          return;
        }
        if (action === 'remove') {
          const project = projectArg(positional[1], defaultProject);
          const target = requiredString(positional[2], 'env_id atau KEY', { max: 120 });
          if (!boolFlag(flags.yes) && confirm && !(await confirm(`Hapus environment variable ${target} dari ${project}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          await api.delete(`/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(target)}`);
          print(`Environment variable dihapus: ${target}`);
          return;
        }
        print('Usage: /vercel env [list|add|update|remove] …');
        return;
      }

      if (sub === 'domains') {
        const data = await api.get('/v5/domains', { limit: numericFlag(flags.limit, 50) });
        const domains = Array.isArray(data?.domains) ? data.domains : Array.isArray(data) ? data : [];
        print(
          [
            'DOMAIN VERCEL',
            ...(domains.length
              ? domains.map(
                  (domain) =>
                    `  ${String(domain.name).padEnd(32)} ${domain.verified ? 'verified' : 'pending'} · ${domain.projectId || 'tanpa project'}`,
                )
              : ['  (belum ada domain)']),
          ].join('\n'),
        );
        return;
      }

      if (sub === 'domain') {
        const action = (positional[0] || '').toLowerCase();
        const project = projectArg(positional[1], defaultProject);
        if (action === 'add') {
          const domain = domainName(positional[2]);
          const result = await api.post(`/v10/projects/${encodeURIComponent(project)}/domains`, { name: domain });
          print(`Domain ditambahkan ke ${project}: ${domain}`);
          if (result?.verification) print(`Verifikasi: ${JSON.stringify(result.verification)}`);
          print('Periksa DNS record yang diminta Vercel sebelum mengubah DNS produksi.');
          return;
        }
        if (action === 'remove') {
          const domain = domainName(positional[2]);
          if (!boolFlag(flags.yes) && confirm && !(await confirm(`Lepaskan domain ${domain} dari ${project}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          await api.delete(`/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`);
          print(`Domain dilepas dari ${project}: ${domain}`);
          return;
        }
        if (action === 'verify') {
          const domain = domainName(positional[2]);
          const result = await api.post(
            `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}/verify`,
          );
          print(`Verifikasi ${domain}: ${JSON.stringify(result)}`);
          return;
        }
        print('Usage: /vercel domain add|remove|verify <project> <domain>');
        return;
      }

      if (sub === 'dns') {
        const action = (positional[0] || 'list').toLowerCase();
        if (action === 'list') {
          const domain = domainName(positional[1]);
          const data = await api.get(`/v4/domains/${encodeURIComponent(domain)}/records`, {
            limit: numericFlag(flags.limit, 100, 200),
          });
          const records = Array.isArray(data?.records) ? data.records : Array.isArray(data) ? data : [];
          print(
            [
              `DNS RECORD · ${domain}`,
              ...(records.length
                ? records.map(
                    (record) =>
                      `  ${String(record.id).padEnd(24)} ${String(record.type).padEnd(6)} ${String(record.name).padEnd(24)} ${record.value}`,
                  )
                : ['  (belum ada record)']),
            ].join('\n'),
          );
          return;
        }
        if (action === 'add') {
          const domain = domainName(positional[1]);
          const type = requiredString(positional[2], 'TYPE', { max: 8 }).toUpperCase();
          const name = requiredString(positional[3], 'name', { max: 253 });
          const value = requiredString(positional[4], 'value', { max: 2048 });
          if (confirm && !(await confirm(`Buat DNS ${type} ${name} → ${value} pada ${domain}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          const result = await api.post(`/v2/domains/${encodeURIComponent(domain)}/records`, {
            name,
            type,
            value,
            ...(flags.ttl !== undefined ? { ttl: Number(flags.ttl) || 60 } : {}),
            ...(flags.priority !== undefined ? { mxPriority: Number(flags.priority) } : {}),
          });
          print(`DNS record dibuat: ${result?.record?.id || result?.id || '(id tidak terbaca)'}`);
          return;
        }
        if (action === 'update') {
          const recordId = requiredString(positional[1], 'record_id', { max: 64 });
          const body = {};
          if (flags.value !== undefined) body.value = String(flags.value);
          if (flags.name !== undefined) body.name = String(flags.name);
          if (flags.type !== undefined) body.type = String(flags.type).toUpperCase();
          if (flags.ttl !== undefined) body.ttl = Number(flags.ttl) || 60;
          if (Object.keys(body).length === 0) throw new Error('Tidak ada perubahan DNS: sertakan --value/--name/--type/--ttl.');
          if (confirm && !(await confirm(`Perbarui DNS record ${recordId}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          await api.patch(`/v1/domains/records/${encodeURIComponent(recordId)}`, body);
          print(`DNS record diperbarui: ${recordId}`);
          return;
        }
        if (action === 'remove') {
          const recordId = requiredString(positional[1], 'record_id', { max: 64 });
          if (!boolFlag(flags.yes) && confirm && !(await confirm(`Hapus DNS record ${recordId}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          await api.delete(`/v1/domains/records/${encodeURIComponent(recordId)}`);
          print(`DNS record dihapus: ${recordId}`);
          return;
        }
        print('Usage: /vercel dns [list|add|update|remove] …');
        return;
      }

      if (sub === 'edge') {
        const action = (positional[0] || 'list').toLowerCase();
        if (action === 'list') {
          const data = await api.get('/v1/edge-config', { limit: numericFlag(flags.limit, 50) });
          const configs = Array.isArray(data?.edgeConfigs) ? data.edgeConfigs : Array.isArray(data) ? data : [];
          print(
            [
              'EDGE CONFIG',
              ...(configs.length
                ? configs.map((item) => `  ${String(item.id).padEnd(28)} ${item.slug || '(tanpa slug)'}`)
                : ['  (belum ada Edge Config)']),
            ].join('\n'),
          );
          return;
        }
        if (action === 'create') {
          const slug = requiredString(positional[1], 'slug', { max: 64 });
          const created = await api.post('/v1/edge-config', { slug });
          print(`Edge Config dibuat: ${created.id || '(id tidak terbaca)'} (${created.slug || slug})`);
          return;
        }
        if (action === 'get') {
          const id = requiredString(positional[1], 'edge_config_id', { max: 64 });
          const item = await api.get(`/v1/edge-config/${encodeURIComponent(id)}`);
          print(
            [
              'EDGE CONFIG',
              `  ID      : ${item.id || id}`,
              `  Slug    : ${item.slug || '(tidak tersedia)'}`,
              `  Dibuat  : ${stamp(item.createdAt)}`,
              `  Diubah  : ${stamp(item.updatedAt)}`,
            ].join('\n'),
          );
          return;
        }
        if (action === 'update') {
          const id = requiredString(positional[1], 'edge_config_id', { max: 64 });
          const slug = requiredString(positional[2], 'slug', { max: 64 });
          await api.patch(`/v1/edge-config/${encodeURIComponent(id)}`, { slug });
          print(`Edge Config diperbarui: ${id} → ${slug}`);
          return;
        }
        if (action === 'delete') {
          const id = requiredString(positional[1], 'edge_config_id', { max: 64 });
          if (!boolFlag(flags.yes) && confirm && !(await confirm(`Hapus Edge Config ${id}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          await api.delete(`/v1/edge-config/${encodeURIComponent(id)}`);
          print(`Edge Config dihapus: ${id}`);
          return;
        }
        if (action === 'items') {
          const id = requiredString(positional[1], 'edge_config_id', { max: 64 });
          const data = await api.get(`/v1/edge-config/${encodeURIComponent(id)}/items`);
          const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
          print(
            [
              `EDGE CONFIG ITEMS · ${id}`,
              ...(items.length ? items.map((item) => `  ${String(item.key).padEnd(28)} ${JSON.stringify(item.value)}`) : ['  (kosong)']),
            ].join('\n'),
          );
          return;
        }
        if (action === 'set') {
          const id = requiredString(positional[1], 'edge_config_id', { max: 64 });
          const key = requiredString(positional[2], 'key', { max: 200 });
          const raw = String(positional[3] ?? '');
          if (!raw) throw new Error('Usage: /vercel edge set <id> <key> <value>');
          let value = raw;
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw;
          }
          if (confirm && !(await confirm(`Set ${key} pada Edge Config ${id}? [y/N] `))) {
            print('Dibatalkan.');
            return;
          }
          await api.patch(`/v1/edge-config/${encodeURIComponent(id)}/items`, {
            items: [{ operation: 'upsert', key, value }],
          });
          print(`Edge Config diperbarui: ${key} pada ${id}`);
          return;
        }
        print('Usage: /vercel edge [list|get|create|update|delete|items|set] …');
        return;
      }

      if (sub === 'logs' || sub === 'events' || sub === 'checks') {
        const deployment = deploymentRef(positional[0]);
        if (sub === 'checks') {
          const data = await api.get(`/v1/deployments/${encodeURIComponent(deployment)}/checks`);
          const checks = Array.isArray(data?.checks) ? data.checks : Array.isArray(data) ? data : [];
          print(
            [
              `DEPLOYMENT CHECKS · ${deployment}`,
              ...(checks.length
                ? checks.map(
                    (check) =>
                      `  ${String(check.name).padEnd(24)} ${String(check.status || '-').padEnd(10)} ${check.conclusion || ''}${check.blocking ? ' · blocking' : ''}`,
                  )
                : ['  (belum ada check)']),
            ].join('\n'),
          );
          return;
        }
        const data = await api.get(`/v2/deployments/${encodeURIComponent(deployment)}/events`, {
          direction: 'forward',
          follow: 0,
          limit: numericFlag(flags.limit, 200, 500),
        });
        const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
        const filtered =
          sub === 'logs' && boolFlag(flags.problems)
            ? events.filter((event) => ['error', 'warning', 'warn'].includes(String(event.level || event.payload?.level || '').toLowerCase()))
            : events;
        print(
          [
            `${sub === 'logs' ? 'LOG' : 'EVENT'} DEPLOYMENT · ${deployment}`,
            ...(filtered.length
              ? filtered.map((event) => {
                  const level = event.level || event.payload?.level || event.type || 'info';
                  const text = String(event.text || event.payload?.text || '').replace(/\s+$/g, '');
                  return `  ${stamp(event.created)} ${String(level).padEnd(8)} ${text}`;
                })
              : ['  (tidak ada baris)']),
          ].join('\n'),
        );
        return;
      }

      print(`Subcommand tidak dikenal: /vercel ${sub}`);
      print(USAGE);
    } catch (error) {
      print(`Vercel: ${error.message}`);
      if (error.code === VERCEL_CODES.UNAUTHORIZED || error.reconnect) {
        print('Jalankan /vercel login untuk menghubungkan ulang akun Vercel.');
      } else if (error.code === VERCEL_CODES.DISABLED) {
        print('Jalankan /vercel enable setelah login.');
      } else if (error.code === VERCEL_CODES.SCOPE) {
        print('Scope integrasi tidak mencukupi. Periksa scope pada Vercel Integrations Console atau instalasi team.');
      }
    }
  };
}

export async function formatStatus(plugin, registry) {
  const status = await plugin.status();
  const registered = registry?.plugins?.get?.(plugin.name);
  const remote = status.remote;
  const lines = [
    'STATUS VERCEL',
    `  Integrasi       : ${status.enabled ? 'aktif' : 'nonaktif'}`,
    `  Autentikasi     : ${status.authenticated ? 'terhubung' : 'belum login'}`,
  ];
  if (status.configError) lines.push(`  Konfigurasi     : error — ${status.configError}`);
  if (status.authError) lines.push(`  Kredensial      : error — ${status.authError}`);
  if (status.sessionExpired) lines.push('  Sesi lokal      : kedaluwarsa — jalankan /vercel login');

  if (status.authenticated) {
    const account = remote?.account || status.auth;
    lines.push(
      `  Akun            : ${account.username ? `@${account.username}` : account.email || '(tidak tersedia)'}`,
      `  Configuration   : ${remote?.configuration?.id || status.auth.configuration?.id || '(akun tanpa configuration)'}`,
      `  Team            : ${remote?.configuration?.teamId || status.auth.configuration?.teamId || '(tidak tersedia)'}`,
      `  Scope instalasi : ${(remote?.configuration?.scopes || status.auth.configuration?.scopes || []).join(', ') || '(tidak tercatat)'}`,
      `  Access token    : ${remote?.token?.present ? 'tersimpan terenkripsi di backend' : 'tidak dapat diverifikasi'}`,
      `  Refresh token   : ${remote?.capabilities?.refreshSupported ? 'didukung' : 'tidak didukung Vercel (tidak dikarang)'}`,
      `  Sesi lokal      : ${status.auth.cliTokenExpiresAt ? `berlaku sampai ${stamp(status.auth.cliTokenExpiresAt)}` : 'tanpa masa berlaku tercatat'}`,
    );
  }

  lines.push(
    `  Backend         : ${remote ? 'terhubung (respons aplikasi)' : status.remoteError ? `gagal — ${status.remoteError}` : status.settings?.backend || 'tidak diketahui'}`,
    `  Tool aktif      : ${registered ? registered.toolNames.length : 0} dari ${status.toolCount}`,
    `  Cek terakhir    : ${stamp(status.lastCheck)}${status.lastCheck === null ? '' : status.lastCheckOk ? ' (berhasil)' : ' (gagal)'}`,
    `  Config file     : ${status.paths.configFile}`,
    `  Credential file : ${status.paths.credentialFile}`,
    '  Rahasia         : Client Secret dan access token Vercel tidak disimpan di CLI',
  );

  if (!status.enabled) {
    lines.push('', 'Integrasi nonaktif. Jalankan /vercel login (bila belum) lalu /vercel enable.');
  } else if (!status.authenticated) {
    lines.push('', 'Jalankan /vercel login untuk menghubungkan akun Vercel.');
  }
  if (status.enabled && status.authenticated && !registered) {
    lines.push('', 'Integrasi aktif tetapi tool belum terdaftar: jalankan /vercel enable.');
  }
  if (remote?.config && !remote.config.ok) {
    lines.push('', `Konfigurasi backend belum lengkap: ${(remote.config.missing || []).join(', ') || 'tidak diketahui'}.`);
  }
  if (remote && remote.ready === false) {
    lines.push('', 'Instalasi Vercel belum menyertakan configuration; pasang integrasi pada team/project lalu login lagi.');
  }
  return lines.join('\n');
}
