#!/usr/bin/env node
// Downloads the prebuilt Delhi map data listed in data-manifest.json into web/public/
// and verifies every file's SHA-256, so a tampered or truncated download is refused.
//
//   node scripts/fetch-data.mjs              # from the pinned source in the manifest
//   DATA_SOURCE=../saferaah/web/public node scripts/fetch-data.mjs   # copy from a local folder
//
// Files that already exist with the right checksum are skipped (fast, idempotent).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(await readFile(join(root, 'data-manifest.json'), 'utf8'));
const outDir = join(root, 'web', 'public');
const local = process.env.DATA_SOURCE ? resolve(process.env.DATA_SOURCE) : null;
const base = process.env.DATA_BASE_URL ?? manifest.source;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SAFE = /^(data|help)\/[A-Za-z0-9._/-]+$/;

async function fetchWithRetry(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`, { cause: err });
      await new Promise((res) => setTimeout(res, 500 * 2 ** i)); // exponential back-off
    }
  }
}

async function one(f) {
  if (!SAFE.test(f.path) || f.path.includes('..')) throw new Error(`unsafe path in manifest: ${f.path}`);
  const dest = join(outDir, f.path);
  const have = await readFile(dest).catch(() => null);
  if (have && sha256(have) === f.sha256) return 'kept';
  await mkdir(dirname(dest), { recursive: true });
  if (local) await copyFile(join(local, f.path), dest);
  else await writeFile(dest, await fetchWithRetry(base + f.path));
  const got = sha256(await readFile(dest));
  if (got !== f.sha256) throw new Error(`checksum mismatch for ${f.path}`);
  return 'fetched';
}

const queue = [...manifest.files];
const stats = { kept: 0, fetched: 0 };
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) stats[await one(f)]++;
  }),
);
const mb = manifest.files.reduce((s, f) => s + f.bytes, 0) / 1e6;
console.log(
  `map data ready: ${stats.fetched} fetched, ${stats.kept} already present (${mb.toFixed(1)} MB, checksums verified)`,
);
