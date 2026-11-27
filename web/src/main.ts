import './styles.css';
import { h, clear } from './dom.ts';
import { SafeMap, loadBasemap, hasTraffic } from './map.ts';
import { PlaceSearch, type Entry } from './search.ts';
import { loadPlaces } from './browse.ts';
import { load, save } from './store.ts';
import { api, checkServer, initPreviewStore } from './api.ts';
import type { ReadyMeta } from './worker-api.ts';
import { MODES, type Mode } from '../../shared/modes.ts';
import { type LonLat } from '../../shared/geo.ts';
import type { Profile } from '../../shared/risk.ts';
import {
  BASE,
  DEMO,
  S,
  checkTimer,
  closeModal,
  mapEl,
  modal,
  params,
  rpc,
  setView,
  sheet,
  smap,
  setMapParts,
  hooks,
  debugHandle,
} from './app.ts';
import { applyTheme, timeToday } from './theme.ts';
import { askSaans, refreshAir } from './ask.ts';
import { openSos } from './sos.ts';
import { refreshReports } from './layers.ts';
import { showContacts, showIntro } from './settings.ts';
import { showTrack } from './track.ts';
import { showDetails } from './details.ts';
import { showCategory } from './category.ts';
import { openDirections, renderDirectionsTop } from './directions.ts';
import { renderFabs } from './fabs.ts';
import { setupMapGestures } from './gestures.ts';
import { drawMe, startLocating } from './here.ts';
import { goHome, renderHome } from './home.ts';
import { startPick } from './pick.ts';
import { openPoi, refreshPois, showPlace } from './place.ts';
import { planRoutes, renderRoutes, selectRoute } from './routes-panel.ts';
import { renderSearchTop } from './searchbar.ts';
// ---------- boot ----------
/** data files the routing worker downloads (added to the offline cache list) */
let workerData: string[] = [];
function showLoading(): void {
  clear(
    sheet,
    h(
      'div',
      { class: 'loading' },
      h('span', { class: 'logo' }),
      h('div', { class: 'spinner' }),
      h('p', null, 'Loading the map of Delhi…'),
    ),
  );
}

function showLoadError(err: unknown): void {
  clear(
    sheet,
    h(
      'div',
      { class: 'pad' },
      h('h2', null, 'The map could not load'),
      h('p', null, String((err as Error).message)),
      h('button', { class: 'btn primary', on: { click: () => location.reload() } }, 'Try again'),
    ),
  );
}

/** The map, the search index and the map interactions. */
function setupMap(searchEntries: Entry[], bounds: [number, number, number, number]): void {
  setMapParts({
    search: new PlaceSearch(searchEntries),
    named: searchEntries.filter((e) => e[3] !== 'street').map(([name, lon, lat, type]) => ({ name, lon, lat, type })),
    smap: new SafeMap(mapEl, BASE, bounds),
  });
  debugHandle.map = smap.map;
  smap.map.on('error', (e) => console.warn('map error', e.error?.message ?? e));
  smap.onRouteClick((i) => selectRoute(i, true));
  smap.onPoiClick((id) => {
    if (['home', 'place', 'category'].includes(S.view)) openPoi(id);
  });
  setupMapGestures();
}

/** The map layers the user switched on last time. */
function applyLayerSettings(): void {
  const L = S.settings.layers;
  smap.setLayerVisible('safety', L.safety);
  smap.setLayerVisible('pois', L.pois);
  smap.setLayerVisible('air', !!L.air);
  smap.setLayerVisible('traffic', L.traffic && hasTraffic());
}

/** Crowd street scores and live reports, from the server or the preview's shared store. */
function connectLive(): void {
  checkServer().then(async (ok) => {
    if (!ok) {
      if (await initPreviewStore()) refreshReports(true);
      return;
    }
    try {
      const c = await api.crowd(S.version);
      await rpc({ type: 'crowd', stats: c.stats });
    } catch {
      /* crowd data optional */
    }
    refreshReports();
  });
}

/** Load the map data, start the routing worker and the map. Throws if the map cannot load. */
async function loadEverything(): Promise<void> {
  const [ver, basemap, searchEntries] = await Promise.all([
    fetch(BASE + 'data/version.json')
      .then((r) => r.json())
      .catch(() => ({ version: 'dev' })),
    loadBasemap(BASE),
    fetch(BASE + 'data/search.json').then((r) => r.json() as Promise<Entry[]>),
  ]);
  S.version = ver.version;
  S.snapshot = ver.snapshot ?? '';
  // the routing worker's own downloads never show in this page's resource list: name them for the offline cache
  workerData = [...((ver.graphParts as string[] | undefined) ?? ['graph.bin']), 'air.bin', 'pois.json'].map(
    (p) => new URL(BASE + 'data/' + p, location.href).href,
  );
  setupMap(searchEntries, basemap.bounds);
  const ready = await rpc<{ meta: ReadyMeta }>({
    type: 'init',
    base: new URL(BASE, location.href).href,
    graphParts: ver.graphParts,
  });
  S.bbox = ready.meta.bbox;
  S.onewayKnown = ready.meta.onewayKnown;
  S.pois = await fetch(BASE + 'data/pois.json').then((r) => r.json());
  applyLayerSettings();
  refreshPois();
  connectLive();
}

/** Links and demos: ?from=lon,lat&to=lon,lat&t=21:30&mode=walk&who=woman&demo=1 */
function applyUrlParams(): void {
  if (DEMO) save({ simulate: true });
  const pf = params.get('from');
  const pt = params.get('to');
  if (pf) S.from = { lonlat: pf.split(',').map(Number) as LonLat, label: params.get('fromName') ?? 'Start' };
  if (pt) S.to = { lonlat: pt.split(',').map(Number) as LonLat, label: params.get('toName') ?? 'Destination' };
  const t = params.get('t');
  if (t && /^\d{1,2}:\d{2}$/.test(t)) S.leaveAt = timeToday(t);
  const md = params.get('mode') as Mode | null;
  if (md && MODES.includes(md)) save({ mode: md });
  const pr = params.get('who') as Profile | null;
  if (pr && ['woman', 'child', 'general'].includes(pr)) save({ profile: pr });
  S.settings = load();
}

/** Clock-driven refreshes: open places and theme every minute, live air every 30 min. */
function startTimers(): void {
  setInterval(() => {
    refreshPois();
    applyTheme();
    if (S.view === 'home') renderHome();
  }, 60000);
  setInterval(() => refreshReports(), 60000);
  setTimeout(() => refreshAir(), 1200);
  setInterval(() => refreshAir(), 30 * 60000);
  setTimeout(() => loadPlaces(BASE), 2500); // nearby-places index for "gym near me" searches
  setTimeout(() => {
    void import('./saans.ts');
  }, 4000); // warm the assistant chunk (and the offline cache)
}

async function boot() {
  setView('home');
  showLoading();
  try {
    await loadEverything();
  } catch (err) {
    showLoadError(err);
    return;
  }
  const track = params.get('track');
  if (track) return showTrack(track);
  applyUrlParams();
  applyTheme();
  startLocating();
  startTimers();
  if (S.to) return openDirections();
  goHome();
  if (!S.settings.seenIntro && !DEMO) showIntro();
}

// ---------- misc ----------
/** Screens whose back button Escape presses (keyboard users leave them like a dialog). */
const ESC_BACK: ReadonlySet<string> = new Set(['contacts', 'help', 'details']);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modal.hidden) {
    if (!checkTimer) closeModal();
    return;
  }
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (!typing && ESC_BACK.has(S.view)) sheet.querySelector<HTMLButtonElement>('.summary .back')?.click();
});
if ('serviceWorker' in navigator && import.meta.env.PROD && !DEMO) {
  navigator.serviceWorker
    .register(BASE + 'sw.js')
    .then(async () => {
      await navigator.serviceWorker.ready;
      // The first visit loads before the service worker controls the page, so the hashed
      // app bundles, fonts and map data were never intercepted. Hand the list to the worker so
      // the next launch works with no signal at all.
      setTimeout(() => {
        const urls = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin) && !u.includes('/api/'));
        const msg = { type: 'warm', urls: [new URL(BASE, location.href).href, ...new Set([...urls, ...workerData])] };
        const sw = navigator.serviceWorker.controller;
        if (sw) sw.postMessage(msg);
        else void navigator.serviceWorker.ready.then((r) => r.active?.postMessage(msg));
      }, 4000);
    })
    .catch(() => {});
}
// screens other modules can open (see hooks in app.ts)
Object.assign(hooks, {
  renderFabs,
  openSos,
  goHome,
  openDirections,
  showContacts,
  drawMe,
  planRoutes,
  renderHome,
  startPick,
  askSaans,
  showCategory,
  renderDirectionsTop,
  renderRoutes,
  showDetails,
  showPlace,
  selectRoute,
  renderSearchTop,
});
boot();
