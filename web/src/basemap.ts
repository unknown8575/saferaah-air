// The base map and drawing helpers: our own OpenMapTiles-schema vector tiles for Delhi, packed
// into one file per zoom-11 area and fetched only when that part of the city comes into view;
// the day/night style; the street colour scales; and small geometry helpers for markers.
import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import { TIER_INFO, type DangerSpot, type Tier } from '../../shared/router.ts';
import type { WorkerRoute } from './worker.ts';
import { icon } from './icons.ts';
import type { LonLat } from '../../shared/geo.ts';
import mapStyle from './map-style.json';

interface Pack {
  tiles: Record<string, [number, number]>;
  data: Uint8Array;
}
const packs = new Map<string, Promise<Pack | null>>();
let packZoom = 11;
let available = new Set<string>();

function loadPack(base: string, key: string): Promise<Pack | null> {
  let p = packs.get(key);
  if (!p) {
    p = (async () => {
      if (!available.has(key)) return null;
      const r = await fetch(`${base}data/tiles/${key}.bin`);
      if (!r.ok) throw new Error(`map pack ${key}: ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (String.fromCharCode(...buf.subarray(0, 4)) !== 'SRT1') throw new Error('Bad map pack');
      const hlen = new DataView(buf.buffer, buf.byteOffset).getUint32(4, true);
      const head = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hlen)));
      return { tiles: head.tiles, data: buf.subarray(8 + hlen) };
    })();
    p.catch(() => packs.delete(key)); // let a failed download retry later
    packs.set(key, p);
  }
  return p;
}

export async function loadBasemap(base: string): Promise<{ bounds: [number, number, number, number] }> {
  const index = await (await fetch(base + 'data/tiles/index.json')).json();
  packZoom = index.packZoom ?? 11;
  available = new Set(index.packs);
  loadPack(base, 'low'); // small; covers the whole-city view
  maplibregl.addProtocol('srt', async (params: { url: string }) => {
    const [z, x, y] = params.url.replace('srt://', '').split('/').map(Number);
    const key = z < packZoom ? 'low' : `${packZoom}_${x >> (z - packZoom)}_${y >> (z - packZoom)}`;
    const pack = await loadPack(base, key);
    const e = pack?.tiles[`${z}/${x}/${y}`];
    if (!pack || !e) return { data: new ArrayBuffer(0) };
    return { data: pack.data.slice(e[0], e[0] + e[1]).buffer };
  });
  return { bounds: index.bounds };
}

export type FeatureCollection = { type: 'FeatureCollection'; features: unknown[] };

export type Theme = 'day' | 'night';
/**
 * The base map: a calm, Apple-Maps-like style so the safety and air colours are the only strong
 * colours on screen. Layers and the day/night palettes live in map-style.json; "@name" values
 * there are filled in here.
 */
type Palette = Record<string, string | number>;
const STYLE = mapStyle as { palette: Record<Theme, Palette>; layers: unknown[] };
const NAME = ['coalesce', ['get', 'name:latin'], ['get', 'name_en'], ['get', 'name']];
const MAJOR_ROADS = ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']];

/** line width growing with zoom: a at z10, b at z14, c at z18 */
const zoomWidth = (a: number, b: number, c: number) => [
  'interpolate',
  ['exponential', 1.6],
  ['zoom'],
  10,
  a,
  14,
  b,
  18,
  c,
];

function fill(v: unknown, pal: Palette): unknown {
  if (Array.isArray(v)) return v.map((x) => fill(x, pal));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, pal)]));
  if (typeof v !== 'string' || !v.startsWith('@')) return v;
  const key = v.slice(1);
  if (key === 'name') return NAME;
  if (key === 'majorRoads') return MAJOR_ROADS;
  if (key.startsWith('width:')) return zoomWidth(...(key.slice(6).split(',').map(Number) as [number, number, number]));
  return pal[key];
}

export function baseStyle(theme: Theme, base: string, bounds: [number, number, number, number]): StyleSpecification {
  const glyphBase = new URL('fonts/', new URL(base, location.href)).href;
  return {
    version: 8,
    glyphs: glyphBase + '{fontstack}/{range}.pbf', // one bundled font stack, named "noto" (Noto Sans Regular)
    sources: {
      base: {
        type: 'vector',
        tiles: ['srt://{z}/{x}/{y}'],
        minzoom: 0,
        maxzoom: 14,
        bounds,
        attribution:
          '© <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
      },
    },
    layers: fill(STYLE.layers, STYLE.palette[theme]) as StyleSpecification['layers'],
  };
}

export const TRAFFIC_KEY = (import.meta.env.VITE_TOMTOM_KEY as string | undefined) ?? '';
export const hasTraffic = () => !!TRAFFIC_KEY;

/** Street risk (0..1) to the same four colours the routes use. */
/** street air factor (1 = city background) → a smog scale from clean teal to deep purple */
export const AIR_COLOR = [
  'interpolate',
  ['linear'],
  ['get', 'f'],
  0.95,
  '#2fbf9b',
  1.12,
  '#c9c446',
  1.3,
  '#ff9f0a',
  1.5,
  '#d9480f',
  1.8,
  '#7b2cbf',
];
export const RISK_COLOR = [
  'step',
  ['get', 'r'],
  TIER_INFO.green.color,
  0.32,
  TIER_INFO.yellow.color,
  0.46,
  TIER_INFO.red.color,
  0.6,
  TIER_INFO.darkred.color,
];

export function circlePolygon(lon: number, lat: number, radiusM: number, n = 48): LonLat[] {
  const out: LonLat[] = [];
  const dLat = radiusM / 111200,
    dLon = radiusM / (111200 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

/** A point on route i that is far from the other routes, so its label doesn't sit on top of theirs. */
export function calloutPoint(routes: { coords: LonLat[] }[], i: number): LonLat {
  const own = routes[i].coords;
  const step = Math.max(1, Math.floor(own.length / 60));
  const others: LonLat[] = [];
  routes.forEach((r, k) => {
    if (k !== i)
      for (let j = 0; j < r.coords.length; j += Math.max(1, Math.floor(r.coords.length / 120)))
        others.push(r.coords[j]);
  });
  let best = own[Math.floor(own.length / 2)],
    bestD = -1;
  const lo = Math.floor(own.length * 0.2),
    hi = Math.ceil(own.length * 0.8);
  for (let j = lo; j < hi; j += step) {
    const p = own[j];
    let d = Infinity;
    for (const q of others) {
      const dd = ((p[0] - q[0]) * 97.6) ** 2 + ((p[1] - q[1]) * 111.2) ** 2;
      if (dd < d) d = dd;
    }
    if (d > bestD + 1e-9) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Marker element: MapLibre owns the outer element's transform, so shapes that rotate go inside. */
export function pinEl(cls: string, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pin-wrap';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  const inner = document.createElement('div');
  inner.className = `pin ${cls}`;
  el.appendChild(inner);
  return el;
}

export const fmtMin = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' m' : ''}`.trim();
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The route lines as GeoJSON; `frac` < 1 draws each only part of the way (the drawing animation). */
export function routeLines(routes: WorkerRoute[], selected: number, frac: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: routes.map((r, i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: frac >= 1 ? r.coords : r.coords.slice(0, Math.max(2, Math.ceil(r.coords.length * frac))),
      },
      properties: {
        i,
        sel: i === selected ? 1 : 0,
        z: i === selected ? 10 : i,
        color: TIER_INFO[r.tier as Tier].color,
      },
    })),
  };
}

/** The time label on a route line, tappable to pick that route. */
export function calloutEl(r: WorkerRoute, i: number, sel: boolean, late: boolean, onPick: () => void): HTMLElement {
  const el = document.createElement('button');
  el.className = `callout tier-${r.tier}${sel ? ' sel' : ''}${late ? ' late' : ''}`;
  el.dataset.i = String(i);
  const ci = document.createElement('span');
  ci.className = 'ci';
  ci.appendChild(icon(r.tier === 'green' ? 'check' : 'alert', 11, 2.6));
  const b = document.createElement('b');
  b.textContent = fmtMin(r.timeS);
  el.append(ci, b);
  el.setAttribute('aria-label', `Route ${i + 1}: ${fmtMin(r.timeS)}, ${TIER_INFO[r.tier as Tier].label}`);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onPick();
  });
  return el;
}

/** The "!" marker on a risky stretch. */
export function dangerPinEl(d: DangerSpot): HTMLElement {
  const el = document.createElement('button');
  el.className = 'danger-pin';
  el.setAttribute('aria-label', `Risky stretch, ${d.lengthM} metres: ${d.reasons.join(', ')}`);
  el.textContent = '!';
  return el;
}

export function dangerPopupHtml(d: DangerSpot): string {
  const where = d.street ? ' on ' + escapeHtml(d.street) : '';
  return `<b>Risky stretch, ${d.lengthM} m${where}</b><br>${d.reasons.map(escapeHtml).join('<br>') || 'quiet at this hour'}`;
}
