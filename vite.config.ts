import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Adds a Content-Security-Policy <meta> tag, so the page is protected even on static hosts
 * (GitHub Pages) that cannot send headers. The Node server also sends it as a header.
 */
function csp(apiBase: string): Plugin {
  const api = apiBase ? new URL(apiBase).origin : '';
  const policy = [
    "default-src 'self'", "script-src 'self'", "worker-src 'self' blob:", "child-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://api.tomtom.com", "font-src 'self' data:",
    `connect-src 'self' ${api} https://air-quality-api.open-meteo.com https://api.open-meteo.com https://api.tomtom.com`.replace(/\s+/g, ' '),
    "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; ');
  return {
    name: 'saferaah-csp',
    transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n  <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    root: 'web',
    base: './',
    publicDir: 'public',
    plugins: [csp(env.VITE_API_BASE ?? process.env.VITE_API_BASE ?? '')],
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1500 },
    worker: { format: 'es' },
    server: { proxy: { '/api': 'http://localhost:8787' } },
  };
});
