import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The CLI version, always read from package.json.
 *
 * Every banner, prompt and MCP handshake prints this value, so a release only
 * has to bump `package.json`. The read is cheap and cached after the first call.
 */
let cached = null;

export function readVersion() {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));
    cached = pkg.version || '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
