// Checks for everything a client sends. Request bodies arrive as `unknown` and leave here as
// typed values with sane ranges, so the route handlers never touch raw input.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { LonLat } from '../shared/geo.ts';
import { DEFAULT_FAMILY, TRAVEL_LABEL, type Family, type Travel } from '../shared/saans/plan.ts';
import { aqiFrom, smogOf, type AirNow, type Weather, type WeatherHour } from '../shared/air.ts';
import type { AssistantContext, Turn } from '../shared/saans/assistant.ts';
import { HttpError } from './http.ts';

/** A JSON object from the client (or an empty one), so fields can be read without `any`. */
export type Json = Record<string, unknown>;

export const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
export const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const text = (v: unknown, max: number, fallback = ''): string => String(v ?? fallback).slice(0, max);

/** A finite number clamped to [lo, hi], or `d` when missing. */
export const num = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** Like `num`, but null when missing (weather readings can be absent). */
const maybe = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;

const isTime = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d/.test(x);

/** Compare a secret the client sent with the stored one in constant time. */
export function sameSecret(given: unknown, stored: unknown): boolean {
  if (typeof given !== 'string' || typeof stored !== 'string' || !given || !stored) return false;
  // hashing first makes both sides the same length, so timingSafeEqual never throws
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(stored).digest());
}

export function isLonLat(p: unknown): p is LonLat {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    p.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90
  );
}

/** A route the app drew: its line, the street ids it uses and the expected time. */
export interface RouteBody {
  route: LonLat[];
  edges: number[];
  etaS: number;
}

export function routeBody(b: Json): RouteBody {
  const { route, edges, etaS } = b;
  if (!Array.isArray(route) || route.length < 2 || route.length > 20000 || !route.every(isLonLat))
    throw new HttpError(400, 'Invalid route');
  if (!Array.isArray(edges) || edges.length > 50000 || !edges.every((e) => Number.isInteger(e) && (e as number) >= 0))
    throw new HttpError(400, 'Invalid edges');
  if (typeof etaS !== 'number' || !(etaS > 0) || etaS > 6 * 3600) throw new HttpError(400, 'Invalid ETA');
  return { route, edges: edges as number[], etaS };
}

/** Accept only the family fields we know, with sane ranges; null when the user hasn't set a profile. */
export function cleanFamily(input: unknown): Family | null {
  if (!isObj(input)) return null;
  const f = input;
  const d = DEFAULT_FAMILY;
  const c = obj(f.commute);
  const cooking = ['lpg', 'induction', 'wood', 'kerosene'].find((k) => k === f.cooking) as
    Family['cooking'] | undefined;
  return {
    adults: Math.round(num(f.adults, 0, 12, d.adults)),
    children: Math.round(num(f.children, 0, 12, d.children)),
    elders: Math.round(num(f.elders, 0, 12, d.elders)),
    asthma: f.asthma === true,
    pregnant: f.pregnant === true,
    cooking: cooking ?? d.cooking,
    bedroomM2: Math.round(num(f.bedroomM2, 4, 80, d.bedroomM2)),
    commute:
      typeof c.mode === 'string' && Object.hasOwn(TRAVEL_LABEL, c.mode)
        ? { mode: c.mode as Travel, km: Math.round(num(c.km, 0.5, 80, 5) * 10) / 10 }
        : null,
  };
}

function cleanHours(v: unknown): AirNow['hours'] {
  return list(v)
    .slice(0, 48)
    .map(obj)
    .filter((x) => isTime(x.time) && typeof x.pm25 === 'number')
    .map((x) => ({
      time: (x.time as string).slice(0, 16),
      pm25: num(x.pm25, 0, 1500, 0),
      pm10: num(x.pm10, 0, 2000, 0),
    }));
}

function cleanAvg(v: unknown): AirNow['avg24'] {
  const a = obj(v);
  if (typeof a.pm25 !== 'number') return undefined;
  return { pm25: num(a.pm25, 0, 1500, 0), pm10: num(a.pm10, 0, 2000, 0), hours: Math.round(num(a.hours, 0, 24, 0)) };
}

function cleanWeatherHour(v: unknown): WeatherHour | null {
  const w = obj(v);
  if (!isTime(w.time)) return null;
  return {
    time: w.time.slice(0, 16),
    tempC: maybe(w.tempC, -20, 55),
    humidity: maybe(w.humidity, 0, 100),
    windMs: maybe(w.windMs, 0, 60),
    windDir: maybe(w.windDir, 0, 360),
    visibilityM: maybe(w.visibilityM, 0, 100000),
    blhM: maybe(w.blhM, 0, 6000),
    temp925C: maybe(w.temp925C, -40, 50),
  };
}

/** Weather: only numbers are accepted; the smog verdict is recomputed from them. */
function cleanWeather(v: unknown): Weather | null {
  const w = obj(v);
  const now = cleanWeatherHour(w.now);
  if (!now) return null;
  const trap = obj(w.nextTrap);
  return {
    now,
    smog: smogOf(now),
    hours: [],
    nextTrap:
      isTime(trap.start) && isTime(trap.end) ? { start: trap.start.slice(0, 16), end: trap.end.slice(0, 16) } : null,
  };
}

function cleanGround(v: unknown): AirNow['ground'] {
  const g = obj(v);
  if (typeof g.pm25 !== 'number') return null;
  return {
    pm25: Math.round(num(g.pm25, 0, 1000, 0)),
    sensors: Math.round(num(g.sensors, 0, 500, 0)),
    source: 'Sensor.Community (low-cost, uncorrected)',
  };
}

/** Air reading sent by the app (it only shapes that user's own answer). */
export function cleanAir(input: unknown): AirNow | null {
  const a = obj(input);
  if (typeof a.pm25 !== 'number' || !Number.isFinite(a.pm25)) return null;
  const pm25 = num(a.pm25, 0, 1500, 0);
  const pm10 = num(a.pm10, 0, 2000, pm25 * 1.6);
  const avg = cleanAvg(a.avg24);
  // the AQI is recomputed here (never trusted from the client): 24-hour CPCB rule when the averages exist
  const aqi = (avg && avg.hours >= 16 ? aqiFrom(avg.pm25, avg.pm10, '24h') : aqiFrom(pm25, pm10, 'hourly'))!;
  return {
    at: text(a.at, 25),
    pm25,
    pm10,
    aqi,
    avg24: avg,
    hours: cleanHours(a.hours),
    source: text(a.source, 80, 'app'),
    weather: cleanWeather(a.weather),
    ground: cleanGround(a.ground),
  };
}

function cleanRoute(v: unknown): AssistantContext['route'] {
  if (!isObj(v)) return null;
  const names = (x: unknown) =>
    list(x)
      .slice(0, 4)
      .map((s) => text(s, 60));
  return {
    mode: text(v.mode, 20),
    minutes: Math.round(num(v.minutes, 0, 600, 0)),
    label: text(v.label, 30, 'Selected'),
    pctLess: Math.round(num(v.pctLess, -100, 100, 0)),
    avoided: names(v.avoided),
    areas: names(v.areas),
  };
}

function cleanPlaces(v: unknown): AssistantContext['places'] {
  if (!isObj(v) || !Array.isArray(v.items)) return null;
  return {
    title: text(v.title, 40, 'Places'),
    items: v.items
      .slice(0, 8)
      .map(obj)
      .filter((x) => typeof x.name === 'string')
      .map((x) => ({
        name: (x.name as string).slice(0, 80),
        kind: text(x.kind, 40),
        // rounded to 50 m: the server never needs the user's exact distance
        distM: Math.round(num(x.distM, 0, 50000, 0) / 50) * 50,
        open: typeof x.open === 'boolean' ? x.open : null,
        similar: x.similar === true,
      })),
  };
}

/** Everything Saans may know about the asker, cleaned. */
export function assistantContext(v: unknown): AssistantContext {
  const c = obj(v);
  return {
    air: cleanAir(c.air),
    family: cleanFamily(c.family),
    route: cleanRoute(c.route),
    places: cleanPlaces(c.places),
  };
}

/** The last few turns of the chat, as plain text. */
export function chatHistory(v: unknown): Turn[] {
  return list(v)
    .slice(-4)
    .map(obj)
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
    .map((t) => ({ role: t.role as Turn['role'], text: (t.text as string).slice(0, 600) }));
}
