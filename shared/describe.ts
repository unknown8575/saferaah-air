// Everything the app shows about one route: time, length, risk, worst stretch, risky spots with
// reasons, safe places on the way, warnings, and the PM2.5 breathed.
import type { Graph } from './graph.ts';
import { ROAD_CLASSES } from './modes.ts';
import type { RiskField } from './risk.ts';
import type { PoiCat } from './places.ts';
import { darkness } from './time.ts';
import { doseUg } from './air.ts';
import { geometryOf } from './astar.ts';
import {
  tierOf,
  type DangerSpot,
  type RouteAir,
  type RouteRequest,
  type RouteResult,
  type Snapped,
} from './route-types.ts';

const MAIN_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const LIT_ROADS = new Set([...MAIN_ROADS, 'pedestrian']);
const DARK_CLASSES = new Set(['service', 'footway', 'path', 'track']);

interface EdgeStep {
  e: number;
  len: number;
  r: number;
}

/** Running totals along a route. */
interface Totals {
  T: number;
  L: number;
  RT: number;
  main: number;
  lit: number;
  police: number;
  AT: number;
  indLen: number;
  busyLen: number;
  areas: Map<string, number>;
  havens: Set<number>;
  steps: EdgeStep[];
}

/** One route between two snapped points, with the inputs every measure needs. */
export interface Trip {
  g: Graph;
  edges: number[];
  s: Snapped;
  t: Snapped;
  times: Float32Array;
  risk: RiskField;
  req: RouteRequest;
  direct?: boolean;
}

/** fraction of each edge actually travelled (first/last are partial) */
function fractionOf(trip: Trip, i: number): number {
  const { g, edges, s, t } = trip;
  if (trip.direct) return Math.abs(t.t - s.t);
  const shares = (e: number, other: number) => g.a.edgeU[e] === g.a.edgeU[other] || g.a.edgeU[e] === g.a.edgeV[other];
  if (i === 0) return shares(edges[0], edges[1]) ? s.t : 1 - s.t;
  if (i === edges.length - 1) return shares(edges[i], edges[i - 1]) ? t.t : 1 - t.t;
  return 1;
}

function addAir(trip: Trip, tot: Totals, e: number, len: number, tm: number): void {
  const air = trip.req.air;
  if (!air) return;
  tot.AT += tm * air.factor[e];
  if (air.field.indM(e) <= 300 || air.field.dumpM(e) <= 800) tot.indLen += len;
  if (air.field.majM(e) <= 30) tot.busyLen += len;
  const nm = air.field.areaName(e);
  if (nm) tot.areas.set(nm, (tot.areas.get(nm) ?? 0) + len);
}

function totalsOf(trip: Trip): Totals {
  const { g, edges, times, risk } = trip;
  const tot: Totals = {
    T: 0,
    L: 0,
    RT: 0,
    main: 0,
    lit: 0,
    police: 0,
    AT: 0,
    indLen: 0,
    busyLen: 0,
    areas: new Map(),
    havens: new Set(),
    steps: [],
  };
  edges.forEach((e, i) => {
    const f = fractionOf(trip, i);
    const len = g.a.edgeLen[e] * f;
    const tm = times[e] * f;
    tot.T += tm;
    tot.L += len;
    tot.RT += tm * risk.risk[e];
    const cls = ROAD_CLASSES[g.a.edgeClass[e]];
    if (MAIN_ROADS.has(cls)) tot.main += len;
    if (LIT_ROADS.has(cls)) tot.lit += len;
    if (g.a.edgePoliceM[e] < 500) tot.police += len;
    for (const p of g.edgePois(e)) if (risk.poiOpen[p]) tot.havens.add(p);
    tot.steps.push({ e, len, r: risk.risk[e] });
    addAir(trip, tot, e, len, tm);
  });
  return tot;
}

/** Risk of the worst ~200 m stretch (sliding window by length). */
function worstStretchOf(tot: Totals): number {
  const steps = tot.steps;
  if (tot.L < 120) return tot.T > 0 ? tot.RT / tot.T : 0;
  let worst = 0;
  let wl = 0;
  let wr = 0;
  let lo = 0;
  for (let hi = 0; hi < steps.length; hi++) {
    wl += steps[hi].len;
    wr += steps[hi].len * steps[hi].r;
    while (wl - steps[lo].len >= 200 && lo < hi) {
      wl -= steps[lo].len;
      wr -= steps[lo].len * steps[lo].r;
      lo++;
    }
    if (wl >= 120) worst = Math.max(worst, wr / wl);
  }
  return worst;
}

/** Why a street scores as risky, in words. */
function reasonsOf(trip: Trip, e: number, dark: number): string[] {
  const { g, risk, req } = trip;
  const r: string[] = [];
  if ((req.ctx.live?.get(e) ?? 0) > 0.1) r.push('reported unsafe by travellers recently');
  const cls = ROAD_CLASSES[g.a.edgeClass[e]];
  const gb = g.a.edgeGreen[e];
  if (gb & 1) r.push('through a park');
  else if (gb & 2) r.push('beside a large park');
  if (gb & 4) r.push('industrial / empty land');
  if (cls === 'path' || cls === 'track') r.push('unpaved lonely path');
  if (cls === 'steps') r.push('steps / underpass');
  if (dark > 0.5 && DARK_CLASSES.has(cls)) r.push('probably poorly lit');
  if (![...g.edgePois(e)].some((p) => risk.poiOpen[p])) r.push('nothing open nearby');
  if (g.a.edgePoliceM[e] > 1200) r.push('far from police');
  return r;
}

/** One risky stretch: its middle point, main street name and reasons. */
function spotOf(trip: Trip, steps: EdgeStep[], dark: number): DangerSpot {
  const { g } = trip;
  const mid = steps[Math.floor((steps.length - 1) / 2)].e;
  const reasons = new Set(steps.flatMap((p) => reasonsOf(trip, p.e, dark)));
  // the street most of this stretch runs along
  const byName = new Map<string, number>();
  for (const p of steps) {
    const nm = g.name(p.e);
    if (nm) byName.set(nm, (byName.get(nm) ?? 0) + p.len);
  }
  const [lon, lat] = g.pointAt(mid, 0.5);
  return {
    lon,
    lat,
    street: [...byName].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
    lengthM: Math.round(steps.reduce((a, p) => a + p.len, 0)),
    reasons: [...reasons].slice(0, 3),
  };
}

/** Contiguous stretches of at least 120 m with risk ≥ 0.55. */
function dangerSpotsOf(trip: Trip, steps: EdgeStep[], dark: number): DangerSpot[] {
  const spots: DangerSpot[] = [];
  let run: EdgeStep[] = [];
  const flush = () => {
    if (run.reduce((a, p) => a + p.len, 0) >= 120) spots.push(spotOf(trip, run, dark));
    run = [];
  };
  for (const p of steps) {
    if (p.r >= 0.55) run.push(p);
    else flush();
  }
  flush();
  return spots;
}

function warningsOf(tot: Totals, spots: DangerSpot[], dark: number): string[] {
  const w: string[] = [];
  const { L } = tot;
  if (spots.length) {
    const m = spots.reduce((a, d) => a + d.lengthM, 0);
    w.push(`${spots.length} risky stretch${spots.length > 1 ? 'es' : ''} (${m} m)`);
  }
  if (dark > 0.5 && L > 0 && tot.lit / L < 0.4) w.push('Mostly side streets after dark');
  if (L > 0 && tot.police / L < 0.2) w.push('Little police presence nearby');
  if (dark > 0.5 && L > 300 && tot.havens.size < L / 400) w.push('Few places open along the way');
  return w;
}

function airOf(trip: Trip, tot: Totals): RouteAir | undefined {
  const air = trip.req.air;
  if (!air) return undefined;
  const factor = tot.T > 0 ? tot.AT / tot.T : 1;
  return {
    doseUg: doseUg(air.pm25, factor, tot.T, trip.req.mode),
    factor,
    pctVsFastest: 0,
    industryM: Math.round(tot.indLen),
    busyM: Math.round(tot.busyLen),
    // only areas the route really runs beside, longest first
    areas: [...tot.areas]
      .filter(([, m]) => m >= 150)
      .sort((a, b) => b[1] - a[1])
      .map(([n]) => n)
      .slice(0, 4),
    avoided: [],
  };
}

function havenCounts(trip: Trip, ids: Set<number>): Partial<Record<PoiCat, number>> {
  const havens: Partial<Record<PoiCat, number>> = {};
  for (const p of ids) {
    const c = trip.req.ctx.pois[p].cat;
    havens[c] = (havens[c] ?? 0) + 1;
  }
  return havens;
}

/** Score one route for display. `alpha` records which safety weight found it (-1 = clean air). */
export function describeRoute(alpha: number, trip: Trip): RouteResult {
  const dark = darkness(trip.req.when);
  const tot = totalsOf(trip);
  const spots = dangerSpotsOf(trip, tot.steps, dark);
  const worst = worstStretchOf(tot);
  const meanRisk = tot.T > 0 ? tot.RT / tot.T : 0;
  const share = (x: number) => (tot.L ? x / tot.L : 0);
  const geo = geometryOf(trip.g, trip.edges, trip.s, trip.t, trip.direct);
  return {
    alpha,
    edges: trip.edges,
    coords: geo.coords,
    segEdge: geo.segEdge,
    timeS: tot.T,
    lengthM: tot.L,
    meanRisk,
    worstStretch: worst,
    tier: tierOf(meanRisk, worst),
    havens: havenCounts(trip, tot.havens),
    havenIds: [...tot.havens],
    mainRoadShare: share(tot.main),
    litShare: share(tot.lit),
    policeShare: share(tot.police),
    dangerSpots: spots,
    warnings: warningsOf(tot, spots, dark),
    labels: [],
    air: airOf(trip, tot),
  };
}
