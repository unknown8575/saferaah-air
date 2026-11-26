import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { createApp, CSP, sameSecret } from '../../server/app.ts';
import { openDb, bump } from '../../server/db.ts';
import { Ai } from '../../server/ai.ts';
import { vi } from 'vitest';

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

describe('abuse limits', () => {
  it('TC-205 secrets are compared in constant time and never match when missing', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abd', 'abc')).toBe(false);
    expect(sameSecret('abc', 'abcdef')).toBe(false);
    expect(sameSecret('', '')).toBe(false);
    expect(sameSecret(undefined, 'abc')).toBe(false);
    expect(sameSecret({ length: 3 }, 'abc')).toBe(false);
  });
  it('TC-206 the daily Gemini cap is counted in the database, so restarting the server does not reset it', async () => {
    const db = openDb(':memory:');
    const f = (async () => {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    }) as any;
    const mk = () =>
      new Ai({
        geminiKey: 'k',
        dailyLimit: 2,
        fetch: f,
        counter: (n, d) => bump(db, n, d),
        now: () => Date.parse('2026-11-27T10:00:00Z'),
      });
    const ctx = { air: null, family: null, route: null };
    expect((await mk().answer('q1', ctx)).engine).toBe('gemini');
    expect((await mk().answer('q2', ctx)).engine).toBe('gemini'); // a "restarted" server
    const third = await mk().answer('q3', ctx);
    expect(third.fallback).toBe(true);
    expect(third.reason).toBe('daily limit reached');
    expect(bump(db, 'gemini', '2026-11-28')).toBe(1); // a new day starts again
  });
  it('TC-207 server SMS cannot be used as a relay: Indian mobiles only, ≤5, short, a few per trip', async () => {
    process.env.SMS_PROVIDER = 'webhook';
    process.env.SMS_WEBHOOK_URL = 'https://hooks.example/sms';
    const sent: { to: string; message: string }[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      sent.push(JSON.parse(String(init!.body)));
      return new Response('{}');
    });
    try {
      const db = openDb(':memory:');
      const app = createApp({ db, graphVersion: 'test' });
      await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
      const dev = 'dev-sms-0123456789ab';
      const post = (path: string, body: unknown) => fetchReal(base + path, body, dev);
      const j = await (
        await post('/api/journeys', {
          mode: 'walk',
          route: [
            [77.2, 28.6],
            [77.21, 28.61],
          ],
          edges: [1, 2],
          dest: [77.21, 28.61],
          etaS: 600,
          graphVersion: 'x'.repeat(500),
        })
      ).json();
      expect(db.prepare('SELECT graph_version FROM journeys').get()).toEqual({ graph_version: 'test' });
      const contacts = [
        '+447911123456',
        '98765 43210',
        '9876543210',
        '+919876543211',
        '9876543212',
        '9876543213',
        '9876543214',
        '9876543215',
        '12345',
      ];
      const r = await (
        await post(`/api/journeys/${j.id}/sos`, { token: j.token, contacts, message: 'help '.repeat(200) })
      ).json();
      expect(r.smsSent).toBe(5);
      expect(new Set(sent.map((x) => x.to)).size).toBe(5);
      expect(sent.every((x) => /^\+91[6-9]\d{9}$/.test(x.to))).toBe(true);
      expect(Math.max(...sent.map((x) => x.message.length))).toBeLessThanOrEqual(320);
      expect((await post(`/api/journeys/${j.id}/sos`, { token: 'wrong', contacts, message: 'x' })).status).toBe(403);
      for (let i = 0; i < 3; i++)
        await post(`/api/journeys/${j.id}/notify`, { token: j.token, contacts: ['9876543210'], message: 'on my way' });
      const fourth = await post(`/api/journeys/${j.id}/notify`, {
        token: j.token,
        contacts: ['9876543210'],
        message: 'on my way',
      });
      expect(fourth.status).toBe(200);
      const over = await post(`/api/journeys/${j.id}/notify`, {
        token: j.token,
        contacts: ['9876543210'],
        message: 'on my way',
      });
      expect(over.status).toBe(429);
      app.close();
    } finally {
      spy.mockRestore();
      delete process.env.SMS_PROVIDER;
      delete process.env.SMS_WEBHOOK_URL;
    }
  });
  it('TC-208 a deployed server does not trust plain http://localhost for CORS', async () => {
    const app = createApp({ db: openDb(':memory:'), graphVersion: 'test', trustProxy: true });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const p = (app.address() as AddressInfo).port;
    const get = (origin: string) =>
      new Promise<string | undefined>((res) =>
        request({ host: '127.0.0.1', port: p, path: '/api/health', headers: { origin } }, (m) => {
          m.resume();
          res(m.headers['access-control-allow-origin'] as string | undefined);
        }).end(),
      );
    expect(await get('http://localhost')).toBeUndefined();
    expect(await get('https://localhost')).toBe('https://localhost');
    expect(await get('https://evil.example')).toBeUndefined();
    app.close();
    expect(
      await raw('/api/health', { origin: 'http://localhost' }).then((r) => r.headers['access-control-allow-origin']),
    ).toBe('http://localhost');
  });
});

/** a request that bypasses the fetch spy (node:http), so the SMS webhook spy sees only server traffic */
function fetchReal(url: string, body: unknown, device: string): Promise<{ status: number; json: () => Promise<any> }> {
  const u = new URL(url);
  const data = JSON.stringify(body);
  return new Promise((res, rej) => {
    const r = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-device-id': device,
          'content-length': Buffer.byteLength(data),
        },
      },
      (m) => {
        let b = '';
        m.on('data', (c) => (b += c));
        m.on('end', () => res({ status: m.statusCode ?? 0, json: async () => JSON.parse(b) }));
      },
    );
    r.on('error', rej);
    r.end(data);
  });
}
