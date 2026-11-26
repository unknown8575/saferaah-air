// Clean-air model: what a street adds to the city's background pollution, how much a
// traveller breathes in on a trip, and India's National AQI (CPCB) from PM2.5 / PM10.
//
// The city background comes from a forecast model (CAMS via Open-Meteo, ~10–45 km
// cells), which cannot see one street from the next. The street-level part is ours:
// busy roads, industrial estates and landfills raise particle levels within a few
// hundred metres; parks lower them a little. The factors are deliberately modest,
// rounded from near-road and Delhi commuter-exposure studies, and every number we
// show is labelled as an estimate.

import type { Graph } from './graph.ts';
import { ROAD_CLASSES, type Mode } from './modes.ts';

// ---------------------------------------------------------------- air.bin
export interface AirArrays {
  /** distance to industrial / quarry land, in AIR_CAP.ind metre steps (255 = far) */
  indM: Uint8Array;
  /** distance to a busy road, in AIR_CAP.maj metre steps */
  majM: Uint8Array;
  /** distance to a landfill, in AIR_CAP.dump metre steps */
  dumpM: Uint8Array;
  /** named industrial area / landfill index, -1 = none */
  area: Int16Array;
}
export interface AirMeta {
  areas: string[];
  cellM: number;
  source: string;
}
/** metres per stored unit */
export const AIR_CAP = { ind: 10, maj: 4, dump: 20 } as const;

const ORDER: [keyof AirArrays, 'u8' | 'i16'][] = [
  ['indM', 'u8'],
  ['majM', 'u8'],
  ['dumpM', 'u8'],
  ['area', 'i16'],
];

export function encodeAir(a: AirArrays, meta: AirMeta): Uint8Array {
  let off = 0;
  const entries = ORDER.map(([name]) => {
    off = Math.ceil(off / 8) * 8;
    const e = { name, offset: off, length: a[name].length };
    off += a[name].byteLength;
    return e;
  });
  const header = new TextEncoder().encode(JSON.stringify({ meta, arrays: entries }));
  const base = Math.ceil((8 + header.length) / 8) * 8;
  const out = new Uint8Array(base + off);
  out.set([0x53, 0x52, 0x41, 0x31], 0); // "SRA1"
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  for (const e of entries) {
    const src = a[e.name as keyof AirArrays];
    out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), base + e.offset);
  }
  return out;
}

export class AirField {
  readonly a: AirArrays;
  readonly meta: AirMeta;
  constructor(buf: ArrayBuffer | Uint8Array) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (bytes[0] !== 0x53 || bytes[1] !== 0x52 || bytes[2] !== 0x41 || bytes[3] !== 0x31)
      throw new Error('Not a SafeRaah air file');
    const hlen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen)));
    const base = Math.ceil((8 + hlen) / 8) * 8;
    const body = Uint8Array.prototype.slice.call(bytes, base).buffer as ArrayBuffer;
    const a: Partial<AirArrays> = {};
    for (const e of head.arrays as { name: keyof AirArrays; offset: number; length: number }[]) {
      (a as Record<string, unknown>)[e.name] =
        e.name === 'area' ? new Int16Array(body, e.offset, e.length) : new Uint8Array(body, e.offset, e.length);
    }
    this.a = a as AirArrays;
    this.meta = head.meta;
  }
  indM(e: number) {
    return this.a.indM[e] * AIR_CAP.ind;
  }
  majM(e: number) {
    return this.a.majM[e] * AIR_CAP.maj;
  }
  dumpM(e: number) {
    return this.a.dumpM[e] * AIR_CAP.dump;
  }
  areaName(e: number): string {
    const k = this.a.area[e];
    return k >= 0 ? (this.meta.areas[k] ?? '') : '';
  }
  /** Build a field from plain arrays (tests). */
  static from(a: AirArrays, areas: string[] = []): AirField {
    const f = Object.create(AirField.prototype) as AirField;
    Object.assign(f, { a, meta: { areas, cellM: 50, source: 'test' } });
    return f;
  }
}

// ---------------------------------------------------------------- street factor
/** How much dirtier than the city background the air on this kind of road is. */
const ROAD_FACTOR: Partial<Record<(typeof ROAD_CLASSES)[number], number>> = {
  motorway: 1.6,
  trunk: 1.55,
  primary: 1.45,
  secondary: 1.3,
  tertiary: 1.12,
  pedestrian: 0.95,
  footway: 0.95,
  path: 0.92,
  cycleway: 0.95,
  track: 0.95,
};

export interface AirSources {
  /** extra factor per edge from live smoke / dust / burning reports */
  live?: Map<number, number>;
}

/**
 * Street-level pollution relative to the city background (1 = background).
 * On a busy road up to +60 %, beside one up to +25 % (fading over 150 m), on industrial
 * land up to +50 % (fading over 600 m), next to a landfill up to +60 % (fading over
 * 1.5 km), inside a park −10 %. Capped at 2.2×.
 */
export function streetFactor(g: Graph, air: AirField, e: number, src?: AirSources): number {
  const cls = ROAD_CLASSES[g.a.edgeClass[e]];
  let f = ROAD_FACTOR[cls] ?? 1;
  const maj = air.majM(e);
  if (f < 1.3 && maj < 150) f += 0.25 * (1 - maj / 150);
  const ind = air.indM(e);
  if (ind < 600) f += 0.5 * (1 - ind / 600);
  const dump = air.dumpM(e);
  if (dump < 1500) f += 0.6 * (1 - dump / 1500);
  const green = g.a.edgeGreen[e];
  if (green & 1) f *= 0.9;
  else if (green & 2) f *= 0.95;
  f += src?.live?.get(e) ?? 0;
  return Math.min(2.2, Math.max(0.7, f));
}

export function streetFactors(g: Graph, air: AirField, src?: AirSources): Float32Array {
  const out = new Float32Array(g.m);
  for (let e = 0; e < g.m; e++) out[e] = streetFactor(g, air, e, src);
  return out;
}

// ---------------------------------------------------------------- breathing
/**
 * Air breathed per hour (m³/h) and how much of the outside air reaches the lungs
 * (cabin ratio). Walking adults breathe ~1.4 m³/h; sitting ~0.6. Riders sit in the
 * exhaust stream; a closed car with recirculation keeps out roughly 40 %.
 */
export const BREATHING: Record<Mode, { m3h: number; cabin: number; label: string }> = {
  walk: { m3h: 1.4, cabin: 1.0, label: 'walking' },
  twowheeler: { m3h: 0.8, cabin: 1.15, label: 'on a two-wheeler' },
  auto: { m3h: 0.7, cabin: 1.05, label: 'in an open auto' },
  car: { m3h: 0.6, cabin: 0.6, label: 'in a closed car' },
};
/** Children breathe more air for their body size; elders and asthma need extra care. */
export const PERSON_FACTOR = { adult: 1, child: 1.5, elder: 1.1 } as const;

/** PM2.5 breathed in (µg) for `seconds` at background `pm25` × street `factor`. */
export function doseUg(pm25: number, factor: number, seconds: number, mode: Mode): number {
  const b = BREATHING[mode];
  return pm25 * factor * b.cabin * b.m3h * (seconds / 3600);
}

// ---------------------------------------------------------------- Indian NAQI (CPCB)
export type AqiBand = 'good' | 'satisfactory' | 'moderate' | 'poor' | 'verypoor' | 'severe';
export const AQI_BANDS: Record<AqiBand, { label: string; color: string; range: [number, number]; advice: string }> = {
  good: { label: 'Good', color: '#30b158', range: [0, 50], advice: 'Air is fine. A good time to be outside.' },
  satisfactory: {
    label: 'Satisfactory',
    color: '#8cc63f',
    range: [51, 100],
    advice: 'Fine for most people; sensitive people may feel minor discomfort.',
  },
  moderate: {
    label: 'Moderate',
    color: '#ffcc00',
    range: [101, 200],
    advice: 'Children, elders and people with asthma should keep long outdoor effort short.',
  },
  poor: {
    label: 'Poor',
    color: '#ff9f0a',
    range: [201, 300],
    advice: 'Most people feel it on long exposure. Avoid outdoor exercise; take quieter streets.',
  },
  verypoor: {
    label: 'Very poor',
    color: '#ff3b30',
    range: [301, 400],
    advice: 'Unhealthy for everyone. Stay indoors when you can; wear an N95 outside.',
  },
  severe: {
    label: 'Severe',
    color: '#a3161f',
    range: [401, 500],
    advice: 'Hazardous. Avoid going out; keep windows shut and run a purifier.',
  },
};
const BAND_ORDER: AqiBand[] = ['good', 'satisfactory', 'moderate', 'poor', 'verypoor', 'severe'];
// concentration breakpoints (µg/m³, 24-h) matching the AQI ranges above
const PM25_BP = [0, 30, 60, 90, 120, 250, 500];
const PM10_BP = [0, 50, 100, 250, 350, 430, 600];
const AQI_BP = [0, 50, 100, 200, 300, 400, 500];

function subIndex(c: number, bp: number[]): number {
  if (!(c >= 0)) return NaN;
  for (let i = 1; i < bp.length; i++) {
    if (c <= bp[i]) {
      const lo = AQI_BP[i - 1] + (i > 1 ? 1 : 0);
      const clo = bp[i - 1] + (i > 1 ? 1 : 0);
      if (c < clo) return lo;
      return lo + ((AQI_BP[i] - lo) * (c - clo)) / (bp[i] - clo);
    }
  }
  return 500;
}

export interface Aqi {
  value: number;
  band: AqiBand;
  main: 'PM2.5' | 'PM10';
  /** CPCB defines the PM sub-indices on 24-hour averages; "hourly" marks an estimate from one hour */
  basis?: '24h' | 'hourly';
}
const valid = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** Indian National AQI from PM2.5 and PM10 (the larger sub-index wins). */
export function naqi(pm25: number, pm10?: number): Aqi {
  return aqiFrom(pm25, pm10) ?? { value: 0, band: 'good', main: 'PM2.5' };
}
/** Like naqi, but honest about missing data: null when neither pollutant is known. */
export function aqiFrom(pm25: number | null | undefined, pm10?: number | null, basis?: Aqi['basis']): Aqi | null {
  const a = valid(pm25) ? subIndex(pm25, PM25_BP) : NaN;
  const b = valid(pm10) ? subIndex(pm10, PM10_BP) : NaN;
  if (Number.isNaN(a) && Number.isNaN(b)) return null;
  const main = Number.isNaN(a) || (!Number.isNaN(b) && b > a) ? 'PM10' : 'PM2.5';
  const v = Math.round(main === 'PM10' ? b : a);
  return { value: v, band: bandOf(v), main, ...(basis ? { basis } : {}) };
}
export function bandOf(aqi: number): AqiBand {
  for (const b of BAND_ORDER) if (aqi <= AQI_BANDS[b].range[1]) return b;
  return 'severe';
}

// ---------------------------------------------------------------- forecast
export interface AirHour {
  time: string;
  pm25: number;
  pm10: number;
}
export interface AirNow {
  at: string;
  /** this hour's concentrations (µg/m³) */
  pm25: number;
  pm10: number;
  /** National AQI: from the 24-hour averages when 16+ hours are known (CPCB rule), else this hour */
  aqi: Aqi;
  /** 24-hour averages used for the AQI */
  avg24?: { pm25: number; pm10: number; hours: number };
  hours: AirHour[];
  source: string;
  /** weather that decides whether smog builds up (Open-Meteo forecast) */
  weather?: Weather | null;
  /** nearby low-cost ground sensors (Sensor.Community), median of recent readings */
  ground?: { pm25: number; sensors: number; source: string } | null;
}

/** Parse an Open-Meteo air-quality response (hourly pm2_5 / pm10, local time; ask with past_days=1). */
export function parseOpenMeteo(j: any, now: Date = new Date()): AirNow | null {
  const t: string[] = j?.hourly?.time ?? [];
  const p25: (number | null)[] = j?.hourly?.pm2_5 ?? [];
  const p10: (number | null)[] = j?.hourly?.pm10 ?? [];
  const off = (j?.utc_offset_seconds ?? 19800) * 1000;
  const hours: AirHour[] = [];
  for (let i = 0; i < t.length; i++) {
    const a = p25[i],
      b = p10[i];
    if (!valid(a) || !valid(b)) continue;
    hours.push({ time: t[i], pm25: a, pm10: b });
  }
  if (!hours.length) return null;
  // the hour that contains `now` (times are local wall-clock, ISO without zone)
  const localNow = new Date(now.getTime() + off).toISOString().slice(0, 13);
  let i = hours.findIndex((h) => h.time.slice(0, 13) >= localNow);
  if (i < 0) i = hours.length - 1;
  const cur = valid(j?.current?.pm2_5)
    ? { pm25: j.current.pm2_5 as number, pm10: valid(j.current.pm10) ? (j.current.pm10 as number) : hours[i].pm10 }
    : hours[i];
  // CPCB: PM2.5 / PM10 sub-indices use 24-hour averages, valid with at least 16 hours of data
  const past = hours.slice(Math.max(0, i - 23), i + 1);
  const avg = (k: 'pm25' | 'pm10') => past.reduce((s, h) => s + h[k], 0) / past.length;
  const has24 = past.length >= 16;
  const avg24 = has24 ? { pm25: avg('pm25'), pm10: avg('pm10'), hours: past.length } : undefined;
  return {
    at: hours[i].time,
    pm25: cur.pm25,
    pm10: cur.pm10,
    aqi: (has24 ? aqiFrom(avg24!.pm25, avg24!.pm10, '24h') : aqiFrom(cur.pm25, cur.pm10, 'hourly'))!,
    avg24,
    hours: hours.slice(i, i + 24),
    source: 'CAMS forecast via Open-Meteo',
  };
}

// ---------------------------------------------------------------- weather & smog
/**
 * Winter smog in Delhi is mostly a weather problem: on calm nights the ground cools, a
 * temperature inversion forms and the boundary layer (the air that pollution can mix into)
 * shrinks to a few hundred metres, so the same emissions give several times the PM2.5.
 */
export interface WeatherHour {
  time: string;
  tempC: number | null;
  humidity: number | null;
  windMs: number | null;
  windDir: number | null;
  visibilityM: number | null;
  /** planetary boundary layer height (m) */
  blhM: number | null;
  /** temperature ~750 m up (925 hPa); warmer-than-expected air aloft means an inversion */
  temp925C: number | null;
}
export type SmogLevel = 'low' | 'moderate' | 'high' | 'severe';
export interface Weather {
  now: WeatherHour;
  /** smog trap now: inversion / stagnant air / shallow mixing */
  smog: { level: SmogLevel; inversion: boolean; stagnant: boolean; reasons: string[] };
  /** the next hours (up to 24) in which smog is trapped, if any */
  nextTrap: { start: string; end: string } | null;
  hours: WeatherHour[];
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Smog-trapping conditions for one hour, from wind, mixing height, temperature profile and humidity. */
export function smogOf(h: WeatherHour): Weather['smog'] {
  const reasons: string[] = [];
  let score = 0;
  // normal lapse rate: ~750 m up is 4–7 °C colder; less than 1.5 °C colder means an inversion / very stable air
  const inversion = h.tempC !== null && h.temp925C !== null && h.temp925C > h.tempC - 1.5;
  if (inversion) {
    score += 2;
    reasons.push('temperature inversion: warm air above traps smoke near the ground');
  }
  if (h.blhM !== null) {
    if (h.blhM < 300) {
      score += 2;
      reasons.push(`very shallow mixing layer (~${Math.round(h.blhM / 10) * 10} m)`);
    } else if (h.blhM < 700) {
      score += 1;
      reasons.push(`shallow mixing layer (~${Math.round(h.blhM / 10) * 10} m)`);
    }
  }
  const stagnant = h.windMs !== null && h.windMs < 1.5;
  if (stagnant) {
    score += 2;
    reasons.push('almost no wind');
  } else if (h.windMs !== null && h.windMs < 3) {
    score += 1;
    reasons.push('light wind');
  }
  if (h.humidity !== null && h.humidity > 80) {
    score += 1;
    reasons.push('humid air helps particles grow');
  }
  if (h.visibilityM !== null && h.visibilityM < 1500) {
    score += 1;
    reasons.push(`poor visibility (${(h.visibilityM / 1000).toFixed(1)} km)`);
  }
  const level: SmogLevel = score >= 6 ? 'severe' : score >= 4 ? 'high' : score >= 2 ? 'moderate' : 'low';
  return { level, inversion, stagnant, reasons };
}

/** Parse an Open-Meteo forecast response (hourly weather, local time). */
export function parseWeather(j: any, now: Date = new Date()): Weather | null {
  const H = j?.hourly;
  const t: string[] = H?.time ?? [];
  if (!t.length) return null;
  const hours: WeatherHour[] = t.map((time, k) => ({
    time,
    tempC: num(H.temperature_2m?.[k]),
    humidity: num(H.relative_humidity_2m?.[k]),
    windMs: num(H.wind_speed_10m?.[k]),
    windDir: num(H.wind_direction_10m?.[k]),
    visibilityM: num(H.visibility?.[k]),
    blhM: num(H.boundary_layer_height?.[k]),
    temp925C: num(H.temperature_925hPa?.[k]),
  }));
  const off = (j?.utc_offset_seconds ?? 19800) * 1000;
  const localNow = new Date(now.getTime() + off).toISOString().slice(0, 13);
  let i = hours.findIndex((h) => h.time.slice(0, 13) >= localNow);
  if (i < 0) i = hours.length - 1;
  const next = hours.slice(i, i + 24);
  let trap: Weather['nextTrap'] = null;
  for (let k = 0; k < next.length; k++) {
    const sm = smogOf(next[k]);
    if (sm.level === 'high' || sm.level === 'severe') {
      if (!trap) trap = { start: next[k].time, end: next[k].time };
      else trap.end = next[k].time;
    } else if (trap) break;
  }
  return { now: hours[i], smog: smogOf(hours[i]), nextTrap: trap, hours: next };
}

/** Median PM2.5 of nearby Sensor.Community stations (readings in µg/m³; obviously broken values dropped). */
export function parseSensors(list: any[]): { pm25: number; sensors: number; source: string } | null {
  const vals: number[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(list) ? list : []) {
    const id = String(s?.sensor?.id ?? s?.id ?? Math.random());
    if (seen.has(id)) continue;
    for (const v of s?.sensordatavalues ?? []) {
      const x = Number(v?.value);
      if (v?.value_type === 'P2' && Number.isFinite(x) && x > 0 && x < 1000) {
        vals.push(x);
        seen.add(id);
      }
    }
  }
  if (vals.length < 2) return null;
  vals.sort((a, b) => a - b);
  const m = vals.length >> 1;
  const median = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  return { pm25: Math.round(median), sensors: vals.length, source: 'Sensor.Community (low-cost, uncorrected)' };
}

/** The cleanest window of `len` hours in the next day, for planning a walk or errand. */
export function cleanestWindow(
  hours: AirHour[],
  len = 2,
  fromHour = 6,
  toHour = 22,
): { start: string; end: string; pm25: number } | null {
  let best: { start: string; end: string; pm25: number } | null = null;
  for (let i = 0; i + len <= hours.length; i++) {
    const h = Number(hours[i].time.slice(11, 13));
    if (h < fromHour || h + len > toHour) continue;
    const avg = hours.slice(i, i + len).reduce((s, x) => s + x.pm25, 0) / len;
    if (!best || avg < best.pm25) best = { start: hours[i].time, end: hours[i + len - 1].time, pm25: avg };
  }
  return best;
}

// ---------------------------------------------------------------- request URLs (shared by app and server)
export const AIR_URL = (lat: string, lon: string) =>
  `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
  '&current=pm2_5,pm10&hourly=pm2_5,pm10&timezone=Asia%2FKolkata&past_days=1&forecast_days=2';
export const WEATHER_URL = (lat: string, lon: string) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
  '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,visibility,boundary_layer_height,temperature_925hPa' +
  '&wind_speed_unit=ms&timezone=Asia%2FKolkata&forecast_days=2';
/** Delhi NCT plus a margin: the only area this service has street data and advice for */
export const COVERAGE = { west: 76.7, south: 28.3, east: 77.5, north: 29.0 };
export const inCoverageArea = (lat: number, lon: number) =>
  lat >= COVERAGE.south && lat <= COVERAGE.north && lon >= COVERAGE.west && lon <= COVERAGE.east;
