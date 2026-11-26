// Live air quality for the area around the user: current PM2.5 / PM10 and the next
// 24 hours. Asked from our server when there is one (it can use Google's Air Quality
// API), otherwise straight from Open-Meteo (CAMS forecast, free, no key).
//
// Privacy: the position is rounded to a ~10 km cell before it leaves the phone (the
// forecast grid is coarser than that anyway), and results live only in memory.
import { parseOpenMeteo, parseWeather, AIR_URL, WEATHER_URL, type AirNow } from '../../shared/air.ts';
import { API_BASE } from './api.ts';
import type { LonLat } from '../../shared/geo.ts';

const TTL = 30 * 60 * 1000;
const cache = new Map<string, { at: number; v: AirNow | null }>();
const cell = (x: number) => (Math.round(x * 10) / 10).toFixed(1);

export function airCellOf(p: LonLat): LonLat {
  return [Number(cell(p[0])), Number(cell(p[1]))];
}

async function fromServer(lon: string, lat: string, signal: AbortSignal): Promise<AirNow | null> {
  const r = await fetch(`${API_BASE ? API_BASE + '/' : ''}api/air?lat=${lat}&lon=${lon}`, { signal });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.aqi ? (d as AirNow) : null;
}

async function fromOpenMeteo(lon: string, lat: string, signal: AbortSignal): Promise<AirNow | null> {
  const [air, wx] = await Promise.all([
    fetch(AIR_URL(lat, lon), { signal }).then((r) => (r.ok ? r.json() : null)),
    fetch(WEATHER_URL(lat, lon), { signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  const v = air ? parseOpenMeteo(air) : null;
  if (v) v.weather = wx ? parseWeather(wx) : null;
  return v;
}

/** Air now and the next day for the cell around `p` (null if offline). */
export async function airAt(p: LonLat, opts: { server?: boolean } = {}): Promise<AirNow | null> {
  const lon = cell(p[0]),
    lat = cell(p[1]);
  const key = `${lon},${lat}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  let v: AirNow | null = null;
  try {
    if (opts.server) v = await fromServer(lon, lat, ctl.signal).catch(() => null);
    v ??= await fromOpenMeteo(lon, lat, ctl.signal);
  } catch {
    v = null;
  } finally {
    clearTimeout(t);
  }
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** Tests can inject a reading without the network. */
export function setAirForTest(p: LonLat, v: AirNow | null) {
  cache.set(`${cell(p[0])},${cell(p[1])}`, { at: Date.now(), v });
}
