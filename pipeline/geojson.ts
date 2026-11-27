// The GeoJSON shapes the pipeline reads from the OpenStreetMap extract (fetch_delhi.sh).
import type { LonLat } from '../shared/geo.ts';

export type Geometry =
  | { type: 'Point'; coordinates: LonLat }
  | { type: 'LineString'; coordinates: LonLat[] }
  | { type: 'MultiLineString'; coordinates: LonLat[][] }
  | { type: 'Polygon'; coordinates: LonLat[][] }
  | { type: 'MultiPolygon'; coordinates: LonLat[][][] };

/** The polygons (each a list of rings) of an area; nothing for points and lines. */
export function polygonsOf(g: Geometry): LonLat[][][] {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/** The lines of a way (a LineString is one line). */
export function linesOf(g: Geometry): LonLat[][] {
  return g.type === 'LineString' ? [g.coordinates] : (g.coordinates as LonLat[][]);
}
