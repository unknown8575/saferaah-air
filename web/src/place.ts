// The place card: a tapped point, a searched place or a safe place, with open state, street safety and directions.
import { h, clear, fmtDuration, fmtDist } from './dom.ts';
import { type Hit } from './search.ts';
import { icon } from './icons.ts';
import { TIER_INFO, tierOf } from '../../shared/router.ts';
import { CAT_INFO, isOpenAt, type Poi } from '../../shared/places.ts';
import { WALK_KMH } from '../../shared/modes.ts';
import { haversine, type LonLat } from '../../shared/geo.ts';
import { S, inCoverage, myLonLat, now, rpc, setView, sheet, smap, toast, type Place, mapPad } from './app.ts';
import { refreshSafety } from './layers.ts';
import { openDirections } from './directions.ts';
import { renderFabs } from './fabs.ts';
import { outside, placeAt } from './gestures.ts';
import { drawMe } from './here.ts';
import { goHome } from './home.ts';
import { renderSearchTop, typeLabel } from './searchbar.ts';

export let lastOpen: { open: Uint8Array; verified: Uint8Array } | null = null;
export async function refreshPois() {
  const r = await rpc<{ open: Uint8Array; verified: Uint8Array }>({ type: 'open', when: now().toISOString() });
  lastOpen = r;
  smap.setPois(S.pois, r.open);
  refreshSafety();
}

// ---------- place card ----------
export function openHit(x: Hit) {
  const p: Place = { lonlat: [x.lon, x.lat], label: x.name, sub: typeLabel(x.type), kind: x.type };
  showPlace(p, true);
}
export function openPoi(id: number) {
  const q = S.pois[id];
  if (!q) return;
  showPlace(
    {
      lonlat: [q.lon, q.lat],
      label: q.name || CAT_INFO[q.cat].label,
      sub: CAT_INFO[q.cat].label,
      poi: id,
      kind: q.cat,
    },
    true,
  );
}
export function dropPin(p: LonLat) {
  if (!inCoverage(p)) return outside();
  showPlace(placeAt(p), false);
}

export async function showPlace(p: Place, fly: boolean) {
  setView('place');
  S.place = p;
  S.category = null;
  smap.setHits([]);
  smap.setPlacePin(p.lonlat);
  renderSearchTop();
  renderPlace();
  if (fly)
    smap.map.flyTo({ center: p.lonlat, zoom: Math.max(16, smap.map.getZoom()), duration: 700, padding: mapPad() });
  const w = await rpc<{ street: string; distM: number | null; onMap: boolean; risk: number | null }>({
    type: 'whereis',
    at: p.lonlat,
    when: now().toISOString(),
    profile: S.settings.profile,
  });
  if (S.place !== p) return;
  p.street = w.street;
  p.risk = w.onMap && (w.distM ?? 999) < 150 ? w.risk : null;
  if (p.label === 'Dropped pin' && w.street) p.label = w.street;
  renderPlace();
}

/** Open state from the place's own data (a mapped POI, or a nearby-places entry). */
function openStateOf(p: Place): { open: boolean; verified: boolean } | null {
  const poi = p.poi != null ? S.pois[p.poi] : null;
  if (poi) return poiOpen(poi);
  return p.cat ? isOpenAt({ cat: p.cat, oh: p.oh }, now()) : null;
}

/** Distance and walking time, open state and how the street feels right now. */
function placeFacts(p: Place): HTMLElement {
  const me = myLonLat();
  const dist = me ? haversine(me[0], me[1], p.lonlat[0], p.lonlat[1]) : null;
  const open = openStateOf(p);
  const tier = p.risk != null ? tierOf(p.risk, p.risk) : null;
  const walk = dist != null && dist > 120 ? ` · ~${fmtDuration((dist * 1.3) / (WALK_KMH / 3.6))} walk` : '';
  return h(
    'div',
    { class: 'pc-facts' },
    dist != null ? h('span', null, `${fmtDist(dist)} from you`, walk) : null,
    open
      ? h(
          'span',
          { class: `open-pill ${open.open ? 'yes' : 'no'}` },
          open.open ? (open.verified ? 'Open now' : 'Likely open now') : 'Closed now',
        )
      : null,
    tier
      ? h(
          'span',
          { class: `street-now tier-text-${tier}` },
          h('span', { class: `sw tier-${tier}` }),
          `Street right now: ${TIER_INFO[tier].label.toLowerCase()}`,
        )
      : null,
  );
}

function placeActions(p: Place): HTMLElement {
  const directions = () => {
    S.to = { ...p };
    S.from = null;
    S.userPicked = false;
    S.reply = null;
    openDirections();
  };
  const startHere = () => {
    S.from = { ...p };
    S.to = null;
    S.reply = null;
    openDirections();
  };
  return h(
    'div',
    { class: 'pc-actions' },
    h(
      'button',
      { class: 'btn primary', id: 'directions', on: { click: directions } },
      icon('navigate', 18),
      'Directions',
    ),
    h('button', { class: 'btn', id: 'start-here', on: { click: startHere } }, 'Start from here'),
    !S.loc.fix
      ? h(
          'button',
          { class: 'btn', id: 'im-here', on: { click: () => setManualMe(p.lonlat) } },
          icon('pin', 18),
          'I am here',
        )
      : null,
    h('button', { class: 'btn ghost', on: { click: () => sharePlace(p) } }, icon('share', 18), 'Share'),
  );
}

export function renderPlace() {
  const p = S.place;
  if (!p || S.view !== 'place') return;
  const poi = p.poi != null ? S.pois[p.poi] : null;
  const hours = poi?.oh ?? p.oh;
  const subBits = [p.sub, p.street && p.street !== p.label ? p.street : null].filter(Boolean).join(' · ');
  clear(
    sheet,
    h('div', { class: 'grip', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'pad place-card' },
      h(
        'div',
        { class: 'pc-head' },
        h('div', null, h('h2', { id: 'place-title' }, p.label), subBits ? h('div', { class: 'meta' }, subBits) : null),
        h(
          'button',
          { class: 'icon-btn flat', 'aria-label': 'Close', on: { click: () => goHome() } },
          icon('close', 18),
        ),
      ),
      placeFacts(p),
      hours ? h('p', { class: 'fine' }, 'Hours: ', hours) : null,
      placeActions(p),
    ),
  );
}

export function poiOpen(q: Poi): { open: boolean; verified: boolean } {
  const r = lastOpen;
  return r ? { open: !!r.open[q.id], verified: !!r.verified[q.id] } : { open: true, verified: false };
}

export function setManualMe(p: LonLat) {
  S.manualMe = p;
  drawMe();
  toast('Got it. We will use this as your location.');
  renderFabs();
  if (S.view === 'place') renderPlace();
}

export async function sharePlace(p: Place) {
  const u = new URL(location.href.split('?')[0]);
  u.searchParams.set('to', `${p.lonlat[0].toFixed(5)},${p.lonlat[1].toFixed(5)}`);
  u.searchParams.set('toName', p.label);
  const text = `${p.label} — open in SafeRaah for safe routes`;
  if (navigator.share) {
    try {
      await navigator.share({ title: p.label, text, url: u.href });
      return;
    } catch {
      /* cancelled */
    }
  }
  navigator.clipboard?.writeText(`${text}: ${u.href}`).then(() => toast('Link copied'));
}
