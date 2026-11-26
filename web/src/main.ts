import './styles.css';
import { h, clear, fmtDuration, fmtDist } from './dom.ts';
import { SafeMap, loadBasemap, hasTraffic } from './map.ts';
import { PlaceSearch, type Entry, type Hit } from './search.ts';
import { icon, placeIcon } from './icons.ts';
import { loadPlaces, placesReady, nearbyFor } from './browse.ts';
import { matchIntent, type Intent } from '../../shared/kinds.ts';
import { load, save } from './store.ts';
import { api, checkServer, isOnline, initPreviewStore } from './api.ts';
import type { RouteReply } from './worker.ts';
import { TIER_INFO, tierOf } from '../../shared/router.ts';
import { CAT_INFO, isOpenAt, type Poi, type PoiCat } from '../../shared/places.ts';
import { MODE_INFO, MODES, WALK_KMH, type Mode } from '../../shared/modes.ts';
import type { AirNow } from '../../shared/air.ts';
import { airAt } from './airnow.ts';
import { airHome, airLine, priorityPicker } from './airui.ts';
import { dayPlan } from '../../shared/saans/plan.ts';
import type { RouteSummary } from '../../shared/saans/assistant.ts';
import { darkness, istTime, IST_OFFSET_MIN } from '../../shared/time.ts';
import { haversine, type LonLat } from '../../shared/geo.ts';
import type { Profile } from '../../shared/risk.ts';
import {
  BASE,
  DEMO,
  DEMO_ME,
  S,
  checkTimer,
  clockText,
  closeModal,
  fabs,
  fromLonLat,
  inCoverage,
  mapEl,
  modal,
  myLonLat,
  named,
  now,
  openModal,
  params,
  rpc,
  search,
  setView,
  sheet,
  smap,
  toast,
  top,
  type Place,
  setMapParts,
  hooks,
  mapPad,
  fitPad,
} from './app.ts';
import { startJourney, openSos, followCamera } from './journey.ts';
import { openReport, refreshAirLayer, refreshReports, refreshSafety } from './layers.ts';
import { openLayers, openMenu } from './menu.ts';
import { showContacts, showIntro } from './settings.ts';
import { showTrack } from './track.ts';
import { showDetails, tierBadge } from './details.ts';
import { browsePlace, intentFor, intentRows, openBrowsePlace, showBrowse } from './nearby.ts';
// ---------- boot ----------
/** data files the routing worker downloads (added to the offline cache list) */
let workerData: string[] = [];
async function boot() {
  setView('home');
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
  try {
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
    setMapParts({
      search: new PlaceSearch(searchEntries),
      named: searchEntries.filter((e) => e[3] !== 'street').map(([name, lon, lat, type]) => ({ name, lon, lat, type })),
      smap: new SafeMap(mapEl, BASE, basemap.bounds),
    });
    (window as any).__sr.map = smap.map;
    smap.map.on('error', (e: any) => console.warn('map error', e?.error?.message ?? e));
    smap.onRouteClick((i) => selectRoute(i, true));
    smap.onPoiClick((id) => {
      if (['home', 'place', 'category'].includes(S.view)) openPoi(id);
    });
    setupMapGestures();
    const ready = await rpc<{ meta: any }>({
      type: 'init',
      base: new URL(BASE, location.href).href,
      graphParts: ver.graphParts,
    });
    S.bbox = ready.meta.bbox;
    S.onewayKnown = ready.meta.onewayKnown;
    S.pois = await fetch(BASE + 'data/pois.json').then((r) => r.json());
    const L = S.settings.layers;
    smap.setLayerVisible('safety', L.safety);
    smap.setLayerVisible('pois', L.pois);
    smap.setLayerVisible('air', !!L.air);
    smap.setLayerVisible('traffic', L.traffic && hasTraffic());
    refreshPois();
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
  } catch (err) {
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
    return;
  }
  const track = params.get('track');
  if (track) {
    showTrack(track);
    return;
  }
  if (DEMO) save({ simulate: true });
  const pf = params.get('from'),
    pt = params.get('to');
  if (pf) S.from = { lonlat: pf.split(',').map(Number) as LonLat, label: params.get('fromName') ?? 'Start' };
  if (pt) S.to = { lonlat: pt.split(',').map(Number) as LonLat, label: params.get('toName') ?? 'Destination' };
  const t = params.get('t');
  if (t && /^\d{1,2}:\d{2}$/.test(t)) S.leaveAt = timeToday(t);
  const md = params.get('mode') as Mode | null;
  if (md && MODES.includes(md)) save({ mode: md });
  const pr = params.get('who') as Profile | null;
  if (pr && ['woman', 'child', 'general'].includes(pr)) save({ profile: pr });
  S.settings = load();
  applyTheme();
  startLocating();
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
  if (S.to) {
    openDirections();
    return;
  }
  goHome();
  if (!S.settings.seenIntro && !DEMO) showIntro();
}

function timeToday(hhmm: string): Date {
  // interpret HH:MM as Delhi time today (or tomorrow if it already passed by > 1 h)
  const [hh, mm] = hhmm.split(':').map(Number);
  const nowIst = new Date(Date.now() + IST_OFFSET_MIN * 60000);
  const d = new Date(
    Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), hh, mm) - IST_OFFSET_MIN * 60000,
  );
  if (d.getTime() < Date.now() - 3600000) d.setTime(d.getTime() + 86400000);
  return d;
}

function applyTheme() {
  const night = darkness(now()) >= 0.5;
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  smap?.setTheme(night ? 'night' : 'day');
}

/** last open/closed snapshot of every place, for place cards */
let lastOpen: { open: Uint8Array; verified: Uint8Array } | null = null;
async function refreshPois() {
  const r = await rpc<{ open: Uint8Array; verified: Uint8Array }>({ type: 'open', when: now().toISOString() });
  lastOpen = r;
  smap.setPois(S.pois, r.open);
  refreshSafety();
}

// ---------- your location (blue dot) ----------
let watchId: number | null = null;
function startLocating() {
  if (DEMO) {
    S.loc = { status: 'on', fix: { lon: DEMO_ME[0], lat: DEMO_ME[1], acc: 12, t: Date.now() }, heading: null };
    drawMe();
    return;
  }
  if (!('geolocation' in navigator)) {
    S.loc.status = 'unavailable';
    return;
  }
  if (watchId !== null) return;
  S.loc.status = 'asking';
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const first = !S.loc.fix;
      const moving = (p.coords.speed ?? 0) > 0.8 && p.coords.heading != null && !Number.isNaN(p.coords.heading);
      S.loc = {
        status: 'on',
        fix: { lon: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, t: p.timestamp || Date.now() },
        heading: moving ? p.coords.heading : S.loc.heading,
      };
      if (!S.journey) drawMe();
      if (first) {
        const me = myLonLat();
        if (me && S.view === 'home' && !S.follow)
          smap.map.easeTo({ center: me, zoom: Math.max(smap.map.getZoom(), 15), duration: 800 });
        if (me && !S.airFor) {
          S.airFor = 'gps';
          refreshAir();
        }
        if (S.view === 'home') renderHome();
        renderFabs();
        if (S.view === 'directions' && !S.from && !S.reply) planRoutes();
      }
      if (S.follow && !S.journey) smap.map.easeTo({ center: [p.coords.longitude, p.coords.latitude], duration: 500 });
    },
    (e) => {
      if (e.code === 1) {
        S.loc.status = 'denied';
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
      } else if (!S.loc.fix) S.loc.status = 'unavailable';
      if (S.view === 'home') renderHome();
      renderFabs();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  // compass heading when standing still (phones only)
  const onOrient = (ev: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    const hd = ev.webkitCompassHeading ?? ((ev as any).absolute && ev.alpha != null ? 360 - ev.alpha : null);
    if (hd == null || S.journey) return;
    S.loc.heading = hd;
    drawMe();
  };
  window.addEventListener('deviceorientationabsolute' as 'deviceorientation', onOrient as EventListener);
  window.addEventListener('deviceorientation', onOrient as EventListener);
}

function drawMe() {
  const f = S.loc.fix;
  if (f) smap.setMe([f.lon, f.lat], f.acc, S.loc.heading, false);
  else if (S.manualMe) smap.setMe(S.manualMe, 0, null, true);
  else smap.setMe(undefined);
}

function locate() {
  (DeviceOrientationEvent as any)?.requestPermission?.().catch(() => {});
  const me = myLonLat();
  if (S.loc.fix && !me) {
    toast('You seem to be outside Delhi. This map covers Delhi NCT only.', 5000);
    smap.map.flyTo({ center: [S.loc.fix.lon, S.loc.fix.lat], zoom: 13 });
    return;
  }
  if (me) {
    S.follow = !!S.loc.fix;
    smap.map.flyTo({ center: me, zoom: Math.max(16, smap.map.getZoom()), bearing: 0, duration: 700 });
    renderFabs();
    return;
  }
  if (S.loc.status === 'idle' || S.loc.status === 'unavailable') {
    startLocating();
    toast('Finding your location…');
  }
  explainNoLocation();
}

function explainNoLocation() {
  openModal(
    h(
      'div',
      { class: 'modal-card' },
      h('h2', null, S.loc.status === 'denied' ? 'Location is blocked' : 'Finding your location'),
      h(
        'p',
        null,
        S.loc.status === 'denied'
          ? 'SafeRaah is not allowed to see your location. On your phone, allow location for this app or website in Settings, then tap the locate button again.'
          : 'We are still waiting for GPS. Step near a window or open area.',
      ),
      h('p', null, 'Meanwhile you can mark where you are yourself: move the map so the pin is on your spot.'),
      h(
        'button',
        {
          class: 'btn primary wide',
          id: 'mark-me',
          on: {
            click: () => {
              closeModal();
              startPick('me');
            },
          },
        },
        'Mark where I am on the map',
      ),
      h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Close'),
    ),
  );
}

// ---------- map gestures ----------
function setupMapGestures() {
  const m = smap.map;
  const hitSomething = (pt: { x: number; y: number }) =>
    m.queryRenderedFeatures(
      [
        [pt.x - 8, pt.y - 8],
        [pt.x + 8, pt.y + 8],
      ],
      { layers: ['pois', 'routes-hit'].filter((l) => m.getLayer(l)) },
    ).length > 0;
  m.on('click', (e) => {
    if (hitSomething(e.point)) return;
    const p: LonLat = [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)];
    if (S.view === 'home' || S.view === 'place' || S.view === 'category') dropPin(p);
  });
  const longPress = (lngLat: { lng: number; lat: number }) => {
    const p: LonLat = [+lngLat.lng.toFixed(6), +lngLat.lat.toFixed(6)];
    if (S.view === 'directions' || S.view === 'details') {
      if (!inCoverage(p)) return outside();
      S.to = placeAt(p);
      S.userPicked = false;
      openDirections();
    } else if (S.view === 'home' || S.view === 'place' || S.view === 'category') dropPin(p);
  };
  m.on('contextmenu', (e) => longPress(e.lngLat));
  // iOS Safari never fires contextmenu on touch, so detect a long-press ourselves
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressAt: { x: number; y: number } | null = null;
  const cancel = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };
  m.on('touchstart', (e) => {
    if (e.originalEvent.touches.length !== 1) return cancel();
    pressAt = { x: e.point.x, y: e.point.y };
    const lngLat = e.lngLat;
    cancel();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      navigator.vibrate?.(30);
      longPress(lngLat);
    }, 600);
  });
  m.on('touchmove', (e) => {
    if (pressAt && Math.hypot(e.point.x - pressAt.x, e.point.y - pressAt.y) > 10) cancel();
  });
  m.on('touchend', cancel);
  m.on('touchcancel', cancel);
  m.on('movestart', (e) => {
    if (!(e as { originalEvent?: Event }).originalEvent) return;
    cancel();
    if (S.follow) {
      S.follow = false;
      renderFabs();
    }
  });
  m.on('rotate', () => renderCompass());
  let safetyTimer: ReturnType<typeof setTimeout>;
  m.on('moveend', () => {
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => {
      refreshSafety();
      refreshAirLayer();
    }, 250);
    if (S.view === 'pick') updatePickLabel();
  });
}

function outside() {
  toast('That point is outside the area this map covers (Delhi NCT).');
}

/** A readable name for any point: a mapped place right there, or the street. */
function nameFor(p: LonLat): { label: string; near?: string } {
  let best: { name: string } | null = null,
    bd = 250;
  for (const q of named) {
    const d = Math.hypot((q.lon - p[0]) * 97600, (q.lat - p[1]) * 111200);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  for (const q of S.pois) {
    if (!q.name) continue;
    const d = Math.hypot((q.lon - p[0]) * 97600, (q.lat - p[1]) * 111200);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  if (best && bd < 40) return { label: best.name };
  return { label: 'Dropped pin', near: best ? best.name : undefined };
}
function placeAt(p: LonLat): Place {
  const n = nameFor(p);
  return {
    lonlat: p,
    label: n.label === 'Dropped pin' && n.near ? `Near ${n.near}` : n.label,
    sub: n.near && n.label === 'Dropped pin' ? `Near ${n.near}` : undefined,
  };
}

// ---------- top: search bar & chips ----------
/** Shortcut chips under the search bar: what a family needs on a smoggy day. */
const CATS: { key: string; label: string; icon: string; cats?: PoiCat[]; intent?: string }[] = [
  { key: 'n95', label: 'N95 masks', icon: 'pharmacy', intent: 'n95 mask' },
  { key: 'purifier', label: 'Purifiers', icon: 'fan', intent: 'air purifier' },
  { key: 'park', label: 'Parks', icon: 'park', intent: 'park' },
  { key: 'station', label: 'Metro', icon: 'station', cats: ['station'] },
  { key: 'hospital', label: 'Hospitals', icon: 'hospital', cats: ['hospital', 'clinic'] },
];
/** Safety shortcuts stay available from the menu ("Safe places near me") and search. */
const SAFETY_CATS: { key: string; label: string; icon: string; cats: PoiCat[] }[] = [
  { key: 'police', label: 'Police', icon: 'police', cats: ['police'] },
  { key: 'pharmacy', label: 'Medical stores', icon: 'pharmacy', cats: ['pharmacy'] },
  { key: 'fuel', label: 'Petrol pumps', icon: 'fuel', cats: ['fuel'] },
];
/** A chip either lists nearby places of a kind (intent) or a map category. */
function openCat(key: string) {
  const c = CATS.find((x) => x.key === key);
  if (c?.intent) {
    const it = matchIntent(c.intent);
    if (it) {
      showBrowse(it);
      return;
    }
  }
  showCategory(key);
}

function renderSearchTop() {
  const input = h('input', {
    type: 'search',
    id: 'q',
    class: 'search-input',
    autocomplete: 'off',
    enterkeyhint: 'search',
    placeholder: 'Search here',
    'aria-label': 'Search for a place in Delhi',
    value: S.view === 'place' && S.place ? S.place.label : '',
  });
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  let intent: Intent | null = null;
  const render = () => {
    const q = input.value;
    const near = (myLonLat() ?? [smap.map.getCenter().lng, smap.map.getCenter().lat]) as LonLat;
    const hits = search.query(q, intentFor(q) ? 4 : 7, near as [number, number]);
    intent = intentFor(q);
    const items: HTMLElement[] = intentRows(
      q,
      near,
      (p) => {
        list.hidden = true;
        input.blur();
        openBrowsePlace(p);
      },
      (it) => {
        list.hidden = true;
        input.blur();
        showBrowse(it);
      },
      render,
    );
    if (items.length && hits.length) items.push(h('li', { class: 'sect', role: 'presentation' }, 'Places by name'));
    items.push(
      ...hits.map((x) =>
        h(
          'li',
          {
            role: 'option',
            tabindex: 0,
            on: {
              click: () => {
                list.hidden = true;
                input.blur();
                openHit(x);
              },
            },
          },
          h('span', { class: 'sic' }, icon(placeIcon(x.type), 18)),
          h('span', null, x.name),
          h('small', null, typeLabel(x.type)),
        ),
      ),
    );
    if (q.length >= 2 && !items.length)
      items.push(
        h(
          'li',
          { class: 'empty' },
          `No place called “${q}” in Delhi. Try a nearby metro station or market, or tap the map.`,
        ),
      );
    if (q.length < 2)
      items.push(
        ...CATS.map((c) =>
          h(
            'li',
            {
              role: 'option',
              tabindex: 0,
              on: {
                click: () => {
                  list.hidden = true;
                  input.blur();
                  openCat(c.key);
                },
              },
            },
            h('span', { class: 'sic' }, icon(c.icon, 18)),
            h('span', null, `${c.label} near you`),
          ),
        ),
      );
    clear(list, items);
    list.hidden = false;
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => {
    input.select();
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (intent) {
        list.hidden = true;
        input.blur();
        showBrowse(intent);
      } else (list.querySelector('li[role=option]') as HTMLElement | null)?.click();
    }
    if (e.key === 'Escape') {
      list.hidden = true;
      input.blur();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 200));
  const hasPlace = S.view === 'place' || S.view === 'category';
  clear(
    top,
    h(
      'div',
      { class: 'searchbar' },
      h(
        'button',
        { class: 'sb-btn', 'aria-label': 'Menu', id: 'menu', on: { click: () => openMenu() } },
        icon('menu', 22),
      ),
      input,
      hasPlace
        ? h('button', { class: 'sb-btn', 'aria-label': 'Clear', on: { click: () => goHome() } }, icon('close', 20))
        : h('span', { class: 'logo', 'aria-hidden': 'true', title: 'SafeRaah' }),
      list,
    ),
    h(
      'div',
      { class: 'catchips', role: 'toolbar', 'aria-label': 'Find nearby' },
      CATS.map((c) =>
        h(
          'button',
          {
            class: `chip cat${S.category?.key === c.key && S.view === 'category' ? ' on' : ''}`,
            'data-cat': c.key,
            on: { click: () => (S.view === 'category' && S.category?.key === c.key ? goHome() : openCat(c.key)) },
          },
          icon(c.icon, 17),
          c.label,
        ),
      ),
    ),
  );
}

function typeLabel(t: string): string {
  if (t === 'street') return 'Street';
  if (t === 'station') return 'Metro / rail';
  const extra: Record<string, string> = {
    landmark: 'Landmark',
    park: 'Park',
    market: 'Market',
    school: 'School / college',
    office: 'Office',
    suburb: 'Area',
    neighbourhood: 'Area',
    quarter: 'Area',
    locality: 'Area',
  };
  if (extra[t]) return extra[t];
  return (
    (CAT_INFO as Record<string, { label: string }>)[t]?.label ??
    (t === 'place' ? 'Place' : t.charAt(0).toUpperCase() + t.slice(1))
  );
}

// ---------- floating map buttons ----------
const compassBtn = h(
  'button',
  {
    class: 'fab compass',
    'aria-label': 'Point the map north',
    hidden: true,
    on: { click: () => smap.map.easeTo({ bearing: 0, pitch: 0 }) },
  },
  h('span', { class: 'needle', 'aria-hidden': 'true' }),
);
function renderCompass() {
  const b = smap?.map.getBearing() ?? 0;
  compassBtn.hidden = Math.abs(b) < 1;
  (compassBtn.firstChild as HTMLElement).style.transform = `rotate(${-b}deg)`;
}
function renderFabs() {
  const v = S.view;
  const show = ['home', 'place', 'category', 'directions', 'details', 'journey'].includes(v);
  fabs.hidden = !show;
  if (!show) return;
  const J = S.journey;
  const locState = myLonLat() ? (S.follow ? 'follow' : 'on') : S.loc.status === 'denied' ? 'off' : 'searching';
  clear(
    fabs,
    compassBtn,
    v !== 'journey'
      ? h(
          'button',
          {
            class: 'fab',
            id: 'layers-btn',
            'aria-label': 'Map layers',
            title: 'Map layers',
            on: { click: () => openLayers() },
          },
          icon('layers', 22),
        )
      : null,
    h(
      'button',
      {
        class: 'fab report-fab',
        id: 'report-btn',
        'aria-label': 'Report smoke, dust or a problem here',
        title: 'Report',
        on: { click: () => openReport() },
      },
      icon('alert', 22),
    ),
    J
      ? S.follow
        ? null
        : h(
            'button',
            {
              class: 'fab wide-fab',
              id: 'recenter',
              on: {
                click: () => {
                  S.follow = true;
                  renderFabs();
                  if (S.myPos) followCamera(S.myPos);
                },
              },
            },
            icon('navigate', 18),
            'Re-centre',
          )
      : h(
          'button',
          {
            class: `fab locate ${locState}`,
            id: 'locate',
            'aria-label': 'Show my location',
            title: 'My location',
            on: { click: () => locate() },
          },
          icon(locState === 'follow' ? 'navigate' : 'locate', 22),
        ),
  );
  renderCompass();
}

// ---------- home ----------
function goHome() {
  setView('home');
  S.place = null;
  S.category = null;
  S.reply = null;
  smap.clearRoutes();
  smap.setEndpoints();
  smap.setPlacePin();
  smap.setHits([]);
  renderSearchTop();
  renderHome();
  drawMe();
}

function renderHome() {
  if (S.view !== 'home') return;
  const d = darkness(now());
  const me = myLonLat();
  const nearReports = me ? S.reports.filter((r) => haversine(r.lon, r.lat, me[0], me[1]) < 2000).length : 0;
  const status =
    S.loc.fix && !me
      ? 'You seem to be outside Delhi. Live air and routes cover Delhi NCT.'
      : me
        ? null
        : S.loc.status === 'denied'
          ? 'Location is off, so the air shown is for central Delhi.'
          : S.loc.status === 'unavailable'
            ? 'GPS is not available right now.'
            : 'Finding your location…';
  const st = S.settings;
  const plan = dayPlan(S.air, st.familySet ? st.family : null);
  clear(
    sheet,
    h('div', { class: 'grip', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'pad home' },
      status
        ? h(
            'div',
            { class: 'loc-note' },
            h('span', null, status),
            !me
              ? h(
                  'button',
                  { class: 'btn small', id: 'mark-me-home', on: { click: () => startPick('me') } },
                  'Mark where I am',
                )
              : null,
          )
        : null,
      airHome({
        air: S.air,
        plan,
        clock: clockText(now()),
        familySet: st.familySet,
        onAsk: () => askSaans(),
        onPlanTrip: () => (document.getElementById('q') as HTMLInputElement | null)?.focus(),
      }),
      nearReports
        ? h(
            'p',
            { class: 'live-line' },
            h('span', { class: 'live-dot' }),
            `${nearReports} live report${nearReports > 1 ? 's' : ''} near you (smoke, dust or street problems)`,
          )
        : null,
      h(
        'p',
        { class: 'hint' },
        d >= 0.5
          ? 'After dark, routes weigh street safety as well as air: lighting, open places and busy streets.'
          : 'Search a place or tap the map, then choose the fastest, safest or cleanest-air route.',
      ),
    ),
  );
}

// ---------- place card ----------
function openHit(x: Hit) {
  const p: Place = { lonlat: [x.lon, x.lat], label: x.name, sub: typeLabel(x.type), kind: x.type };
  showPlace(p, true);
}
function openPoi(id: number) {
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
function dropPin(p: LonLat) {
  if (!inCoverage(p)) return outside();
  showPlace(placeAt(p), false);
}

async function showPlace(p: Place, fly: boolean) {
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

function renderPlace() {
  const p = S.place;
  if (!p || S.view !== 'place') return;
  const me = myLonLat();
  const dist = me ? haversine(me[0], me[1], p.lonlat[0], p.lonlat[1]) : null;
  const poi = p.poi != null ? S.pois[p.poi] : null;
  let open: { open: boolean; verified: boolean } | null = null;
  if (poi) open = poiOpen(poi);
  else if (p.cat) open = isOpenAt({ cat: p.cat, oh: p.oh }, now());
  const tier = p.risk != null ? tierOf(p.risk, p.risk) : null;
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
      h(
        'div',
        { class: 'pc-facts' },
        dist != null
          ? h(
              'span',
              null,
              `${fmtDist(dist)} from you`,
              dist > 120 ? ` · ~${fmtDuration((dist * 1.3) / (WALK_KMH / 3.6))} walk` : '',
            )
          : null,
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
      ),
      (poi?.oh ?? p.oh) ? h('p', { class: 'fine' }, 'Hours: ', poi?.oh ?? p.oh) : null,
      h(
        'div',
        { class: 'pc-actions' },
        h(
          'button',
          {
            class: 'btn primary',
            id: 'directions',
            on: {
              click: () => {
                S.to = { ...p };
                S.from = null;
                S.userPicked = false;
                S.reply = null;
                openDirections();
              },
            },
          },
          icon('navigate', 18),
          'Directions',
        ),
        h(
          'button',
          {
            class: 'btn',
            id: 'start-here',
            on: {
              click: () => {
                S.from = { ...p };
                S.to = null;
                S.reply = null;
                openDirections();
              },
            },
          },
          'Start from here',
        ),
        !S.loc.fix
          ? h(
              'button',
              { class: 'btn', id: 'im-here', on: { click: () => setManualMe(p.lonlat) } },
              icon('pin', 18),
              'I am here',
            )
          : null,
        h('button', { class: 'btn ghost', on: { click: () => sharePlace(p) } }, icon('share', 18), 'Share'),
      ),
    ),
  );
}

function poiOpen(q: Poi): { open: boolean; verified: boolean } {
  const r = lastOpen;
  return r ? { open: !!r.open[q.id], verified: !!r.verified[q.id] } : { open: true, verified: false };
}

function setManualMe(p: LonLat) {
  S.manualMe = p;
  drawMe();
  toast('Got it. We will use this as your location.');
  renderFabs();
  if (S.view === 'place') renderPlace();
}

async function sharePlace(p: Place) {
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

// ---------- category results ----------
async function showCategory(key: string) {
  const c =
    key === 'safe'
      ? {
          key: 'safe',
          label: 'Safe places',
          icon: 'police',
          cats: ['police', 'hospital', 'pharmacy', 'clinic', 'station', 'fuel'] as PoiCat[],
        }
      : ((CATS.find((x) => x.key === key && x.cats) ?? SAFETY_CATS.find((x) => x.key === key))! as {
          key: string;
          label: string;
          icon: string;
          cats: PoiCat[];
        });
  const me = myLonLat();
  const center: LonLat =
    me && smap.map.getBounds().contains(me) ? me : [smap.map.getCenter().lng, smap.map.getCenter().lat];
  setView('category');
  S.place = null;
  smap.setPlacePin();
  S.category = { key, title: c.label, items: [] };
  renderSearchTop();
  clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'loading small' }, h('div', { class: 'spinner' })));
  const r = await rpc<{ places: (Poi & { distM: number; open: boolean; verified: boolean })[] }>({
    type: 'nearby',
    at: center,
    when: now().toISOString(),
    radiusM: 3000,
    cats: c.cats,
    sort: key === 'safe' ? 'open' : 'dist',
    limit: 25,
  });
  if (S.view !== 'category' || S.category?.key !== key) return;
  S.category.items = r.places;
  smap.setHits(
    r.places.map((p) => ({
      lon: p.lon,
      lat: p.lat,
      icon: placeIcon(p.cat),
      open: p.open,
      label: `${p.name || CAT_INFO[p.cat].label}, ${p.open ? 'open' : 'closed'}`,
    })),
    (i) => openPoi(r.places[i].id),
  );
  if (r.places.length) smap.fit([center, ...r.places.slice(0, 10).map((p) => [p.lon, p.lat] as LonLat)], fitPad());
  clear(
    sheet,
    h('div', { class: 'grip' }),
    h(
      'div',
      { class: 'list-head' },
      h('h2', null, `${c.label} nearby`),
      h(
        'div',
        { class: 'meta' },
        `Within 3 km of ${me && center === me ? 'you' : 'the map centre'}, open state at ${clockText(now())}`,
      ),
    ),
    h(
      'ul',
      { class: 'places' },
      r.places.length
        ? r.places.map((p) =>
            h(
              'li',
              null,
              h(
                'button',
                { class: 'place-row', on: { click: () => openPoi(p.id) } },
                h('span', { class: `pi cat-${p.cat}` }, icon(placeIcon(p.cat), 18)),
                h(
                  'div',
                  null,
                  h('b', null, p.name || CAT_INFO[p.cat].label),
                  h('small', null, `${CAT_INFO[p.cat].label} · ${fmtDist(p.distM)}`),
                ),
                h(
                  'span',
                  { class: `open-pill ${p.open ? 'yes' : 'no'}` },
                  p.open ? (p.verified ? 'Open' : 'Likely open') : 'Closed',
                ),
              ),
              h(
                'button',
                {
                  class: 'btn small go',
                  'aria-label': `Directions to ${p.name || CAT_INFO[p.cat].label}`,
                  on: {
                    click: () => {
                      S.to = { lonlat: [p.lon, p.lat], label: p.name || CAT_INFO[p.cat].label };
                      S.from = null;
                      S.userPicked = false;
                      openDirections();
                    },
                  },
                },
                icon('navigate', 18),
              ),
            ),
          )
        : h('li', { class: 'empty' }, 'Nothing like this is mapped within 3 km. Call 112 if you need help.'),
    ),
  );
}

// ---------- choose on map ----------
function startPick(target: 'from' | 'to' | 'me') {
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
let pickSeq = 0;
async function updatePickLabel() {
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
function endPick(ok: boolean) {
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

// ---------- directions ----------
function placeField(which: 'from' | 'to'): HTMLElement {
  const val = which === 'from' ? (S.from ? S.from.label : myLonLat() ? 'Your location' : '') : (S.to?.label ?? '');
  const input = h('input', {
    type: 'search',
    class: 'field-input',
    id: `f-${which}`,
    autocomplete: 'off',
    enterkeyhint: 'search',
    placeholder: which === 'from' ? 'Choose start' : 'Choose destination',
    value: val,
    'aria-label': which === 'from' ? 'Start point' : 'Destination',
  });
  if (which === 'from' && !S.from && myLonLat()) input.classList.add('mine');
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  const choose = (hit: Hit | 'me' | 'map') => {
    list.hidden = true;
    input.blur();
    if (hit === 'map') {
      startPick(which);
      return;
    }
    if (hit === 'me') {
      if (!myLonLat()) {
        explainNoLocation();
        return;
      }
      if (which === 'from') S.from = null;
      else S.to = { lonlat: myLonLat()!, label: 'Your location', mine: true };
    } else {
      const p = { lonlat: [hit.lon, hit.lat] as LonLat, label: hit.name };
      if (which === 'from') S.from = p;
      else S.to = p;
    }
    S.userPicked = false;
    openDirections();
  };
  const render = () => {
    const q = input.value === 'Your location' ? '' : input.value;
    const near = fromLonLat() ?? [77.215, 28.6];
    const hits = search.query(q, intentFor(q) ? 4 : 7, near as [number, number]);
    const items: HTMLElement[] = [];
    items.push(
      h(
        'li',
        { role: 'option', tabindex: 0, on: { click: () => choose('me') } },
        h('span', { class: 'sic me-ic' }, icon('locate', 18)),
        'Your location',
        !myLonLat() ? h('small', null, 'not found yet') : null,
      ),
    );
    // "gym": the nearest gyms (or similar) to the other end of the trip
    items.push(
      ...intentRows(
        q,
        near as LonLat,
        (p) => {
          list.hidden = true;
          input.blur();
          if (which === 'from') S.from = browsePlace(p);
          else S.to = browsePlace(p);
          S.userPicked = false;
          openDirections();
        },
        null,
        render,
      ),
    );
    items.push(
      ...hits.map((x) =>
        h(
          'li',
          { role: 'option', tabindex: 0, on: { click: () => choose(x) } },
          h('span', { class: 'sic' }, icon(placeIcon(x.type), 18)),
          h('span', null, x.name),
          h('small', null, typeLabel(x.type)),
        ),
      ),
    );
    items.push(
      h(
        'li',
        { role: 'option', tabindex: 0, on: { click: () => choose('map') } },
        h('span', { class: 'sic' }, icon('pin', 18)),
        'Choose on map',
      ),
    );
    if (q.length >= 2 && !hits.length)
      items.splice(
        1,
        0,
        h('li', { class: 'empty' }, `No place called “${q}” in Delhi. Try a nearby metro station or market.`),
      );
    clear(list, items);
    list.hidden = false;
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => {
    input.select();
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const opts = list.querySelectorAll('li[role=option]');
      (opts[input.value.length >= 2 && opts.length > 2 ? 1 : 0] as HTMLElement | undefined)?.click();
    }
    if (e.key === 'Escape') list.hidden = true;
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 200));
  return h(
    'div',
    { class: `field field-${which}` },
    h('span', { class: `dot dot-${which}`, 'aria-hidden': 'true' }),
    input,
    list,
  );
}

function renderDirectionsTop() {
  const st = S.settings;
  const timeInput = h('input', {
    type: 'time',
    class: 'time-input',
    'aria-label': 'Leave at',
    value: S.leaveAt ? isoClock(S.leaveAt) : '',
  });
  timeInput.addEventListener('change', () => {
    S.leaveAt = timeInput.value ? timeToday(timeInput.value) : null;
    applyTheme();
    refreshPois();
    openDirections();
  });
  const who = h(
    'select',
    { class: 'who-select', 'aria-label': 'Who is travelling', id: 'who' },
    (
      [
        ['general', 'Family'],
        ['child', 'Child alone'],
        ['woman', 'Woman alone'],
      ] as [Profile, string][]
    ).map(([v, l]) => h('option', { value: v, selected: st.profile === v }, l)),
  );
  who.addEventListener('change', () => {
    S.settings = save({ profile: who.value as Profile });
    openDirections();
  });
  clear(
    top,
    h(
      'div',
      { class: 'dir-panel' },
      h(
        'div',
        { class: 'dir-fields' },
        h(
          'button',
          {
            class: 'back',
            'aria-label': 'Close directions',
            on: {
              click: () => {
                if (S.to) showPlace(S.to, false);
                else goHome();
              },
            },
          },
          icon('back', 24),
        ),
        h('div', { class: 'fields' }, placeField('from'), placeField('to')),
        h(
          'button',
          { class: 'swap', 'aria-label': 'Swap start and destination', id: 'swap', on: { click: () => swapEnds() } },
          icon('swap', 20),
        ),
      ),
      h(
        'div',
        { class: 'modes', role: 'tablist', 'aria-label': 'How are you travelling' },
        MODES.map((m) => {
          const t = S.modeTimes[m];
          return h(
            'button',
            {
              class: `mode-tab${m === st.mode ? ' on' : ''}`,
              role: 'tab',
              'aria-selected': m === st.mode ? 'true' : 'false',
              'data-mode': m,
              on: {
                click: () => {
                  if (m === S.settings.mode) return;
                  S.settings = save({ mode: m });
                  S.userPicked = false;
                  openDirections();
                },
              },
            },
            icon(m, 20),
            h('span', { class: 'sr-only' }, `${MODE_INFO[m].label} `),
            h('small', null, t ? fmtDuration(t) : t === null ? '—' : ''),
          );
        }),
      ),
      h(
        'div',
        { class: 'dir-opts' },
        who,
        h(
          'button',
          {
            class: `chip mini${S.leaveAt ? '' : ' on'}`,
            on: {
              click: () => {
                S.leaveAt = null;
                applyTheme();
                refreshPois();
                openDirections();
              },
            },
          },
          'Leave now',
        ),
        h('label', { class: `chip mini time${S.leaveAt ? ' on' : ''}` }, 'at ', timeInput),
      ),
    ),
  );
}

function swapEnds() {
  const a = S.from ?? (myLonLat() ? { lonlat: myLonLat()!, label: 'Your location', mine: true } : null);
  const b = S.to;
  S.to = a;
  S.from = b?.mine ? null : b;
  S.userPicked = false;
  openDirections();
}

function isoClock(d: Date): string {
  const m = istTime(d).minutes;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function openDirections() {
  if (S.view !== 'directions') setView('directions');
  smap.setPlacePin();
  smap.setHits([]);
  renderDirectionsTop();
  planRoutes();
}

let planSeq = 0;
async function planRoutes(opts: { quiet?: boolean } = {}) {
  const from = fromLonLat();
  const to = S.to?.lonlat;
  smap.setEndpoints(S.from ? (from ?? undefined) : undefined, to);
  if (!to || !from) {
    S.reply = null;
    smap.clearRoutes();
    clear(
      sheet,
      h('div', { class: 'grip' }),
      h(
        'div',
        { class: 'pad' },
        !to
          ? h(
              'p',
              { class: 'hint' },
              'Where do you want to go? Search above, or ',
              h('button', { class: 'linkish', on: { click: () => startPick('to') } }, 'choose on the map'),
              '.',
            )
          : [
              h('h3', null, 'Where are you starting from?'),
              h(
                'p',
                null,
                S.loc.status === 'denied'
                  ? 'Location is off, so we do not know where you are.'
                  : S.loc.status === 'asking' || S.loc.status === 'idle'
                    ? 'Finding your location…'
                    : 'GPS is not available right now.',
              ),
              h(
                'div',
                { class: 'row2' },
                h(
                  'button',
                  { class: 'btn primary', id: 'pick-start', on: { click: () => startPick('from') } },
                  icon('pin', 18),
                  'Choose start on map',
                ),
                h(
                  'button',
                  {
                    class: 'btn',
                    on: { click: () => (document.getElementById('f-from') as HTMLInputElement | null)?.focus() },
                  },
                  'Search start',
                ),
              ),
            ],
      ),
    );
    return;
  }
  if (!inCoverage(from) || !inCoverage(to)) {
    toast('Both points must be inside Delhi NCT for now.');
    return;
  }
  const seq = ++planSeq;
  if (!opts.quiet)
    clear(
      sheet,
      h('div', { class: 'grip' }),
      h(
        'div',
        { class: 'loading small' },
        h('div', { class: 'spinner' }),
        h('p', null, 'Checking which streets are busy and open right now…'),
      ),
    );
  applyTheme();
  const when = now().toISOString();
  rpc<{ times: Partial<Record<Mode, number | null>> }>({
    type: 'modeTimes',
    from,
    to,
    when,
    profile: S.settings.profile,
  })
    .then((r) => {
      if (seq === planSeq && (S.view === 'directions' || S.view === 'details')) {
        S.modeTimes = r.times;
        updateModeTimes();
      }
    })
    .catch(() => {});
  let reply: RouteReply;
  try {
    reply = (
      await rpc<{ reply: RouteReply }>({
        type: 'route',
        from,
        to,
        mode: S.settings.mode,
        when,
        profile: S.settings.profile,
        pm25: S.air?.pm25 ?? null,
      })
    ).reply;
  } catch (err) {
    if (seq !== planSeq) return;
    S.reply = null;
    clear(
      sheet,
      h('div', { class: 'grip' }),
      h('div', { class: 'pad' }, h('p', { class: 'error' }, 'Routing failed: ' + (err as Error).message)),
    );
    return;
  }
  if (seq !== planSeq || (S.view !== 'directions' && S.view !== 'details')) return;
  const prevLabel = S.reply?.routes[S.selected]?.labels[0];
  S.reply = reply;
  // the fastest route is shown first; the user decides
  if (S.userPicked && prevLabel)
    S.selected = Math.max(
      0,
      reply.routes.findIndex((r) => r.labels[0] === prevLabel),
    );
  else S.selected = 0;
  if (S.view === 'details') showDetails();
  else renderRoutes();
  if (!opts.quiet && reply.routes.length)
    smap.fit(
      reply.routes.flatMap((x) => x.coords),
      fitPad(),
    );
}

function updateModeTimes() {
  for (const b of top.querySelectorAll<HTMLButtonElement>('.mode-tab')) {
    const m = b.dataset.mode as Mode;
    const t = S.modeTimes[m];
    b.querySelector('small')!.textContent = t ? fmtDuration(t) : t === null ? '—' : '';
  }
}

function selectRoute(i: number, fromMap = false) {
  if (!S.reply || (S.view !== 'directions' && S.view !== 'details')) return;
  S.selected = i;
  S.userPicked = true;
  if (S.view === 'details') showDetails();
  else renderRoutes();
  if (fromMap)
    (sheet.querySelector('.route-card.sel') as HTMLElement | null)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
}

function renderRoutes() {
  const R = S.reply!;
  smap.showRoutes(R.routes, S.selected, { callouts: true, onSelect: (i) => selectRoute(i, true) });
  const adv = R.advice;
  const vehicleNote = S.settings.mode !== 'walk' && !S.onewayKnown;
  const sel = R.routes[S.selected];
  clear(
    sheet,
    h('div', { class: 'grip' }),
    R.error ? h('div', { class: 'pad' }, h('p', { class: 'error' }, R.error)) : null,
    adv && adv.level !== 'ok'
      ? h(
          'div',
          { class: `advice advice-${adv.level}` },
          h('strong', null, adv.title),
          h('p', null, adv.body),
          adv.suggestMode
            ? h(
                'button',
                {
                  class: 'btn small',
                  on: {
                    click: () => {
                      S.settings = save({ mode: adv.suggestMode! });
                      S.userPicked = false;
                      openDirections();
                    },
                  },
                },
                `Show ${MODE_INFO[adv.suggestMode].label.toLowerCase()} routes`,
              )
            : null,
        )
      : null,
    R.routes.length
      ? h(
          'p',
          { class: 'decide' },
          `${R.routes.length} route${R.routes.length > 1 ? 's' : ''}, fastest first. The colour shows how safe each is at ${clockText(now())}. You choose.`,
        )
      : null,
    R.routes.length > 1 ? priorityPicker(R.routes, S.selected, (i) => selectRoute(i)) : null,
    h(
      'ol',
      { class: 'route-list', 'aria-label': 'Routes, fastest first' },
      R.routes.map((r, i) => {
        const on = i === S.selected;
        return h(
          'li',
          null,
          h(
            'button',
            {
              class: `route-card${on ? ' sel' : ''}`,
              'aria-pressed': on ? 'true' : 'false',
              'data-tier': r.tier,
              on: {
                click: () => {
                  if (S.selected === i) showDetails();
                  else selectRoute(i);
                },
              },
            },
            h('span', { class: 'swatch', style: { background: TIER_INFO[r.tier].color } }),
            h(
              'span',
              { class: 'rc-body' },
              h(
                'span',
                { class: 'rc-top' },
                h('span', { class: 'rc-time' }, fmtDuration(r.timeS)),
                h('span', { class: 'rc-sub' }, fmtDist(r.lengthM)),
                r.labels
                  .filter((l) => l !== 'Also safest' && l !== 'Alternative' && l !== 'Also cleanest')
                  .map((l) =>
                    h(
                      'span',
                      { class: `lbl lbl-${l.toLowerCase().replace(/\s+/g, '-')}` },
                      l === 'Cleanest air' ? [icon('leaf', 12), l] : l,
                    ),
                  ),
                h('span', { class: 'rc-badge' }, tierBadge(r)),
              ),
              h(
                'span',
                { class: `rc-prec prec-${r.tier}` },
                icon(r.tier === 'green' ? 'police' : 'alert', 15),
                r.precautions.headline,
              ),
              airLine(r),
              on && r.precautions.items.length && r.tier !== 'green'
                ? h(
                    'span',
                    { class: 'rc-items' },
                    r.precautions.items.slice(0, 2).map((t) => h('span', null, '• ', t)),
                  )
                : null,
            ),
          ),
        );
      }),
    ),
    R.note ? h('p', { class: 'note' }, R.note) : null,
    R.routes.some((x) => x.labels.includes('Also cleanest')) && R.routes.length > 1
      ? h(
          'p',
          { class: 'note air-note' },
          icon('leaf', 14),
          'The fastest route is also the cleanest air here: less time outside beats a detour.',
        )
      : null,
    vehicleNote ? h('p', { class: 'note' }, 'One-way streets are not in this map yet. Follow road signs.') : null,
    sel
      ? h(
          'div',
          { class: 'actions sticky' },
          h('button', { class: 'btn', id: 'details-btn', on: { click: () => showDetails() } }, 'Precautions'),
          h(
            'button',
            { class: 'btn primary', id: 'start', on: { click: () => startJourney() } },
            icon('navigate', 18),
            'Start',
          ),
        )
      : null,
  );
}

/** What Saans needs to know about the selected route. */
function routeSummary(): RouteSummary | null {
  const r = S.reply?.routes[S.selected];
  if (!r?.air || !['directions', 'details'].includes(S.view)) return null;
  return {
    mode: MODE_INFO[S.settings.mode].label.toLowerCase(),
    minutes: Math.round(r.timeS / 60),
    label: r.labels[0] ?? 'Selected',
    pctLess: r.air.pctVsFastest,
    avoided: r.air.avoided,
    areas: r.air.areas,
  };
}

/** Live air for where the user is (or the map centre), refreshed every 30 min. */
async function refreshAir(): Promise<AirNow | null> {
  const p = myLonLat() ?? (smap ? ([smap.map.getCenter().lng, smap.map.getCenter().lat] as LonLat) : null);
  if (!p) return S.air;
  const v = await airAt(p, { server: isOnline() });
  if (v) {
    S.air = v;
    if (S.view === 'home') renderHome();
  }
  return S.air;
}
/** Saans is loaded on first use (its own chunk), so the map opens faster. */
async function askSaans(ask?: string) {
  const { openSaans, closeSaans } = await import('./saans.ts');
  openSaans(
    {
      air: refreshAir,
      route: routeSummary,
      online: async () => isOnline() || checkServer(),
      // looked up on the phone; the position itself never leaves it
      near: (it) => {
        const me = myLonLat();
        return me && placesReady() ? nearbyFor(it, me, now(), { min: 5, max: 7 }) : me ? [] : null;
      },
      go: (p) => {
        closeSaans();
        S.from = null;
        S.to = browsePlace(p);
        S.userPicked = false;
        S.reply = null;
        openDirections();
      },
    },
    { ask },
  );
}

// ---------- misc ----------
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden && !checkTimer) closeModal();
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
