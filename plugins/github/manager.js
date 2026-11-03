import fsp from 'node:fs/promises';
import os from 'node:os';

import { RyuuError } from '../../src/utils/errors.js';
import {
  DEFAULT_GITHUB_CONFIG,
  describeGitHubConfig,
  githubPaths,
  readGitHubConfig,
  readGitHubState,
  updateGitHubConfig,
  validateConfigEntry,
  writeGitHubConfig,
  writeGitHubState,
} from './config.js';
import { clearCredentials, describeCredentials, loadCredentials, saveCredentials } from './credentials.js';
import { GitHubBackendClient } from './backend.js';
import { GitHubApi } from './api.js';
import { GitHubPluginError, GITHUB_CODES } from './errors.js';
import { describeLoginFailure, openBrowser } from './auth.js';
import { createGitHubTools } from './tools.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lifecycle plugin GitHub.
 *
 * Status yang dihormati sama seperti plugin Google Drive:
 *   enabled + authenticated    → tool terdaftar dan bisa dipakai
 *   disabled + authenticated   → tool tidak diberikan ke model
 *   enabled + unauthenticated  → tool tidak diberikan, /github login disarankan
 *
 * Setiap handler tool memanggil `requireClient()`, yang memeriksa ulang status
 * saat eksekusi. Model yang memegang daftar tool lama tidak bisa bertindak
 * setelah `/github disable`.
 */
export class GitHubPlugin {
  constructor({
    logger = null,
    workspace = null,
    config = null,
    paths = null,
    backendUrl = undefined,
    fetchImpl = null,
    now = () => Date.now(),
    pollIntervalMs = 2000,
    sessionTimeoutMs = 300000,
  } = {}) {
    this.name = 'github';
    this.version = '1.0.0';
    this.command = 'github';
    this.logger = logger;
    this.workspace = workspace;
    this.appConfig = config;
    this.paths = paths || githubPaths();
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.settings = null;
    this.settingsMtime = null;
    this.stored = null;
    this.loggingIn = false;
    this.lastCheck = null;
    this.lastCheckOk = null;

    this.backend = new GitHubBackendClient({
      ...(backendUrl ? { baseUrl: backendUrl } : {}),
      getToken: () => this.stored?.cliToken || null,
      fetchImpl,
      logger,
    });
    this.api = new GitHubApi({ backend: this.backend, logger });
    this.tools = createGitHubTools(this);
  }

  get pathsInfo() {
    return { ...this.paths };
  }

  /** Konfigurasi di-cache dengan invalidasi mtime agar perubahan luar terlihat. */
  async loadConfig({ force = false } = {}) {
    const mtime = await fsp
      .stat(this.paths.configFile)
      .then((stat) => stat.mtimeMs)
      .catch(() => null);
    if (force || !this.settings || mtime !== this.settingsMtime) {
      this.settings = await readGitHubConfig({ paths: this.paths });
      this.settingsMtime = mtime;
    }
    return this.settings;
  }

  async loadCredentials({ force = false } = {}) {
    if (!this.stored || force) this.stored = await loadCredentials({ paths: this.paths });
    return this.stored;
  }

  /** Metadata kredensial; tidak pernah memuat cliToken. */
  async authInfo() {
    const stored = await this.loadCredentials();
    return describeCredentials(stored);
  }

  async isAuthenticated() {
    const info = await this.authInfo();
    if (!info.connected) return false;
    if (info.cliTokenExpiresAt && Date.parse(info.cliTokenExpiresAt) <= this.now()) return false;
    return true;
  }

  async isEnabled() {
    const settings = await this.loadConfig();
    return Boolean(settings.enabled);
  }

  /** Guard setiap tool dan operasi yang membutuhkan GitHub. */
  async requireClient() {
    const settings = await this.loadConfig();
    if (!settings.enabled) {
      throw new GitHubPluginError(
        'Integrasi GitHub sedang nonaktif. Jalankan /github enable untuk mengaktifkannya.',
        { code: GITHUB_CODES.DISABLED },
      );
    }
    const info = await this.authInfo();
    if (!info.connected) {
      throw new GitHubPluginError('Belum ada akun GitHub yang terhubung. Jalankan /github login.', {
        code: GITHUB_CODES.UNAUTHORIZED,
        status: 401,
        reconnect: true,
      });
    }
    if (info.cliTokenExpiresAt && Date.parse(info.cliTokenExpiresAt) <= this.now()) {
      throw new GitHubPluginError('Sesi CLI GitHub sudah kedaluwarsa. Jalankan /github login lagi.', {
        code: GITHUB_CODES.UNAUTHORIZED,
        status: 401,
        reconnect: true,
      });
    }
    return this.api;
  }

  async saveState(patch) {
    const current = await readGitHubState({ paths: this.paths });
    return writeGitHubState({ ...current, ...patch }, { paths: this.paths });
  }

  // ------------------------------------------------------------------
  // Login
  // ------------------------------------------------------------------

  /** Login browser (utama) atau device flow (fallback headless). */
  async login({
    print = () => {},
    showCode = null,
    confirmReplace = null,
    openBrowser: shouldOpen = true,
    device = false,
    timeoutMs = null,
  } = {}) {
    if (this.loggingIn) {
      throw new GitHubPluginError('Login GitHub sedang berjalan.', { code: GITHUB_CODES.BUSY });
    }
    const existing = await this.authInfo().catch(() => ({ connected: false }));
    if (existing.connected && existing.login && confirmReplace) {
      const replace = await confirmReplace(
        `Akun GitHub @${existing.login} sudah terhubung. Ganti dengan akun lain? [y/N] `,
      );
      if (!replace) {
        print('Login dibatalkan. Kredensial yang ada tidak diubah.');
        return { connected: false, cancelled: true };
      }
    }

    this.loggingIn = true;
    try {
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.sessionTimeoutMs;
      if (device) return await this.#loginDevice({ print, timeoutMs: limit });
      return await this.#loginBrowser({ print, showCode, shouldOpen, timeoutMs: limit });
    } catch (error) {
      if (error instanceof GitHubPluginError) throw error;
      throw new GitHubPluginError(describeLoginFailure(error), {
        code: error.code || GITHUB_CODES.SESSION,
        status: error.status || 0,
        retryable: Boolean(error.retryable),
      });
    } finally {
      this.loggingIn = false;
    }
  }

  async #loginBrowser({ print, showCode, shouldOpen, timeoutMs }) {
    const session = await this.backend.startSession({ label: this.#deviceLabel() });
    let launched = false;
    if (shouldOpen) launched = openBrowser(session.url);

    const emitCode = typeof showCode === 'function' ? showCode : (block) => print(`\n${block.text}\n`);
    print(
      [
        'GitHub Authentication',
        '',
        launched
          ? 'Halaman otorisasi GitHub dibuka di browser default.'
          : 'Browser tidak tersedia di mesin ini — buka tautan di bawah secara manual.',
        'Setujui akses untuk akun GitHub yang ingin dihubungkan.',
      ].join('\n'),
    );
    emitCode({ label: 'login url', text: session.url });
    print(
      [
        `Callback   : ${session.redirectUri || '(dikelola backend)'}`,
        `Kedaluwarsa: ${session.expiresAt || '(10 menit)'}`,
        'Client Secret dan token GitHub tidak pernah disimpan di CLI.',
        '',
        'Menunggu persetujuan pengguna…',
      ].join('\n'),
    );

    const result = await this.#waitForSession({
      sessionId: session.sessionId,
      pairingSecret: session.pairingSecret,
      timeoutMs,
    });
    return this.#completeLogin(result, { print });
  }

  async #loginDevice({ print, timeoutMs }) {
    const session = await this.backend.startDevice();
    print(
      [
        'GitHub Device Login',
        '',
        `1. Buka ${session.verificationUri}`,
        `2. Masukkan kode: ${session.userCode}`,
        '3. Setujui akses untuk Ryuu CLI.',
        '',
        'Menunggu persetujuan pengguna…',
      ].join('\n'),
    );
    const deadline = this.now() + timeoutMs;
    let interval = Math.max(5, Number(session.interval) || 5);
    while (this.now() < deadline) {
      const result = await this.backend.pollDevice({
        sessionId: session.sessionId,
        pairingSecret: session.pairingSecret,
      });
      if (result.status === 'authorized') return this.#completeLogin(result, { print });
      if (result.status === 'error') {
        throw new GitHubPluginError(result.message || 'Device flow gagal.', {
          code: GITHUB_CODES.SESSION,
        });
      }
      if (Number.isFinite(result.interval)) interval = Math.max(5, Number(result.interval));
      await sleep(interval * 1000);
    }
    throw new GitHubPluginError('Waktu login device flow habis. Jalankan /github login --device lagi.', {
      code: GITHUB_CODES.LOGIN_TIMEOUT,
    });
  }

  async #waitForSession({ sessionId, pairingSecret, timeoutMs }) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      let result = null;
      try {
        result = await this.backend.pollSession({ sessionId, pairingSecret });
      } catch (error) {
        // Gangguan jaringan sesaat tidak membatalkan login; sesi tetap valid
        // sampai masa berlakunya habis.
        if (!error.retryable) throw error;
      }
      if (result?.status === 'authorized') return result;
      if (result?.status === 'error') {
        throw new GitHubPluginError(result.message || 'GitHub menolak otorisasi.', {
          code: GITHUB_CODES.SESSION,
        });
      }
      await sleep(this.pollIntervalMs);
    }
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    throw new GitHubPluginError(`Waktu login habis (${minutes} menit). Jalankan /github login lagi.`, {
      code: GITHUB_CODES.LOGIN_TIMEOUT,
    });
  }

  async #completeLogin(result, { print }) {
    if (!result?.cliToken) {
      throw new GitHubPluginError('Backend tidak mengembalikan token akses CLI.', {
        code: GITHUB_CODES.SESSION,
        status: 502,
      });
    }
    const settings = await this.loadConfig();
    const account = result.account || {};
    await saveCredentials(
      {
        cliToken: result.cliToken,
        ryuuUserId: result.ryuuUserId || null,
        cliTokenExpiresAt: result.cliTokenExpiresAt || null,
        account,
        backend: settings.backend,
      },
      { paths: this.paths },
    );
    this.stored = null;
    await this.loadCredentials({ force: true });
    if (!settings.enabled) {
      await updateGitHubConfig('enabled', true, { paths: this.paths });
      this.settings = null;
    }

    let backendOk = true;
    let backendError = null;
    try {
      await this.backend.status();
    } catch (error) {
      backendOk = false;
      backendError = error.message;
    }
    this.lastCheck = new Date(this.now()).toISOString();
    this.lastCheckOk = backendOk;
    await this.saveState({
      lastCheck: this.lastCheck,
      backendOk,
      ...(account.login ? { lastLogin: account.login } : {}),
    });

    print(
      [
        '[✓] Autentikasi berhasil!',
        '',
        `Akun       : @${account.login || '(tidak terbaca)'}`,
        account.name ? `Nama       : ${account.name}` : null,
        account.type ? `Tipe akun  : ${account.type}` : null,
        account.scope ? `Scope      : ${account.scope}` : null,
        `Instalasi  : ${Array.isArray(account.installations) ? account.installations.length : 0} terlihat`,
        `Verifikasi : ${backendOk ? 'backend merespons' : `gagal (${backendError})`}`,
        '',
        `GitHub aktif. ${this.tools.length} tool tersedia untuk AI Agent.`,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
    return { connected: true, account, enabled: true };
  }

  #deviceLabel() {
    const host = (() => {
      try {
        return os.hostname();
      } catch {
        return 'cli';
      }
    })();
    return `ryuu-cli@${host}`.slice(0, 60);
  }

  // ------------------------------------------------------------------
  // Logout & lifecycle
  // ------------------------------------------------------------------

  async logout({ print = () => {} } = {}) {
    const stored = await loadCredentials({ paths: this.paths }).catch(() => null);
    if (!stored?.cliToken) {
      await clearCredentials({ paths: this.paths }).catch(() => {});
      this.stored = null;
      print('Belum ada akun GitHub yang terhubung di mesin ini.');
      return { connected: false, remote: false };
    }
    let remote = null;
    let remoteError = null;
    try {
      remote = await this.backend.disconnect();
    } catch (error) {
      remoteError = error.message;
    }
    await clearCredentials({ paths: this.paths });
    this.stored = null;
    const settings = await this.loadConfig();
    if (settings.enabled) {
      await updateGitHubConfig('enabled', false, { paths: this.paths });
      this.settings = null;
    }
    print('Koneksi GitHub diputus di mesin ini. Kredensial lokal dihapus.');
    print(
      remote?.revoked
        ? 'Revocation token di GitHub: berhasil.'
        : remote
          ? `Revocation token di GitHub: dilewati (${remote.reason || 'tidak ada token'}).`
          : `Backend tidak dapat dihubungi (${remoteError}); token di server mungkin masih tersimpan.`,
    );
    print('Repository, issue, dan release di GitHub tidak diubah.');
    return { connected: false, remote: Boolean(remote?.disconnected), revoked: Boolean(remote?.revoked) };
  }

  async enable() {
    if (!(await this.isAuthenticated())) {
      throw new GitHubPluginError('Belum ada akun GitHub yang terhubung. Jalankan /github login lebih dulu.', {
        code: GITHUB_CODES.UNAUTHORIZED,
        status: 401,
      });
    }
    const settings = await this.loadConfig();
    if (!settings.clientId) {
      throw new GitHubPluginError('Client ID GitHub tidak tersedia pada konfigurasi plugin.', {
        code: GITHUB_CODES.CONFIG,
      });
    }
    await updateGitHubConfig('enabled', true, { paths: this.paths });
    this.settings = null;
    return { enabled: true, tools: this.tools.map((tool) => tool.name) };
  }

  async disable() {
    await updateGitHubConfig('enabled', false, { paths: this.paths });
    this.settings = null;
    return { enabled: false };
  }

  async setConfig(key, value) {
    const parsed = validateConfigEntry(key, value);
    await updateGitHubConfig(key, parsed, { paths: this.paths });
    this.settings = null;
    return parsed;
  }

  async configView() {
    const settings = await this.loadConfig({ force: true });
    return { settings, lines: describeGitHubConfig(settings) };
  }

  // ------------------------------------------------------------------
  // Status, akun, test
  // ------------------------------------------------------------------

  /** Status lengkap tanpa token; kegagalan backend dilaporkan, tidak dilempar. */
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
    const sessionExpired = Boolean(
      auth.cliTokenExpiresAt && Date.parse(auth.cliTokenExpiresAt) <= this.now(),
    );
    const authenticated = Boolean(auth.connected) && !sessionExpired;
    let remote = null;
    let remoteError = null;
    if (authenticated) {
      try {
        remote = await this.backend.status();
        this.lastCheck = new Date(this.now()).toISOString();
        this.lastCheckOk = true;
        await this.saveState({ lastCheck: this.lastCheck, backendOk: true });
      } catch (error) {
        remoteError = error.message;
        this.lastCheck = new Date(this.now()).toISOString();
        this.lastCheckOk = false;
        await this.saveState({ lastCheck: this.lastCheck, backendOk: false });
      }
    }
    return {
      enabled: Boolean(settings?.enabled),
      authenticated,
      sessionExpired,
      auth,
      authError,
      configError,
      remote,
      remoteError,
      toolCount: this.tools.length,
      toolNames: this.tools.map((tool) => tool.name),
      settings,
      lastCheck: this.lastCheck,
      lastCheckOk: this.lastCheckOk,
      paths: this.paths,
    };
  }

  async account() {
    if (!(await this.isAuthenticated())) {
      throw new GitHubPluginError('Belum ada akun GitHub yang terhubung. Jalankan /github login.', {
        code: GITHUB_CODES.UNAUTHORIZED,
        status: 401,
      });
    }
    const account = await this.backend.account();
    if (account?.login) {
      const stored = await this.loadCredentials();
      if (stored?.cliToken) {
        await saveCredentials(
          {
            cliToken: stored.cliToken,
            ryuuUserId: stored.ryuuUserId,
            cliTokenExpiresAt: stored.cliTokenExpiresAt,
            account: { ...stored.account, ...account },
            backend: stored.backend,
          },
          { paths: this.paths },
        );
        this.stored = null;
      }
    }
    return account;
  }

  /**
   * Diagnostik aman: konfigurasi, sesi, backend, GET /user, instalasi, token.
   * Tidak membuat, mengubah, atau menghapus repository.
   */
  async test() {
    const report = [];
    const push = (label, ok, detail = '') => report.push({ label, ok, detail });

    let settings;
    try {
      settings = await this.loadConfig({ force: true });
      push('Konfigurasi plugin', true, this.paths.configFile);
    } catch (error) {
      push('Konfigurasi plugin', false, error.message);
      return { ok: false, report };
    }
    push('Client ID', Boolean(settings.clientId), settings.clientId || 'tidak tersedia');
    push('Backend', Boolean(settings.backend), settings.backend);
    push(
      'Rahasia di CLI',
      true,
      'client secret/private key/access token tidak disimpan di CLI',
    );

    const info = await this.authInfo().catch((error) => ({ connected: false, error: error.message }));
    if (!info.connected) {
      push('Sesi CLI', false, 'belum login. Jalankan /github login.');
      return { ok: false, report };
    }
    push('Sesi CLI', true, `akun @${info.login || '(tanpa login)'}`);
    if (info.cliTokenExpiresAt) {
      const expired = Date.parse(info.cliTokenExpiresAt) <= this.now();
      push('Masa berlaku sesi', !expired, `${info.cliTokenExpiresAt}${expired ? ' (kedaluwarsa)' : ''}`);
    }

    let remote = null;
    try {
      remote = await this.backend.status();
      push('Respon backend', true, `terhubung${remote?.backend?.apiVersion ? ` (API ${remote.backend.apiVersion})` : ''}`);
    } catch (error) {
      push('Respon backend', false, error.message);
    }
    push('Status integrasi', settings.enabled, settings.enabled ? 'enabled' : 'disabled');

    if (remote?.token) {
      push(
        'Access token',
        !remote.token.expired,
        remote.token.accessExpiresAt
          ? `berlaku sampai ${remote.token.accessExpiresAt}`
          : 'tanpa masa berlaku (expiration off)',
      );
      push(
        'Refresh token',
        Boolean(remote.token.hasRefreshToken),
        remote.token.hasRefreshToken ? 'tersedia di backend' : 'tidak tersedia',
      );
      push(
        'Instalasi',
        Array.isArray(remote.installations) && remote.installations.length > 0,
        `${Array.isArray(remote.installations) ? remote.installations.length : 0} instalasi terlihat`,
      );
    }

    try {
      const tested = await this.backend.test();
      for (const row of tested?.report || []) push(`GitHub: ${row.label}`, row.ok, row.detail || '');
    } catch (error) {
      push('GitHub API', false, error.message);
    }
    push('Tool terdaftar', true, `${this.tools.length} tool didefinisikan`);

    this.lastCheck = new Date(this.now()).toISOString();
    this.lastCheckOk = report.every((row) => row.ok);
    await this.saveState({ lastCheck: this.lastCheck, backendOk: this.lastCheckOk });
    return { ok: this.lastCheckOk, report, account: remote?.github || null };
  }

  async refresh() {
    const result = await this.backend.refresh();
    this.lastCheck = new Date(this.now()).toISOString();
    this.lastCheckOk = true;
    await this.saveState({ lastCheck: this.lastCheck, backendOk: true });
    return result;
  }

  /** Reset konfigurasi ke default (dipakai test). */
  async resetConfigFile() {
    await writeGitHubConfig({ ...DEFAULT_GITHUB_CONFIG }, { paths: this.paths });
    this.settings = null;
  }
}

export function createGitHubPlugin(options = {}) {
  return new GitHubPlugin(options);
}

export { DEFAULT_GITHUB_CONFIG };
