// Shared app context: worker RPC, state, layout elements, small helpers and the modal.
// main.ts (screens) and journey.ts (navigation) both build on it.
import { h, clear } from './dom.ts';
import type { SafeMap } from './map.ts';
import type { PlaceSearch } from './search.ts';
import { icon } from './icons.ts';
import { load } from './store.ts';
import type { JourneyHandle } from './api.ts';
import type { PositionSource } from './location.ts';
import type { RouteReply, WorkerRoute } from './worker.ts';
import type { Tier } from '../../shared/router.ts';
import { type Poi, type PoiCat } from '../../shared/places.ts';
import type { Mode } from '../../shared/modes.ts';
import type { JourneyMonitor, Fix } from '../../shared/journey.ts';
import type { LiveReport } from '../../shared/live.ts';
import type { AirNow } from '../../shared/air.ts';
import { istTime } from '../../shared/time.ts';
import type { LonLat } from '../../shared/geo.ts';
import type { Guide } from './nav.ts';

export const BASE = import.meta.env.BASE_URL;
export const params = new URLSearchParams(location.search);
export const DEMO = params.has('demo');
export const DEMO_ME: LonLat = [77.2197, 28.6328]; // Rajiv Chowk

// ---------- worker RPC ----------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let rpcId = 0;
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
worker.onmessage = (ev) => {
  const p = pending.get(ev.data.id);
  if (!p) return;
  pending.delete(ev.data.id);
  if (ev.data.type === 'error') p.rej(new Error(ev.data.message));
  else p.res(ev.data);
};
export function rpc<T = any>(msg: Record<string, unknown>): Promise<T> {
  const id = ++rpcId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    worker.postMessage({ ...msg, id });
  });
}

// ---------- state ----------
export interface Place {
  lonlat: LonLat;
  label: string;
  sub?: string;
  poi?: number;
  kind?: string;
  street?: string;
  risk?: number | null;
  mine?: boolean;
  /** for places from the nearby-places index: open/closed from these */
  cat?: PoiCat;
  oh?: string;
}
export type View =
  | 'home'
  | 'place'
  | 'category'
  | 'directions'
  | 'details'
  | 'pick'
  | 'journey'
  | 'arrived'
  | 'contacts'
  | 'help'
  | 'track';
export type LocStatus = 'idle' | 'asking' | 'on' | 'denied' | 'unavailable';
export type Pref = 'fastest' | 'safest' | 'balanced';

export const S = {
  settings: load(),
  version: 'dev',
  snapshot: '',
  bbox: [76.83, 28.4, 77.35, 28.89] as [number, number, number, number],
  onewayKnown: true,
  view: 'home' as View,
  loc: { status: 'idle' as LocStatus, fix: null as Fix | null, heading: null as number | null },
  manualMe: null as LonLat | null,
  follow: false,
  place: null as Place | null,
  category: null as null | {
    key: string;
    title: string;
    items: (Poi & { distM: number; open: boolean; verified: boolean })[];
  },
  from: null as Place | null, // null = your location
  to: null as Place | null,
  leaveAt: null as Date | null, // null = now
  reply: null as RouteReply | null,
  selected: 0,
  userPicked: false,
  modeTimes: {} as Partial<Record<Mode, number | null>>,
  pick: null as null | { target: 'from' | 'to' | 'me'; back: View },
  myPos: null as Fix | null, // position used during a journey (real or simulated)
  pois: [] as Poi[],
  reports: [] as LiveReport[],
  reportsAt: 0,
  air: null as AirNow | null,
  airFor: '' as string,
  journey: null as null | {
    route: WorkerRoute;
    monitor: JourneyMonitor;
    source: PositionSource;
    handle: JourneyHandle | null;
    pref: Pref;
    pendingFixes: Fix[];
    dest: Place;
    startedAt: number;
    clock: () => number;
    offRoute: boolean;
    tickTimer: ReturnType<typeof setInterval>;
    pushTimer: ReturnType<typeof setInterval>;
    result?: any;
    sos?: boolean;
    rerouting?: boolean;
    lastReroute: number;
    lastSaferCheck: number;
    better: WorkerRoute | null;
    dismissedBetter?: boolean;
    guide: Guide;
    islandOpen: boolean;
  },
};
(window as any).__sr = { S, rpc };

export const now = () => S.leaveAt ?? new Date();
export const inCoverage = (p: LonLat) =>
  p[0] >= S.bbox[0] && p[0] <= S.bbox[2] && p[1] >= S.bbox[1] && p[1] <= S.bbox[3];
/** Where the user is: live GPS (inside Delhi) or the point they marked themselves. */
export function myLonLat(): LonLat | null {
  const f = S.loc.fix;
  if (f && inCoverage([f.lon, f.lat])) return [f.lon, f.lat];
  return S.manualMe;
}
export const myAcc = () => (S.loc.fix && inCoverage([S.loc.fix.lon, S.loc.fix.lat]) ? S.loc.fix.acc : 50);
export const fromLonLat = () => S.from?.lonlat ?? myLonLat();
export function clockText(d: Date): string {
  const m = istTime(d).minutes;
  const hh = Math.floor(m / 60),
    mm = m % 60;
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`;
}
export const TIER_RANK: Record<Tier, number> = { green: 0, yellow: 1, red: 2, darkred: 3 };
export const tierIcon = (t: Tier) => (t === 'green' ? '✓' : t === 'yellow' ? '!' : '⚠');
export const tierSvg = (t: Tier, size = 14) => icon(t === 'green' ? 'check' : 'alert', size, 2.2);

// ---------- layout ----------
const app = document.getElementById('app')!;
export const mapEl = h('div', { id: 'map', role: 'application', 'aria-label': 'Map' });
export const top = h('header', { id: 'top' });
export const fabs = h('div', { id: 'fabs' });
export const sheet = h('section', { id: 'sheet', 'aria-live': 'polite' });
export const crosshair = h(
  'div',
  { id: 'crosshair', hidden: true, 'aria-hidden': 'true' },
  h('div', { class: 'pin pin-to' }),
);
export const sosBtn = h(
  'button',
  { id: 'sos', class: 'sos', 'aria-label': 'SOS emergency', on: { click: () => hooks.openSos() } },
  'SOS',
);
export const toastEl = h('div', { id: 'toast', role: 'status' });
export const modal = h('div', { id: 'modal', hidden: true });
app.append(mapEl, top, fabs, sheet, crosshair, sosBtn, toastEl, modal);
// keep the floating buttons just above the sheet, whatever its current height
const syncSizes = () => {
  const sh = sheet.offsetParent && !sheet.hidden ? sheet.getBoundingClientRect().height : 0;
  const th = top.offsetParent ? top.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty('--sheet-h', `${Math.min(sh, window.innerHeight - 170)}px`);
  document.documentElement.style.setProperty('--top-h', `${th}px`);
};
new ResizeObserver(syncSizes).observe(sheet);
// tap the grip (or drag it up) to see more of the sheet, like a map app's bottom panel
sheet.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).classList.contains('grip')) sheet.classList.toggle('expanded');
});
let gripY: number | null = null;
sheet.addEventListener(
  'touchstart',
  (e) => {
    gripY = (e.target as HTMLElement).classList.contains('grip') ? e.touches[0].clientY : null;
  },
  { passive: true },
);
sheet.addEventListener('touchend', (e) => {
  if (gripY == null) return;
  const dy = e.changedTouches[0].clientY - gripY;
  if (dy < -30) sheet.classList.add('expanded');
  else if (dy > 30) sheet.classList.remove('expanded');
  gripY = null;
});
new ResizeObserver(syncSizes).observe(top);

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(msg: string, ms = 3500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

export let smap: SafeMap;
export let search: PlaceSearch;
export let named: { name: string; lon: number; lat: number; type: string }[] = [];
export function setMapParts(p: { smap?: SafeMap; search?: PlaceSearch; named?: typeof named }) {
  if (p.smap) smap = p.smap;
  if (p.search) search = p.search;
  if (p.named) named = p.named;
}

/**
 * Screens defined in main.ts or journey.ts that other modules need to open. Registered at
 * start-up, so modules don't import each other in a circle.
 */
export const hooks = {
  renderFabs: () => {},
  openSos: () => {},
  goHome: () => {},
  openDirections: () => {},
  showContacts: () => {},
  drawMe: () => {},
};
export const wide = () => window.innerWidth >= 860;

let enterTimer: ReturnType<typeof setTimeout>;
export function setView(v: View) {
  S.view = v;
  document.body.dataset.view = v;
  const changed = !sheet.classList.contains(`v-${v}`);
  sheet.className = `v-${v}`; // also collapses an expanded sheet
  // new screen: its content rises in once (re-renders within the same screen stay still)
  if (changed) {
    sheet.classList.add('enter');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => sheet.classList.remove('enter'), 650);
  }
  crosshair.hidden = v !== 'pick';
  sosBtn.hidden = v === 'track';
  smap?.dimSafety(['directions', 'details', 'journey'].includes(v));
  hooks.renderFabs();
}

// ---------- modal ----------
/** The "Are you OK?" check-in timer; while it runs the modal can't be dismissed by accident. */
export let checkTimer: ReturnType<typeof setInterval> | null = null;
export function setCheckTimer(t: ReturnType<typeof setInterval> | null) {
  checkTimer = t;
}
export function openModal(content: HTMLElement) {
  clear(modal, content);
  modal.hidden = false;
  // move focus into the dialog without drawing a focus ring on a button the user did not choose
  content.setAttribute('tabindex', '-1');
  content.focus({ preventScroll: true });
}
export function closeModal() {
  modal.hidden = true;
  clear(modal);
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
modal.addEventListener('click', (e) => {
  if (e.target === modal && !checkTimer) closeModal();
});
