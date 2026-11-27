// Plain-language advice shown above the route list, including a
// suggestion to switch travel mode when every route is risky.

import type { Mode } from './modes.ts';
import { MODE_INFO } from './modes.ts';
import type { Profile } from './risk.ts';
import type { RouteResult, Tier } from './router.ts';
import { istTime } from './time.ts';
import { AQI_BANDS, type AqiBand } from './air.ts';

export interface Advice {
  level: 'ok' | 'caution' | 'warn';
  title: string;
  body: string;
  /** a safer travel mode to switch to, if we recommend one */
  suggestMode?: Mode;
}

const RANK: Record<Tier, number> = { green: 0, yellow: 1, red: 2, darkred: 3 };

function fmtClock(when: Date): string {
  const m = istTime(when).minutes;
  const h = Math.floor(m / 60),
    mm = m % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

export function adviseTrip(opts: {
  mode: Mode;
  profile: Profile;
  when: Date;
  routes: RouteResult[];
  /** fastest time for an auto/cab over the same trip, if computed */
  vehicleAltS?: { mode: Mode; timeS: number; tier: Tier; fastestS?: number };
  /** how many trusted contacts get the arrival message (0: none saved, so promise nothing) */
  contacts?: number;
}): Advice | null {
  const { mode, profile, when, routes, vehicleAltS } = opts;
  const arrival = (opts.contacts ?? 0) > 0;
  if (!routes.length) return null;
  const best = routes.reduce((a, b) => (RANK[b.tier] < RANK[a.tier] ? b : a));
  const bestRank = RANK[best.tier];
  const km = (best.lengthM / 1000).toFixed(1);
  const clock = fmtClock(when);
  const who = profile === 'child' ? 'for a child ' : '';

  if (mode === 'walk' && bestRank >= 2 && best.lengthM > 700 && vehicleAltS && RANK[vehicleAltS.tier] <= bestRank) {
    const mins = Math.max(1, Math.round(vehicleAltS.timeS / 60));
    const fastMins = vehicleAltS.fastestS != null ? Math.max(1, Math.round(vehicleAltS.fastestS / 60)) : mins;
    const took =
      fastMins < mins
        ? `the safest route takes about ${mins} min (fastest ${fastMins} min)`
        : `it takes about ${mins} min`;
    return {
      level: 'warn',
      title: `Walking ${who}is risky on every route right now`,
      body:
        `It is ${clock} and even the safest walk (${km} km) passes quiet, closed stretches. ` +
        `By ${MODE_INFO[vehicleAltS.mode].label.toLowerCase()}, ${took} — consider it, and share your trip.`,
      suggestMode: vehicleAltS.mode,
    };
  }
  if (bestRank === 3) {
    return {
      level: 'warn',
      title: 'Every route has high-risk stretches',
      body: 'Share your live trip with a trusted contact before you start, and keep the SOS button handy.',
    };
  }
  if (bestRank === 2) {
    return {
      level: 'caution',
      title: 'Choose the safest route and stay alert',
      body:
        best === routes[0]
          ? 'The fastest route is also the least risky one, but it has quiet stretches.'
          : 'The safer route takes a little longer but keeps you on busier, more open streets.',
    };
  }
  if (bestRank === 1) {
    return {
      level: 'caution',
      title: 'Mostly safe, a few quiet parts',
      body: `Stick to the yellow or green route. ${arrival ? 'We will tell your contacts when you arrive.' : 'Add a trusted contact if you want someone told when you arrive.'}`,
    };
  }
  return {
    level: 'ok',
    title: 'Busy, open streets on the safest route',
    body: arrival
      ? 'We will still send an arrival message to your contacts when you reach.'
      : 'Enjoy the trip; add a trusted contact if you want someone told when you reach.',
  };
}

// ---------------------------------------------------------------- air on the way

/** Straight-line trips longer than this open on an auto, not a walk, unless the user picked a mode. */
export const LONG_WALK_M = 3000;

/** The travel mode a trip opens with when the user has not chosen one. */
export function defaultMode(distM: number): Mode {
  return distM > LONG_WALK_M ? 'auto' : 'walk';
}

/** Minutes in the open past which each AQI band gets a warning on the routes screen. */
const AIR_LIMIT_MIN: Partial<Record<AqiBand, number>> = { poor: 30, verypoor: 15, severe: 10 };
const OPEN_AIR: Partial<Record<Mode, string>> = {
  walk: 'on foot',
  twowheeler: 'on a two-wheeler',
  auto: 'in an open auto',
};

function duration(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

/**
 * A warning when the trip means breathing bad air for a long time: poor air for 30+ min,
 * very poor for 15+ min or severe for 10+ min in an open mode (walk, two-wheeler, auto).
 * It names the time in the air, says when smog is trapped, and suggests a closed car or cab.
 */
export function adviseAir(o: {
  mode: Mode;
  /** the quickest route's time, s */
  timeS: number;
  aqi: { value: number; band: AqiBand } | null;
  smogTrapped?: boolean;
  /** an auto over the same trip, when walking */
  vehicleAlt?: { mode: Mode; timeS: number };
}): Advice | null {
  const how = OPEN_AIR[o.mode];
  const limit = o.aqi ? AIR_LIMIT_MIN[o.aqi.band] : undefined;
  if (!o.aqi || !how || limit === undefined || o.timeS < limit * 60) return null;
  const alt =
    o.vehicleAlt && o.vehicleAlt.timeS < o.timeS
      ? `By ${MODE_INFO[o.vehicleAlt.mode].label.toLowerCase()} it takes about ${duration(o.vehicleAlt.timeS)}, far less time in this air. `
      : '';
  return {
    level: o.aqi.band === 'poor' ? 'caution' : 'warn',
    title: `${AQI_BANDS[o.aqi.band].label} air (AQI ${o.aqi.value}): ${duration(o.timeS)} ${how}`,
    body:
      (o.smogTrapped ? 'Smog is trapped near the ground right now, so it will not clear on the way. ' : '') +
      alt +
      'A closed car or cab, or the metro, keeps most of it out. If you go this way, wear a well-fitted N95 and pick the cleanest-air route.',
    suggestMode: 'car',
  };
}
