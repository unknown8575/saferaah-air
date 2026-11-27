// Safe-haven places (POIs) and whether they are open at a given time.
import opening_hours from 'opening_hours';
import { istTime, istWallClockDate } from './time.ts';

export const POI_CATS = [
  'police',
  'hospital',
  'clinic',
  'pharmacy',
  'govt',
  'station',
  'fuel',
  'hotel',
  'shop',
  'food',
  'bank',
  'atm',
  'worship',
  'liquor',
] as const;
export type PoiCat = (typeof POI_CATS)[number];

export interface Poi {
  id: number;
  lon: number;
  lat: number;
  cat: PoiCat;
  name: string;
  /** Raw OSM opening_hours string, if mapped. */
  oh?: string;
}

export const CAT_INFO: Record<PoiCat, { label: string; icon: string; haven: number }> = {
  police: { label: 'Police', icon: '👮', haven: 1.0 },
  hospital: { label: 'Hospital', icon: '🏥', haven: 1.0 },
  clinic: { label: 'Clinic', icon: '🩺', haven: 0.6 },
  pharmacy: { label: 'Medical store', icon: '💊', haven: 0.75 },
  govt: { label: 'Govt office', icon: '🏛️', haven: 0.5 },
  station: { label: 'Metro / rail', icon: '🚇', haven: 0.8 },
  fuel: { label: 'Petrol pump', icon: '⛽', haven: 0.7 },
  hotel: { label: 'Hotel', icon: '🏨', haven: 0.5 },
  shop: { label: 'Shop', icon: '🛍️', haven: 0.45 },
  food: { label: 'Eatery', icon: '🍽️', haven: 0.45 },
  bank: { label: 'Bank', icon: '🏦', haven: 0.2 },
  atm: { label: 'ATM', icon: '🏧', haven: 0.15 },
  worship: { label: 'Place of worship', icon: '🛕', haven: 0.3 },
  // Criminology: liquor outlets attract trouble after dark, so they count against safety.
  liquor: { label: 'Liquor shop / bar', icon: '🍺', haven: -0.5 },
};

/** OSM tag values that decide a category, in priority order (the first match wins). */
const POI_RULES: [PoiCat, (t: Record<string, string>, kind?: string) => boolean][] = [
  ['police', (t) => t.amenity === 'police'],
  ['hospital', (t) => t.amenity === 'hospital' || t.healthcare === 'hospital'],
  ['clinic', (t) => ['clinic', 'doctors', 'dentist'].includes(t.amenity) || t.healthcare === 'clinic'],
  ['pharmacy', (t) => t.amenity === 'pharmacy' || t.shop === 'chemist' || t.healthcare === 'pharmacy'],
  ['clinic', (t) => t.amenity === 'blood_bank'],
  [
    'govt',
    (t) =>
      ['public_building', 'courthouse', 'townhall', 'post_office'].includes(t.amenity) || t.office === 'government',
  ],
  [
    'station',
    (t, kind) =>
      kind === 'station' || t.railway === 'station' || t.station === 'subway' || t.public_transport === 'station',
  ],
  ['fuel', (t) => t.amenity === 'fuel'],
  ['hotel', (t) => ['hotel', 'guest_house', 'hostel'].includes(t.tourism)],
  ['liquor', (t) => t.shop === 'alcohol' || ['bar', 'pub', 'nightclub'].includes(t.amenity)],
  ['food', (t) => ['restaurant', 'fast_food', 'cafe', 'ice_cream', 'food_court'].includes(t.amenity)],
  ['bank', (t) => t.amenity === 'bank'],
  ['atm', (t) => t.amenity === 'atm' || t.amenity === 'bureau_de_change'],
  ['worship', (t) => t.amenity === 'place_of_worship'],
  ['shop', (t) => !!t.shop],
];

/** Categorise OSM tags into a POI category (null = not a safety-relevant place). */
export function poiCategory(t: Record<string, string>, kind?: string): PoiCat | null {
  return POI_RULES.find(([, test]) => test(t, kind))?.[0] ?? null;
}

/**
 * Fallback hours (IST) when a place has no opening_hours tag. These are
 * deliberately conservative Delhi priors; the UI labels them "estimated".
 * Each entry: list of [openMin, closeMin] windows, close may exceed 1440.
 */
const DEFAULT_WINDOWS: Record<PoiCat, [number, number][]> = {
  police: [[0, 1440]],
  hospital: [[0, 1440]],
  hotel: [[0, 1440]],
  atm: [[0, 1440]],
  clinic: [
    [10 * 60, 14 * 60],
    [17 * 60, 21 * 60],
  ],
  pharmacy: [[9 * 60, 22 * 60]],
  govt: [[9 * 60 + 30, 18 * 60]],
  station: [[5 * 60 + 30, 23 * 60 + 30]],
  fuel: [[6 * 60, 23 * 60]],
  shop: [[10 * 60 + 30, 21 * 60]],
  food: [[11 * 60, 23 * 60]],
  bank: [[10 * 60, 16 * 60]],
  worship: [[5 * 60, 21 * 60]],
  liquor: [[11 * 60, 23 * 60 + 30]],
};
const CLOSED_SUNDAY = new Set<PoiCat>(['govt', 'bank']);

export interface OpenState {
  open: boolean;
  /** true when the answer came from the place's own opening_hours tag */
  verified: boolean;
}

/**
 * opening_hours.js has no Indian public-holiday calendar, so any "PH" rule
 * throws at evaluation time. Treat PH as an ordinary day: drop standalone
 * "PH off/closed/open" rules and "PH" inside day lists.
 */
export function stripPublicHolidays(s: string): string {
  return s
    .split(/;|\|\|/)
    .map((r) => r.trim())
    .filter((r) => !/^PH(\s+(off|closed|open|"[^"]*"))?$/i.test(r) && !/^PH\s*[\d"]/.test(r))
    .map((r) =>
      r
        .replace(/\s*\bPH\s+(off|closed|open)\b/gi, '')
        .replace(/\bPH\s*,\s*/g, '')
        .replace(/\s*,\s*PH\b/g, '')
        .replace(/^PH\s+/, '')
        .replace(/\bPH\b/g, '')
        .trim(),
    )
    .filter((r) => r.length > 0)
    .join('; ');
}

const ohCache = new Map<string, InstanceType<typeof opening_hours> | null>();
function parseOh(raw: string): InstanceType<typeof opening_hours> | null {
  if (ohCache.has(raw)) return ohCache.get(raw)!;
  let v: InstanceType<typeof opening_hours> | null = null;
  const s = stripPublicHolidays(raw);
  if (s) {
    try {
      v = new opening_hours(
        s,
        { lat: 28.61, lon: 77.21, address: { country_code: 'in', state: 'Delhi' } } as never,
        { mode: 0, tag_key: 'opening_hours', warnings_severity: 0 } as never,
      );
    } catch {
      v = null;
    }
  }
  ohCache.set(raw, v);
  return v;
}

export function isOpenAt(p: Pick<Poi, 'cat' | 'oh'>, when: Date): OpenState {
  if (p.oh) {
    const o = parseOh(p.oh);
    if (o) {
      try {
        return { open: o.getState(istWallClockDate(when)), verified: true };
      } catch {
        /* fall through to priors */
      }
    }
  }
  const { dow, minutes } = istTime(when);
  if (dow === 0 && CLOSED_SUNDAY.has(p.cat)) return { open: false, verified: false };
  for (const [a, b] of DEFAULT_WINDOWS[p.cat]) {
    if ((minutes >= a && minutes < b) || (b > 1440 && minutes < b - 1440)) return { open: true, verified: false };
  }
  return { open: false, verified: false };
}
