// Start the SafeRaah server:  npm start   (PORT, DB_PATH, STATIC_DIR env vars)
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.ts';
import { openDb, bump } from './db.ts';
import { Ai, aiConfigFromEnv } from './ai.ts';

const port = Number(process.env.PORT ?? 8787);
const staticDir = resolve(process.env.STATIC_DIR ?? 'web/dist');
const dbPath = resolve(process.env.DB_PATH ?? 'data/saferaah.db');
mkdirSync(dirname(dbPath), { recursive: true });

let graphVersion = 'dev';
try {
  graphVersion = createHash('sha1')
    .update(readFileSync(resolve(staticDir, 'data/graph.bin')))
    .digest('hex')
    .slice(0, 12);
} catch {
  console.warn('graph.bin not found in', staticDir, '— run `npm run build` first');
}
const db = openDb(dbPath);
// the daily Gemini cap is counted in the database, so a restart does not reset it
const ai = new Ai({ ...aiConfigFromEnv(), counter: (name, day) => bump(db, name, day) });
// Cloud Run sets K_SERVICE; there the real client address comes from Google's front end
const server = createApp({
  db,
  staticDir,
  graphVersion,
  ai,
  trustProxy: !!process.env.K_SERVICE || process.env.TRUST_PROXY === '1',
});
server.listen(port, () =>
  console.log(
    `SafeRaah running on http://localhost:${port}  (graph ${graphVersion}; Gemini ${ai.hasGemini ? 'on' : 'off'})`,
  ),
);

// Cloud Run (or any orchestrator) sends SIGTERM before replacing an instance: stop taking new
// requests, let in-flight ones finish, close the database, then exit. Hard stop after 10 s.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
