// Optional street reviews after a verified trip, and the crowd scores they add up to.
import { HttpError, readBody } from '../http.ts';
import { obj, sameSecret, type Json } from '../validate.ts';
import type { Ctx, Routes } from '../context.ts';
import type { JourneyRow } from './journeys.ts';

const TAGS = new Set([
  'felt_safe',
  'well_lit',
  'busy',
  'police_seen',
  'shops_open',
  'dark',
  'deserted',
  'harassment',
  'followed',
  'stray_dogs',
  'bad_footpath',
  'drunk_people',
]);
/** crowd votes lose half their weight every 90 days */
const HALF_LIFE_MS = 90 * 86400000;

/** The trip being reviewed, if this phone travelled it and it was verified. */
function reviewableTrip(ctx: Ctx, dev: string, b: Json): JourneyRow {
  ctx.purge();
  const j = ctx.db.prepare('SELECT * FROM journeys WHERE id = ?').get(String(b.journeyId)) as JourneyRow | undefined;
  if (!j) throw new HttpError(404, 'This trip has ended and its data was deleted');
  if (!j.eligible || !sameSecret(b.reviewToken, j.review_token))
    throw new HttpError(403, 'This journey is not verified for a review');
  if (j.device !== dev) throw new HttpError(403, 'Only the traveller can review this journey');
  if (j.reviewed) throw new HttpError(409, 'Already reviewed');
  return j;
}

function saveReview(ctx: Ctx, dev: string, b: Json) {
  const j = reviewableTrip(ctx, dev, b);
  const rating = b.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)
    throw new HttpError(400, 'Rating must be a whole number from 1 to 5');
  const tags = Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === 'string' && TAGS.has(t)).slice(0, 8) : [];
  // round the time to the day so a vote cannot be matched to a trip by its timestamp
  const day = Math.floor(ctx.now() / 86400000) * 86400000;
  // a separate pseudonym for every street: still one vote per person per street, but one
  // person's votes cannot be grouped together (a set of streets could hint where they live)
  const voterFor = (e: number) => ctx.pseudo(`vote:${e}`, dev);
  ctx.db.exec('BEGIN');
  try {
    const up = ctx.db
      .prepare(`INSERT INTO edge_votes (graph_version, edge, device, rating, tags, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(graph_version, edge, device) DO UPDATE SET rating = excluded.rating, tags = excluded.tags, updated_at = excluded.updated_at`);
    const tagStr = tags.join(',');
    for (const e of new Set<number>(JSON.parse(j.edges_json)))
      up.run(j.graph_version, e, voterFor(e), rating, tagStr, day);
    // only a bare "reached safely" status stays for the family's link, until the hourly clean-up
    ctx.db
      .prepare(
        `UPDATE journeys SET edges_json = '[]', review_token = NULL, reviewed = 1, device = '', token = '' WHERE id = ?`,
      )
      .run(j.id);
    ctx.db.exec('COMMIT');
  } catch (err) {
    ctx.db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true };
}

/** Each pseudonym counts once per street; older votes weigh less. */
function crowdStats(ctx: Ctx, v: string) {
  const rows = ctx.db.prepare(`SELECT edge, rating, updated_at FROM edge_votes WHERE graph_version = ?`).all(v) as {
    edge: number;
    rating: number;
    updated_at: number;
  }[];
  const agg = new Map<number, { w: number; s: number }>();
  const t = ctx.now();
  for (const r of rows) {
    const w = Math.pow(0.5, Math.max(0, t - r.updated_at) / HALF_LIFE_MS);
    const a = agg.get(r.edge) ?? { w: 0, s: 0 };
    a.w += w;
    a.s += w * r.rating;
    agg.set(r.edge, a);
  }
  return { v, stats: [...agg].map(([e, a]) => [e, +a.w.toFixed(2), +(a.s / a.w).toFixed(3)]) };
}

export function reviewRoutes(ctx: Ctx): Routes {
  return {
    'POST /api/reviews': async (req) => {
      const dev = ctx.device(req);
      ctx.rateLimit('r:' + dev);
      return saveReview(ctx, dev, obj(await readBody(req)));
    },
    'GET /api/crowd': async (req) =>
      crowdStats(ctx, new URL(req.url ?? '', 'http://x').searchParams.get('v') ?? ctx.opts.graphVersion),
  };
}
