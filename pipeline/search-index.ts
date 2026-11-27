// The offline search index: named places, stations, safe places, other named POIs and named
// streets (one entry per name per ~1 km).
import type { LonLat } from '../shared/geo.ts';
import { poiCategory, type Poi } from '../shared/places.ts';
import type { Geometry } from './geojson.ts';

export type Entry = [string, number, number, string]; // name, lon, lat, type

interface Feature {
  geometry: Geometry;
  properties: { kind: string; name?: string; tags?: Record<string, string> };
}

/** every other named place people search for: landmarks, markets, parks, colleges, malls, offices… */
function searchType(t: Record<string, string>): string {
  if (t.tourism === 'attraction' || t.tourism === 'museum' || t.historic || t.tourism === 'viewpoint')
    return 'landmark';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.amenity === 'marketplace' || t.shop === 'mall' || t.shop === 'department_store') return 'market';
  if (['school', 'college', 'university', 'kindergarten'].includes(t.amenity)) return 'school';
  if (t.office || t.amenity === 'townhall') return 'office';
  return 'place';
}

const nameOf = (f: Feature, t: Record<string, string>) => (t['name:en'] || t.name || f.properties.name || '').trim();

interface Sources {
  features: Feature[];
  pois: Poi[];
  inBox: (lon: number, lat: number) => boolean;
  /** named streets: the name index of each edge (-1 = none), its midpoint, and the names */
  edgeName: ArrayLike<number>;
  mids: LonLat[];
  names: string[];
}
type Add = (name: string, lon: number, lat: number, type: string) => void;

/** Neighbourhoods, towns and stations. */
function addPlaces(o: Sources, add: Add): void {
  for (const f of o.features) {
    const kind = f.properties.kind;
    if ((kind !== 'place' && kind !== 'station') || f.geometry.type !== 'Point') continue;
    const t = f.properties.tags ?? {};
    const [lon, lat] = f.geometry.coordinates;
    const type = kind === 'station' ? 'station' : (poiCategory(t) ?? t.place ?? t.tourism ?? 'place');
    if (o.inBox(lon, lat)) add(nameOf(f, t), lon, lat, type);
  }
}

/** Named POIs that are not safe places (those are added from the POI list). */
function addOtherPois(o: Sources, add: Add): void {
  for (const f of o.features) {
    if (f.properties.kind !== 'poi' || f.geometry.type !== 'Point') continue;
    const t = f.properties.tags ?? {};
    if (poiCategory(t, 'poi')) continue;
    const nm = nameOf(f, t);
    const [lon, lat] = f.geometry.coordinates;
    if (nm && o.inBox(lon, lat)) add(nm, lon, lat, searchType(t));
  }
}

/** Each street name once per ~1 km cell. */
function addStreets(o: Sources, add: Add): void {
  const seen = new Set<number>();
  for (let j = 0; j < o.mids.length; j++) {
    const k = o.edgeName[j];
    if (k < 0) continue;
    const [x, y] = o.mids[j];
    const sk = k * 1e7 + Math.round(x * 100) * 1000 + Math.round(y * 100);
    if (seen.has(sk)) continue;
    seen.add(sk);
    add(o.names[k], x, y, 'street');
  }
}

export function buildSearchIndex(o: Sources): Entry[] {
  const search: Entry[] = [];
  const seen = new Set<string>();
  const add: Add = (name, lon, lat, type) => {
    const k = `${name.toLowerCase()}|${lon.toFixed(3)}|${lat.toFixed(3)}`;
    if (!name || seen.has(k)) return;
    seen.add(k);
    search.push([name, +lon.toFixed(5), +lat.toFixed(5), type]);
  };
  addPlaces(o, add);
  for (const p of o.pois) add(p.name, p.lon, p.lat, p.cat);
  addOtherPois(o, add);
  addStreets(o, add);
  return search;
}
