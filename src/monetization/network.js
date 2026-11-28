/**
 * I/O jaringan untuk engine monetisasi.
 *
 * Addon native tidak bisa menunggu `fetch` (N-API tidak punya await), jadi
 * pengambilan iklan dan pengiriman impression tetap di sini. Bagian ini hanya
 * transport: normalisasi payload, pemilihan iklan, dan renderer tetap berada di
 * binary `engine.node`. Tidak ada kebijakan iklan atau data pengguna di file
 * ini selain endpoint dan timeout.
 */

const DEFAULT_API_BASE = 'https://restapi.ryuu-dev.my.id';

function baseOf(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/, '');
}

/**
 * Lengkapi engine native dengan `fetchAds`/`sendImpression`. Engine source
 * development sudah membawa fungsi ini, jadi objek yang sama dikembalikan.
 */
export function attachNetwork(engine) {
  if (typeof engine.fetchAds === 'function' && typeof engine.sendImpression === 'function') {
    return engine;
  }
  const wrapped = Object.assign({}, engine);

  wrapped.fetchAds = async (options = {}) => {
    const opts = options || {};
    const baseURL = baseOf(opts.baseURL);
    const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 4000);
    const retries = Math.max(0, Math.min(3, Number(opts.retries) || 0));
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch tidak tersedia pada runtime ini.');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const response = await fetchImpl(`${baseURL}/api/v1/ads`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': `ryuu-cli/${wrapped.sanitizeText(opts.cliVersion || 'unknown', 32)}`,
          },
          signal: controller.signal,
        });
        if (!response || !response.ok) {
          const status = response && response.status ? response.status : 'network';
          throw new Error(`Backend iklan membalas ${status}.`);
        }
        const payload = await response.json();
        const normalized = wrapped.normalizePayload(payload);
        return { ...normalized, fetchedAt: Date.now(), source: baseURL };
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => {
            const delay = setTimeout(resolve, 300 * (attempt + 1));
            delay.unref?.();
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('Gagal mengambil iklan.');
  };

  wrapped.sendImpression = async (options = {}) => {
    const opts = options || {};
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return false;
    const baseURL = baseOf(opts.baseURL);
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 3000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${baseURL}/api/v1/ads/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `ryuu-cli/${wrapped.sanitizeText(opts.cliVersion || 'unknown', 32)}`,
        },
        body: JSON.stringify({
          adId: opts.adId,
          type: 'ad_impression',
          cliVersion: wrapped.sanitizeText(opts.cliVersion || '', 32) || null,
          sessionId: wrapped.sanitizeText(opts.sessionId || '', 64) || null,
        }),
        signal: controller.signal,
      });
      return Boolean(response && response.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  return wrapped;
}
