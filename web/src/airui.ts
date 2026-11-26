// Clean-air views: the AQI card, the air line on each route card, the "Air on this route"
// section, and the time / safety / air picker. Pure renderers: they get everything they
// show as arguments and report taps through callbacks, so main.ts keeps only the flow.
import { h, fmtDist } from './dom.ts';
import { icon } from './icons.ts';
import { AQI_BANDS, type AirNow } from '../../shared/air.ts';
import { TIER_INFO, type Tier } from '../../shared/router.ts';
import type { WorkerRoute } from './worker.ts';

const TIER_RANK: Record<Tier, number> = { green: 0, yellow: 1, red: 2, darkred: 3 };

/** Home-screen card: AQI, band and how far above the WHO guideline the air is. */
export function aqiCard(a: AirNow | null, onOpen: () => void): HTMLElement {
  const B = a ? AQI_BANDS[a.aqi.band] : null;
  return h('button', {
    class: 'aqi-card', id: 'aqi-card', style: B ? { '--band': B.color } : {}, on: { click: onOpen },
  },
  h('span', { class: 'sr-only' }, 'Air quality index '),
  h('span', { class: 'aqi-ring' }, a ? String(a.aqi.value) : '–'),
  h('span', { class: 'aqi-txt' },
    h('b', null, a && B ? `${B.label} air` : 'Air quality'),
    h('small', null, a ? `PM2.5 ${Math.round(a.pm25)} µg/m³ · ${(a.pm25 / 15).toFixed(0)}× WHO` : 'Checking the air near you…')),
  h('span', { class: 'aqi-ask' }, icon('sparkle', 15), 'Ask Saans'));
}

/** One line on a route card: how much PM2.5 this route means compared with the fastest. */
export function airLine(r: WorkerRoute): HTMLElement | null {
  const a = r.air;
  if (!a) return null;
  const isFastest = r.labels.includes('Fastest');
  const txt = isFastest
    ? (a.areas.length ? `Air: passes ${a.areas[0]}` : `Air: ${a.factor >= 1.35 ? 'busy-road air' : a.factor >= 1.15 ? 'some traffic air' : 'mostly quiet streets'}`)
    : a.pctVsFastest >= 3 ? `${a.pctVsFastest}% less PM2.5 breathed than fastest`
      : a.pctVsFastest <= -3 ? `${-a.pctVsFastest}% more PM2.5 breathed than fastest` : 'About the same air as fastest';
  return h('span', { class: `rc-air${!isFastest && a.pctVsFastest >= 3 ? ' better' : ''}` }, icon('wind', 14), txt);
}

/** Route details: dose, comparison, busy-road and industry metres, areas passed/avoided, honest trade-off. */
export function airSection(r: WorkerRoute, routes: WorkerRoute[], cityPm25: number | null, clock: string, onAsk: () => void): HTMLElement[] | null {
  const a = r.air;
  if (!a) return null;
  const fastest = routes.find((x) => x.labels.includes('Fastest'));
  const cleanest = routes.find((x) => x.labels.includes('Cleanest air'));
  const items: (HTMLElement | null)[] = [
    cityPm25 !== null ? h('li', null, h('b', null, `≈${Math.round(a.doseUg)} µg`), ` of PM2.5 breathed on this trip (city air now ${Math.round(cityPm25)} µg/m³)`) : null,
    r !== fastest && a.pctVsFastest !== 0 ? h('li', null, h('b', null, `${Math.abs(a.pctVsFastest)}% ${a.pctVsFastest > 0 ? 'less' : 'more'}`), ' than on the fastest route') : null,
    h('li', null, h('b', null, fmtDist(a.busyM)), ' on or beside busy roads'),
    a.industryM > 50 ? h('li', null, h('b', null, fmtDist(a.industryM)), ' near industrial land or a landfill') : null,
    a.areas.length ? h('li', null, 'Passes ', a.areas.join(', ')) : null,
    a.avoided.length ? h('li', { class: 'good' }, 'Avoids ', a.avoided.join(', ')) : null,
  ];
  // honest trade-off: cleaner air through a park or a quiet lane can be the less safe choice at night
  const tradeoff = r === cleanest && fastest && TIER_RANK[r.tier] > TIER_RANK[fastest.tier]
    ? h('p', { class: 'tradeoff' }, icon('alert', 15), `Cleaner air, but ${TIER_INFO[r.tier].label.toLowerCase()} for safety at ${clock}. After dark the safer route may be the better choice.`) : null;
  const out: (HTMLElement | null)[] = [h('h3', null, 'Air on this route'), h('ul', { class: 'facts' }, items), tradeoff,
    h('button', { class: 'btn ghost ask-route', id: 'ask-route', on: { click: onAsk } }, icon('sparkle', 16), 'Ask Saans about this route'),
    h('p', { class: 'fine' }, 'Estimates: the city forecast (CAMS) plus street-level effects of traffic, industry and landfills.')];
  return out.filter((x): x is HTMLElement => x !== null);
}

/** One tap to the route that is best for what matters most right now: time, safety or air. */
export function priorityPicker(routes: WorkerRoute[], selected: number, onSelect: (i: number) => void): HTMLElement {
  const find = (...labels: string[]) => routes.findIndex((r) => labels.some((l) => r.labels.includes(l)));
  const opts = [
    { key: 'fastest', label: 'Fastest', ic: 'clock', i: find('Fastest') },
    { key: 'safest', label: 'Safest', ic: 'police', i: find('Safest', 'Also safest') },
    { key: 'air', label: 'Cleanest air', ic: 'leaf', i: find('Cleanest air', 'Also cleanest') },
  ];
  return h('div', { class: 'prio', role: 'radiogroup', 'aria-label': 'What matters most on this trip' },
    opts.filter((o) => o.i >= 0).map((o) => h('button', {
      class: `prio-btn${selected === o.i ? ' on' : ''}`, role: 'radio', 'aria-checked': selected === o.i ? 'true' : 'false', 'data-prio': o.key,
      on: { click: () => onSelect(o.i) },
    }, icon(o.ic, 15), o.label)));
}
