import { RyuuError } from '../../src/utils/errors.js';
import fsp from 'node:fs/promises';
import {
  DEFAULT_GOOGLE_DRIVE_CONFIG,
  describeDriveConfig,
  drivePaths,
  readDriveConfig,
  updateDriveConfig,
  validateConfigEntry,
  writeDriveConfig,
} from './config.js';
import { clearCredentials, describeCredentials, loadCredentials, saveCredentials } from './credentials.js';
import { describeOAuthFailure, openBrowser } from './auth.js';
import {
  refreshAccessToken,
  revokeRemoteToken,
  startLogin,
  waitForTokens,
} from './oauth-backend.js';
import { BackendTokenAuth } from './token-client.js';
import { DriveClient } from './drive-api.js';
import { createDriveTools } from './tools.js';

/**
 * Lifecycle manager for the Google Drive plugin.
 *
 * It owns the four states the CLI must honour:
 *   enabled + authenticated   → tools registered and usable
 *   disabled + authenticated  → tools withheld from the model
 *   enabled + unauthenticated → tools withheld, /drive login is suggested
 *   disabled + unauthenticated→ integration inactive
 *
 * Tool handlers re-check freshness on every call (`requireClient`), so a model
 * holding a stale tool list cannot act after `/drive disable`.
 */
export class GoogleDrivePlugin {
  constructor({ logger = null, workspace = null, config = null, paths = null } = {}) {
    this.name = 'google-drive';
    this.version = '1.0.0';
    this.command = 'drive';
    this.logger = logger;
    this.workspace = workspace;
    this.appConfig = config;
    this.paths = paths || drivePaths();
    this.settings = null;
    this.settingsMtime = null;
    this.stored = null;
    this.client = null;
    this.clientFor = null;
    this.lastCheck = null;
    this.lastCheckOk = null;
    this.loggingIn = false;
    this.tools = createDriveTools(this);
  }

  /** Absolute paths of the plugin's own configuration and credential files. */
  get pathsInfo() {
    return { ...this.paths };
  }

  /**
   * Cached config read, invalidated by the file's mtime.
   *
   * The cache must not hide a change made by another process or by a test that
   * writes the file directly — `/drive enable` would otherwise be ignored until
   * the CLI restarted.
   */
  async loadConfig({ force = false } = {}) {
    const mtime = await fsp
      .stat(this.paths.configFile)
      .then((stat) => stat.mtimeMs)
      .catch(() => null);
    if (force || !this.settings || mtime !== this.settingsMtime) {
      this.settings = await readDriveConfig({ paths: this.paths });
      this.settingsMtime = mtime;
    }
    return this.settings;
  }

  async loadCredentials({ force = false } = {}) {
    if (!this.stored || force) this.stored = await loadCredentials({ paths: this.paths });
    return this.stored;
  }

  /** Metadata only (never a token). */
  async authInfo() {
    await this.loadCredentials();
    return describeCredentials(this.stored);
  }

  async isAuthenticated() {
    const info = await this.authInfo();
    return info.connected;
  }

  async isEnabled() {
    const settings = await this.loadConfig();
    return Boolean(settings.enabled);
  }

  /** Token masih dianggap segar? Dipakai untuk memutuskan refresh. */
  static isExpired(stored) {
    if (!stored?.expiryDate) return false;
    return Date.now() > stored.expiryDate - 60000;
  }

  /** Minta access token baru ke backend memakai grant hasil login. */
  async refreshStored() {
    const stored = await this.loadCredentials({ force: true });
    if (!stored?.grantId) {
      throw new RyuuError('Izin Drive tidak tersedia. Jalankan /drive login.', {
        code: 'DRIVE_UNAUTHORIZED',
      });
    }
    const tokens = await refreshAccessToken({ grantId: stored.grantId });
    await saveCredentials(
      {
        tokens: {
          grant_id: tokens.grantId || stored.grantId,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken || stored.refreshToken,
          expiry_date: tokens.expiryDate,
          token_type: tokens.tokenType,
          scope: tokens.scope || stored.scope,
        },
        account: stored.account || null,
      },
      { paths: this.paths },
    );
    this.stored = null;
    this.client = null;
    this.clientFor = null;
    return tokens;
  }

  /** Build (or reuse) a Drive client bound to the stored tokens. */
  async getClient({ refreshAccount = false } = {}) {
    const stored = await this.loadCredentials();
    if (!stored?.refreshToken && !stored?.accessToken) {
      throw new RyuuError('Google Drive belum terhubung. Jalankan /drive login terlebih dahulu.', {
        code: 'DRIVE_UNAUTHORIZED',
      });
    }
    if (this.client && this.clientFor === stored.accessToken) return this.client;
    if (GoogleDrivePlugin.isExpired(stored)) {
      await this.refreshStored().catch((error) => {
        this.logger?.warn('drive token refresh failed', { error: error.message });
      });
    }
    const current = await this.loadCredentials({ force: true });
    const auth = new BackendTokenAuth({
      accessToken: current?.accessToken || null,
      expiresAt: current?.expiryDate || null,
      logger: this.logger,
      onRefresh: () => this.refreshStored(),
    });
    const client = new DriveClient({ auth, logger: this.logger });
    this.client = client;
    this.clientFor = current?.accessToken || null;
    if (refreshAccount) await this.refreshAccount();
    return client;
  }

  /** Guard used by every tool and command: enabled AND authenticated. */
  async requireClient({ refreshAccount = false } = {}) {
    const settings = await this.loadConfig();
    if (!settings.enabled) {
      throw new RyuuError(
        'Integrasi Google Drive sedang nonaktif. Jalankan /drive enable untuk mengaktifkannya.',
        { code: 'DRIVE_DISABLED' },
      );
    }
    return this.getClient({ refreshAccount });
  }

  /** Re-read account identity + quota and persist it next to the tokens. */
  async refreshAccount() {
    const stored = await loadCredentials({ paths: this.paths });
    if (!stored) return null;
    const client = this.client || (await this.getClient());
    const about = await client.getAbout();
    await saveCredentials(
      {
        tokens: {
          access_token: stored.accessToken,
          refresh_token: stored.refreshToken,
          expiry_date: stored.expiryDate,
          token_type: stored.tokenType,
          scope: stored.scope,
        },
        account: about,
      },
      { paths: this.paths },
    );
    this.stored = null;
    return about;
  }

  /**
   * Interactive OAuth login lewat backend API.
   *
   * CLI meminta URL otorisasi ke `website/api` (pemegang Client ID + Secret),
   * lalu mem-poll sampai server menukar authorization code menjadi token.
   * Tidak ada callback server lokal, dan tidak ada kredensial Google di sisi
   * CLI. `print` menerima baris untuk pengguna; URL selalu dicetak sehingga
   * VPS headless bisa membukanya di perangkat lain.
   */
  async login({ print = () => {}, showCode = null, confirmReplace = null, openBrowser: shouldOpen = true, timeoutMs = 300000 } = {}) {
    if (this.loggingIn) throw new RyuuError('Login Google Drive sedang berjalan.', { code: 'DRIVE_BUSY' });
    const settings = await this.loadConfig();
    const existing = await this.authInfo();
    if (existing.connected && confirmReplace) {
      const replace = await confirmReplace(
        'Akun Google sudah terhubung. Ganti dengan akun lain? [y/N] ',
      );
      if (!replace) {
        print('Login dibatalkan. Kredensial yang ada tidak diubah.');
        return { connected: false, cancelled: true };
      }
    }

    this.loggingIn = true;
    // The TUI hands over its framed copyable block; the line renderer takes the
    // same call. Without one, the URL is still printed so login never breaks.
    const emitCode =
      typeof showCode === 'function' ? showCode : (block) => print(`\n${block.text}\n`);
    let launched = false;
    try {
      // Server yang membuat state, PKCE verifier, dan URL otorisasi.
      const session = await startLogin({ loginHint: existing.email || null });

      const shown = session.url;
      if (shouldOpen) launched = openBrowser(shown);
      print(
        [
          'Google Drive Authentication',
          '',
          launched
            ? 'Halaman autentikasi Google dibuka di browser default.'
            : 'Browser tidak tersedia di mesin ini — buka tautan di bawah secara manual.',
          'Login dengan akun Google lewat tautan berikut; blok di bawah bisa diklik untuk menyalin.',
        ].join('\n'),
      );
      emitCode({ label: 'login url', text: shown });
      print(
        [
          `Callback  : ${session.redirectUri || '(dikelola backend API)'}`,
          `Otorisasi : backend API ${settings.oauthBackend}`,
          'Kredensial Google (client id/secret) tidak disimpan di CLI.',
          '',
          'Menunggu persetujuan pengguna…',
        ].join('\n'),
      );

      const tokens = await waitForTokens({ state: session.state, timeoutMs });
      // Token milik sesi ini: disimpan terenkripsi, tidak pernah dicetak.
      await saveCredentials(
        {
          tokens: {
            grant_id: tokens.grantId,
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            expiry_date: tokens.expiryDate,
            token_type: tokens.tokenType,
            scope: tokens.scope || settings.scopes.join(' '),
          },
          account: null,
        },
        { paths: this.paths },
      );
      this.client = null;
      this.clientFor = null;
      this.stored = null;

      const auth = new BackendTokenAuth({
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiryDate,
        logger: this.logger,
        onRefresh: () => this.refreshStored(),
      });
      const client = new DriveClient({ auth, logger: this.logger });
      let about = null;
      let verifyError = null;
      try {
        about = await client.getAbout();
        await saveCredentials(
          {
            tokens: {
              grant_id: tokens.grantId,
              access_token: tokens.accessToken,
              refresh_token: tokens.refreshToken,
              expiry_date: tokens.expiryDate,
              token_type: tokens.tokenType,
              scope: tokens.scope || settings.scopes.join(' '),
            },
            account: about,
          },
          { paths: this.paths },
        );
        this.stored = null;
      } catch (error) {
        verifyError = error;
      }

      if (!settings.enabled) await updateDriveConfig('enabled', true, { paths: this.paths });
      this.settings = null;
      this.lastCheck = new Date().toISOString();
      this.lastCheckOk = Boolean(about);

      const scope = (tokens.scope || settings.scopes.join(' ')).split(/\s+/).filter(Boolean).join(', ');
      const email = about?.email || '(tidak terbaca)';
      print(
        [
          '[✓] Autentikasi berhasil!',
          '',
          `Akun       : ${email}`,
          about?.name ? `Nama       : ${about.name}` : null,
          `Permission : ${scope}`,
          `Status     : ${about ? 'Connected' : 'Token tersimpan (verifikasi gagal)'}`,
          verifyError ? `Catatan    : ${verifyError.message}` : null,
          '',
          'Google Drive aktif. Tools Drive sekarang tersedia untuk AI Agent.',
        ]
          .filter((line) => line !== null)
          .join('\n'),
      );
      return { connected: Boolean(about), account: about, enabled: true };
    } catch (error) {
      const message = error instanceof RyuuError ? error.message : `Login gagal: ${describeOAuthFailure(error)}`;
      throw error instanceof RyuuError ? error : new RyuuError(message, { code: 'DRIVE_AUTH' });
    } finally {
      this.loggingIn = false;
    }
  }

  /** Logout: revoke (best effort), drop tokens, keep non-sensitive config. */
  async logout({ print = () => {} } = {}) {
    const stored = await loadCredentials({ paths: this.paths }).catch(() => null);
    let revocation = { revoked: false, reason: 'tidak ada token' };
    if (stored?.grantId || stored?.refreshToken || stored?.accessToken) {
      revocation = await revokeRemoteToken({ grantId: stored.grantId });
    }
    await clearCredentials({ paths: this.paths });
    this.client = null;
    this.clientFor = null;
    this.stored = null;
    if (this.settings?.enabled) {
      await updateDriveConfig('enabled', false, { paths: this.paths }).catch(() => {});
      this.settings = null;
    }
    print('Koneksi Google Drive diputus. Token lokal dihapus, konfigurasi non-sensitif dipertahankan.');
    print(
      revocation.revoked
        ? 'Revocation token OAuth: berhasil.'
        : `Revocation token OAuth: dilewati (${revocation.reason}).`,
    );
    print('File di Google Drive tidak dihapus.');
    return { revoked: revocation.revoked, reason: revocation.reason };
  }

  async enable() {
    const authenticated = await this.isAuthenticated();
    if (!authenticated) {
      throw new RyuuError('Belum ada akun Google yang terhubung. Jalankan /drive login lebih dulu.', {
        code: 'DRIVE_UNAUTHORIZED',
      });
    }
    await updateDriveConfig('enabled', true, { paths: this.paths });
    this.settings = null;
    return { enabled: true, tools: this.tools.map((tool) => tool.name) };
  }

  async disable() {
    await updateDriveConfig('enabled', false, { paths: this.paths });
    this.settings = null;
    return { enabled: false };
  }

  async setConfig(key, value) {
    const parsed = validateConfigEntry(key, value);
    await updateDriveConfig(key, parsed, { paths: this.paths });
    this.settings = null;
    return parsed;
  }

  async configView() {
    const settings = await this.loadConfig();
    return { settings, lines: describeDriveConfig(settings) };
  }

  /** Diagnostic report; every step is independent so one failure is visible. */
  async diagnose() {
    const report = [];
    const push = (label, ok, detail = '') => report.push({ label, ok, detail });

    let settings;
    try {
      settings = await this.loadConfig({ force: true });
      push('Konfigurasi', true, `${this.paths.configFile}`);
    } catch (error) {
      push('Konfigurasi', false, error.message);
      return { ok: false, report };
    }
    push('Backend OAuth', true, settings.oauthBackend);
    push(
      'Kunci login Drive',
      true,
      'bawaan aplikasi (header x-ryuu-drive-auth, tidak dapat diubah)',
    );
    push('Mode', true, settings.enabled ? 'enabled' : 'disabled');

    let stored;
    try {
      stored = await this.loadCredentials({ force: true });
    } catch (error) {
      push('Credential', false, error.message);
      return { ok: false, report };
    }
    if (!stored) {
      push('Credential', false, 'belum ada. Jalankan /drive login.');
      return { ok: false, report };
    }
    push('Credential', true, `file terenkripsi: ${this.paths.credentialFile}`);
    push('Refresh token', Boolean(stored.refreshToken), stored.refreshToken ? 'tersedia' : 'tidak ada');
    push(
      'Access token kedaluwarsa',
      true,
      stored.expiryDate ? new Date(stored.expiryDate).toISOString() : 'tidak diketahui',
    );

    let about = null;
    try {
      const client = await this.getClient();
      about = await client.getAbout();
      push('Google Drive API', true, `terhubung sebagai ${about.email || '(tanpa email)'}`);
      this.lastCheck = new Date().toISOString();
      this.lastCheckOk = true;
    } catch (error) {
      push('Google Drive API', false, error.message);
      this.lastCheck = new Date().toISOString();
      this.lastCheckOk = false;
    }

    if (about?.storageQuota) {
      const quota = about.storageQuota;
      const fmt = (bytes) => (bytes === null || bytes === undefined ? 'tidak tersedia' : `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
      push('Storage', true, `terpakai ${fmt(quota.usage)} dari ${fmt(quota.limit)}`);
    }
    return { ok: report.every((row) => row.ok), report, account: about };
  }

  /** Everything /drive status prints, without any token. */
  async status() {
    let settings = null;
    let configError = null;
    try {
      settings = await this.loadConfig();
    } catch (error) {
      configError = error.message;
    }
    let auth = { connected: false };
    let authError = null;
    try {
      auth = await this.authInfo();
    } catch (error) {
      authError = error.message;
    }
    let quota = null;
    let account = null;
    if (auth.connected) {
      try {
        const stored = await this.loadCredentials();
        account = stored?.account || null;
        quota = stored?.account?.storageQuota || null;
      } catch {
        account = null;
      }
    }
    return {
      enabled: Boolean(settings?.enabled),
      authenticated: Boolean(auth.connected),
      auth,
      authError,
      configError,
      toolCount: this.tools.length,
      toolNames: this.tools.map((tool) => tool.name),
      settings,
      account,
      quota,
      lastCheck: this.lastCheck,
      lastCheckOk: this.lastCheckOk,
      paths: this.paths,
    };
  }

  /** Reset the file-based store (used by tests). */
  async resetConfigFile() {
    await writeDriveConfig({ ...DEFAULT_GOOGLE_DRIVE_CONFIG }, { paths: this.paths });
    this.settings = null;
  }
}

export function createGoogleDrivePlugin(options = {}) {
  return new GoogleDrivePlugin(options);
}

export { DEFAULT_GOOGLE_DRIVE_CONFIG };
