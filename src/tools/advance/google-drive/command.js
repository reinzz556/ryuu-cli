import { formatBytes } from './tool-helpers.js';
import { syncPluginTools, unregisterPluginTools } from '../index.js';

/**
 * `/drive` command handler.
 *
 * It is wired into the existing command parser through `define()` in
 * cli/commands.js; this module only formats output and calls the manager.
 * Every message is Indonesian, and no token is ever printed.
 */

const USAGE = [
  'Google Drive Integration',
  '',
  'Autentikasi:',
  '  /drive login',
  '  /drive logout',
  '  /drive account',
  '',
  'Integrasi:',
  '  /drive enable',
  '  /drive disable',
  '  /drive status',
  '',
  'Konfigurasi:',
  '  /drive config',
  '  /drive config show',
  '  /drive config set <key> <value>',
  '',
  'Diagnostik:',
  '  /drive test',
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

function stamp(value) {
  if (!value) return 'belum pernah';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export function createDriveCommand({ plugin, registry, confirm = null, openBrowser = true, showCode = null }) {
  /**
   * @param {string} args raw argument string after `/drive`
   * @param {(text: string) => void} print
   */
  return async function driveCommand(args, print) {
    const parts = tokenize(args);
    const sub = (parts[0] || '').toLowerCase();
    const rest = parts.slice(1);

    if (!sub || sub === 'help' || sub === '?') {
      print(USAGE);
      return;
    }

    if (sub === 'login') {
      try {
        await plugin.login({
          print,
          showCode,
          openBrowser,
          confirmReplace: confirm ? (question) => confirm(question) : null,
        });
      } catch (error) {
        print(`Login gagal: ${error.message}`);
      }
      return;
    }

    if (sub === 'logout') {
      const authenticated = await plugin.isAuthenticated().catch(() => false);
      if (!authenticated) {
        print('Belum ada akun Google yang terhubung. Tidak ada yang perlu diputus.');
        return;
      }
      if (confirm && !(await confirm('Putuskan koneksi Google Drive dan hapus kredensial lokal? [y/N] '))) {
        print('Logout dibatalkan. Kredensial tidak diubah.');
        return;
      }
      unregisterPluginTools(plugin, registry);
      await plugin.logout({ print });
      return;
    }

    if (sub === 'enable') {
      try {
        const result = await plugin.enable();
        const count = await syncPluginTools(plugin, registry);
        print(`Integrasi Google Drive diaktifkan. ${count} tool terdaftar untuk AI Agent:`);
        print(`  ${result.tools.join(', ')}`);
      } catch (error) {
        print(error.message);
        if (error.code === 'DRIVE_UNAUTHORIZED') print('Jalankan /drive login untuk menghubungkan akun Google.');
      }
      return;
    }

    if (sub === 'disable') {
      const removed = unregisterPluginTools(plugin, registry);
      await plugin.disable();
      print(
        `Integrasi Google Drive dinonaktifkan (${removed} tool dilepas dari AI Agent). ` +
          'Token dan konfigurasi tetap disimpan; backup tidak dihapus.',
      );
      return;
    }

    if (sub === 'status') {
      print(await formatStatus(plugin, registry));
      return;
    }

    if (sub === 'account') {
      const info = await plugin.authInfo().catch((error) => ({ connected: false, error: error.message }));
      if (!info.connected) {
        print('Belum ada akun Google yang terhubung. Jalankan /drive login.');
        return;
      }
      let quota = null;
      try {
        const client = await plugin.getClient();
        const about = await client.getAbout();
        quota = about.storageQuota;
        print(
          [
            'AKUN GOOGLE DRIVE',
            `  Nama       : ${about.name || '(tidak tersedia)'}`,
            `  Email      : ${about.email || '(tidak tersedia)'}`,
            `  Permission : ${info.scope || '(tidak tercatat)'}`,
            `  Token      : ${info.hasRefreshToken ? 'izin refresh tersedia (grant)' : 'hanya access token'}`,
            `  Kadaluarsa : ${stamp(info.expiresAt)}`,
            `  Tersimpan  : ${stamp(info.savedAt)}`,
            quota?.limit
              ? `  Storage    : ${formatBytes(quota.usage)} / ${formatBytes(quota.limit)}`
              : '  Storage    : tidak tersedia dari API',
          ].join('\n'),
        );
      } catch (error) {
        print(`Akun tersimpan: ${info.email || '(tanpa email)'} — tetapi API menolak: ${error.message}`);
      }
      return;
    }

    if (sub === 'config') {
      const action = (rest[0] || 'show').toLowerCase();
      if (action === 'show') {
        const { lines } = await plugin.configView();
        const width = Math.max(...Object.keys(lines).map((key) => key.length));
        print(
          [
            'KONFIGURASI GOOGLE DRIVE',
            ...Object.entries(lines).map(([key, value]) => `  ${key.padEnd(width)}  ${value}`),
            '',
            'Ubah dengan: /drive config set <key> <value>',
            'Key: enabled, defaultBackupFolder, backupDirectory, maxUploadSize, confirmDestructive, autoRefresh, excludePatterns',
          ].join('\n'),
        );
        return;
      }
      if (action === 'set') {
        const key = rest[1];
        const value = rest.slice(2).join(' ');
        if (!key || rest.length < 3) {
          print('Usage: /drive config set <key> <value>');
          return;
        }
        try {
          const parsed = await plugin.setConfig(key, value);
          const shown = Array.isArray(parsed) ? parsed.join(', ') || '(kosong)' : String(parsed);
          print(`Konfigurasi diperbarui: ${key} = ${shown}`);
          if (key === 'enabled') {
            if (parsed === true) await syncPluginTools(plugin, registry);
            else unregisterPluginTools(plugin, registry);
          }
        } catch (error) {
          print(error.message);
        }
        return;
      }
      print('Usage: /drive config [show] | /drive config set <key> <value>');
      return;
    }

    if (sub === 'test') {
      print('Menjalankan pemeriksaan Google Drive…');
      const result = await plugin.diagnose();
      const rows = result.report.map((row) => `  ${row.ok ? '[✓]' : '[!]'} ${row.label.padEnd(24)} ${row.detail}`);
      print(['DIAGNOSTIK GOOGLE DRIVE', ...rows, '', result.ok ? 'Semua pemeriksaan berhasil.' : 'Ada pemeriksaan yang gagal.'].join('\n'));
      return;
    }

    if (sub === 'tools') {
      const registered = registry?.plugins?.get?.(plugin.name);
      print(
        registered
          ? `Tool Google Drive terdaftar (${registered.toolNames.length}): ${registered.toolNames.join(', ')}`
          : 'Tool Google Drive sedang tidak terdaftar untuk AI Agent (nonaktif atau belum login).',
      );
      return;
    }

    print(`Subcommand tidak dikenal: /drive ${sub}`);
    print(USAGE);
  };
}

export async function formatStatus(plugin, registry) {
  const status = await plugin.status();
  const registered = registry?.plugins?.get?.(plugin.name);
  const integration = status.enabled ? 'aktif' : 'nonaktif';
  const auth = status.authenticated ? 'terhubung' : 'belum login';
  const lines = [
    'STATUS GOOGLE DRIVE',
    `  Integrasi       : ${integration}`,
    `  Autentikasi     : ${auth}`,
  ];
  if (status.configError) lines.push(`  Konfigurasi     : error — ${status.configError}`);
  if (status.authError) lines.push(`  Credential      : error — ${status.authError}`);
  if (status.authenticated) {
    lines.push(`  Akun            : ${status.auth.email || status.account?.email || '(tanpa email)'}`);
    if (status.auth.name || status.account?.name) lines.push(`  Nama            : ${status.auth.name || status.account.name}`);
    lines.push(`  Scope OAuth     : ${status.auth.scope || (status.settings?.scopes || []).join(', ')}`);
    lines.push(
      `  Token           : ${status.auth.hasRefreshToken ? 'izin refresh tersedia (grant)' : 'hanya access token'} · kadaluarsa ${stamp(status.auth.expiresAt)}`,
    );
    if (status.quota?.limit) {
      lines.push(`  Storage         : ${formatBytes(status.quota.usage)} / ${formatBytes(status.quota.limit)}`);
    }
  }
  lines.push(
    `  Tool aktif      : ${registered ? registered.toolNames.length : 0} dari ${status.toolCount}`,
    `  Folder backup   : ${status.settings?.defaultBackupFolder || '(My Drive root / belum diatur)'}`,
    `  Folder arsip    : ${status.settings?.backupDirectory || 'Backups'}`,
    `  Cek terakhir    : ${stamp(status.lastCheck)}${status.lastCheck === null ? '' : status.lastCheckOk ? ' (berhasil)' : ' (gagal)'}`,
    `  Config file     : ${status.paths.configFile}`,
    `  Credential file : ${status.paths.credentialFile}`,
  );
  if (status.enabled && !status.authenticated) lines.push('', 'Jalankan /drive login untuk menghubungkan akun Google.');
  if (status.registered === false) lines.push('', 'Integrasi aktif tetapi tool belum terdaftar: jalankan /drive enable.');
  return lines.join('\n');
}
