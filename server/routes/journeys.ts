// Live trips (optional family-safety add-on): start, location fixes, re-route, finish, SOS,
// check-in messages and the share link a trusted contact opens.
import type { IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { JourneyMonitor, reviewEligibility, type Fix } from '../../shared/journey.ts';
import { MODES, type Mode } from '../../shared/modes.ts';
import { sendSms, smsConfigured, normalizeIndianPhone } from '../notify.ts';
import { bump } from '../db.ts';
import { HttpError, readBody } from '../http.ts';
import { isLonLat, obj, routeBody, sameSecret, type Json } from '../validate.ts';
import type { Ctx, Routes } from '../context.ts';

/** A row of the journeys table. */
export interface JourneyRow {
  id: string;
  device: string;
  token: string;
  share_id: string;
  graph_version: string;
  mode: Mode;
  route_json: string;
  edges_json: string;
  dest_lon: number;
  dest_lat: number;
  eta_s: number;
  started_at: number;
  arrived_at: number | null;
  ended_at: number | null;
  status: 'active' | 'sos' | 'arrived' | 'ended';
  traveller_name: string | null;
  simulated: number;
  eligible: number;
  review_token: string | null;
  reviewed: number;
}

const SMS_MAX_TO = 5;
const SMS_MAX_CHARS = 320;
const SMS_DAILY = 200;
const SMS_PER_TRIP = { sos: 3, notify: 4 } as const;
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

/** The trip with this id, if the caller holds its token. */
function journeyFor(ctx: Ctx, id: string, token: unknown): JourneyRow {
  const j = ctx.db.prepare('SELECT * FROM journeys WHERE id = ?').get(id) as JourneyRow | undefined;
  if (!j) throw new HttpError(404, 'Journey not found');
  if (!sameSecret(token, j.token)) throw new HttpError(403, 'Bad journey token');
  return j;
}

/** after a trip ends, no more locations are accepted for it */
function stillTravelling(j: JourneyRow): void {
  if (j.status !== 'active' && j.status !== 'sos') throw new HttpError(409, 'This trip has ended');
}

/** Replay the trip's stored fixes to see whether the route was really travelled. */
function monitorFor(ctx: Ctx, j: JourneyRow): JourneyMonitor {
  const m = new JourneyMonitor({
    mode: j.mode,
    route: JSON.parse(j.route_json),
    dest: [j.dest_lon, j.dest_lat],
    etaS: j.eta_s,
    startedAt: j.started_at,
  });
  const fixes = ctx.db
    .prepare('SELECT t, lon, lat, acc FROM fixes WHERE journey_id = ? ORDER BY t')
    .all(j.id) as unknown as Fix[];
  for (const f of fixes) m.feed(f);
  return m;
}

/**
 * Optional server SMS (off unless a provider is configured). It must not become a free SMS
 * relay: only up to 5 distinct Indian mobile numbers, a short message, a few sends per trip
 * and a server-wide daily cap, all counted in the database.
 */
async function relaySms(ctx: Ctx, tripId: string, kind: 'sos' | 'notify', b: Json): Promise<number> {
  if (!smsConfigured() || !Array.isArray(b.contacts) || typeof b.message !== 'string') return 0;
  const numbers = b.contacts.map((c) => normalizeIndianPhone(String(c))).filter((p) => p && INDIAN_MOBILE.test(p));
  const to = [...new Set(numbers as string[])].slice(0, SMS_MAX_TO);
  if (!to.length) return 0;
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  if (bump(ctx.db, `sms:${kind}:${tripId}`, 'trip') > SMS_PER_TRIP[kind])
    throw new HttpError(429, 'Message limit for this trip reached; use the SMS or WhatsApp buttons');
  let sent = 0;
  for (const p of to) {
    if (bump(ctx.db, 'sms:day', day) > SMS_DAILY) break;
    if (await sendSms(p, b.message.slice(0, SMS_MAX_CHARS))) sent++;
  }
  return sent;
}

function startJourney(ctx: Ctx, dev: string, b: Json) {
  if (!MODES.includes(b.mode as Mode)) throw new HttpError(400, 'Invalid mode');
  const r = routeBody(b);
  if (!isLonLat(b.dest)) throw new HttpError(400, 'Invalid destination');
  const id = randomUUID();
  const token = randomBytes(24).toString('base64url');
  const shareId = randomBytes(16).toString('base64url');
  const graph =
    typeof b.graphVersion === 'string' && /^[\w.-]{1,40}$/.test(b.graphVersion)
      ? b.graphVersion
      : ctx.opts.graphVersion;
  ctx.db
    .prepare(
      `INSERT INTO journeys (id, device, token, share_id, graph_version, mode, route_json, edges_json,
      dest_lon, dest_lat, eta_s, started_at, traveller_name, simulated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      dev,
      token,
      shareId,
      graph,
      b.mode as Mode,
      JSON.stringify(r.route),
      JSON.stringify(r.edges),
      b.dest[0],
      b.dest[1],
      r.etaS,
      ctx.now(),
      typeof b.name === 'string' ? b.name.slice(0, 40) : null,
      b.simulated ? 1 : 0,
    );
  return { id, token, shareId };
}

function storeFixes(ctx: Ctx, j: JourneyRow, fixes: unknown[]): number {
  const ins = ctx.db.prepare('INSERT OR IGNORE INTO fixes (journey_id, t, lon, lat, acc) VALUES (?,?,?,?,?)');
  let n = 0;
  for (const raw of fixes) {
    const f = obj(raw);
    const { t, lon, lat, acc } = f;
    if (!isLonLat([lon, lat]) || typeof t !== 'number' || typeof acc !== 'number') continue;
    if (!Number.isFinite(t) || !Number.isFinite(acc) || acc < 0) continue;
    if (t > ctx.now() + 60000 || t < j.started_at - 60000) continue; // reject clock games
    ins.run(j.id, Math.round(t), lon as number, lat as number, acc);
    n++;
  }
  return n;
}

function finishJourney(ctx: Ctx, j: JourneyRow) {
  const mon = monitorFor(ctx, j);
  const el = reviewEligibility(mon);
  if (j.simulated) {
    el.eligible = false;
    el.reasons.unshift('this was a demo trip with simulated movement');
  }
  const reviewToken = el.eligible ? randomBytes(18).toString('base64url') : null;
  // the trip is over: GPS points, route, destination and name are erased now
  ctx.db.prepare('DELETE FROM fixes WHERE journey_id = ?').run(j.id);
  ctx.db
    .prepare(
      `UPDATE journeys SET status = ?, arrived_at = ?, ended_at = ?, eligible = ?, coverage = ?, review_token = ?,
        route_json = '[]', dest_lon = 0, dest_lat = 0, traveller_name = NULL,
        edges_json = CASE WHEN ? THEN edges_json ELSE '[]' END WHERE id = ?`,
    )
    .run(
      mon.arrivedAt ? 'arrived' : 'ended',
      mon.arrivedAt,
      ctx.now(),
      el.eligible ? 1 : 0,
      el.coverage,
      reviewToken,
      el.eligible ? 1 : 0,
      j.id,
    );
  return { arrived: !!mon.arrivedAt, eligible: el.eligible, coverage: el.coverage, reasons: el.reasons, reviewToken };
}

/** What a trusted contact sees on the share link (nothing once the trip data is deleted). */
function sharedTrip(ctx: Ctx, shareId: string) {
  ctx.purge();
  const j = ctx.db.prepare('SELECT * FROM journeys WHERE share_id = ?').get(shareId) as JourneyRow | undefined;
  if (!j) throw new HttpError(404, 'This trip has ended and its location data was deleted');
  const last = ctx.db
    .prepare('SELECT t, lon, lat, acc FROM fixes WHERE journey_id = ? ORDER BY t DESC LIMIT 1')
    .get(j.id);
  const stale = ctx.now() - j.started_at > 12 * 3600 * 1000;
  return {
    status: stale && j.status === 'active' ? 'expired' : j.status,
    mode: j.mode,
    name: j.traveller_name,
    route: JSON.parse(j.route_json),
    dest: j.dest_lon || j.dest_lat ? [j.dest_lon, j.dest_lat] : null,
    etaS: j.eta_s,
    startedAt: j.started_at,
    arrivedAt: j.arrived_at,
    last: last ?? null,
  };
}

export function journeyRoutes(ctx: Ctx): Routes {
  /** the body and the trip it names (the token must match) */
  const tripOf = async (req: IncomingMessage, id: string) => {
    const b = obj(await readBody(req));
    return { b, j: journeyFor(ctx, id, b.token) };
  };
  return {
    'POST /api/journeys': async (req) => {
      const dev = ctx.device(req);
      ctx.rateLimit('j:' + dev);
      return startJourney(ctx, dev, obj(await readBody(req)));
    },

    'POST /api/journeys/([\\w-]+)/fixes': async (req, m) => {
      const { b, j } = await tripOf(req, m[1]);
      stillTravelling(j);
      ctx.rateLimit('f:' + j.id);
      if (!Array.isArray(b.fixes) || b.fixes.length > 500) throw new HttpError(400, 'Invalid fixes');
      return { ok: true, stored: storeFixes(ctx, j, b.fixes), status: j.status };
    },

    'POST /api/journeys/([\\w-]+)/finish': async (req, m) => {
      const { j } = await tripOf(req, m[1]);
      stillTravelling(j);
      return finishJourney(ctx, j);
    },

    'POST /api/journeys/([\\w-]+)/sos': async (req, m) => {
      const { b, j } = await tripOf(req, m[1]);
      ctx.rateLimit('s:' + j.id);
      ctx.db.prepare(`UPDATE journeys SET status = 'sos' WHERE id = ?`).run(j.id);
      return { ok: true, shareId: j.share_id, smsSent: await relaySms(ctx, j.id, 'sos', b) };
    },

    'POST /api/journeys/([\\w-]+)/notify': async (req, m) => {
      const { b, j } = await tripOf(req, m[1]);
      ctx.rateLimit('n:' + j.id);
      return { ok: true, smsSent: await relaySms(ctx, j.id, 'notify', b) };
    },

    // re-routed mid-journey: verification and review use the new route from here on
    'POST /api/journeys/([\\w-]+)/route': async (req, m) => {
      const { b, j } = await tripOf(req, m[1]);
      stillTravelling(j);
      const r = routeBody(b);
      ctx.db
        .prepare('UPDATE journeys SET route_json = ?, edges_json = ?, eta_s = ?, started_at = ? WHERE id = ?')
        .run(JSON.stringify(r.route), JSON.stringify(r.edges), r.etaS, ctx.now(), j.id);
      ctx.db.prepare('DELETE FROM fixes WHERE journey_id = ? AND t < ?').run(j.id, ctx.now() - 60000);
      return { ok: true };
    },

    'GET /api/share/([\\w-]+)': async (_req, m) => sharedTrip(ctx, m[1]),
  };
}
