// Safety-aware routing: parametric A* producing up to four tiered routes.
//
// Edge cost:  c_α(e) = T(e) · (1 + α · E_mode · R(e))
//   T(e)  travel time for the chosen mode at departure time
//   R(e)  time-dependent risk score (risk.ts)
//   E_mode how exposed this mode is to the street (walk 1.0 … car 0.4)
//   α     safety penalty: 0 = pure fastest, 5 = strongly safety-first
//
// A* uses straight-line distance / top speed as heuristic. Since c_α ≥ T,
// the heuristic stays admissible for every α, so each search is exact.
//
// Clean air: with an air field the router also searches
//   c_air(e) = T(e) · (F(e) / 0.7)^1.5 · (1 + 0.5 · E_mode · R(e))
// where F(e) is the street pollution factor (air.ts). Every route is then scored by
// the PM2.5 dose breathed on it, and the lowest-dose one is labelled "Cleanest air".

import { Graph } from './graph.ts';
import { MODE_INFO, F_FOOT, F_VEHICLE, edgeSeconds, WALK_KMH, type Mode } from './modes.ts';
import { computeRisk, type RiskField } from './risk.ts';
import { CAT_INFO, type PoiCat } from './places.ts';
import { isPeakIST } from './time.ts';
import { haversine, type LonLat } from './geo.ts';
import { astar, geometryOf, overlap, type PathResult } from './astar.ts';
import { describeRoute } from './describe.ts';
import {
  ALPHAS,
  MAX_DETOUR,
  MIN_RISK_GAIN,
  type RouteRequest,
  type RouteResponse,
  type RouteResult,
  type Snapped,
} from './route-types.ts';

export * from './route-types.ts';

/** One routing request after snapping: everything the searches share. */
interface Job {
  req: RouteRequest;
  s: Snapped;
  t: Snapped;
  times: Float32Array;
  risk: RiskField;
  usable: (e: number) => boolean;
  exposure: number;
}

/** closer than this, start and destination are one place */
const SAME_PLACE_M = 25;

/** Longest a slower route may take and still be shown. */
const detourLimit = (fastestT: number, extraS = 240) => Math.max(fastestT * MAX_DETOUR, fastestT + extraS);

export class Router {
  /** node is in the main connected network for walking / vehicles */
  private footComp: Uint8Array;
  private vehComp: Uint8Array;

  constructor(readonly g: Graph) {
    this.footComp = this.mainComponent(F_FOOT);
    this.vehComp = this.mainComponent(F_VEHICLE);
  }

  private mainComponent(flag: number): Uint8Array {
    const g = this.g;
    const comp = new Int32Array(g.n).fill(-1);
    let best = -1,
      bestSize = 0,
      cid = 0;
    const stack: number[] = [];
    for (let s = 0; s < g.n; s++) {
      if (comp[s] >= 0) continue;
      let size = 0;
      comp[s] = cid;
      stack.push(s);
      while (stack.length) {
        const u = stack.pop()!;
        size++;
        for (let k = g.adjOff[u]; k < g.adjOff[u + 1]; k++) {
          const e = g.adjEdge[k];
          if (!(g.a.edgeFlags[e] & flag)) continue;
          const v = g.other(e, u);
          if (comp[v] < 0) {
            comp[v] = cid;
            stack.push(v);
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = cid;
      }
      cid++;
    }
    const out = new Uint8Array(g.n);
    for (let i = 0; i < g.n; i++) out[i] = comp[i] === best ? 1 : 0;
    return out;
  }

  usableFor(mode: Mode): (e: number) => boolean {
    const g = this.g;
    const flag = mode === 'walk' ? F_FOOT : F_VEHICLE;
    const comp = mode === 'walk' ? this.footComp : this.vehComp;
    return (e) => {
      if (!(g.a.edgeFlags[e] & flag)) return false;
      if (!comp[g.a.edgeU[e]] || !comp[g.a.edgeV[e]]) return false;
      return Number.isFinite(edgeSeconds(mode, g.a.edgeClass[e], g.a.edgeFlags[e], 1, false));
    };
  }

  edgeTimes(mode: Mode, when: Date, profile: string): Float32Array {
    const g = this.g,
      peak = isPeakIST(when);
    const out = new Float32Array(g.m);
    const childSlow = mode === 'walk' && profile === 'child' ? WALK_KMH / 3.8 : 1;
    for (let e = 0; e < g.m; e++)
      out[e] = edgeSeconds(mode, g.a.edgeClass[e], g.a.edgeFlags[e], g.a.edgeLen[e], peak) * childSlow;
    return out;
  }

  /** A* from a snapped start to a snapped end over per-edge costs. */
  astar(cost: Float32Array, mode: Mode, s: Snapped, t: Snapped, usable: (e: number) => boolean): PathResult | null {
    return astar(this.g, cost, mode, s, t, usable);
  }

  /** The road geometry of an edge chain (see astar.ts). */
  geometryOf(edges: number[], s: Snapped, t: Snapped, direct?: boolean): { coords: LonLat[]; segEdge: number[] } {
    return geometryOf(this.g, edges, s, t, direct);
  }

  /** Score one route for display (see describe.ts). */
  describe(
    alpha: number,
    edges: number[],
    s: Snapped,
    t: Snapped,
    times: Float32Array,
    risk: RiskField,
    req: RouteRequest,
    direct?: boolean,
  ): RouteResult {
    return describeRoute(alpha, { g: this.g, edges, s, t, times, risk, req, direct });
  }

  private overlap(a: number[], b: number[]): number {
    return overlap(this.g, a, b);
  }

  /** Fastest travel time only (for the travel-mode tabs). */
  fastestTime(from: LonLat, to: LonLat, mode: Mode, when: Date, profile: string): number | null {
    const g = this.g;
    const usable = this.usableFor(mode);
    const s = g.snap(from[0], from[1], usable),
      t = g.snap(to[0], to[1], usable);
    if (!s || !t) return null;
    const times = this.edgeTimes(mode, when, profile);
    const r = this.astar(times, mode, s, t, usable);
    return r ? r.cost : null;
  }

  /** Main entry point: the up-to-four tiered routes. */
  route(req: RouteRequest, risk?: RiskField): RouteResponse {
    const t0 = performance.now();
    const g = this.g;
    const usable = this.usableFor(req.mode);
    const s = g.snap(req.from[0], req.from[1], usable);
    const t = g.snap(req.to[0], req.to[1], usable);
    risk ??= computeRisk(g, req.ctx);
    const base = { from: s!, to: t!, risk, routes: [] as RouteResult[] };
    const fail = (error: string) => ({ ...base, error, computeMs: performance.now() - t0 });
    if (!s) return fail('Start point is too far from any road we know.');
    if (!t) return fail('Destination is too far from any road we know.');
    if (haversine(req.from[0], req.from[1], req.to[0], req.to[1]) < SAME_PLACE_M)
      return fail('Start and destination are the same place: you are already there.');
    const times = this.edgeTimes(req.mode, req.when, req.ctx.profile);
    const job: Job = { req, s, t, times, risk, usable, exposure: MODE_INFO[req.mode].exposure };
    const accepted = this.sweep(job);
    if (!accepted.length) return fail('No route found for this travel mode between these points.');
    const swept = this.front(accepted.map((a) => this.describeIn(job, a.alpha, a)));
    const fastestT = swept[0].timeS;
    const alts = this.alternatives(job, swept, fastestT);
    // An alternative that turns out clearly safer joins the fastest→safest front;
    // near-identical twins (same streets, same time) would show as two cards with one meaning
    const ranked = this.dedupe(this.front([...swept, ...alts]));
    const others = this.othersBesides(ranked, [...swept, ...alts]);
    this.label(ranked, others);
    const routes = [...ranked, ...others];
    if (req.air) this.addCleanAir(routes, job, fastestT);
    return {
      ...base,
      routes,
      rankedCount: ranked.length,
      note: routeNote(ranked.length, routes.length),
      computeMs: performance.now() - t0,
    };
  }

  private describeIn(job: Job, alpha: number, p: { edges: number[]; direct?: boolean }): RouteResult {
    return this.describe(alpha, p.edges, job.s, job.t, job.times, job.risk, job.req, p.direct);
  }

  /** Per-edge cost: time × (1 + α · exposure · risk) × an optional penalty. */
  private costs(job: Job, alpha: number, penalty?: Float32Array): Float32Array {
    const { times, risk, exposure } = job;
    const cost = new Float32Array(this.g.m);
    for (let e = 0; e < this.g.m; e++)
      cost[e] = times[e] * (1 + alpha * exposure * risk.risk[e]) * (penalty ? penalty[e] : 1);
    return cost;
  }

  /** One search per safety weight α; a near-copy of an earlier path is pushed off it and retried. */
  private sweep(job: Job): { alpha: number; edges: number[]; direct?: boolean }[] {
    const accepted: { alpha: number; edges: number[]; direct?: boolean }[] = [];
    const penalty = new Float32Array(this.g.m).fill(1);
    for (const alpha of ALPHAS) {
      let found: PathResult | null = null;
      for (let attempt = 0; attempt < 3 && !found; attempt++) {
        const r = astar(
          this.g,
          this.costs(job, alpha, attempt > 0 ? penalty : undefined),
          job.req.mode,
          job.s,
          job.t,
          job.usable,
        );
        if (!r) break;
        if (!accepted.some((a) => this.overlap(a.edges, r.edges) > 0.85)) found = r;
        else for (const e of r.edges) penalty[e] *= 1.5; // push the next attempt off this path
      }
      if (!found) continue;
      accepted.push({ alpha, edges: found.edges, direct: found.direct });
      for (const e of found.edges) penalty[e] *= 1.25;
    }
    return accepted;
  }

  /** Genuinely different alternatives (penalty method, ≤ 70% shared road). */
  private alternatives(job: Job, swept: RouteResult[], fastestT: number): RouteResult[] {
    const alts: RouteResult[] = [];
    const penalty = new Float32Array(this.g.m).fill(1);
    for (const r of swept) for (const e of r.edges) penalty[e] = 2.5;
    for (let attempt = 0; attempt < 5 && swept.length + alts.length < 4; attempt++) {
      const r = astar(this.g, this.costs(job, 1.5, penalty), job.req.mode, job.s, job.t, job.usable);
      if (!r) break;
      for (const e of r.edges) penalty[e] *= 2;
      if ([...swept, ...alts].some((k) => this.overlap(k.edges, r.edges) > 0.7)) continue;
      const d = this.describeIn(job, 1.5, r);
      if (d.timeS <= detourLimit(fastestT)) alts.push(d);
    }
    return alts;
  }

  /**
   * Keep a slower route only if it is clearly safer than every faster route we kept, and not
   * absurdly long. This yields a Pareto front: time ↑ ⇒ risk ↓.
   */
  private front(cands: RouteResult[]): RouteResult[] {
    const sorted = [...cands].sort((a, b) => a.timeS - b.timeS || b.meanRisk - a.meanRisk);
    const out: RouteResult[] = [];
    for (const r of sorted) {
      if (!out.length) {
        out.push(r);
        continue;
      }
      // nearly the same path and time, but safer: show only the safer one
      const twin = out.findIndex((k) => this.overlap(k.edges, r.edges) > 0.75 && r.timeS <= k.timeS * 1.05);
      if (twin >= 0) {
        if (r.meanRisk < out[twin].meanRisk) out[twin] = r;
        continue;
      }
      const clearlySafer = out.every(
        (k) => r.meanRisk <= k.meanRisk - MIN_RISK_GAIN || r.worstStretch <= k.worstStretch - 0.08,
      );
      const notWorse = out.every((k) => r.meanRisk < k.meanRisk);
      if (clearlySafer && notWorse && r.timeS <= detourLimit(out[0].timeS)) out.push(r);
    }
    return out;
  }

  /** Routes not on the front (and not twins of one), fastest first, to fill up to four. */
  private othersBesides(ranked: RouteResult[], all: RouteResult[]): RouteResult[] {
    const twinOfRanked = (r: RouteResult) =>
      ranked.some((k) => this.overlap(k.edges, r.edges) > 0.75 && Math.abs(r.timeS - k.timeS) <= k.timeS * 0.05);
    return all
      .filter((r) => !ranked.includes(r) && !twinOfRanked(r))
      .sort((a, b) => a.timeS - b.timeS)
      .slice(0, Math.max(0, 4 - ranked.length));
  }

  private label(ranked: RouteResult[], others: RouteResult[]): void {
    for (const r of [...ranked, ...others]) r.labels = [];
    const fastest = ranked[0];
    const safest = ranked.reduce((a, b) => (b.meanRisk < a.meanRisk ? b : a));
    fastest.labels.push('Fastest');
    if (safest !== fastest) safest.labels.push('Safest');
    else fastest.labels.push('Also safest');
    // routes on the front between fastest and safest trade a little time for a little safety
    for (const r of ranked) if (!r.labels.length) r.labels.push('Balanced');
    for (const r of others) r.labels.push('Alternative');
  }

  /** The lowest-dose path, if it is new, short enough and clearly cleaner than every route shown. */
  private cleanestPath(routes: RouteResult[], job: Job, fastestT: number): RouteResult | null {
    const air = job.req.air!;
    const cost = new Float32Array(this.g.m);
    for (let e = 0; e < this.g.m; e++) {
      // ∝ the dose breathed (time × street factor), a little steeper so smoky peaks count;
      // dividing by the lowest factor keeps c_air ≥ T, so the A* heuristic stays admissible
      cost[e] = job.times[e] * Math.pow(air.factor[e] / 0.7, 1.5) * (1 + 0.5 * job.exposure * job.risk.risk[e]);
    }
    const r = astar(this.g, cost, job.req.mode, job.s, job.t, job.usable);
    if (!r || routes.some((k) => this.overlap(k.edges, r.edges) > 0.85)) return null;
    const d = this.describeIn(job, -1, r);
    const minDose = Math.min(...routes.map((k) => k.air!.doseUg));
    return d.timeS <= detourLimit(fastestT, 300) && d.air!.doseUg < minDose * 0.97 ? d : null;
  }

  /** Find the lowest-PM2.5 route, score every route's dose and label the cleanest. */
  private addCleanAir(routes: RouteResult[], job: Job, fastestT: number): void {
    const clean = this.cleanestPath(routes, job, fastestT);
    if (clean) {
      // keep at most four routes: a plain alternative makes way for the cleaner one
      if (routes.length >= 4) {
        const alt = routes.findIndex((k) => k.labels.length === 1 && k.labels[0] === 'Alternative');
        if (alt >= 0) routes.splice(alt, 1);
      }
      if (routes.length < 5) routes.push(clean);
    }
    const fastest = routes.find((k) => k.labels.includes('Fastest')) ?? routes[0];
    const base = fastest.air!.doseUg;
    for (const k of routes) {
      k.air!.pctVsFastest = base > 0 ? Math.round((1 - k.air!.doseUg / base) * 100) : 0;
      const mine = new Set(k.air!.areas);
      k.air!.avoided = fastest.air!.areas.filter((a) => !mine.has(a));
    }
    const cleanest = routes.reduce((a, b) => (b.air!.doseUg < a.air!.doseUg ? b : a));
    if (cleanest !== fastest && cleanest.air!.pctVsFastest >= 3) cleanest.labels.push('Cleanest air');
    else fastest.labels.push('Also cleanest');
  }

  /** Drop a route that shares >90% of its road and is within 2% of the time of one already kept. */
  private dedupe(list: RouteResult[]): RouteResult[] {
    const kept: RouteResult[] = [];
    const twin = (k: RouteResult, r: RouteResult) =>
      Math.abs(k.timeS - r.timeS) <= Math.max(k.timeS, r.timeS) * 0.02 && this.overlap(k.edges, r.edges) > 0.9;
    for (const r of list) if (!kept.some((k) => twin(k, r))) kept.push(r);
    return kept;
  }
}

/** A short note when there are fewer than four meaningfully different routes. */
function routeNote(ranked: number, total: number): string | undefined {
  const parts: string[] = [];
  if (ranked === 1) parts.push('The fastest route is already the safest one here.');
  if (total < 4)
    parts.push(
      total === 1
        ? 'No other sensible route exists between these points.'
        : `Only ${total} meaningfully different routes exist here.`,
    );
  return parts.length ? parts.join(' ') : undefined;
}

export function havenSummary(h: Partial<Record<PoiCat, number>>): string {
  const order: PoiCat[] = ['police', 'hospital', 'pharmacy', 'clinic', 'station', 'fuel', 'shop', 'food'];
  return order
    .filter((c) => h[c])
    .map((c) => `${CAT_INFO[c].icon} ${h[c]}`)
    .join('  ');
}
