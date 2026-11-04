import fsp from 'node:fs/promises';
import os from 'node:os';

import {
  DEFAULT_VERCEL_CONFIG,
  configurationPageUrl,
  describeVercelConfig,
  ensureVercelConfig,
  readVercelState,
  updateVercelConfig,
  validateConfigEntry,
  vercelPaths,
  writeVercelState,
} from './config.js';
import { clearCredentials, describeCredentials, loadCredentials, saveCredentials } from './credentials.js';
import { VercelBackendClient } from './backend.js';
import { VercelApi } from './api.js';
import { VercelPluginError, VERCEL_CODES } from './errors.js';
import { describeLoginFailure, openBrowser } from './auth.js';
import { createVercelTools } from './tools.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lifecycle plugin Vercel.
 *
 * Sama seperti plugin GitHub/Drive, tool hanya terdaftar saat
 * enabled + authenticated, dan setiap handler memanggil `requireClient()`
 * sehingga status diperiksa ulang saat eksekusi.
 *
 * Berbeda dari GitHub, tidak ada device flow: Vercel Integration memakai
 * halaman instalasi/OAuth di browser. CLI menunggu sesi backend lewat polling.
 */
export class VercelPlugin {
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
    this.name = 'vercel';
    this.version = '1.0.0';
    this.command = 'vercel';
    this.logger = logger;
    this.workspace = workspace;
    this.appConfig = config;
    this.paths = paths || vercelPaths();
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.settings = null;
    this.settingsMtime = null;
    this.configCreated = null;
    this.stored = null;
    this.loggingIn = false;
    this.lastCheck = null;
    this.lastCheckOk = null;

    this.backend = new VercelBackendClient({
      ...(backendUrl ? { baseUrl: backendUrl } : {}),
      getToken: () => this.stored?.cliToken || null,
      fetchImpl,
      logger,
    });
    this.api = new VercelApi({ backend: this.backend, logger });
    this.tools = createVercelTools(this);
  }

  get pathsInfo() {
    return { ...this.paths };
  }

  async loadConfig({ force = false } = {}) {
    const mtime = await fsp
      .stat(this.paths.configFile)
      .then((stat) => stat.mtimeMs)
      .catch(() => null);
    if (force || !this.settings || mtime !== this.settingsMtime) {
      // File yang belum ada dibuat otomatis; file yang tidak valid tetap
      // dilaporkan sebagai error dan tidak pernah ditimpa diam-diam.
      const { config, created } = await ensureVercelConfig({ paths: this.paths });
      this.settings = config;
      this.configCreated = created
        ? { path: this.paths.configFile, at: new Date(this.now()).toISOString() }
        : null;
      this.settingsMtime = await fsp
        .stat(this.paths.configFile)
        .then((stat) => stat.mtimeMs)
        .catch(() => null);
    }
    return this.settings;
  }

  /**
   * Preflight konfigurasi untuk command: tidak pernah melempar, sehingga
   * `/vercel …` selalu bisa menampilkan masalahnya di terminal.
   */
  async configDiagnostic({ force = true } = {}) {
    try {
      const config = await this.loadConfig({ force });
      return { ok: true, path: this.paths.configFile, config, created: this.configCreated };
    } catch (error) {
      return { ok: false, path: this.paths.configFile, error };
    }
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

  /** Guard setiap tool dan operasi yang membutuhkan Vercel. */
  async requireClient() {
    const settings = await this.loadConfig();
    if (!settings.enabled) {
      throw new VercelPluginError('Integrasi Vercel sedang nonaktif. Jalankan /vercel enable untuk mengaktifkannya.', {
        code: VERCEL_CODES.DISABLED,
      });
    }
    const info = await this.authInfo();
    if (!info.connected) {
      throw new VercelPluginError('Belum ada akun Vercel yang terhubung. Jalankan /vercel login.', {
        code: VERCEL_CODES.UNAUTHORIZED,
        status: 401,
        reconnect: true,
      });
    }
    if (info.cliTokenExpiresAt && Date.parse(info.cliTokenExpiresAt) <= this.now()) {
      throw new VercelPluginError('Sesi CLI Vercel sudah kedaluwarsa. Jalankan /vercel login lagi.', {
        code: VERCEL_CODES.UNAUTHORIZED,
        status: 401,
        reconnect: true,
      });
    }
    return this.api;
  }

  async saveState(patch) {
    const current = await readVercelState({ paths: this.paths });
    return writeVercelState({ ...current, ...patch }, { paths: this.paths });
  }

  #hostLabel() {
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
  // Login
  // ------------------------------------------------------------------

  async login({
    print = () => {},
    showCode = null,
    confirmReplace = null,
    openBrowser: shouldOpen = true,
    timeoutMs = null,
  } = {}) {
    if (this.loggingIn) throw new VercelPluginError('Login Vercel sedang berjalan.', { code: VERCEL_CODES.BUSY });
    const existing = await this.authInfo().catch(() => ({ connected: false }));
    if (existing.connected && (existing.username || existing.email) && confirmReplace) {
      const replace = await confirmReplace(
        `Akun Vercel ${existing.username ? `@${existing.username}` : existing.email} sudah terhubung. Ganti dengan akun lain? [y/N] `,
      );
      if (!replace) {
        print('Login dibatalkan. Kredensial yang ada tidak diubah.');
        return { connected: false, cancelled: true };
      }
    }

    this.loggingIn = true;
    try {
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.sessionTimeoutMs;
      const session = await this.backend.startSession({ label: this.#hostLabel() });
      let launched = false;
      if (shouldOpen) launched = openBrowser(session.url);
      const emitCode = typeof showCode === 'function' ? showCode : (block) => print(`\n${block.text}\n`);

      print(
        [
          'Vercel Authentication',
          '',
          launched
            ? 'Halaman instalasi Vercel dibuka di browser default.'
            : 'Browser tidak tersedia di mesin ini — buka tautan di bawah secara manual.',
          'Pilih akun/team Vercel, lalu setujui instalasi integrasi Ryuu CLI.',
          'Akses hanya mencakup scope yang disetujui pada halaman tersebut.',
        ].join('\n'),
      );
      emitCode({ label: 'login url', text: session.url });
      print(
        [
          session.redirectUri ? `Callback   : ${session.redirectUri}` : null,
          `Kedaluwarsa: ${session.expiresAt || '(10 menit)'}`,
          'Client Secret dan access token Vercel hanya ada di backend.',
          '',
          'Menunggu persetujuan pengguna…',
        ]
          .filter(Boolean)
          .join('\n'),
      );

      const result = await this.#waitForSession({
        sessionId: session.sessionId,
        pairingSecret: session.pairingSecret,
        timeoutMs: limit,
      });
      return await this.#completeLogin(result, { print });
    } catch (error) {
      if (error instanceof VercelPluginError) throw error;
      throw new VercelPluginError(describeLoginFailure(error), {
        code: error.code || VERCEL_CODES.SESSION,
        status: error.status || 0,
        retryable: Boolean(error.retryable),
      });
    } finally {
      this.loggingIn = false;
    }
  }

  async #waitForSession({ sessionId, pairingSecret, timeoutMs }) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      let result = null;
      try {
        result = await this.backend.pollSession({ sessionId, pairingSecret });
      } catch (error) {
        if (!error.retryable) throw error;
      }
      if (result?.status === 'authorized') return result;
      if (result?.status === 'error') {
        throw new VercelPluginError(result.message || 'Vercel menolak otorisasi.', {
          code: VERCEL_CODES.SESSION,
        });
      }
      await sleep(this.pollIntervalMs);
    }
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    throw new VercelPluginError(`Waktu login habis (${minutes} menit). Jalankan /vercel login lagi.`, {
      code: VERCEL_CODES.LOGIN_TIMEOUT,
    });
  }

  async #completeLogin(result, { print }) {
    if (!result?.cliToken) {
      throw new VercelPluginError('Backend tidak mengembalikan token akses CLI.', {
        code: VERCEL_CODES.SESSION,
        status: 502,
      });
    }
    const settings = await this.loadConfig();
    const account = result.account || {};
    const configuration = result.configuration || null;
    await saveCredentials(
      {
        cliToken: result.cliToken,
        ryuuUserId: result.ryuuUserId || null,
        cliTokenExpiresAt: result.cliTokenExpiresAt || null,
        account,
        configuration,
        backend: settings.backend,
      },
      { paths: this.paths },
    );
    this.stored = null;
    await this.loadCredentials({ force: true });
    if (!settings.enabled) {
      await updateVercelConfig('enabled', true, { paths: this.paths });
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
      ...(account.username ? { lastLogin: account.username } : {}),
    });

    print(
      [
        '[✓] Autentikasi berhasil!',
        '',
        `Akun          : ${account.username ? `@${account.username}` : account.email || '(tidak terbaca)'}`,
        account.name ? `Nama          : ${account.name}` : null,
        `Configuration : ${configuration?.id || '(akun tanpa configuration)'}`,
        configuration?.teamId ? `Team          : ${configuration.teamId}` : null,
        `Instalasi     : ${result.ready === false ? 'perlu instalasi ulang di team/project' : 'siap dipakai'}`,
        `Verifikasi    : ${backendOk ? 'backend merespons' : `gagal (${backendError})`}`,
        result.warning ? `Catatan       : ${result.warning}` : null,
        '',
        `Vercel aktif. ${this.tools.length} tool tersedia untuk AI Agent.`,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
    return { connected: true, account, configuration, enabled: true };
  }

  // ------------------------------------------------------------------
  // Logout & lifecycle
  // ------------------------------------------------------------------

  async logout({ print = () => {} } = {}) {
    const stored = await loadCredentials({ paths: this.paths }).catch(() => null);
    if (!stored?.cliToken) {
      await clearCredentials({ paths: this.paths }).catch(() => {});
      this.stored = null;
      print('Belum ada akun Vercel yang terhubung di mesin ini.');
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
      await updateVercelConfig('enabled', false, { paths: this.paths });
      this.settings = null;
    }
    print('Koneksi Vercel diputus di mesin ini. Kredensial lokal dihapus.');
    print(
      remote?.disconnected
        ? 'Token Vercel di backend: dihapus dari penyimpanan terenkripsi.'
        : `Backend tidak dapat dihubungi (${remoteError}); token di server mungkin masih tersimpan.`,
    );
    print('Project, deployment, domain, dan resource Vercel tidak diubah.');
    print('Untuk mencabut instalasi sepenuhnya, hapus integrasi dari Vercel Integrations Console.');
    return { connected: false, remote: Boolean(remote?.disconnected), revoked: Boolean(remote?.revoked) };
  }

  async enable() {
    if (!(await this.isAuthenticated())) {
      throw new VercelPluginError('Belum ada akun Vercel yang terhubung. Jalankan /vercel login lebih dulu.', {
        code: VERCEL_CODES.UNAUTHORIZED,
        status: 401,
      });
    }
    await updateVercelConfig('enabled', true, { paths: this.paths });
    this.settings = null;
    return { enabled: true, tools: this.tools.map((tool) => tool.name) };
  }

  async disable() {
    await updateVercelConfig('enabled', false, { paths: this.paths });
    this.settings = null;
    return { enabled: false };
  }

  async setConfig(key, value) {
    const parsed = validateConfigEntry(key, value);
    await updateVercelConfig(key, parsed, { paths: this.paths });
    this.settings = null;
    return parsed;
  }

  async configView() {
    const settings = await this.loadConfig({ force: true });
    return { settings, lines: describeVercelConfig(settings), created: this.configCreated };
  }

  /** URL halaman Configure yang dipanggil Vercel. */
  async configureUrl() {
    const settings = await this.loadConfig();
    const stored = await this.loadCredentials().catch(() => null);
    return configurationPageUrl(settings, { configurationId: stored?.configuration?.id || null });
  }

  // ------------------------------------------------------------------
  // Status, akun, test
  // ------------------------------------------------------------------

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
    const sessionExpired = Boolean(auth.cliTokenExpiresAt && Date.parse(auth.cliTokenExpiresAt) <= this.now());
    const authenticated = Boolean(auth.connected) && !sessionExpired;
    let remote = null;
    let remoteError = null;
    if (authenticated) {
      try {
        remote = await this.backend.status();
      } catch (error) {
        remoteError = error.message;
      }
    }
    return {
      enabled: Boolean(settings?.enabled),
      authenticated,
      sessionExpired,
      auth,
      authError,
      configError,
      settings,
      remote,
      remoteError,
      paths: this.paths,
      toolCount: this.tools.length,
      lastCheck: this.lastCheck,
      lastCheckOk: this.lastCheckOk,
    };
  }

  async account() {
    const info = await this.authInfo();
    if (!info.connected) {
      throw new VercelPluginError('Belum ada akun Vercel yang terhubung. Jalankan /vercel login.', {
        code: VERCEL_CODES.UNAUTHORIZED,
        status: 401,
        reconnect: true,
      });
    }
    let remote = null;
    let remoteError = null;
    try {
      remote = await this.backend.account();
    } catch (error) {
      remoteError = error.message;
    }
    return {
      connected: true,
      username: info.username,
      name: info.name,
      email: info.email,
      configuration: info.configuration,
      remote,
      remoteError,
    };
  }

  /** Diagnostik read-only; tidak mengubah resource Vercel. */
  async test() {
    const settings = await this.loadConfig();
    const report = [
      { label: 'Konfigurasi CLI', ok: true, detail: this.paths.configFile },
      { label: 'Integrasi aktif', ok: Boolean(settings.enabled), detail: settings.enabled ? 'enabled' : 'disabled' },
      { label: 'Client Secret di CLI', ok: true, detail: 'tidak ada (hanya backend)' },
    ];
    if (!(await this.isAuthenticated())) {
      report.push({ label: 'Autentikasi', ok: false, detail: 'belum login — jalankan /vercel login' });
      return { ok: false, report };
    }
    let remote;
    try {
      remote = await this.backend.test();
    } catch (error) {
      report.push({ label: 'Backend test', ok: false, detail: error.message });
      return { ok: false, report };
    }
    for (const row of remote.report || []) report.push(row);
    return { ok: report.every((row) => row.ok), report };
  }

  async updateCredentials(patch) {
    const stored = await this.loadCredentials({ force: true });
    if (!stored?.cliToken) return null;
    await saveCredentials(
      {
        cliToken: stored.cliToken,
        ryuuUserId: stored.ryuuUserId,
        cliTokenExpiresAt: stored.cliTokenExpiresAt,
        account: patch.account || stored.account,
        configuration: patch.configuration || stored.configuration,
        backend: stored.backend,
      },
      { paths: this.paths },
    );
    this.stored = null;
    return this.loadCredentials({ force: true });
  }
}

export function createVercelPlugin(options = {}) {
  return new VercelPlugin(options);
}

export { DEFAULT_VERCEL_CONFIG };
