// Plain-language precautions for one route, shown on its card and in its details.
import type { RouteResult } from './router.ts';
import type { Mode } from './modes.ts';
import type { Profile } from './risk.ts';
import type { Poi } from './places.ts';
import { darkness } from './time.ts';

export interface Precautions {
  /** one short line for the route card */
  headline: string;
  /** full list for the details screen, most important first */
  items: string[];
}

const fmtM = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 'es' : ''}`;

function policeNote(r: RouteResult, police: Poi[]): string | null {
  if (police.length) return `Police on the way: ${[...new Set(police.map((p) => p.name))].slice(0, 2).join(', ')}`;
  return r.policeShare < 0.2 && r.tier !== 'green' ? 'Few police posts along this route' : null;
}

function precautionItems(r: RouteResult, mode: Mode, profile: Profile, dark: boolean, pois: Poi[]): string[] {
  const items: string[] = [];
  const risky = r.tier === 'red' || r.tier === 'darkred';
  const police = r.havenIds.map((i) => pois[i]).filter((p) => p?.cat === 'police' && p.name);
  if (risky && mode === 'walk' && dark) items.push('Consider an auto or cab for this trip, or walk with someone');
  for (const s of [...r.dangerSpots].sort((a, b) => b.lengthM - a.lengthM).slice(0, 3))
    items.push(
      `${fmtM(s.lengthM)}${s.street ? ` on ${s.street}` : ''}: ${s.reasons.join(', ') || 'quiet at this hour'}`,
    );
  if (dark && r.litShare < 0.5 && r.lengthM > 300)
    items.push('Much of this route uses side streets that may be poorly lit; keep to main roads where you can');
  const policeLine = policeNote(r, police);
  if (policeLine) items.push(policeLine);
  if (mode === 'twowheeler' && dark && risky)
    items.push('Avoid stopping on the dark stretches; keep to the main carriageway');
  if (profile === 'child' && mode === 'walk' && r.mainRoadShare > 0.4)
    items.push('Busy traffic: cross only at signals or subways');
  if (r.tier !== 'green') items.push('Share your live trip with a contact before you start');
  return items;
}

function precautionHeadline(r: RouteResult, mode: Mode, dark: boolean): string {
  const n = r.dangerSpots.length;
  const total = fmtM(r.dangerSpots.reduce((a, s) => a + s.lengthM, 0));
  if (r.tier === 'green')
    return n ? `Mostly busy and open; ${total} quieter` : 'Busy, open streets: no special precautions';
  if (r.tier === 'yellow')
    return n
      ? `Stay alert on ${plural(n, 'quiet stretch')} (${total})`
      : 'Some quiet parts: stay alert and share your trip';
  if (mode === 'walk' && dark) return 'Risky on foot now: prefer an auto, or go with someone';
  return n
    ? `Avoid alone: ${plural(n, 'risky stretch')} (${total})`
    : 'Risky at this hour: share your trip and stay alert';
}

export function routePrecautions(
  r: RouteResult,
  opts: { mode: Mode; profile: Profile; when: Date; pois: Poi[] },
): Precautions {
  const dark = darkness(opts.when) >= 0.5;
  return {
    headline: precautionHeadline(r, opts.mode, dark),
    items: precautionItems(r, opts.mode, opts.profile, dark, opts.pois),
  };
}
