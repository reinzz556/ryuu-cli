import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Logger, createLogger } from '../../src/services/logger.js';
import { makeTempDir } from '../helpers.js';

test('logger redacts the configured key and keeps log files owner-only', async () => {
  const dir = await makeTempDir('ryuu-logger-');
  try {
    const logFile = path.join(dir, 'logs', 'agent.log');
    const logger = new Logger({
      level: 'debug',
      file: logFile,
      secrets: ['nvapi-logger-secret-123456'],
    });
    logger.info('request used nvapi-logger-secret-123456', {
      nested: { token: 'nvapi-logger-secret-123456' },
    });
    logger.debug('workspace excerpt', { file: 'src/app.js' });

    const text = await fsp.readFile(logFile, 'utf8');
    assert.ok(!text.includes('nvapi-logger-secret-123456'), 'secret must not reach the log');
    assert.match(text, /\[REDACTED\]/);
    assert.match(text, /workspace excerpt/);

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(logFile)).mode & 0o777, 0o700);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('reasoning logs are redacted, bounded to a session, and owner-only', async () => {
  const dir = await makeTempDir('ryuu-reasoning-');
  try {
    const logFile = path.join(dir, 'logs', 'agent.log');
    const logger = new Logger({ level: 'debug', file: logFile, secrets: ['nvapi-reasoning-secret'] });
    const pathWritten = logger.writeReasoning({
      sessionId: '20261020-demo',
      step: 3,
      text: 'step uses nvapi-reasoning-secret and then calls read_file',
    });
    assert.equal(pathWritten, path.join(dir, 'logs', 'reasoning', 'reasoning-20261020-demo.log'));
    const text = await fsp.readFile(pathWritten, 'utf8');
    assert.match(text, /=== step 3/);
    assert.match(text, /read_file/);
    assert.ok(!text.includes('nvapi-reasoning-secret'));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(pathWritten).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(pathWritten)).mode & 0o777, 0o700);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('createLogger honors silent level without creating a file', async () => {
  const dir = await makeTempDir('ryuu-logger-silent-');
  try {
    const logFile = path.join(dir, 'logs', 'agent.log');
    const logger = createLogger({ logLevel: 'silent', logDir: path.join(dir, 'logs'), apiKey: 'nvapi-x' });
    logger.error('should not be written');
    assert.equal(logger.enabled, false);
    assert.equal(fs.existsSync(logFile), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
