// Small HTTP building blocks shared by the routes: errors, headers, body reading, client address
// and rate limiting.
import type { IncomingMessage } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

/** Sent with every response: no MIME sniffing, no framing, no referrer, only the browser features the app uses. */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(self), microphone=(self), camera=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * Content Security Policy for the app page: scripts only from this origin, workers from this
 * origin or blob: (MapLibre), network only to this server and the public air-quality forecast.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://api.tomtom.com",
  "font-src 'self' data:",
  "connect-src 'self' https://air-quality-api.open-meteo.com https://api.open-meteo.com https://api.tomtom.com",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const BODY_MAX = 512 * 1024;
/** past this the connection is closed instead of drained */
const DRAIN_MAX = 4 * 1024 * 1024;

/** Read a JSON request body (≤ 512 KB). An empty body is `{}`; the caller checks the shape. */
export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > DRAIN_MAX) {
      req.destroy();
      break;
    }
    // over the limit: keep draining so the client gets a clean 413 instead of a reset connection
    if (size <= BODY_MAX) chunks.push(c as Buffer);
  }
  if (size > BODY_MAX) throw new HttpError(413, 'Request too large');
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * The caller's address. On Cloud Run every request arrives from Google's front end, which
 * appends the real client address as the LAST X-Forwarded-For entry (earlier entries can be
 * forged by the caller, so they are ignored).
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress ?? '?';
}

/** The anonymous phone id every write request must carry. */
export function deviceId(req: IncomingMessage): string {
  const d = String(req.headers['x-device-id'] ?? '');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(d)) throw new HttpError(400, 'Missing or invalid x-device-id header');
  return d;
}

/** Fixed one-minute windows per key: cheap, for the general API limit. */
export class MinuteLimiter {
  private buckets = new Map<string, { n: number; reset: number }>();
  constructor(
    private perMin: number,
    private now: () => number,
  ) {}

  take(key: string): void {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || t > b.reset) {
      b = { n: 0, reset: t + 60000 };
      this.buckets.set(key, b);
    }
    if (++b.n > this.perMin) throw new HttpError(429, 'Too many requests, slow down');
    if (this.buckets.size > 10000) for (const [k, v] of this.buckets) if (t > v.reset) this.buckets.delete(k);
  }
}

/** Sliding windows per key (timestamps kept), for the costly assistant. */
export class SlidingLimiter {
  private hits = new Map<string, number[]>();
  constructor(private now: () => number) {}

  take(key: string, max: number, windowMs: number, msg: string): void {
    const t = this.now();
    const xs = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (xs.length >= max) throw new HttpError(429, msg);
    xs.push(t);
    this.hits.set(key, xs);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < 3600000)) this.hits.delete(k);
  }
}
