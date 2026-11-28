import process from 'node:process';

import { loadMonetizationEngine, MonetizationIntegrityError, prepareMonetizationEngine } from './index.js';
import { DEFAULT_ENGINE_API_BASE } from '../services/engine-binary.js';

/**
 * Scheduler iklan selama task AI berjalan.
 *
 * - Tidak pernah menampilkan iklan saat idle: `start()` hanya dipanggil dari
 *   lifecycle task dan `stop()` dipanggil di `finally`.
 * - Iklan pertama tampil segera setelah task mulai, lalu interval acak dari
 *   konfigurasi backend (default 2-5 menit). Iklan tidak bisa dimatikan lewat
 *   environment atau setting pengguna.
 * - Tidak memilih iklan yang sama dua kali berturut-turut selama ada opsi.
 * - Kegagalan jaringan/integritas tidak pernah membuat task gagal.
 * - Timer di-unref dan selalu dibersihkan; satu task = satu siklus hidup.
 */
export function createAdScheduler({
  engine = null,
  renderer,
  logger = null,
  baseURL = process.env.RYUU_ADS_API_BASE || null,
  cliVersion = 'unknown',
  fetchImpl = null,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let running = false;
  let timer = null;
  let loading = null;
  let ads = [];
  let config = null;
  let lastAdId = null;
  let sessionId = null;
  let resolvedBaseURL = baseURL;
  let fatal = false;
  let cycle = 0;
  let shown = 0;
  let preparing = null;

  // Beri taskStart/agent satu kesempatan menggambar UI dulu, lalu tampilkan
  // iklan pertama. Tanpa ini task pendek selesai sebelum interval 2-5 menit
  // dan pengguna tidak pernah melihat satu iklan pun.
  const FIRST_AD_DELAY_MS = 750;
  const FIRST_AD_RETRY_MS = 3000;

  const logWarn = (message, error) => {
    const detail = error?.message ? `: ${error.message}` : '';
    logger?.warn?.(`[monetization] ${message}${detail}`);
  };

  const getEngine = () => {
    if (engine) return engine;
    const loaded = loadMonetizationEngine({ logger });
    if (!loaded?.engine) return null;
    engine = loaded.engine;
    if (!resolvedBaseURL) resolvedBaseURL = engine.DEFAULT_API_BASE || DEFAULT_ENGINE_API_BASE;
    return engine;
  };

  /**
   * Engine yang sudah dibundel/cache dipakai lebih dulu; bila belum ada,
   * binary yang cocok diunduh dari backend (sekali per siklus task).
   */
  const ensureEngine = async () => {
    const existing = getEngine();
    if (existing) return existing;
    if (!preparing) {
      preparing = prepareMonetizationEngine({ logger }).finally(() => {
        preparing = null;
      });
    }
    const loaded = await preparing;
    if (!loaded?.engine) return null;
    engine = loaded.engine;
    if (!resolvedBaseURL) resolvedBaseURL = engine.DEFAULT_API_BASE || DEFAULT_ENGINE_API_BASE;
    if (!sessionId) sessionId = engine.createSessionId();
    return engine;
  };

  const clear = () => {
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (!running) return;
    clear();
    const engineRef = getEngine();
    if (!engineRef) {
      running = false;
      return;
    }
    const delay = engineRef.nextDelay(config, random);
    timer = setTimeoutImpl(tick, delay);
    timer?.unref?.();
  };

  const hydrate = async () => {
    const engineRef = await ensureEngine();
    if (!engineRef) return false;
    if (!resolvedBaseURL) resolvedBaseURL = engineRef.DEFAULT_API_BASE || DEFAULT_ENGINE_API_BASE;
    const result = await engineRef.fetchAds({
      baseURL: resolvedBaseURL,
      cliVersion,
      fetchImpl: fetchImpl || undefined,
      timeoutMs: 4000,
      retries: 1,
    });
    ads = result.ads;
    config = result.config;
    if (!config.enabled || ads.length === 0) {
      running = false;
      return false;
    }
    return true;
  };

  const tick = () => {
    timer = null;
    if (!running) return;
    try {
      // Jangan menimpa panel interaktif (approval/block view) atau TUI yang
      // sedang menampilkan overlay; coba lagi pada interval berikutnya.
      if (renderer?.isBlockViewOpen?.()) {
        schedule();
        return;
      }
      if (typeof renderer?.canShowAdvertisement === 'function' && !renderer.canShowAdvertisement()) {
        // Jawaban AI sedang streaming atau panel terbuka: coba lagi. Sebelum
        // iklan pertama tampil, coba lebih sering agar task pendek tetap
        // kebagian iklan; setelah itu jangan mengganggu streaming.
        timer = setTimeoutImpl(tick, shown === 0 ? FIRST_AD_RETRY_MS : 20000);
        timer?.unref?.();
        return;
      }

      const engineRef = getEngine();
      if (!engineRef) {
        running = false;
        return;
      }
      const ad = engineRef.pickAd(ads, lastAdId, random);
      if (!ad) {
        running = false;
        return;
      }

      const ansi = renderer?.ansi !== false && renderer?.plain !== true;
      const width = typeof renderer?.contentWidth === 'function' ? renderer.contentWidth() : 80;
      const clickUrl = engineRef.buildClickUrl(resolvedBaseURL, ad.id, { cliVersion, sessionId });
      const rendered = engineRef.renderAd(ad, {
        width,
        color: ansi,
        hyperlinks: ansi,
        clickUrl,
      });

      if (typeof renderer?.advertisement === 'function') {
        renderer.advertisement(rendered.lines, rendered.plainLines, {
          clickUrl: rendered.clickUrl,
          domain: rendered.domain,
        });
      } else if (typeof renderer?.lines === 'function') {
        renderer.lines(rendered.plainLines.join('\n'));
      } else {
        running = false;
        return;
      }

      lastAdId = ad.id;
      shown += 1;

      // Analytics hanya mencatat impression anonim; klik tidak pernah dikarang
      // dari sekadar teks yang tampil. Fire-and-forget, tidak memblokir task.
      Promise.resolve(
        engineRef.sendImpression({
          baseURL: resolvedBaseURL,
          adId: ad.id,
          cliVersion,
          sessionId,
          fetchImpl: fetchImpl || undefined,
        }),
      ).catch(() => {});

      schedule();
    } catch (error) {
      logWarn('gagal menampilkan iklan', error);
      schedule();
    }
  };

  return {
    get running() {
      return running;
    },

    get sessionId() {
      return sessionId;
    },

    get ads() {
      return ads;
    },

    get config() {
      return config;
    },

    /** Mulai siklus untuk satu task. Tidak pernah melempar ke pemanggil. */
    start() {
      if (running || fatal) return false;
      running = true;
      const generation = cycle + 1;
      cycle = generation;
      lastAdId = null;
      shown = 0;
      // Bila engine sudah tersedia (bundled/cache), siapkan sesi sekarang.
      // Bila belum, hydrate akan mengunduh binary yang cocok dari backend
      // lalu membuat sesi setelahnya.
      try {
        const engineRef = getEngine();
        if (engineRef) {
          if (!resolvedBaseURL) resolvedBaseURL = engineRef.DEFAULT_API_BASE || DEFAULT_ENGINE_API_BASE;
          sessionId = engineRef.createSessionId();
        }
      } catch (error) {
        running = false;
        if (error instanceof MonetizationIntegrityError) fatal = true;
        logWarn('modul monetisasi tidak dapat dimuat', error);
        return false;
      }

      loading = hydrate()
        .then((ready) => {
          if (!running || !ready || generation !== cycle) return;
          // Iklan pertama tidak menunggu 2-5 menit: tampil setelah UI task
          // sempat digambar, lalu interval normal berlaku untuk berikutnya.
          timer = setTimeoutImpl(tick, FIRST_AD_DELAY_MS);
          timer?.unref?.();
        })
        .catch((error) => {
          running = false;
          if (error instanceof MonetizationIntegrityError) fatal = true;
          logWarn('backend iklan tidak tersedia; iklan dilewati', error);
        })
        .finally(() => {
          loading = null;
        });

      return true;
    },

    /** Hentikan siklus task; aman dipanggil berkali-kali. */
    stop() {
      running = false;
      cycle += 1;
      clear();
      sessionId = null;
      // `loading` sengaja tidak di-abort: promise fetch akan selesai dan
      // memeriksa `running` sebelum menjadwalkan timer. Tidak ada timer bocor.
    },

    /** Untuk test/observability. */
    async ready() {
      if (loading) await loading;
      return running;
    },
  };
}
