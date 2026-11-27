// Static files for the web app. Each file is read and compressed once, then served from memory
// with an ETag, so repeat visits get a 304 and the 25 MB road graph is not re-gzipped on every request.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CSP, HttpError } from './http.ts';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pbf': 'application/x-protobuf',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
};

interface Entry {
  mtime: number;
  etag: string;
  type: string;
  raw: Buffer;
  gz: Buffer | null;
}

const CACHE_MAX_BYTES = 160 * 1024 * 1024;
const COMPRESSIBLE = /json|javascript|css|html|octet|svg|protobuf|markdown/;
/**
 * Chrome fails to write very large validated entries to its HTTP cache while the service
 * worker fetches the same file (ERR_CACHE_WRITE_FAILURE); those big files are cached by the
 * service worker instead, so they go without an ETag.
 */
const ETAG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Hashed bundles never change; map data changes only with a new data manifest (and the service
 * worker keeps its own versioned copy); pages are always revalidated.
 */
export function cacheControl(path: string): string {
  if (path.includes('/assets/')) return 'public, max-age=31536000, immutable';
  if (/\/(data|help)\//.test(path)) return 'public, max-age=86400';
  return 'no-cache';
}

export class StaticFiles {
  private root: string;
  private cache = new Map<string, Entry>();
  private bytes = 0;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  /** The file a URL path names, or null if it would leave the web root. */
  private fileFor(url: string | undefined): { path: string; file: string } | null {
    let p: string;
    try {
      p = decodeURIComponent(new URL(url ?? '/', 'http://x').pathname);
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    if (p.includes('\0')) throw new HttpError(400, 'Bad path');
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(this.root, p));
    // must stay inside the web root (a bare prefix check would let "/../dist-evil" through)
    if (file !== this.root && !file.startsWith(this.root + sep)) return null;
    return { path: p, file };
  }

  private async load(file: string, mtime: number): Promise<Entry> {
    const hit = this.cache.get(file);
    if (hit && hit.mtime === mtime) return hit;
    const raw = await readFile(file);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const gz = COMPRESSIBLE.test(type) && raw.length > 1024 ? gzipSync(raw) : null;
    const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`;
    const entry = { mtime, etag, type, raw, gz };
    const size = raw.length + (gz?.length ?? 0);
    if (this.bytes + size < CACHE_MAX_BYTES) {
      this.cache.set(file, entry);
      this.bytes += size;
    }
    return entry;
  }

  /** Serve a GET/HEAD for a file in the web root. False when there is no such file. */
  async serve(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const target = this.fileFor(req.url);
    if (!target) return false;
    const s = await stat(target.file).catch(() => null);
    if (!s?.isFile()) return false;
    const entry = await this.load(target.file, s.mtimeMs);
    const headers: Record<string, string> = {
      'content-type': entry.type,
      vary: 'accept-encoding',
      'cache-control': cacheControl(target.path),
    };
    if (entry.raw.length < ETAG_MAX_BYTES) headers.etag = entry.etag;
    if (entry.type.startsWith('text/html')) headers['content-security-policy'] = CSP;
    if (headers.etag && req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const useGz = entry.gz && /gzip/.test(String(req.headers['accept-encoding']));
    if (useGz) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : useGz ? entry.gz : entry.raw);
    return true;
  }

  /** Single-page app: unknown paths get index.html. */
  async serveIndex(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET') return false;
    const html = await readFile(join(this.root, 'index.html')).catch(() => null);
    if (!html) return false;
    res.writeHead(200, { 'content-type': MIME['.html'], 'content-security-policy': CSP, 'cache-control': 'no-cache' });
    res.end(html);
    return true;
  }
}
