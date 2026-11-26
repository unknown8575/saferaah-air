import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const m = JSON.parse(readFileSync('data-manifest.json', 'utf8')) as { source: string; files: { path: string; sha256: string; bytes: number }[] };

describe('map data manifest', () => {
  it('TC-185 is pinned to an exact commit over https and lists only safe relative paths', () => {
    expect(m.source).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
    for (const f of m.files) {
      expect(f.path).toMatch(/^(data|help)\/[A-Za-z0-9._/-]+$/);
      expect(f.path).not.toContain('..');
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(m.files.map((f) => f.path)).toEqual(expect.arrayContaining(['data/graph.bin', 'data/air.bin', 'data/places.json']));
  });
  it('TC-186 the data used by the tests is exactly what the manifest pins', () => {
    for (const f of m.files.filter((x) => x.path.startsWith('data/') && !x.path.includes('tiles/'))) {
      const p = `web/public/${f.path}`;
      expect(statSync(p).size).toBe(f.bytes);
      expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(f.sha256);
    }
  });
});
