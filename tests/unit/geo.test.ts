import { describe, it, expect } from 'vitest';
import {
  haversine,
  LocalProjection,
  pointPolylineDist,
  polylineLength,
  pointInRing,
  pointInPolygon,
  ringAreaM2,
  GridIndex,
  type LonLat,
} from '../../shared/geo.ts';

const P = new LocalProjection(28.6);
// a 1 km × 1 km square near Connaught Place, with a 200 m hole in the middle
const sq = (lon: number, lat: number, m: number): LonLat[] => {
  const dl = m / P.kx,
    dt = m / P.ky;
  return [
    [lon, lat],
    [lon + dl, lat],
    [lon + dl, lat + dt],
    [lon, lat + dt],
    [lon, lat],
  ];
};
const outer = sq(77.2, 28.6, 1000);
const hole = sq(77.2 + 400 / P.kx, 28.6 + 400 / P.ky, 200);

describe('geometry used by the router and the pipeline', () => {
  it('TC-210 distances agree between haversine, the local projection and polylines', () => {
    const d = haversine(77.2, 28.6, 77.21, 28.6);
    expect(d).toBeGreaterThan(970);
    expect(d).toBeLessThan(985);
    expect(P.dist(77.2, 28.6, 77.21, 28.6) / d).toBeCloseTo(1, 2);
    expect(
      polylineLength([
        [77.2, 28.6],
        [77.21, 28.6],
        [77.21, 28.61],
      ]),
    ).toBeCloseTo(d + haversine(77.21, 28.6, 77.21, 28.61), 6);
    expect(polylineLength([[77.2, 28.6]])).toBe(0);
  });
  it('TC-211 point-to-segment and point-to-polyline distances clamp to the ends', () => {
    const a: LonLat = [77.2, 28.6],
      b: LonLat = [77.2 + 100 / P.kx, 28.6];
    expect(P.pointSegDist(77.2 + 50 / P.kx, 28.6 + 30 / P.ky, a[0], a[1], b[0], b[1])).toBeCloseTo(30, 3);
    expect(P.pointSegDist(77.2 - 40 / P.kx, 28.6, a[0], a[1], b[0], b[1])).toBeCloseTo(40, 3);
    expect(P.pointSegDist(77.2, 28.6 + 10 / P.ky, a[0], a[1], a[0], a[1])).toBeCloseTo(10, 3); // zero-length segment
    expect(pointPolylineDist(P, [77.2 + 150 / P.kx, 28.6], [a, b])).toBeCloseTo(50, 3);
  });
  it('TC-212 point in polygon respects holes; areas are right', () => {
    expect(pointInRing(77.2 + 100 / P.kx, 28.6 + 100 / P.ky, outer)).toBe(true);
    expect(pointInRing(77.19, 28.6, outer)).toBe(false);
    const inHole: [number, number] = [77.2 + 500 / P.kx, 28.6 + 500 / P.ky];
    expect(pointInPolygon(...inHole, [outer])).toBe(true);
    expect(pointInPolygon(...inHole, [outer, hole])).toBe(false);
    expect(pointInPolygon(77.2 + 100 / P.kx, 28.6 + 100 / P.ky, [outer, hole])).toBe(true);
    expect(pointInPolygon(77.2, 28.6, [])).toBe(false);
    expect(ringAreaM2(P, outer)).toBeCloseTo(1_000_000, -2);
    expect(ringAreaM2(P, hole)).toBeCloseTo(40_000, -1);
  });
  it('TC-213 the grid index finds points and boxes within a radius and nothing far away', () => {
    const g = new GridIndex(P, 100);
    g.insertPoint(1, 77.2, 28.6);
    g.insertPoint(2, 77.2 + 250 / P.kx, 28.6);
    g.insertPoint(3, 77.3, 28.7);
    g.insertBBox(4, 77.2 - 300 / P.kx, 28.6 - 10 / P.ky, 77.2 - 150 / P.kx, 28.6 + 10 / P.ky);
    const near = g.near(77.2, 28.6, 120);
    expect(near.has(1)).toBe(true);
    expect(near.has(3)).toBe(false);
    const wide = g.near(77.2, 28.6, 320);
    expect([1, 2, 4].every((i) => wide.has(i))).toBe(true);
    expect(wide.has(3)).toBe(false);
    expect(g.cellOf(77.2, 28.6)).toEqual(g.cellOf(77.2 + 1 / P.kx, 28.6 + 1 / P.ky));
  });
});
