import { syncPluginTools, unregisterPluginTools } from '../index.js';

/**
 * Handler `/github`.
 *
 * Command memakai parser Ryuu yang sudah ada (`define` di cli/commands.js);
 * modul ini hanya memformat keluaran dan memanggil manager. Tidak ada token
 * yang pernah dicetak.
 */

const USAGE = [
  'GitHub Integration',
  '',
  'Autentikasi:',
  '  /github login              login lewat browser (utama)',
  '  /github login --device     login device flow (headless)',
  '  /github logout             putuskan akun GitHub',
  '',
  'Status:',
  '  /github status',
  '  /github account',
  '  /github test',
  '',
  'Integrasi:',
  '  /github enable',
  '  /github disable',
  '',
  'Konfigurasi:',
  '  /github config',
  '  /github config set <key> <value>',
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

function redirectNote(plugin) {
  return [
    `  Backend         : ${plugin.pathsInfo.configFile.replace(/\/config\.json$/, '')}`,
    '  Client Secret / Private Key / Webhook Secret: hanya di backend, tidak ada di CLI.',
  ].join('\n');
}

export function createGitHubCommand({ plugin, registry, confirm = null, openBrowser = true, showCode = null }) {
  return async function githubCommand(args, print) {
    const parts = tokenize(args);
    const sub = (parts[0] || '').toLowerCase();
    const rest = parts.slice(1);

    if (!sub || sub === 'help' || sub === '?') {
      print(USAGE);
      return;
    }

    if (sub === 'login') {
      const device = rest.includes('--device');
      const noBrowser = rest.includes('--no-browser');
      try {
        await plugin.login({
          print,
          showCode,
          device,
          openBrowser: openBrowser && !noBrowser,
          confirmReplace: confirm ? (question) => confirm(question) : null,
        });
        // Setelah login, plugin otomatis enabled; daftarkan tool agar sesi ini
        // langsung bisa memakainya tanpa restart.
        if (await plugin.isEnabled()) await syncPluginTools(plugin, registry);
      } catch (error) {
        print(`Login GitHub gagal: ${error.message}`);
      }
      return;
    }

    if (sub === 'logout') {
      // Sesi yang kedaluwarsa tetap punya kredensial lokal yang harus dihapus,
      // jadi pemeriksaannya memakai `authInfo().connected`, bukan isAuthenticated.
      const info = await plugin.authInfo().catch(() => ({ connected: false }));
      if (!info.connected) {
        print('Belum ada akun GitHub yang terhubung. Tidak ada yang perlu diputus.');
        return;
      }
      if (confirm && !(await confirm('Putuskan koneksi GitHub dan hapus kredensial lokal? [y/N] '))) {
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
        print(`Integrasi GitHub diaktifkan. ${count} tool terdaftar untuk AI Agent:`);
        print(`  ${result.tools.join(', ')}`);
        print('Operasi yang mengubah data tetap meminta approval Ryuu.');
      } catch (error) {
        print(error.message);
        if (error.code === 'GITHUB_UNAUTHORIZED') print('Jalankan /github login untuk menghubungkan akun GitHub.');
      }
      return;
    }

    if (sub === 'disable') {
      const removed = unregisterPluginTools(plugin, registry);
      await plugin.disable();
      print(
        `Integrasi GitHub dinonaktifkan (${removed} tool dilepas dari AI Agent). ` +
          'Akun dan token tetap tersimpan; instalasi GitHub App tidak diputus.',
      );
      return;
    }

    if (sub === 'status') {
      print(await formatStatus(plugin, registry));
      return;
    }

    if (sub === 'account') {
      try {
        const account = await plugin.account();
        print(
          [
            'AKUN GITHUB',
            `  Username   : @${account.login || '(tidak tersedia)'}`,
            `  Nama       : ${account.name || '(tidak tersedia)'}`,
            `  Tipe akun  : ${account.type || '(tidak tersedia)'}`,
            `  Profil     : ${account.htmlUrl || '(tidak tersedia)'}`,
            `  Avatar     : ${account.avatarUrl || '(tidak tersedia)'}`,
            `  Scope      : ${account.scope || '(tidak tercatat)'}`,
            `  Status     : ${account.connected ? 'terhubung' : 'perlu login ulang'}`,
            `  Integrasi  : ${(await plugin.isEnabled()) ? 'aktif' : 'nonaktif'}`,
            `  Instalasi  : ${(account.installations || []).length} terlihat`,
          ].join('\n'),
        );
        for (const installation of account.installations || []) {
          print(`    · ${installation.account || '?'} (${installation.accountType || '?'}) · id ${installation.id}`);
        }
      } catch (error) {
        print(`Tidak dapat membaca akun GitHub: ${error.message}`);
        if (error.reconnect) print('Jalankan /github login untuk menghubungkan ulang.');
      }
      return;
    }

    if (sub === 'test') {
      print('Menjalankan pemeriksaan GitHub…');
      const result = await plugin.test();
      const rows = (result.report || []).map(
        (row) => `  ${row.ok ? '[✓]' : '[!]'} ${String(row.label).padEnd(26)} ${row.detail || ''}`,
      );
      print(
        [
          'DIAGNOSTIK GITHUB',
          ...rows,
          '',
          result.ok ? 'Semua pemeriksaan berhasil.' : 'Ada pemeriksaan yang gagal.',
          'Tidak ada repository yang dibuat, diubah, atau dihapus oleh test ini.',
        ].join('\n'),
      );
      return;
    }

    if (sub === 'config') {
      const action = (rest[0] || 'show').toLowerCase();
      if (action === 'show') {
        let view;
        try {
          view = await plugin.configView();
        } catch (error) {
          print(`Tidak dapat membaca konfigurasi GitHub: ${error.message}`);
          return;
        }
        const width = Math.max(...Object.keys(view.lines).map((key) => key.length));
        print(
          [
            'KONFIGURASI GITHUB (NON-RAHASIA)',
            ...Object.entries(view.lines).map(([key, value]) => `  ${key.padEnd(width)}  ${value}`),
            '',
            redirectNote(plugin),
            '',
            'Ubah dengan: /github config set <key> <value>',
            'Key: enabled, autoRefresh, confirmDestructive, defaultRepo',
          ].join('\n'),
        );
        return;
      }
      if (action === 'set') {
        const key = rest[1];
        const value = rest.slice(2).join(' ');
        if (!key || rest.length < 3) {
          print('Usage: /github config set <key> <value>');
          return;
        }
        try {
          const parsed = await plugin.setConfig(key, value);
          print(`Konfigurasi diperbarui: ${key} = ${parsed === null ? '(kosong)' : String(parsed)}`);
          if (key === 'enabled') {
            if (parsed === true) {
              const count = await syncPluginTools(plugin, registry);
              print(`${count} tool GitHub ${count > 0 ? 'terdaftar' : 'belum dapat didaftarkan (pastikan sudah login)'}.`);
            } else {
              const removed = unregisterPluginTools(plugin, registry);
              print(`${removed} tool GitHub dilepas dari AI Agent.`);
            }
          }
          if (key === 'confirmDestructive' && parsed === false) {
            print('Peringatan: penghapusan file dan merge pull request akan diblokir sampai opsi ini diaktifkan lagi.');
          }
        } catch (error) {
          print(error.message);
        }
        return;
      }
      print('Usage: /github config [show] | /github config set <key> <value>');
      return;
    }

    print(`Subcommand tidak dikenal: /github ${sub}`);
    print(USAGE);
  };
}

export async function formatStatus(plugin, registry) {
  const status = await plugin.status();
  const registered = registry?.plugins?.get?.(plugin.name);
  const remote = status.remote;
  const lines = [
    'STATUS GITHUB',
    `  Integrasi       : ${status.enabled ? 'aktif' : 'nonaktif'}`,
    `  Autentikasi     : ${status.authenticated ? 'terhubung' : 'belum login'}`,
  ];
  if (status.configError) lines.push(`  Konfigurasi     : error — ${status.configError}`);
  if (status.authError) lines.push(`  Kredensial      : error — ${status.authError}`);
  if (status.sessionExpired) lines.push('  Sesi lokal      : kedaluwarsa — jalankan /github login');

  if (status.authenticated) {
    const account = remote?.github || status.auth;
    lines.push(`  Akun            : @${account.login || status.auth.login || '(tidak tersedia)'}`);
    if (account.name || status.auth.name) lines.push(`  Nama            : ${account.name || status.auth.name}`);
    if (remote?.token) {
      lines.push(
        `  Access token    : ${
          remote.token.accessExpiresAt
            ? `berlaku sampai ${stamp(remote.token.accessExpiresAt)}`
            : 'tanpa masa berlaku (expiration off)'
        }`,
      );
      lines.push(
        `  Refresh token   : ${remote.token.hasRefreshToken ? 'tersedia di backend' : 'tidak tersedia'}`,
      );
      if (remote.token.needsReconnect) lines.push('  Perlu login ulang: ya (otorisasi dicabut/kedaluwarsa)');
    }
    lines.push(
      `  Instalasi       : ${Array.isArray(remote?.installations) ? remote.installations.length : (status.auth.installations || 0)} terlihat`,
    );
    lines.push(`  Sesi lokal      : ${status.auth.cliTokenExpiresAt ? `berlaku sampai ${stamp(status.auth.cliTokenExpiresAt)}` : 'tanpa masa berlaku tercatat'}`);
  }

  lines.push(
    `  Backend         : ${remote ? 'terhubung (respons aplikasi)' : status.remoteError ? `gagal — ${status.remoteError}` : status.settings?.backend || 'tidak diketahui'}`,
    `  Tool aktif      : ${registered ? registered.toolNames.length : 0} dari ${status.toolCount}`,
    `  Cek terakhir    : ${stamp(status.lastCheck)}${status.lastCheck === null ? '' : status.lastCheckOk ? ' (berhasil)' : ' (gagal)'}`,
    `  Config file     : ${status.paths.configFile}`,
    `  Credential file : ${status.paths.credentialFile}`,
    '  Rahasia         : Client Secret, Private Key, dan token GitHub tidak disimpan di CLI',
  );

  if (status.enabled && !status.authenticated) lines.push('', 'Jalankan /github login untuk menghubungkan akun GitHub.');
  if (status.enabled && status.authenticated && !registered) {
    lines.push('', 'Integrasi aktif tetapi tool belum terdaftar: jalankan /github enable.');
  }
  if (remote?.config && !remote.config.ok) {
    lines.push('', `Konfigurasi backend belum lengkap: ${(remote.config.missing || []).join(', ') || 'tidak diketahui'}.`);
  }
  return lines.join('\n');
}
