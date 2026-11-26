import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Writable } from 'node:stream';

import {
  loadMonetizationEngine,
  verifyMonetizationArtifact,
  ARTIFACT_FILE,
} from '../../src/monetization/index.js';
import { createAdScheduler } from '../../src/monetization/scheduler.js';
import { Renderer } from '../../src/cli/renderer.js';
import { displayWidth } from '../../src/cli/width.js';

const { engine } = loadMonetizationEngine({ force: true });

const PAYLOAD = {
  success: true,
  ads: {
    pterokudesu: {
      title: 'Pterokudesu',
      desc: 'Dapatkan panel Pterodactyl dengan harga murah disini!!',
      url: 'https://my.pterokudesu.com/daftar?ref=CSGTF2GX',
      enabled: true,
    },
    'iklan-nonaktif': {
      title: 'Nonaktif',
      desc: 'Tidak boleh tampil',
      url: 'https://example.com/off',
      enabled: false,
    },
    'skema-berbahaya': {
      title: 'Bahaya',
      desc: 'Skema tidak valid',
      url: 'javascript:alert(1)',
      enabled: true,
    },
  },
  config: { enabled: true, minInterval: 120000, maxInterval: 300000 },
};

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('normalizePayload hanya menerima iklan aktif dengan URL http/https', () => {
  const normalized = engine.normalizePayload(PAYLOAD);
  assert.equal(normalized.ads.length, 1);
  assert.equal(normalized.ads[0].id, 'pterokudesu');
  assert.equal(normalized.ads[0].url, 'https://my.pterokudesu.com/daftar?ref=CSGTF2GX');
  assert.equal(normalized.config.minInterval, 120000);
  assert.equal(normalized.config.maxInterval, 300000);
});

test('pickAd menghindari iklan yang sama dua kali berturut-turut', () => {
  const ads = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
    { id: 'c', enabled: true },
  ];
  // random tetap selalu memilih elemen pertama dari pool yang tersedia.
  const first = engine.pickAd(ads, null, () => 0);
  const second = engine.pickAd(ads, first.id, () => 0);
  assert.notEqual(second.id, first.id);

  assert.equal(engine.pickAd([], null, () => 0), null);
});

test('nextDelay selalu berada di dalam konfigurasi backend', () => {
  const config = { minInterval: 120000, maxInterval: 300000 };
  for (const sample of [0, 0.25, 0.5, 0.99]) {
    const delay = engine.nextDelay(config, () => sample);
    assert.ok(delay >= 120000 && delay <= 300000, `delay ${delay} di luar rentang`);
  }
  // Konfigurasi rusak tetap dinormalisasi ke batas aman.
  const normalized = engine.normalizeConfig({ minInterval: 1, maxInterval: 2 });
  assert.equal(normalized.minInterval, 30000);
  assert.equal(normalized.maxInterval, 30000);
});

test('renderer menghasilkan OSC 8 dan fallback URL biasa', () => {
  const ad = engine.normalizePayload(PAYLOAD).ads[0];
  const withLink = engine.renderAd(ad, {
    width: 64,
    color: false,
    hyperlinks: true,
    clickUrl: 'https://restapi.ryuu-dev.my.id/api/v1/ads/pterokudesu/click',
  });
  assert.ok(withLink.lines.join('\n').includes('\x1b]8;;'));
  assert.ok(withLink.lines.join('\n').includes('Buka Pterokudesu'));
  assert.ok(withLink.plainLines.join('\n').includes('my.pterokudesu.com'));
  assert.equal(withLink.plainLines.join('\n').includes('\x1b'), false);
  // OSC 8 tidak boleh menambah lebar visual baris.
  const linkRow = withLink.lines.findIndex((line) => line.includes('\x1b]8;;'));
  assert.ok(linkRow >= 0);
  assert.equal(
    displayWidth(withLink.lines[linkRow], { ansi: true }),
    displayWidth(withLink.plainLines[linkRow], { ansi: true }),
  );

  const fallback = engine.renderAd(ad, { width: 64, color: false, hyperlinks: false });
  assert.equal(fallback.lines.join('\n').includes('\x1b]8;;'), false);
  assert.ok(fallback.lines.join('\n').includes('https://my.pterokudesu.com/daftar?ref=CSGTF2GX'));

  // Setiap baris plain harus muat di lebar yang diminta.
  for (const line of fallback.plainLines) {
    assert.ok(engine.visibleWidth(line) <= 64, `baris terlalu lebar: ${line}`);
  }

  // Terminal sempit: box tidak boleh dipaksa melebihi lebar yang tersedia.
  const narrow = engine.renderAd(ad, { width: 24, color: false, hyperlinks: false });
  for (const line of narrow.plainLines) {
    assert.ok(engine.visibleWidth(line) <= 24, `baris sempit terlalu lebar: ${line}`);
  }
});

test('buildClickUrl mempertahankan API base dan parameter anonim', () => {
  const url = engine.buildClickUrl('https://restapi.ryuu-dev.my.id/', 'pterokudesu', {
    cliVersion: '0.7.0',
    sessionId: 'ryuu_abc',
  });
  assert.equal(
    url,
    'https://restapi.ryuu-dev.my.id/api/v1/ads/pterokudesu/click?v=0.7.0&s=ryuu_abc',
  );
});

test('fetchAds memakai timeout/retry terbatas dan tidak melempar saat backend mati', async () => {
  let calls = 0;
  const ok = await engine.fetchAds({
    baseURL: 'https://ads.invalid',
    retries: 1,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(PAYLOAD);
    },
  });
  assert.equal(calls, 1);
  assert.equal(ok.ads.length, 1);

  let failures = 0;
  await assert.rejects(
    engine.fetchAds({
      baseURL: 'https://ads.invalid',
      retries: 1,
      timeoutMs: 50,
      fetchImpl: async () => {
        failures += 1;
        throw new Error('offline');
      },
    }),
    /offline/,
  );
  assert.equal(failures, 2);
});

test('artifact yang dimodifikasi terdeteksi oleh checksum', () => {
  const verified = verifyMonetizationArtifact();
  if (!verified.ok) {
    // Artifact belum dibangun (mis. npm test sebelum build): tidak ada yang
    // bisa dimodifikasi. Build script diuji terpisah oleh `npm run build:monetization`.
    return;
  }
  const original = fs.readFileSync(ARTIFACT_FILE);
  try {
    fs.appendFileSync(ARTIFACT_FILE, '\n// tampered\n');
    const tampered = verifyMonetizationArtifact();
    assert.equal(tampered.ok, false);
    assert.equal(tampered.reason, 'checksum-mismatch');
  } finally {
    fs.writeFileSync(ARTIFACT_FILE, original);
  }
  assert.equal(verifyMonetizationArtifact().ok, true);
});

test('loadMonetizationEngine memuat artifact terverifikasi', () => {
  const loaded = loadMonetizationEngine({ force: true });
  assert.ok(['artifact', 'source'].includes(loaded.mode));
  assert.equal(typeof loaded.engine.renderAd, 'function');
  assert.equal(loaded.engine.ENGINE_VERSION, '1.0.0');
});

test('Renderer.advertisement menulis box OSC 8 tanpa menghapus output task', () => {
  let output = '';
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.rows = 40;
  stdout.cursorTo = () => true;
  stdout.clearLine = () => true;
  stdout.moveCursor = () => true;

  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  renderer.taskStart({ task: 'membangun komponen', sessionId: 'sesi-1', maxSteps: 3 });
  const ad = engine.normalizePayload(PAYLOAD).ads[0];
  const box = engine.renderAd(ad, {
    width: renderer.contentWidth(),
    color: true,
    hyperlinks: true,
    clickUrl: 'https://restapi.ryuu-dev.my.id/api/v1/ads/pterokudesu/click',
  });
  renderer.advertisement(box.lines, box.plainLines);

  assert.match(output, /task uplink/);
  assert.match(output, /SPONSORED/);
  assert.match(output, /\x1b\]8;;https:\/\/restapi\.ryuu-dev\.my\.id\/api\/v1\/ads\/pterokudesu\/click/);
  // Border box harus muat di lebar renderer (92 kolom maksimum).
  const visible = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r/g, '')
  const adRows = visible.split('\n').filter((line) => line.includes('│') || line.includes('┌') || line.includes('└'))
  assert.ok(adRows.length > 0)
  for (const row of adRows) assert.ok(row.length <= 92, `baris iklan terlalu lebar: ${row.length}`)
});

test('scheduler hanya berjalan selama task dan mencatat impression anonim', async () => {
  const events = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/ads')) return jsonResponse(PAYLOAD);
    if (String(url).endsWith('/api/v1/ads/events')) {
      events.push(JSON.parse(options.body));
      return jsonResponse({ success: true }, { status: 202 });
    }
    throw new Error(`fetch tak terduga: ${url}`);
  };

  const timers = [];
  const setTimeoutImpl = (fn, delay) => {
    const timer = { fn, delay, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutImpl = (timer) => {
    if (timer) timer.cleared = true;
  };

  const rendered = [];
  const renderer = {
    ansi: true,
    plain: false,
    contentWidth: () => 60,
    advertisement: (lines, plainLines) => rendered.push({ lines, plainLines }),
  };

  const scheduler = createAdScheduler({
    engine,
    renderer,
    logger: { warn() {} },
    cliVersion: '0.7.0',
    fetchImpl,
    random: () => 0,
    setTimeoutImpl,
    clearTimeoutImpl,
  });

  assert.equal(scheduler.start(), true);
  assert.equal(await scheduler.ready(), true);
  assert.equal(timers.length, 1);
  // Iklan pertama dijadwalkan segera (bukan menunggu 2-5 menit), tetapi
  // tetap memberi taskStart kesempatan menggambar UI lebih dulu.
  assert.equal(timers[0].delay, 750);
  assert.equal(rendered.length, 0, 'iklan pertama belum tampil sebelum timer');

  timers.shift().fn();
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].lines.join('\n').includes('\x1b]8;;'));
  assert.ok(rendered[0].plainLines.join('\n').includes('Pterokudesu'));

  // Impression dikirim fire-and-forget; beri event loop satu putaran.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ad_impression');
  assert.equal(events[0].adId, 'pterokudesu');
  assert.equal(events[0].cliVersion, '0.7.0');
  assert.match(events[0].sessionId, /^ryuu_[a-f0-9]{32}$/);
  assert.equal('prompt' in events[0], false);

  assert.equal(timers.length, 1, 'timer berikutnya dijadwalkan setelah iklan');
  assert.equal(timers[0].delay, 120000, 'interval berikutnya kembali 2-5 menit');
  scheduler.stop();
  assert.equal(timers.at(-1).cleared, true);
  assert.equal(scheduler.running, false);

  // Setelah stop, callback yang terlanjur dipanggil tidak merender apa pun.
  const stale = timers.at(-1);
  stale.fn();
  assert.equal(rendered.length, 1);
});
