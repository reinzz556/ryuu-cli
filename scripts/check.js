#!/usr/bin/env node
/**
 * Dependency-free syntax check: runs `node --check` on every JavaScript file
 * in src/, scripts/ and tests/. Fails with a non-zero exit code on any error.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TARGETS = ['src', 'scripts', 'tests'].map((dir) => path.join(ROOT, dir));

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const files = TARGETS.flatMap((dir) => walk(dir));
let failures = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`FAIL ${path.relative(ROOT, file)}\n${result.stderr}\n`);
  }
}
if (failures > 0) {
  process.stderr.write(`\n${failures} file(s) failed syntax check\n`);
  process.exit(1);
}
process.stdout.write(`Syntax check passed for ${files.length} file(s).\n`);
