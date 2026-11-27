// What people type → which kinds of places they mean, and what is "similar" when that
// exact kind is not nearby. Kinds are OpenStreetMap types (amenity/shop/leisure values).

import type { PoiCat } from './places.ts';
import intents from './data/intents.json';
import kindLabels from './data/kind-labels.json';

export interface Intent {
  /** shown as "<title> near you" */
  title: string;
  /** singular, for "No gym mapped nearby" */
  one: string;
  exact: string[];
  similar: string[];
  /** words and spellings people type, English and common Hinglish */
  words: string[];
}

/** What people search for (data: shared/data/intents.json). */
export const INTENTS: Intent[] = intents;

/** Display names for OSM kinds (data: shared/data/kind-labels.json). */
const LABELS: Record<string, string> = kindLabels;

export function kindLabel(sub: string): string {
  return LABELS[sub] ?? sub.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Closest safety category, so open/closed and default opening hours work for every kind. */
export function kindCat(sub: string): PoiCat {
  if (['police'].includes(sub)) return 'police';
  if (['hospital'].includes(sub)) return 'hospital';
  if (['clinic', 'doctors', 'dentist', 'laboratory', 'blood_bank', 'veterinary'].includes(sub)) return 'clinic';
  if (['pharmacy', 'chemist'].includes(sub)) return 'pharmacy';
  if (['station', 'bus_station'].includes(sub)) return 'station';
  if (['fuel', 'charging_station'].includes(sub)) return 'fuel';
  if (['atm'].includes(sub)) return 'atm';
  if (['bank', 'bureau_de_change'].includes(sub)) return 'bank';
  if (['government', 'post_office', 'fire_station'].includes(sub)) return 'govt';
  if (['hotel', 'guest_house', 'hostel'].includes(sub)) return 'hotel';
  if (['alcohol', 'bar', 'pub', 'beverages'].includes(sub)) return 'liquor';
  if (['place_of_worship'].includes(sub)) return 'worship';
  if (
    ['restaurant', 'fast_food', 'cafe', 'tea', 'ice_cream', 'bakery', 'pastry', 'confectionery', 'food_court'].includes(
      sub,
    )
  )
    return 'food';
  return 'shop';
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What kind of place the person is typing about, if any. Matches whole words and
 * prefixes of 3+ letters ("gy" no, "gym" yes, "groc" yes), and a mapped type name.
 */
export function matchIntent(query: string, knownSubs?: Set<string>): Intent | null {
  const q = norm(query);
  if (q.length < 3) return null;
  let best: { intent: Intent; score: number } | null = null;
  for (const intent of INTENTS) {
    for (const w of intent.words) {
      const ww = norm(w);
      let score = 0;
      if (q === ww) score = 3;
      else if (ww.startsWith(q) && q.length >= 3) score = 2 + q.length / ww.length / 2;
      else if (q.split(' ').some((t) => t === ww) || ` ${q} `.includes(` ${ww} `)) score = 1.5;
      if (score) score += ww.length / 1000; // a longer matched phrase is more specific
      if (score && (!best || score > best.score)) best = { intent, score };
    }
  }
  if (best) return best.intent;
  // a mapped type typed directly, e.g. "tattoo", "florist"
  if (knownSubs) {
    const t = q.replace(/ /g, '_');
    for (const s of knownSubs) {
      if (s === t || (t.length >= 4 && s.startsWith(t)) || norm(kindLabel(s)) === q) {
        return { title: `${kindLabel(s)}s`, one: kindLabel(s).toLowerCase(), exact: [s], similar: [], words: [] };
      }
    }
  }
  return null;
}
