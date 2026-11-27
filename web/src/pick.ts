// Choose a point on the map with the centre pin (start, destination or "I am here").
import { h, clear } from './dom.ts';
import { icon } from './icons.ts';
import { type LonLat } from '../../shared/geo.ts';
import { S, fromLonLat, inCoverage, rpc, setView, sheet, smap, top } from './app.ts';
import { openDirections } from './directions.ts';
import { outside, placeAt } from './gestures.ts';
import { goHome } from './home.ts';
import { setManualMe, showPlace } from './place.ts';

// ---------- choose on map ----------
export function startPick(target: 'from' | 'to' | 'me') {
  S.pick = { target, back: S.view === 'pick' ? 'home' : S.view };
  setView('pick');
  smap.setPlacePin();
  const start = target === 'from' ? fromLonLat() : target === 'to' ? S.to?.lonlat : null;
  if (start) smap.map.easeTo({ center: start, zoom: Math.max(16, smap.map.getZoom()) });
  else if (smap.map.getZoom() < 15) smap.map.easeTo({ zoom: 15.5 });
  const title = target === 'me' ? 'Where are you?' : target === 'from' ? 'Choose start' : 'Choose destination';
  clear(
    top,
    h(
      'div',
      { class: 'pick-bar' },
      h('button', { class: 'back', 'aria-label': 'Cancel', on: { click: () => endPick(false) } }, icon('back', 24)),
      h('div', null, h('b', null, title), h('div', { class: 'meta' }, 'Move the map so the pin is on the spot')),
    ),
  );
  clear(
    sheet,
    h(
      'div',
      { class: 'pad pick' },
      h('div', { class: 'pick-label', id: 'pick-label' }, '…'),
      h(
        'button',
        { class: 'btn primary wide', id: 'pick-ok', on: { click: () => endPick(true) } },
        target === 'me' ? 'I am here' : 'Done',
      ),
    ),
  );
  updatePickLabel();
}
export let pickSeq = 0;
export async function updatePickLabel() {
  const c = smap.map.getCenter();
  const p: LonLat = [c.lng, c.lat];
  const el = document.getElementById('pick-label');
  if (!el) return;
  if (!inCoverage(p)) {
    el.textContent = 'Outside Delhi NCT';
    return;
  }
  const seq = ++pickSeq;
  const n = placeAt(p);
  el.textContent = n.label;
  const w = await rpc<{ street: string }>({ type: 'whereis', at: p });
  if (seq !== pickSeq) return;
  if (w.street)
    el.textContent =
      n.label.startsWith('Near') || n.label === 'Dropped pin'
        ? `${w.street}${n.label.startsWith('Near') ? ' · ' + n.label : ''}`
        : `${n.label} · ${w.street}`;
}
export function endPick(ok: boolean) {
  const pk = S.pick!;
  S.pick = null;
  if (ok) {
    const c = smap.map.getCenter();
    const p: LonLat = [+c.lng.toFixed(6), +c.lat.toFixed(6)];
    if (!inCoverage(p)) {
      outside();
      return startPick(pk.target);
    }
    const label = (document.getElementById('pick-label')?.textContent || placeAt(p).label).split(' · ')[0];
    if (pk.target === 'me') {
      setManualMe(p);
    } else if (pk.target === 'from') S.from = { lonlat: p, label };
    else S.to = { lonlat: p, label };
    if (pk.target !== 'me' || pk.back === 'directions' || pk.back === 'details') {
      S.userPicked = false;
      openDirections();
      return;
    }
  }
  if (pk.back === 'directions' || pk.back === 'details') openDirections();
  else if (pk.back === 'place' && S.place) showPlace(S.place, false);
  else goHome();
}
