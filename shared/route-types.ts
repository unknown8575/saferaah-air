// The shapes the router works with: requests, routes, safety tiers and the tuning constants.
import type { Mode } from './modes.ts';
import type { RiskContext, RiskField } from './risk.ts';
import type { PoiCat } from './places.ts';
import type { LonLat } from './geo.ts';
import type { AirField } from './air.ts';

export const ALPHAS = [0, 0.5, 1.5, 5] as const;
/** A slower route must lower mean risk at least this much to be shown. */
export const MIN_RISK_GAIN = 0.02;
/** …and may take at most this multiple of the fastest time. */
export const MAX_DETOUR = 1.6;

export type Tier = 'darkred' | 'red' | 'yellow' | 'green';
export const TIER_INFO: Record<Tier, { color: string; label: string; short: string }> = {
  darkred: { color: '#a3161f', label: 'High risk', short: 'Avoid if you can' },
  red: { color: '#ff3b30', label: 'Unsafe', short: 'Risky stretches' },
  yellow: { color: '#ff9f0a', label: 'Take care', short: 'Medium risk' },
  green: { color: '#30b158', label: 'Low risk', short: 'Busy, open, watched' },
};
/** Absolute thresholds on the route's time-weighted mean risk. */
export function tierOf(meanRisk: number, worstStretch: number): Tier {
  const r = 0.7 * meanRisk + 0.3 * worstStretch;
  if (r >= 0.6) return 'darkred';
  if (r >= 0.46) return 'red';
  if (r >= 0.32) return 'yellow';
  return 'green';
}

export interface Snapped {
  edge: number;
  t: number;
  lon: number;
  lat: number;
  distM: number;
}

export interface DangerSpot {
  lon: number;
  lat: number;
  lengthM: number;
  reasons: string[];
  street: string;
}

export interface RouteResult {
  alpha: number;
  edges: number[];
  coords: LonLat[];
  /** edge travelled between coords[i] and coords[i+1] */
  segEdge: number[];
  timeS: number;
  lengthM: number;
  meanRisk: number;
  /** worst ~200 m stretch risk */
  worstStretch: number;
  tier: Tier;
  /** open safe havens within 50 m of the route, by category */
  havens: Partial<Record<PoiCat, number>>;
  havenIds: number[];
  mainRoadShare: number;
  litShare: number;
  policeShare: number;
  dangerSpots: DangerSpot[];
  warnings: string[];
  labels: string[];
  /** clean-air score, when the router has an air field */
  air?: RouteAir;
}

export interface RouteAir {
  /** PM2.5 breathed on this trip at the given background (µg) */
  doseUg: number;
  /** time-weighted street pollution factor (1 = city background) */
  factor: number;
  /** % less PM2.5 breathed than on the fastest route (negative = more) */
  pctVsFastest: number;
  /** metres within 300 m of industrial land or a landfill */
  industryM: number;
  /** metres on or right beside a busy road */
  busyM: number;
  /** named industrial areas / landfills passed */
  areas: string[];
  /** named areas the fastest route passes that this one avoids */
  avoided: string[];
}

export interface AirInput {
  field: AirField;
  /** per-edge street factor (air.ts streetFactors) */
  factor: Float32Array;
  /** city background PM2.5 now, µg/m³ */
  pm25: number;
}

export interface RouteRequest {
  from: LonLat;
  to: LonLat;
  mode: Mode;
  when: Date;
  ctx: RiskContext;
  air?: AirInput;
}

export interface RouteResponse {
  routes: RouteResult[];
  /** routes[0..rankedCount) are the fastest→safest front; the rest are alternatives */
  rankedCount?: number;
  from: Snapped;
  to: Snapped;
  risk: RiskField;
  note?: string;
  error?: string;
  computeMs: number;
}
