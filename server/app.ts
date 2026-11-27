// SafeRaah Air API + static file server (plain node:http, no framework).
// Routes live in server/routes/*, request checks in validate.ts, shared state in context.ts.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { HttpError, SECURITY_HEADERS } from './http.ts';
import { makeContext, type AppOptions, type Ctx, type Handler } from './context.ts';
import { StaticFiles } from './static.ts';
import { airRoutes } from './routes/air.ts';
import { journeyRoutes } from './routes/journeys.ts';
import { reportRoutes } from './routes/reports.ts';
import { reviewRoutes } from './routes/reviews.ts';

export { CSP, SECURITY_HEADERS } from './http.ts';
export { sameSecret, cleanAir, cleanFamily } from './validate.ts';
export { REVIEW_WINDOW_MS, ABANDONED_TRIP_MS, VOTE_LIFETIME_MS, type AppOptions } from './context.ts';

interface CompiledRoute {
  method: string;
  re: RegExp;
  fn: Handler;
}

function compileRoutes(ctx: Ctx): CompiledRoute[] {
  const all = { ...airRoutes(ctx), ...journeyRoutes(ctx), ...reportRoutes(ctx), ...reviewRoutes(ctx) };
  return Object.entries(all).map(([k, fn]) => {
    const [method, path] = k.split(' ');
    return { method, re: new RegExp(`^${path}$`), fn };
  });
}

/**
 * The Android/iOS apps load the UI from the device (capacitor://localhost or https://localhost)
 * and call this server, so those origins may use the API. Plain http://localhost (a local dev
 * server) is only trusted when not deployed behind a proxy.
 */
function allowedOrigins(trustProxy: boolean): Set<string> {
  const extra = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(['capacitor://localhost', 'https://localhost', ...(trustProxy ? [] : ['http://localhost']), ...extra]);
}

/** CORS for allowed origins. True when the request was a preflight and has been answered. */
function cors(req: IncomingMessage, res: ServerResponse, allowed: Set<string>): boolean {
  const origin = String(req.headers.origin ?? '');
  if (!allowed.has(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'content-type, x-device-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204);
  res.end();
  return true;
}

function sendError(res: ServerResponse, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: err instanceof HttpError ? err.message : 'Internal error' }));
}

export function createApp(opts: AppOptions): Server {
  const ctx = makeContext(opts);
  const routes = compileRoutes(ctx);
  const files = opts.staticDir ? new StaticFiles(opts.staticDir) : null;
  const allowed = allowedOrigins(!!opts.trustProxy);

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    ctx.rateLimit('ip:' + ctx.ip(req));
    const route = routes.find((r) => r.method === req.method && r.re.test(path));
    if (!route) throw new HttpError(404, 'No such endpoint');
    const out = await route.fn(req, path.match(route.re)!);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
  }

  return createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (opts.trustProxy) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      if (path.startsWith('/api/')) {
        if (!cors(req, res, allowed)) await api(req, res, path);
        return;
      }
      if (files && ((await files.serve(req, res)) || (await files.serveIndex(req, res)))) return;
      throw new HttpError(404, 'Not found');
    } catch (err) {
      sendError(res, err);
    }
  });
}
