// Live reports from people on the street (smoke, burning, dust, a dark stretch...), and votes
// on whether they are still there. Reports expire on their own.
import { randomUUID } from 'node:crypto';
import { REPORT_KINDS, isReportKind, type ReportKind } from '../../shared/live.ts';
import { haversine } from '../../shared/geo.ts';
import { inCoverageArea } from '../../shared/air.ts';
import { HttpError, readBody } from '../http.ts';
import { isLonLat, obj, type Json } from '../validate.ts';
import type { Ctx, Routes } from '../context.ts';

interface ReportRow {
  id: string;
  kind: ReportKind;
  lon: number;
  lat: number;
  expires_at: number;
}

/** The reporter's own position, which must be close to what they report. */
function reporterAt(b: Json): { lon: number; lat: number; acc: number } {
  const at = obj(b.at);
  if (!isLonLat([at.lon, at.lat])) throw new HttpError(403, 'Only people near the spot can confirm it');
  return { lon: at.lon as number, lat: at.lat as number, acc: Math.min(200, Math.max(0, Number(at.acc) || 0)) };
}

/** the same problem already reported close by counts as a confirmation */
function nearbyReport(ctx: Ctx, kind: ReportKind, lon: number, lat: number, t: number): string | undefined {
  const rows = ctx.db
    .prepare(
      'SELECT id, lon, lat FROM reports WHERE kind = ? AND expires_at > ? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?',
    )
    .all(kind, t, lon - 0.001, lon + 0.001, lat - 0.001, lat + 0.001) as { id: string; lon: number; lat: number }[];
  return rows.find((r) => haversine(r.lon, r.lat, lon, lat) <= 80)?.id;
}

function addReport(ctx: Ctx, dev: string, b: Json) {
  if (!isReportKind(b.kind)) throw new HttpError(400, 'Unknown report type');
  const kind = b.kind;
  const at = obj(b.at);
  if (!isLonLat([b.lon, b.lat]) || !isLonLat([at.lon, at.lat])) throw new HttpError(400, 'Location needed');
  const lon = b.lon as number;
  const lat = b.lat as number;
  if (!inCoverageArea(lat, lon)) throw new HttpError(400, 'Reports are for places in Delhi NCT only');
  const me = reporterAt(b);
  // you can only report a spot you are near
  if (haversine(lon, lat, me.lon, me.lat) > 300 + me.acc)
    throw new HttpError(403, 'Report only places near where you are');
  const t = ctx.now();
  const recent = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM reports WHERE device = ? AND created_at > ?')
    .get(dev, t - 3600000) as { n: number };
  if (recent.n >= 6) throw new HttpError(429, 'Too many reports in the last hour');
  const near = nearbyReport(ctx, kind, lon, lat, t);
  const id = near ?? randomUUID();
  if (!near) {
    ctx.db
      .prepare('INSERT INTO reports (id, kind, lon, lat, device, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, kind, lon, lat, dev, t, t + REPORT_KINDS[kind].hours * 3600000);
  }
  ctx.db
    .prepare(
      `INSERT INTO report_votes (report_id, device, still, at) VALUES (?,?,1,?)
      ON CONFLICT(report_id, device) DO UPDATE SET still = 1, at = excluded.at`,
    )
    .run(id, dev, t);
  return { ok: true, id, merged: !!near };
}

function voteReport(ctx: Ctx, dev: string, id: string, b: Json) {
  const r = ctx.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
  if (!r || r.expires_at <= ctx.now()) throw new HttpError(404, 'Report has expired');
  if (typeof b.still !== 'boolean') throw new HttpError(400, 'Say whether it is still there');
  const me = reporterAt(b);
  if (haversine(r.lon, r.lat, me.lon, me.lat) > 500 + me.acc)
    throw new HttpError(403, 'Only people near the spot can confirm it');
  ctx.db
    .prepare(
      `INSERT INTO report_votes (report_id, device, still, at) VALUES (?,?,?,?)
      ON CONFLICT(report_id, device) DO UPDATE SET still = excluded.still, at = excluded.at`,
    )
    .run(r.id, dev, b.still ? 1 : 0, ctx.now());
  return { ok: true };
}

function reportsIn(ctx: Ctx, bbox: string) {
  const [w, s, e, n] = bbox.split(',').map(Number);
  if (![w, s, e, n].every(Number.isFinite) || e - w > 2 || n - s > 2)
    throw new HttpError(400, 'bbox=w,s,e,n needed (max 2°)');
  const t = ctx.now();
  const rows = ctx.db
    .prepare(
      `SELECT r.id, r.kind, r.lon, r.lat, r.created_at AS createdAt, r.expires_at AS expiresAt,
        COALESCE(SUM(v.still = 1), 0) AS confirms, COALESCE(SUM(v.still = 0), 0) AS dismisses
      FROM reports r LEFT JOIN report_votes v ON v.report_id = r.id
      WHERE r.expires_at > ? AND r.lon BETWEEN ? AND ? AND r.lat BETWEEN ? AND ?
      GROUP BY r.id ORDER BY r.created_at DESC LIMIT 500`,
    )
    .all(t, w, e, s, n) as { confirms: number; dismisses: number }[];
  // a report most people nearby say is gone is hidden
  return { now: t, reports: rows.filter((r) => r.dismisses <= r.confirms) };
}

export function reportRoutes(ctx: Ctx): Routes {
  return {
    'POST /api/reports': async (req) => {
      const dev = ctx.pseudo('report', ctx.device(req));
      return addReport(ctx, dev, obj(await readBody(req)));
    },
    'POST /api/reports/([\\w-]+)/vote': async (req, m) => {
      const dev = ctx.pseudo('report', ctx.device(req));
      ctx.rateLimit('rv:' + dev);
      return voteReport(ctx, dev, m[1], obj(await readBody(req)));
    },
    'GET /api/reports': async (req) =>
      reportsIn(ctx, new URL(req.url ?? '', 'http://x').searchParams.get('bbox') ?? ''),
  };
}
