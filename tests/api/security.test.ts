import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { createApp, CSP } from '../../server/app.ts';
import { openDb } from '../../server/db.ts';

// a tiny web root, plus a sibling folder whose name starts with the same letters
const dir = mkdtempSync(join(tmpdir(), 'sr-'));
const root = join(dir, 'dist');
mkdirSync(root);
mkdirSync(join(dir, 'dist-secret'));
writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>' + 'x'.repeat(2000));
writeFileSync(join(dir, 'dist-secret', 'key.txt'), 'top secret');

let server: Server,
  port = 0;
beforeAll(async () => {
  server = createApp({ db: openDb(':memory:'), graphVersion: 'test', staticDir: root });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

/** raw request, so the path is sent exactly as written (fetch would normalise "..") */
function raw(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((res, rej) => {
    const r = request({ host: '127.0.0.1', port, path, headers }, (m) => {
      let body = '';
      m.on('data', (c) => (body += c));
      m.on('end', () => res({ status: m.statusCode ?? 0, headers: m.headers, body }));
    });
    r.on('error', rej);
    r.end();
  });
}

describe('HTTP security', () => {
  it('TC-201 every response carries the security headers; the page carries a strict CSP', async () => {
    const page = await raw('/');
    expect(page.status).toBe(200);
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['permissions-policy']).toMatch(/camera=\(\)/);
    expect(page.headers['content-security-policy']).toBe(CSP);
    expect(CSP).toMatch(/script-src 'self'(;|$)/);
    expect(CSP).not.toMatch(/unsafe-eval/);
    const api = await raw('/api/health');
    expect(api.headers['x-content-type-options']).toBe('nosniff');
  });
  it('TC-202 path traversal cannot read files outside the web root', async () => {
    for (const p of ['/../dist-secret/key.txt', '/%2e%2e/dist-secret/key.txt', '/..%2fdist-secret%2fkey.txt']) {
      const r = await raw(p);
      expect(r.body).not.toContain('top secret');
    }
    expect((await raw('/%E0%A4%A')).status).toBe(400); // malformed escape
  });
  it('TC-203 static files: gzip, ETag and 304 for repeat visits', async () => {
    const a = await raw('/index.html', { 'accept-encoding': 'gzip' });
    expect(a.headers['content-encoding']).toBe('gzip');
    const etag = String(a.headers.etag);
    expect(etag).toMatch(/^"/);
    const b = await raw('/index.html', { 'if-none-match': etag });
    expect(b.status).toBe(304);
  });
});
