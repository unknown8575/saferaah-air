// Runs the graph, risk model and router off the main thread. Each request type (worker-api.ts)
// has one handler below; the dispatcher adds the request id to the reply.
import { Graph } from '../../shared/graph.ts';
import { Router, tierOf, type RouteResult } from '../../shared/router.ts';
import { computeRisk, type CrowdStat, type Profile, type RiskField } from '../../shared/risk.ts';
import { isOpenAt, CAT_INFO, type Poi } from '../../shared/places.ts';
import { buildSteps } from '../../shared/steps.ts';
import { adviseAir, adviseTrip } from '../../shared/advice.ts';
import { MODES, type Mode } from '../../shared/modes.ts';
import { routePrecautions } from '../../shared/precautions.ts';
import { liveEdgeDeltas, airEdgeDeltas } from '../../shared/live.ts';
import { AirField, streetFactors } from '../../shared/air.ts';
import type { LonLat } from '../../shared/geo.ts';
import type { LinesFC, NearbyPlace, RouteReply, WorkerRequest, WorkerRoute } from './worker-api.ts';

export type { RouteReply, WorkerRoute } from './worker-api.ts';

let g: Graph;
let router: Router;
let pois: Poi[] = [];
const crowd = new Map<number, CrowdStat>();
let live = new Map<number, number>();
let liveVersion = 0;
let riskCache: { key: string; field: RiskField } | null = null;
let air: AirField | null = null;
let airLive = new Map<number, number>();
let airFactor: Float32Array | null = null;

/** per-edge street pollution factor, rebuilt when air reports change */
function airFactors(): Float32Array | null {
  if (!air) return null;
  airFactor ??= streetFactors(g, air, { live: airLive });
  return airFactor;
}

function riskFor(whenISO: string, profile: Profile): RiskField {
  // cache per 5-minute bucket so changing mode doesn't recompute
  const when = new Date(whenISO);
  const key = `${Math.floor(when.getTime() / 300000)}|${profile}|${crowd.size}|${liveVersion}`;
  if (riskCache?.key === key) return riskCache.field;
  const field = computeRisk(g, { when, profile, pois, crowd, live });
  riskCache = { key, field };
  return field;
}

function routeOnce(from: LonLat, to: LonLat, mode: Mode, whenISO: string, profile: Profile, pm25?: number | null) {
  const when = new Date(whenISO);
  const risk = riskFor(whenISO, profile);
  const factor = pm25 === undefined ? null : airFactors();
  // without a live reading, doses are scored at a typical Delhi level; % differences don't depend on it
  const airIn = factor && air ? { field: air, factor, pm25: pm25 ?? 100 } : undefined;
  return router.route({ from, to, mode, when, ctx: { when, profile, pois, crowd, live }, air: airIn }, risk);
}

/** the graph may be split into parts for hosts that limit file size */
async function loadGraph(base: string, parts: string[]): Promise<ArrayBuffer> {
  const bufs = await Promise.all(
    parts.map(async (p) => {
      const r = await fetch(base + 'data/' + p);
      if (!r.ok) throw new Error(p + ' ' + r.status);
      return r.arrayBuffer();
    }),
  );
  if (bufs.length === 1) return bufs[0];
  const out = new Uint8Array(bufs.reduce((a, b) => a + b.byteLength, 0));
  let o = 0;
  for (const b of bufs) {
    out.set(new Uint8Array(b), o);
    o += b.byteLength;
  }
  return out.buffer;
}

/** street air data is optional: without it the app still routes for safety */
async function loadAir(base: string): Promise<AirField | null> {
  try {
    const ab = await fetch(base + 'data/air.bin').then((r) => (r.ok ? r.arrayBuffer() : null));
    return ab ? new AirField(ab) : null;
  } catch {
    return null;
  }
}

/** On a walk, the safest auto route too: the mode tab shows the fastest auto time, the advice the safest. */
function autoAlternative(m: Extract<WorkerRequest, { type: 'route' }>) {
  const alt = routeOnce(m.from, m.to, 'auto', m.when, m.profile);
  const best = alt.routes.reduce<RouteResult | null>((a, b) => (!a || b.meanRisk < a.meanRisk ? b : a), null);
  if (!best) return undefined;
  const fastestS = Math.min(...alt.routes.map((r) => r.timeS));
  return { mode: 'auto' as Mode, timeS: best.timeS, tier: best.tier, fastestS };
}

/** The air advice for a trip; the car time is worked out only when the warning will show. */
function airAdviceFor(m: Extract<WorkerRequest, { type: 'route' }>, timeS: number) {
  const base = { mode: m.mode, timeS, aqi: m.aqi ?? null, smogTrapped: m.smogTrapped };
  const first = adviseAir(base);
  if (!first || m.mode === 'car') return first;
  const car = routeOnce(m.from, m.to, 'car', m.when, m.profile).routes;
  return adviseAir({ ...base, carS: car.length ? Math.min(...car.map((r) => r.timeS)) : undefined });
}

/** A route plus what the screens need: turn steps, colours per segment, safe places, precautions. */
function forScreen(r: RouteResult, m: Extract<WorkerRequest, { type: 'route' }>, risk: RiskField): WorkerRoute {
  return {
    ...r,
    steps: buildSteps(g, r.segEdge, r.coords),
    segTier: r.segEdge.map((e) => tierOf(risk.risk[e], risk.risk[e])),
    havenList: r.havenIds
      .map((id) => pois[id])
      .filter((p) => CAT_INFO[p.cat].haven >= 0.5)
      .sort((a, b) => CAT_INFO[b.cat].haven - CAT_INFO[a.cat].haven)
      .slice(0, 40)
      .map((p) => ({ id: p.id, name: p.name, cat: p.cat, lon: p.lon, lat: p.lat, verified: !!risk.poiVerified[p.id] })),
    precautions: routePrecautions(r, { mode: m.mode, profile: m.profile, when: new Date(m.when), pois }),
  };
}

function routes(m: Extract<WorkerRequest, { type: 'route' }>): RouteReply {
  const res = routeOnce(m.from, m.to, m.mode, m.when, m.profile, m.pm25 ?? null);
  const vehicleAlt = m.mode === 'walk' && res.routes.length ? autoAlternative(m) : undefined;
  const risk = riskFor(m.when, m.profile);
  const when = new Date(m.when);
  return {
    routes: res.routes.map((r) => forScreen(r, m, risk)),
    rankedCount: res.rankedCount ?? res.routes.length,
    note: res.note,
    error: res.error,
    computeMs: res.computeMs,
    advice: adviseTrip({
      mode: m.mode,
      profile: m.profile,
      when,
      routes: res.routes,
      vehicleAltS: vehicleAlt,
      contacts: m.contacts,
    }),
    airAdvice: res.routes.length ? airAdviceFor(m, Math.min(...res.routes.map((r) => r.timeS))) : null,
    snapped: {
      from: res.from ? [res.from.lon, res.from.lat] : m.from,
      to: res.to ? [res.to.lon, res.to.lat] : m.to,
    },
  };
}

/** The street at a tapped point and how it feels right now, for the place card. */
function whereis(m: Extract<WorkerRequest, { type: 'whereis' }>) {
  const [lon, lat] = m.at;
  const s = g.snap(lon, lat, () => true, 400);
  let street = s ? g.name(s.edge) : '';
  if (s && !street)
    street =
      g
        .edgesNear(lon, lat, 90)
        .map((e) => g.name(e))
        .find(Boolean) ?? '';
  const risk = s && m.when ? riskFor(m.when, m.profile ?? 'woman').risk[s.edge] : null;
  return {
    street,
    distM: s ? Math.round(s.distM) : null,
    onMap: !!s,
    risk: risk == null ? null : Math.round(risk * 100) / 100,
  };
}

/** Every street in a box as a line, with one value per street. */
function lines(bbox: number[], limit: number | undefined, value: (e: number) => Record<string, number>): LinesFC {
  const [w, s, e, n] = bbox;
  return {
    type: 'FeatureCollection',
    features: g.edgesInBox(w, s, e, n, limit ?? 6000).map((ed) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: g.polyline(ed).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]) },
      properties: value(ed),
    })),
  };
}

function nearby(m: Extract<WorkerRequest, { type: 'nearby' }>): NearbyPlace[] {
  const when = new Date(m.when);
  const [lon, lat] = m.at;
  const out: NearbyPlace[] = [];
  for (const p of pois) {
    if (!m.cats.includes(p.cat)) continue;
    const d = g.proj.dist(lon, lat, p.lon, p.lat);
    if (d > m.radiusM) continue;
    const s = isOpenAt(p, when);
    out.push({ ...p, distM: Math.round(d), open: s.open, verified: s.verified });
  }
  if (m.sort === 'dist') out.sort((a, b) => a.distM - b.distM);
  else out.sort((a, b) => Number(b.open) - Number(a.open) || a.distM - b.distM);
  return out.slice(0, m.limit ?? 40);
}

/** open/closed state of every POI at a time (for the map layer), sent without copying */
function openStates(whenISO: string) {
  const when = new Date(whenISO);
  const open = new Uint8Array(pois.length);
  const verified = new Uint8Array(pois.length);
  pois.forEach((p, i) => {
    const s = isOpenAt(p, when);
    open[i] = s.open ? 1 : 0;
    verified[i] = s.verified ? 1 : 0;
  });
  return { open, verified };
}

type Req<K extends WorkerRequest['type']> = Extract<WorkerRequest, { type: K }>;
type Reply = { type: string } & Record<string, unknown>;
const EMPTY_FC: LinesFC = { type: 'FeatureCollection', features: [] };

const HANDLERS: { [K in WorkerRequest['type']]: (m: Req<K>) => Reply | Promise<Reply> } = {
  init: async (m) => {
    const [gb, pj] = await Promise.all([
      loadGraph(m.base, m.graphParts ?? ['graph.bin']),
      fetch(m.base + 'data/pois.json').then((r) => r.json() as Promise<Poi[]>),
    ]);
    g = new Graph(gb);
    pois = pj;
    air = await loadAir(m.base);
    router = new Router(g);
    const { bbox, snapshot, onewayKnown } = g.meta;
    return { type: 'ready', meta: { bbox, snapshot, onewayKnown, nodes: g.n, edges: g.m, air: !!air } };
  },
  crowd: (m) => {
    crowd.clear();
    for (const [e, n, mean] of m.stats) crowd.set(e, { n, mean });
    riskCache = null;
    return { type: 'ok' };
  },
  route: (m) => ({ type: 'routes', reply: routes(m) }),
  // live reports from other travellers change street risk and air until they expire
  reports: (m) => {
    live = liveEdgeDeltas(g, m.reports, m.now ?? Date.now());
    airLive = airEdgeDeltas(g, m.reports, m.now ?? Date.now());
    airFactor = null;
    liveVersion++;
    riskCache = null;
    return { type: 'ok', affected: live.size };
  },
  modeTimes: (m) => {
    const when = new Date(m.when);
    const times: Partial<Record<Mode, number | null>> = {};
    for (const md of MODES) times[md] = router.fastestTime(m.from, m.to, md, when, m.profile);
    return { type: 'modeTimes', times };
  },
  whereis: (m) => ({ type: 'whereis', ...whereis(m) }),
  // every street in view coloured by its risk right now
  safetyLines: (m) => {
    const risk = riskFor(m.when, m.profile);
    return { type: 'safetyLines', fc: lines(m.bbox, m.limit, (e) => ({ r: Math.round(risk.risk[e] * 100) / 100 })) };
  },
  // every street in view coloured by its estimated pollution factor (busy roads, industry, landfills, reports)
  airLines: (m) => {
    const f = airFactors();
    return {
      type: 'airLines',
      fc: f ? lines(m.bbox, m.limit, (e) => ({ f: Math.round(f[e] * 100) / 100 })) : EMPTY_FC,
    };
  },
  open: (m) => ({ type: 'open', ...openStates(m.when) }),
  nearby: (m) => ({ type: 'nearby', places: nearby(m) }),
};

self.onmessage = async (ev: MessageEvent<WorkerRequest & { id: number }>) => {
  const m = ev.data;
  try {
    const handler = HANDLERS[m.type] as (r: WorkerRequest) => Reply | Promise<Reply>;
    const out = await handler(m);
    const transfer =
      out.open instanceof Uint8Array && out.verified instanceof Uint8Array
        ? [out.open.buffer, out.verified.buffer]
        : [];
    postMessage({ ...out, id: m.id }, { transfer });
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
  }
};
