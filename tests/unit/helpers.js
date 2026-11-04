import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Direktori sementara yang selalu dibersihkan pemanggil (atau OS). */
export async function tempDir(prefix = 'ryuu-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}
