import { defineConfig, loadEnv, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

/**
 * Adds a Content-Security-Policy <meta> tag, so the page is protected even on static hosts
 * (GitHub Pages) that cannot send headers. The Node server also sends it as a header.
 */
function csp(apiBase: string): Plugin {
  const api = apiBase ? new URL(apiBase).origin : '';
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://api.tomtom.com",
    "font-src 'self' data:",
    `connect-src 'self' ${api} https://air-quality-api.open-meteo.com https://api.open-meteo.com https://api.tomtom.com`.replace(
      /\s+/g,
      ' ',
    ),
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'saferaah-csp',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta charset="utf-8" />',
        `<meta charset="utf-8" />\n  <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      ),
  };
}

/** Stamps the service worker with the build and data versions, so old caches are replaced and cleaned up. */
function swVersion(): Plugin {
  return {
    name: 'saferaah-sw-version',
    apply: 'build',
    closeBundle() {
      const assets = readdirSync('web/dist/assets').sort().join(',');
      const build = createHash('sha1').update(assets).digest('hex').slice(0, 10);
      const data = createHash('sha1').update(readFileSync('data-manifest.json')).digest('hex').slice(0, 10);
      const p = 'web/dist/sw.js';
      writeFileSync(p, readFileSync(p, 'utf8').replace('__BUILD__', build).replace('__DATA__', data));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    root: 'web',
    base: './',
    publicDir: 'public',
    plugins: [csp(env.VITE_API_BASE ?? process.env.VITE_API_BASE ?? ''), swVersion()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      // the largest chunk is MapLibre itself (1.08 MB minified, 292 KB gzipped); the app's own code is ~150 KB
      chunkSizeWarningLimit: 1100,
      // MapLibre (the map engine) is most of the bundle and changes rarely: its own chunk stays
      // cached across app updates
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ },
              { name: 'lucide', test: /node_modules[\\/]lucide/ },
              { name: 'capacitor', test: /node_modules[\\/]@capacitor/ },
              { name: 'opening-hours', test: /node_modules[\\/]opening_hours/ },
              { name: 'vendor', test: /node_modules/ },
            ],
          },
        },
      },
    },
    worker: { format: 'es' },
    server: { proxy: { '/api': 'http://localhost:8787' } },
  };
});
