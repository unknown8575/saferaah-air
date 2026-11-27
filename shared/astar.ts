// A* shortest path between two points that lie part-way along edges, the path's road
// geometry, and how much road two paths share.
import type { Graph } from './graph.ts';
import { F_ONEWAY, WALK_KMH, type Mode } from './modes.ts';
import type { LonLat } from './geo.ts';
import type { Snapped } from './route-types.ts';

/** Binary min-heap of (node id, key) with growable typed arrays. */
export class MinHeap {
  ids: Int32Array;
  keys: Float64Array;
  size = 0;
  constructor(cap: number) {
    this.ids = new Int32Array(cap);
    this.keys = new Float64Array(cap);
  }
  private grow() {
    const ni = new Int32Array(this.ids.length * 2);
    ni.set(this.ids);
    this.ids = ni;
    const nk = new Float64Array(this.keys.length * 2);
    nk.set(this.keys);
    this.keys = nk;
  }
  push(id: number, k: number) {
    if (this.size === this.ids.length) this.grow();
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = k;
  }
  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids[--this.size];
    const lastK = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastK) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = lastId;
    this.keys[i] = lastK;
    return top;
  }
}

export interface PathResult {
  edges: number[];
  cost: number;
  direct?: boolean;
}

const topSpeed = (mode: Mode) => (mode === 'walk' ? WALK_KMH / 3.6 : 60 / 3.6);
const isOneway = (g: Graph, mode: Mode, e: number) => mode !== 'walk' && (g.a.edgeFlags[e] & F_ONEWAY) !== 0;
/** vehicles may only enter a one-way edge at its start */
const canTraverse = (g: Graph, mode: Mode, e: number, from: number) => !isOneway(g, mode, e) || g.a.edgeU[e] === from;

/** Cost of staying on one edge when start and end lie on it (Infinity if not allowed). */
function sameEdgeCost(g: Graph, cost: Float32Array, mode: Mode, s: Snapped, t: Snapped): number {
  if (s.edge !== t.edge) return Infinity;
  if (t.t >= s.t) return (t.t - s.t) * cost[s.edge];
  return isOneway(g, mode, s.edge) ? Infinity : (s.t - t.t) * cost[s.edge];
}

/** One A* search; the target is a virtual node reached from either end of the target edge. */
class Search {
  readonly VT: number;
  readonly gScore: Float64Array;
  readonly prev: Int32Array;
  private closed: Uint8Array;
  private heap = new MinHeap(4096);
  private h: (u: number) => number;
  /** tu or tv: the node from which the destination point was reached */
  lastNode = -1;

  constructor(
    private g: Graph,
    private cost: Float32Array,
    private mode: Mode,
    private t: Snapped,
  ) {
    this.VT = g.n;
    this.gScore = new Float64Array(g.n + 1).fill(Infinity);
    this.prev = new Int32Array(g.n + 1).fill(-1);
    this.closed = new Uint8Array(g.n + 1);
    const vmax = topSpeed(mode);
    this.h = (u) => g.proj.dist(g.lon(u), g.lat(u), t.lon, t.lat) / vmax;
  }

  /** leave the start point towards u (backwards, unless one-way) or v (forwards) */
  seed(s: Snapped): void {
    const { g, cost, gScore, prev } = this;
    const se = s.edge;
    const su = g.a.edgeU[se];
    const sv = g.a.edgeV[se];
    if (!isOneway(g, this.mode, se)) {
      gScore[su] = s.t * cost[se];
      this.heap.push(su, gScore[su] + this.h(su));
      prev[su] = -2;
    }
    gScore[sv] = Math.min(gScore[sv], (1 - s.t) * cost[se]);
    this.heap.push(sv, gScore[sv] + this.h(sv));
    prev[sv] = -2;
  }

  /** Reaching an end of the target edge offers a way to the virtual target. */
  private offerTarget(u: number, node: number, extra: number): void {
    const { gScore, VT } = this;
    if (u === node && gScore[u] + extra < gScore[VT]) {
      gScore[VT] = gScore[u] + extra;
      this.lastNode = node;
      this.heap.push(VT, gScore[VT]);
    }
  }

  private relax(u: number, usable: (e: number) => boolean): void {
    const { g, gScore, prev } = this;
    for (let k = g.adjOff[u]; k < g.adjOff[u + 1]; k++) {
      const e = g.adjEdge[k];
      if (!usable(e) || !canTraverse(g, this.mode, e, u)) continue;
      const v = g.other(e, u);
      if (this.closed[v]) continue;
      const ng = gScore[u] + this.cost[e];
      if (ng < gScore[v]) {
        gScore[v] = ng;
        prev[v] = e;
        this.heap.push(v, ng + this.h(v));
      }
    }
  }

  /** Run until the target is settled or nothing beats `bound` (the same-edge cost). */
  run(usable: (e: number) => boolean, bound: number): void {
    const { g, t, cost } = this;
    const te = t.edge;
    const tu = g.a.edgeU[te];
    const tv = g.a.edgeV[te];
    const extraU = t.t * cost[te]; // from tu along the edge to the point
    const extraV = isOneway(g, this.mode, te) ? Infinity : (1 - t.t) * cost[te];
    while (this.heap.size) {
      const u = this.heap.pop();
      if (this.closed[u]) continue;
      this.closed[u] = 1;
      if (u === this.VT || this.gScore[u] >= bound) break;
      this.offerTarget(u, tu, extraU);
      this.offerTarget(u, tv, extraV);
      this.relax(u, usable);
    }
  }

  /** the edge chain from start to target */
  path(se: number): number[] {
    let cur = this.lastNode;
    const edges: number[] = [this.t.edge];
    while (this.prev[cur] >= 0) {
      const e = this.prev[cur];
      edges.push(e);
      cur = this.g.other(e, cur);
    }
    edges.push(se);
    return edges.reverse();
  }
}

/** A* from a snapped start to a snapped end over per-edge costs. */
export function astar(
  g: Graph,
  cost: Float32Array,
  mode: Mode,
  s: Snapped,
  t: Snapped,
  usable: (e: number) => boolean,
): PathResult | null {
  const direct = sameEdgeCost(g, cost, mode, s, t);
  const search = new Search(g, cost, mode, t);
  search.seed(s);
  search.run(usable, direct);
  const best = search.gScore[search.VT];
  if (direct <= best) return Number.isFinite(direct) ? { edges: [s.edge], cost: direct, direct: true } : null;
  if (!Number.isFinite(best)) return null;
  return { edges: search.path(s.edge), cost: best };
}

/**
 * Turn an edge chain (first/last edges partial) into coordinates along the real road
 * geometry. segEdge[i] is the edge travelled between coords[i] and coords[i+1].
 */
export function geometryOf(
  g: Graph,
  edges: number[],
  s: Snapped,
  t: Snapped,
  direct?: boolean,
): { coords: LonLat[]; segEdge: number[] } {
  const coords: LonLat[] = [];
  const segEdge: number[] = [];
  const append = (pts: LonLat[], e: number) => {
    for (const p of pts) {
      const last = coords[coords.length - 1];
      if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
      if (coords.length) segEdge.push(e);
      coords.push(p);
    }
  };
  const finish = (e: number) => {
    if (coords.length < 2) {
      coords.push([t.lon, t.lat]);
      segEdge.push(e);
    }
    return { coords, segEdge };
  };
  if (direct || edges.length < 2) {
    append(g.cut(edges[0], s.t, t.t), edges[0]);
    return finish(edges[0]);
  }
  const [e0, e1] = edges;
  const u0 = g.a.edgeU[e0];
  let cur = u0 === g.a.edgeU[e1] || u0 === g.a.edgeV[e1] ? u0 : g.a.edgeV[e0];
  append(g.cut(e0, s.t, cur === u0 ? 0 : 1), e0);
  for (let i = 1; i < edges.length - 1; i++) {
    const e = edges[i];
    const pts = g.polyline(e);
    append(g.a.edgeU[e] === cur ? pts : pts.reverse(), e);
    cur = g.other(e, cur);
  }
  const te = edges[edges.length - 1];
  append(g.cut(te, g.a.edgeU[te] === cur ? 0 : 1, t.t), te);
  return finish(te);
}

/** Share of the shorter path's length that both paths use. */
export function overlap(g: Graph, a: number[], b: number[]): number {
  const sa = new Set(a);
  let shared = 0;
  let la = 0;
  let lb = 0;
  for (const e of a) la += g.a.edgeLen[e];
  for (const e of b) {
    lb += g.a.edgeLen[e];
    if (sa.has(e)) shared += g.a.edgeLen[e];
  }
  return shared / Math.max(1, Math.min(la, lb));
}
