import './styles.css';
import { h, clear, fmtDuration, fmtDist } from './dom.ts';
import { SafeMap, loadBasemap, hasTraffic } from './map.ts';
import { PlaceSearch, type Entry, type Hit } from './search.ts';
import { icon, placeIcon, REPORT_ICON, subIcon } from './icons.ts';
import { loadPlaces, placesReady, knownSubs, nearbyFor, type BrowsePlace } from './browse.ts';
import { matchIntent, kindCat, type Intent } from '../../shared/kinds.ts';
import { load, save, normalisePhone, type Contact } from './store.ts';
import { api, live, checkServer, isOnline, initPreviewStore, liveAvailable, livePreview } from './api.ts';
import { telLink, arrivalText, HELPLINES } from './messages.ts';
import type { RouteReply, WorkerRoute } from './worker.ts';
import { TIER_INFO, tierOf, type Tier } from '../../shared/router.ts';
import { CAT_INFO, isOpenAt, type Poi, type PoiCat } from '../../shared/places.ts';
import { MODE_INFO, MODES, WALK_KMH, type Mode } from '../../shared/modes.ts';
import { REPORT_KINDS, isAirReport, type ReportKind } from '../../shared/live.ts';
import type { AirNow } from '../../shared/air.ts';
import { airAt } from './airnow.ts';
import { aqiCard, airLine, airSection, priorityPicker } from './airui.ts';
import type { RouteSummary } from '../../shared/saans/assistant.ts';
import { darkness, istTime, IST_OFFSET_MIN } from '../../shared/time.ts';
import { haversine, type LonLat } from '../../shared/geo.ts';
import type { Profile } from '../../shared/risk.ts';
import { BASE, DEMO, DEMO_ME, S, checkTimer, clockText, closeModal, fabs, fromLonLat, inCoverage, mapEl, modal, myAcc, myLonLat, named, now, openModal, params, rpc, search, setView, sheet, smap, tierSvg, toast, top, wide, type Place, type View, setMapParts, hooks } from './app.ts';
import { startJourney, renderJourney, renderArrived, openSos, followCamera } from './journey.ts';
// ---------- boot ----------
async function boot() {
  setView('home');
  clear(sheet, h('div', { class: 'loading' }, h('span', { class: 'logo' }), h('div', { class: 'spinner' }), h('p', null, 'Loading the map of Delhi…')));
  try {
    const [ver, basemap, searchEntries] = await Promise.all([
      fetch(BASE + 'data/version.json').then((r) => r.json()).catch(() => ({ version: 'dev' })),
      loadBasemap(BASE),
      fetch(BASE + 'data/search.json').then((r) => r.json() as Promise<Entry[]>),
    ]);
    S.version = ver.version;
    S.snapshot = ver.snapshot ?? '';
    setMapParts({
      search: new PlaceSearch(searchEntries),
      named: searchEntries.filter((e) => e[3] !== 'street').map(([name, lon, lat, type]) => ({ name, lon, lat, type })),
      smap: new SafeMap(mapEl, BASE, basemap.bounds),
    });
    (window as any).__sr.map = smap.map;
    smap.map.on('error', (e: any) => console.warn('map error', e?.error?.message ?? e));
    smap.onRouteClick((i) => selectRoute(i, true));
    smap.onPoiClick((id) => { if (['home', 'place', 'category'].includes(S.view)) openPoi(id); });
    setupMapGestures();
    const ready = await rpc<{ meta: any }>({ type: 'init', base: new URL(BASE, location.href).href, graphParts: ver.graphParts });
    S.bbox = ready.meta.bbox; S.onewayKnown = ready.meta.onewayKnown;
    S.pois = await fetch(BASE + 'data/pois.json').then((r) => r.json());
    const L = S.settings.layers;
    smap.setLayerVisible('safety', L.safety); smap.setLayerVisible('pois', L.pois); smap.setLayerVisible('air', !!L.air); smap.setLayerVisible('traffic', L.traffic && hasTraffic());
    refreshPois();
    checkServer().then(async (ok) => {
      if (!ok) { if (await initPreviewStore()) refreshReports(true); return; }
      try { const c = await api.crowd(S.version); await rpc({ type: 'crowd', stats: c.stats }); } catch { /* crowd data optional */ }
      refreshReports();
    });
  } catch (err) {
    clear(sheet, h('div', { class: 'pad' }, h('h2', null, 'The map could not load'),
      h('p', null, String((err as Error).message)), h('button', { class: 'btn primary', on: { click: () => location.reload() } }, 'Try again')));
    return;
  }
  const track = params.get('track');
  if (track) { showTrack(track); return; }
  if (DEMO) save({ simulate: true });
  const pf = params.get('from'), pt = params.get('to');
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
  setInterval(() => { refreshPois(); applyTheme(); if (S.view === 'home') renderHome(); }, 60000);
  setInterval(() => refreshReports(), 60000);
  setTimeout(() => refreshAir(), 1200);
  setInterval(() => refreshAir(), 30 * 60000);
  setTimeout(() => loadPlaces(BASE), 2500); // nearby-places index for "gym near me" searches
  setTimeout(() => { void import('./saans.ts'); }, 4000); // warm the assistant chunk (and the offline cache)
  if (S.to) { openDirections(); return; }
  goHome();
  if (!S.settings.seenIntro && !DEMO) showIntro();
}

function timeToday(hhmm: string): Date {
  // interpret HH:MM as Delhi time today (or tomorrow if it already passed by > 1 h)
  const [hh, mm] = hhmm.split(':').map(Number);
  const nowIst = new Date(Date.now() + IST_OFFSET_MIN * 60000);
  const d = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), hh, mm) - IST_OFFSET_MIN * 60000);
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
  if (!('geolocation' in navigator)) { S.loc.status = 'unavailable'; return; }
  if (watchId !== null) return;
  S.loc.status = 'asking';
  watchId = navigator.geolocation.watchPosition((p) => {
    const first = !S.loc.fix;
    const moving = (p.coords.speed ?? 0) > 0.8 && p.coords.heading != null && !Number.isNaN(p.coords.heading);
    S.loc = { status: 'on', fix: { lon: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, t: p.timestamp || Date.now() },
      heading: moving ? p.coords.heading : S.loc.heading };
    if (!S.journey) drawMe();
    if (first) {
      const me = myLonLat();
      if (me && S.view === 'home' && !S.follow) smap.map.easeTo({ center: me, zoom: Math.max(smap.map.getZoom(), 15), duration: 800 });
      if (me && !S.airFor) { S.airFor = 'gps'; refreshAir(); }
      if (S.view === 'home') renderHome();
      renderFabs();
      if (S.view === 'directions' && !S.from && !S.reply) planRoutes();
    }
    if (S.follow && !S.journey) smap.map.easeTo({ center: [p.coords.longitude, p.coords.latitude], duration: 500 });
  }, (e) => {
    if (e.code === 1) { S.loc.status = 'denied'; if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; }
    else if (!S.loc.fix) S.loc.status = 'unavailable';
    if (S.view === 'home') renderHome();
    renderFabs();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
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
  if (S.loc.fix && !me) { toast('You seem to be outside Delhi. This map covers Delhi NCT only.', 5000); smap.map.flyTo({ center: [S.loc.fix.lon, S.loc.fix.lat], zoom: 13 }); return; }
  if (me) {
    S.follow = !!S.loc.fix;
    smap.map.flyTo({ center: me, zoom: Math.max(16, smap.map.getZoom()), bearing: 0, duration: 700 });
    renderFabs();
    return;
  }
  if (S.loc.status === 'idle' || S.loc.status === 'unavailable') { startLocating(); toast('Finding your location…'); }
  explainNoLocation();
}

function explainNoLocation() {
  openModal(h('div', { class: 'modal-card' },
    h('h2', null, S.loc.status === 'denied' ? 'Location is blocked' : 'Finding your location'),
    h('p', null, S.loc.status === 'denied'
      ? 'SafeRaah is not allowed to see your location. On your phone, allow location for this app or website in Settings, then tap the locate button again.'
      : 'We are still waiting for GPS. Step near a window or open area.'),
    h('p', null, 'Meanwhile you can mark where you are yourself: move the map so the pin is on your spot.'),
    h('button', { class: 'btn primary wide', id: 'mark-me', on: { click: () => { closeModal(); startPick('me'); } } }, 'Mark where I am on the map'),
    h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Close'),
  ));
}

// ---------- map gestures ----------
function setupMapGestures() {
  const m = smap.map;
  const hitSomething = (pt: { x: number; y: number }) =>
    m.queryRenderedFeatures([[pt.x - 8, pt.y - 8], [pt.x + 8, pt.y + 8]], { layers: ['pois', 'routes-hit'].filter((l) => m.getLayer(l)) }).length > 0;
  m.on('click', (e) => {
    if (hitSomething(e.point)) return;
    const p: LonLat = [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)];
    if (S.view === 'home' || S.view === 'place' || S.view === 'category') dropPin(p);
  });
  const longPress = (lngLat: { lng: number; lat: number }) => {
    const p: LonLat = [+lngLat.lng.toFixed(6), +lngLat.lat.toFixed(6)];
    if (S.view === 'directions' || S.view === 'details') { if (!inCoverage(p)) return outside(); S.to = placeAt(p); S.userPicked = false; openDirections(); }
    else if (S.view === 'home' || S.view === 'place' || S.view === 'category') dropPin(p);
  };
  m.on('contextmenu', (e) => longPress(e.lngLat));
  // iOS Safari never fires contextmenu on touch, so detect a long-press ourselves
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressAt: { x: number; y: number } | null = null;
  const cancel = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; };
  m.on('touchstart', (e) => {
    if (e.originalEvent.touches.length !== 1) return cancel();
    pressAt = { x: e.point.x, y: e.point.y };
    const lngLat = e.lngLat;
    cancel();
    pressTimer = setTimeout(() => { pressTimer = null; navigator.vibrate?.(30); longPress(lngLat); }, 600);
  });
  m.on('touchmove', (e) => { if (pressAt && Math.hypot(e.point.x - pressAt.x, e.point.y - pressAt.y) > 10) cancel(); });
  m.on('touchend', cancel);
  m.on('touchcancel', cancel);
  m.on('movestart', (e) => {
    if (!(e as { originalEvent?: Event }).originalEvent) return;
    cancel();
    if (S.follow) { S.follow = false; renderFabs(); }
  });
  m.on('rotate', () => renderCompass());
  let safetyTimer: ReturnType<typeof setTimeout>;
  m.on('moveend', () => { clearTimeout(safetyTimer); safetyTimer = setTimeout(() => { refreshSafety(); refreshAirLayer(); }, 250); if (S.view === 'pick') updatePickLabel(); });
}

function outside() { toast('That point is outside the area this map covers (Delhi NCT).'); }

/** A readable name for any point: a mapped place right there, or the street. */
function nameFor(p: LonLat): { label: string; near?: string } {
  let best: { name: string } | null = null, bd = 250;
  for (const q of named) {
    const d = Math.hypot((q.lon - p[0]) * 97600, (q.lat - p[1]) * 111200);
    if (d < bd) { bd = d; best = q; }
  }
  for (const q of S.pois) {
    if (!q.name) continue;
    const d = Math.hypot((q.lon - p[0]) * 97600, (q.lat - p[1]) * 111200);
    if (d < bd) { bd = d; best = q; }
  }
  if (best && bd < 40) return { label: best.name };
  return { label: 'Dropped pin', near: best ? best.name : undefined };
}
function placeAt(p: LonLat): Place {
  const n = nameFor(p);
  return { lonlat: p, label: n.label === 'Dropped pin' && n.near ? `Near ${n.near}` : n.label, sub: n.near && n.label === 'Dropped pin' ? `Near ${n.near}` : undefined };
}

// ---------- top: search bar & chips ----------
const CATS: { key: string; label: string; icon: string; cats: PoiCat[] }[] = [
  { key: 'police', label: 'Police', icon: 'police', cats: ['police'] },
  { key: 'hospital', label: 'Hospitals', icon: 'hospital', cats: ['hospital', 'clinic'] },
  { key: 'pharmacy', label: 'Medical stores', icon: 'pharmacy', cats: ['pharmacy'] },
  { key: 'station', label: 'Metro', icon: 'station', cats: ['station'] },
  { key: 'fuel', label: 'Petrol pumps', icon: 'fuel', cats: ['fuel'] },
];

function renderSearchTop() {
  const input = h('input', {
    type: 'search', id: 'q', class: 'search-input', autocomplete: 'off', enterkeyhint: 'search',
    placeholder: 'Search here', 'aria-label': 'Search for a place in Delhi', value: S.view === 'place' && S.place ? S.place.label : '',
  });
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  let intent: Intent | null = null;
  const render = () => {
    const q = input.value;
    const near = (myLonLat() ?? [smap.map.getCenter().lng, smap.map.getCenter().lat]) as LonLat;
    const hits = search.query(q, intentFor(q) ? 4 : 7, near as [number, number]);
    intent = intentFor(q);
    const items: HTMLElement[] = intentRows(q, near, (p) => { list.hidden = true; input.blur(); openBrowsePlace(p); },
      (it) => { list.hidden = true; input.blur(); showBrowse(it); }, render);
    if (items.length && hits.length) items.push(h('li', { class: 'sect', role: 'presentation' }, 'Places by name'));
    items.push(...hits.map((x) => h('li', { role: 'option', tabindex: 0, on: { click: () => { list.hidden = true; input.blur(); openHit(x); } } },
      h('span', { class: 'sic' }, icon(placeIcon(x.type), 18)), h('span', null, x.name), h('small', null, typeLabel(x.type)))));
    if (q.length >= 2 && !items.length) items.push(h('li', { class: 'empty' }, `No place called “${q}” in Delhi. Try a nearby metro station or market, or tap the map.`));
    if (q.length < 2) items.push(...CATS.map((c) => h('li', { role: 'option', tabindex: 0, on: { click: () => { list.hidden = true; input.blur(); showCategory(c.key); } } },
      h('span', { class: 'sic' }, icon(c.icon, 18)), h('span', null, `${c.label} near you`))));
    clear(list, items);
    list.hidden = false;
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => { input.select(); render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (intent) { list.hidden = true; input.blur(); showBrowse(intent); }
      else (list.querySelector('li[role=option]') as HTMLElement | null)?.click();
    }
    if (e.key === 'Escape') { list.hidden = true; input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 200));
  const hasPlace = S.view === 'place' || S.view === 'category';
  clear(top,
    h('div', { class: 'searchbar' },
      h('button', { class: 'sb-btn', 'aria-label': 'Menu', id: 'menu', on: { click: () => openMenu() } }, icon('menu', 22)),
      input,
      hasPlace ? h('button', { class: 'sb-btn', 'aria-label': 'Clear', on: { click: () => goHome() } }, icon('close', 20))
        : h('span', { class: 'logo', 'aria-hidden': 'true', title: 'SafeRaah' }),
      list),
    h('div', { class: 'catchips', role: 'toolbar', 'aria-label': 'Find nearby' },
      CATS.map((c) => h('button', { class: `chip cat${S.category?.key === c.key && S.view === 'category' ? ' on' : ''}`, 'data-cat': c.key,
        on: { click: () => (S.view === 'category' && S.category?.key === c.key ? goHome() : showCategory(c.key)) } },
      icon(c.icon, 17), c.label))),
  );
}

function typeLabel(t: string): string {
  if (t === 'street') return 'Street';
  if (t === 'station') return 'Metro / rail';
  const extra: Record<string, string> = { landmark: 'Landmark', park: 'Park', market: 'Market', school: 'School / college', office: 'Office', suburb: 'Area', neighbourhood: 'Area', quarter: 'Area', locality: 'Area' };
  if (extra[t]) return extra[t];
  return (CAT_INFO as Record<string, { label: string }>)[t]?.label ?? (t === 'place' ? 'Place' : t.charAt(0).toUpperCase() + t.slice(1));
}

// ---------- "gym near me": nearby places by kind ----------
const intentFor = (q: string) => matchIntent(q, knownSubs());

/** Suggestion rows for a kind of place: the nearest 5–7, or similar places when none are close. */
function intentRows(q: string, near: LonLat, pick: (p: BrowsePlace) => void, all: ((i: Intent) => void) | null, rerender: () => void): HTMLElement[] {
  const it = intentFor(q);
  if (!it) {
    if (!placesReady() && q.trim().length >= 3) loadPlaces(BASE).then(() => { if (intentFor(q)) rerender(); });
    return [];
  }
  if (!placesReady()) {
    loadPlaces(BASE).then(rerender);
    return [h('li', { class: 'empty' }, `Finding ${it.title.toLowerCase()} near you…`)];
  }
  const res = nearbyFor(it, near, now());
  const exact = res.filter((p) => !p.similar).length;
  const me = myLonLat();
  const isMe = !!me && me[0] === near[0] && me[1] === near[1];
  const rows: HTMLElement[] = [h('li', { class: 'sect', role: 'presentation' },
    exact ? `${it.title} near ${isMe ? 'you' : 'here'}` : `No ${it.one} mapped nearby. Similar places:`)];
  rows.push(...res.map((p) => h('li', { role: 'option', tabindex: 0, class: 'kind-row', on: { click: () => pick(p) } },
    h('span', { class: `sic kind${p.similar ? ' sim' : ''}` }, icon(subIcon(p.sub), 18)),
    h('span', { class: 'kr-main' }, h('span', { class: 'kr-name' }, p.name),
      h('small', null, p.similar ? `Similar: ${p.label}` : p.label, ` · ${fmtDist(p.distM)}`)),
    h('span', { class: `open-pill ${p.open ? 'yes' : 'no'}` }, p.open ? (p.verified ? 'Open' : 'Likely open') : 'Closed'))));
  if (!res.length) rows.push(h('li', { class: 'empty' }, `Nothing like this is mapped within 15 km.`));
  else if (all) rows.push(h('li', { role: 'option', tabindex: 0, class: 'see-all', id: 'see-all', on: { click: () => all(it) } },
    h('span', { class: 'sic me-ic' }, icon('map', 18)), h('span', null, `Show ${it.title.toLowerCase()} on the map`)));
  return rows;
}

function browsePlace(p: BrowsePlace): Place {
  return { lonlat: [p.lon, p.lat], label: p.name, sub: p.label, kind: p.sub, cat: kindCat(p.sub), oh: p.oh };
}
function openBrowsePlace(p: BrowsePlace) { showPlace(browsePlace(p), true); }

/** All places of a kind near you, as a list and pins (like the category chips). */
function showBrowse(it: Intent) {
  if (!placesReady()) { loadPlaces(BASE).then(() => showBrowse(it)); return; }
  const me = myLonLat();
  const center: LonLat = me && smap.map.getBounds().contains(me) ? me : [smap.map.getCenter().lng, smap.map.getCenter().lat];
  setView('category');
  S.place = null;
  smap.setPlacePin();
  S.category = { key: `kind:${it.title}`, title: it.title, items: [] };
  renderSearchTop();
  const res = nearbyFor(it, center, now(), { min: 8, max: 25 });
  const exact = res.filter((p) => !p.similar).length;
  smap.setHits(res.map((p) => ({ lon: p.lon, lat: p.lat, icon: subIcon(p.sub), open: p.open, label: `${p.name}, ${p.label}, ${p.open ? 'open' : 'closed'}` })),
    (i) => openBrowsePlace(res[i]));
  if (res.length) smap.fit([center, ...res.slice(0, 10).map((p) => [p.lon, p.lat] as LonLat)], fitPad());
  clear(sheet, h('div', { class: 'grip' }),
    h('div', { class: 'list-head' }, h('h2', null, exact ? `${it.title} nearby` : `Places like a ${it.one}`),
      h('div', { class: 'meta' }, exact ? `Nearest to ${me && center === me ? 'you' : 'the map centre'}, open state at ${clockText(now())}`
        : `No ${it.one} is mapped near ${me && center === me ? 'you' : 'here'}, so these are the closest similar places.`)),
    h('ul', { class: 'places' }, res.length ? res.map((p) => h('li', null,
      h('button', { class: 'place-row', on: { click: () => openBrowsePlace(p) } },
        h('span', { class: `pi cat-${kindCat(p.sub)}` }, icon(subIcon(p.sub), 18)),
        h('div', null, h('b', null, p.name), h('small', null, `${p.similar ? 'Similar: ' : ''}${p.label} · ${fmtDist(p.distM)}`)),
        h('span', { class: `open-pill ${p.open ? 'yes' : 'no'}` }, p.open ? (p.verified ? 'Open' : 'Likely open') : 'Closed')),
      h('button', { class: 'btn small go', 'aria-label': `Directions to ${p.name}`,
        on: { click: () => { S.to = browsePlace(p); S.from = null; S.userPicked = false; openDirections(); } } }, icon('navigate', 18)))) :
      h('li', { class: 'empty' }, 'Nothing like this is mapped within 15 km yet.')),
    h('p', { class: 'note' }, 'Places come from OpenStreetMap; some shops may be missing or have moved.'));
}

// ---------- floating map buttons ----------
const compassBtn = h('button', { class: 'fab compass', 'aria-label': 'Point the map north', hidden: true, on: { click: () => smap.map.easeTo({ bearing: 0, pitch: 0 }) } },
  h('span', { class: 'needle', 'aria-hidden': 'true' }));
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
  clear(fabs,
    compassBtn,
    v !== 'journey' ? h('button', { class: 'fab', id: 'layers-btn', 'aria-label': 'Map layers', title: 'Map layers', on: { click: () => openLayers() } }, icon('layers', 22)) : null,
    h('button', { class: 'fab report-fab', id: 'report-btn', 'aria-label': 'Report something unsafe here', title: 'Report', on: { click: () => openReport() } }, icon('alert', 22)),
    J ? (S.follow ? null : h('button', { class: 'fab wide-fab', id: 'recenter', on: { click: () => { S.follow = true; renderFabs(); if (S.myPos) followCamera(S.myPos); } } }, icon('navigate', 18), 'Re-centre'))
      : h('button', { class: `fab locate ${locState}`, id: 'locate', 'aria-label': 'Show my location', title: 'My location', on: { click: () => locate() } },
        icon(locState === 'follow' ? 'navigate' : 'locate', 22)),
  );
  renderCompass();
}

// ---------- home ----------
function goHome() {
  setView('home');
  S.place = null; S.category = null; S.reply = null;
  smap.clearRoutes(); smap.setEndpoints(); smap.setPlacePin(); smap.setHits([]);
  renderSearchTop();
  renderHome();
  drawMe();
}

function renderHome() {
  if (S.view !== 'home') return;
  const d = darkness(now());
  const me = myLonLat();
  const nearReports = me ? S.reports.filter((r) => haversine(r.lon, r.lat, me[0], me[1]) < 2000 && REPORT_KINDS[r.kind]?.danger).length : 0;
  const status = S.loc.fix && !me ? 'You seem to be outside Delhi. Routes work inside Delhi NCT.'
    : me ? null
      : S.loc.status === 'denied' ? 'Location is off, so we cannot show where you are.'
        : S.loc.status === 'unavailable' ? 'GPS is not available right now.' : 'Finding your location…';
  clear(sheet,
    h('div', { class: 'grip', 'aria-hidden': 'true' }),
    h('div', { class: 'pad home' },
      status ? h('div', { class: 'loc-note' }, h('span', null, status),
        !me ? h('button', { class: 'btn small', id: 'mark-me-home', on: { click: () => startPick('me') } }, 'Mark where I am') : null) : null,
      h('div', { class: 'now-row' },
        h('span', { class: `now-pill ${d >= 0.5 ? 'night' : 'day'}` }, icon(d >= 0.5 ? 'moon' : 'sun', 15), clockText(now())),
        h('span', { class: 'now-text' }, d >= 0.5 ? 'After dark: we weigh lighting, open places and busy streets more.' : 'Daytime: most busy streets are low risk.')),
      aqiCard(S.air, () => askSaans()),
      nearReports ? h('p', { class: 'live-line' }, h('span', { class: 'live-dot' }), `${nearReports} live safety report${nearReports > 1 ? 's' : ''} near you`) : null,
      h('p', { class: 'hint' }, 'Search a place, tap anywhere on the map, or pick a category above. Then tap ', h('b', null, 'Directions'), '.'),
      h('div', { class: 'quick' },
        h('button', { class: 'btn', on: { click: () => showCategory('safe') } }, icon('police', 18), 'Safe places near me'),
        h('button', { class: 'btn', on: { click: () => showContacts() } }, icon('contacts', 18), 'Trusted contacts')),
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
  showPlace({ lonlat: [q.lon, q.lat], label: q.name || CAT_INFO[q.cat].label, sub: CAT_INFO[q.cat].label, poi: id, kind: q.cat }, true);
}
function dropPin(p: LonLat) {
  if (!inCoverage(p)) return outside();
  showPlace(placeAt(p), false);
}

async function showPlace(p: Place, fly: boolean) {
  setView('place');
  S.place = p; S.category = null;
  smap.setHits([]);
  smap.setPlacePin(p.lonlat);
  renderSearchTop();
  renderPlace();
  if (fly) smap.map.flyTo({ center: p.lonlat, zoom: Math.max(16, smap.map.getZoom()), duration: 700, padding: mapPad() });
  const w = await rpc<{ street: string; distM: number | null; onMap: boolean; risk: number | null }>({
    type: 'whereis', at: p.lonlat, when: now().toISOString(), profile: S.settings.profile });
  if (S.place !== p) return;
  p.street = w.street; p.risk = w.onMap && (w.distM ?? 999) < 150 ? w.risk : null;
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
  clear(sheet,
    h('div', { class: 'grip', 'aria-hidden': 'true' }),
    h('div', { class: 'pad place-card' },
      h('div', { class: 'pc-head' },
        h('div', null, h('h2', { id: 'place-title' }, p.label), subBits ? h('div', { class: 'meta' }, subBits) : null),
        h('button', { class: 'icon-btn flat', 'aria-label': 'Close', on: { click: () => goHome() } }, icon('close', 18))),
      h('div', { class: 'pc-facts' },
        dist != null ? h('span', null, `${fmtDist(dist)} from you`, dist > 120 ? ` · ~${fmtDuration((dist * 1.3) / (WALK_KMH / 3.6))} walk` : '') : null,
        open ? h('span', { class: `open-pill ${open.open ? 'yes' : 'no'}` }, open.open ? (open.verified ? 'Open now' : 'Likely open now') : 'Closed now') : null,
        tier ? h('span', { class: `street-now tier-text-${tier}` }, h('span', { class: `sw tier-${tier}` }), `Street right now: ${TIER_INFO[tier].label.toLowerCase()}`) : null),
      (poi?.oh ?? p.oh) ? h('p', { class: 'fine' }, 'Hours: ', poi?.oh ?? p.oh) : null,
      h('div', { class: 'pc-actions' },
        h('button', { class: 'btn primary', id: 'directions', on: { click: () => { S.to = { ...p }; S.from = null; S.userPicked = false; S.reply = null; openDirections(); } } }, icon('navigate', 18), 'Directions'),
        h('button', { class: 'btn', id: 'start-here', on: { click: () => { S.from = { ...p }; S.to = null; S.reply = null; openDirections(); } } }, 'Start from here'),
        !S.loc.fix ? h('button', { class: 'btn', id: 'im-here', on: { click: () => setManualMe(p.lonlat) } }, icon('pin', 18), 'I am here') : null,
        h('button', { class: 'btn ghost', on: { click: () => sharePlace(p) } }, icon('share', 18), 'Share')),
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
  if (navigator.share) { try { await navigator.share({ title: p.label, text, url: u.href }); return; } catch { /* cancelled */ } }
  navigator.clipboard?.writeText(`${text}: ${u.href}`).then(() => toast('Link copied'));
}

// ---------- category results ----------
async function showCategory(key: string) {
  const c = key === 'safe' ? { key: 'safe', label: 'Safe places', icon: 'police', cats: ['police', 'hospital', 'pharmacy', 'clinic', 'station', 'fuel'] as PoiCat[] } : CATS.find((x) => x.key === key)!;
  const me = myLonLat();
  const center: LonLat = me && smap.map.getBounds().contains(me) ? me : [smap.map.getCenter().lng, smap.map.getCenter().lat];
  setView('category');
  S.place = null;
  smap.setPlacePin();
  S.category = { key, title: c.label, items: [] };
  renderSearchTop();
  clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'loading small' }, h('div', { class: 'spinner' })));
  const r = await rpc<{ places: (Poi & { distM: number; open: boolean; verified: boolean })[] }>({
    type: 'nearby', at: center, when: now().toISOString(), radiusM: 3000, cats: c.cats, sort: key === 'safe' ? 'open' : 'dist', limit: 25 });
  if (S.view !== 'category' || S.category?.key !== key) return;
  S.category.items = r.places;
  smap.setHits(r.places.map((p) => ({ lon: p.lon, lat: p.lat, icon: placeIcon(p.cat), open: p.open, label: `${p.name || CAT_INFO[p.cat].label}, ${p.open ? 'open' : 'closed'}` })),
    (i) => openPoi(r.places[i].id));
  if (r.places.length) smap.fit([center, ...r.places.slice(0, 10).map((p) => [p.lon, p.lat] as LonLat)], fitPad());
  clear(sheet, h('div', { class: 'grip' }),
    h('div', { class: 'list-head' }, h('h2', null, `${c.label} nearby`), h('div', { class: 'meta' }, `Within 3 km of ${me && center === me ? 'you' : 'the map centre'}, open state at ${clockText(now())}`)),
    h('ul', { class: 'places' }, r.places.length ? r.places.map((p) => h('li', null,
      h('button', { class: 'place-row', on: { click: () => openPoi(p.id) } },
        h('span', { class: `pi cat-${p.cat}` }, icon(placeIcon(p.cat), 18)),
        h('div', null, h('b', null, p.name || CAT_INFO[p.cat].label), h('small', null, `${CAT_INFO[p.cat].label} · ${fmtDist(p.distM)}`)),
        h('span', { class: `open-pill ${p.open ? 'yes' : 'no'}` }, p.open ? (p.verified ? 'Open' : 'Likely open') : 'Closed')),
      h('button', { class: 'btn small go', 'aria-label': `Directions to ${p.name || CAT_INFO[p.cat].label}`,
        on: { click: () => { S.to = { lonlat: [p.lon, p.lat], label: p.name || CAT_INFO[p.cat].label }; S.from = null; S.userPicked = false; openDirections(); } } }, icon('navigate', 18)))) :
      h('li', { class: 'empty' }, 'Nothing like this is mapped within 3 km. Call 112 if you need help.')));
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
  clear(top, h('div', { class: 'pick-bar' },
    h('button', { class: 'back', 'aria-label': 'Cancel', on: { click: () => endPick(false) } }, icon('back', 24)),
    h('div', null, h('b', null, title), h('div', { class: 'meta' }, 'Move the map so the pin is on the spot'))));
  clear(sheet, h('div', { class: 'pad pick' },
    h('div', { class: 'pick-label', id: 'pick-label' }, '…'),
    h('button', { class: 'btn primary wide', id: 'pick-ok', on: { click: () => endPick(true) } }, target === 'me' ? 'I am here' : 'Done')));
  updatePickLabel();
}
let pickSeq = 0;
async function updatePickLabel() {
  const c = smap.map.getCenter();
  const p: LonLat = [c.lng, c.lat];
  const el = document.getElementById('pick-label');
  if (!el) return;
  if (!inCoverage(p)) { el.textContent = 'Outside Delhi NCT'; return; }
  const seq = ++pickSeq;
  const n = placeAt(p);
  el.textContent = n.label;
  const w = await rpc<{ street: string }>({ type: 'whereis', at: p });
  if (seq !== pickSeq) return;
  if (w.street) el.textContent = n.label.startsWith('Near') || n.label === 'Dropped pin' ? `${w.street}${n.label.startsWith('Near') ? ' · ' + n.label : ''}` : `${n.label} · ${w.street}`;
}
function endPick(ok: boolean) {
  const pk = S.pick!;
  S.pick = null;
  if (ok) {
    const c = smap.map.getCenter();
    const p: LonLat = [+c.lng.toFixed(6), +c.lat.toFixed(6)];
    if (!inCoverage(p)) { outside(); return startPick(pk.target); }
    const label = (document.getElementById('pick-label')?.textContent || placeAt(p).label).split(' · ')[0];
    if (pk.target === 'me') { setManualMe(p); }
    else if (pk.target === 'from') S.from = { lonlat: p, label };
    else S.to = { lonlat: p, label };
    if (pk.target !== 'me' || pk.back === 'directions' || pk.back === 'details') { S.userPicked = false; openDirections(); return; }
  }
  if (pk.back === 'directions' || pk.back === 'details') openDirections();
  else if (pk.back === 'place' && S.place) showPlace(S.place, false);
  else goHome();
}

// ---------- directions ----------
function placeField(which: 'from' | 'to'): HTMLElement {
  const val = which === 'from' ? (S.from ? S.from.label : myLonLat() ? 'Your location' : '') : S.to?.label ?? '';
  const input = h('input', {
    type: 'search', class: 'field-input', id: `f-${which}`, autocomplete: 'off', enterkeyhint: 'search',
    placeholder: which === 'from' ? 'Choose start' : 'Choose destination', value: val,
    'aria-label': which === 'from' ? 'Start point' : 'Destination',
  });
  if (which === 'from' && !S.from && myLonLat()) input.classList.add('mine');
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  const choose = (hit: Hit | 'me' | 'map') => {
    list.hidden = true;
    input.blur();
    if (hit === 'map') { startPick(which); return; }
    if (hit === 'me') {
      if (!myLonLat()) { explainNoLocation(); return; }
      if (which === 'from') S.from = null; else S.to = { lonlat: myLonLat()!, label: 'Your location', mine: true };
    } else {
      const p = { lonlat: [hit.lon, hit.lat] as LonLat, label: hit.name };
      if (which === 'from') S.from = p; else S.to = p;
    }
    S.userPicked = false;
    openDirections();
  };
  const render = () => {
    const q = input.value === 'Your location' ? '' : input.value;
    const near = fromLonLat() ?? [77.215, 28.6];
    const hits = search.query(q, intentFor(q) ? 4 : 7, near as [number, number]);
    const items: HTMLElement[] = [];
    items.push(h('li', { role: 'option', tabindex: 0, on: { click: () => choose('me') } }, h('span', { class: 'sic me-ic' }, icon('locate', 18)), 'Your location',
      !myLonLat() ? h('small', null, 'not found yet') : null));
    // "gym": the nearest gyms (or similar) to the other end of the trip
    items.push(...intentRows(q, near as LonLat, (p) => {
      list.hidden = true; input.blur();
      if (which === 'from') S.from = browsePlace(p); else S.to = browsePlace(p);
      S.userPicked = false; openDirections();
    }, null, render));
    items.push(...hits.map((x) => h('li', { role: 'option', tabindex: 0, on: { click: () => choose(x) } },
      h('span', { class: 'sic' }, icon(placeIcon(x.type), 18)), h('span', null, x.name), h('small', null, typeLabel(x.type)))));
    items.push(h('li', { role: 'option', tabindex: 0, on: { click: () => choose('map') } }, h('span', { class: 'sic' }, icon('pin', 18)), 'Choose on map'));
    if (q.length >= 2 && !hits.length) items.splice(1, 0, h('li', { class: 'empty' }, `No place called “${q}” in Delhi. Try a nearby metro station or market.`));
    clear(list, items);
    list.hidden = false;
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => { input.select(); render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const opts = list.querySelectorAll('li[role=option]'); (opts[input.value.length >= 2 && opts.length > 2 ? 1 : 0] as HTMLElement | undefined)?.click(); }
    if (e.key === 'Escape') list.hidden = true;
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 200));
  return h('div', { class: `field field-${which}` }, h('span', { class: `dot dot-${which}`, 'aria-hidden': 'true' }), input, list);
}

function renderDirectionsTop() {
  const st = S.settings;
  const timeInput = h('input', { type: 'time', class: 'time-input', 'aria-label': 'Leave at', value: S.leaveAt ? isoClock(S.leaveAt) : '' });
  timeInput.addEventListener('change', () => { S.leaveAt = timeInput.value ? timeToday(timeInput.value) : null; applyTheme(); refreshPois(); openDirections(); });
  const who = h('select', { class: 'who-select', 'aria-label': 'Who is travelling', id: 'who' },
    ([['woman', 'Woman'], ['child', 'Child'], ['general', 'Anyone']] as [Profile, string][]).map(([v, l]) => h('option', { value: v, selected: st.profile === v }, l)));
  who.addEventListener('change', () => { S.settings = save({ profile: who.value as Profile }); openDirections(); });
  clear(top,
    h('div', { class: 'dir-panel' },
      h('div', { class: 'dir-fields' },
        h('button', { class: 'back', 'aria-label': 'Close directions', on: { click: () => { if (S.to) showPlace(S.to, false); else goHome(); } } }, icon('back', 24)),
        h('div', { class: 'fields' }, placeField('from'), placeField('to')),
        h('button', { class: 'swap', 'aria-label': 'Swap start and destination', id: 'swap', on: { click: () => swapEnds() } }, icon('swap', 20))),
      h('div', { class: 'modes', role: 'tablist', 'aria-label': 'How are you travelling' },
        MODES.map((m) => {
          const t = S.modeTimes[m];
          return h('button', { class: `mode-tab${m === st.mode ? ' on' : ''}`, role: 'tab', 'aria-selected': m === st.mode ? 'true' : 'false', 'data-mode': m,
            on: { click: () => { if (m === S.settings.mode) return; S.settings = save({ mode: m }); S.userPicked = false; openDirections(); } } },
          icon(m, 20), h('span', { class: 'sr-only' }, `${MODE_INFO[m].label} `), h('small', null, t ? fmtDuration(t) : t === null ? '—' : ''));
        })),
      h('div', { class: 'dir-opts' }, who,
        h('button', { class: `chip mini${S.leaveAt ? '' : ' on'}`, on: { click: () => { S.leaveAt = null; applyTheme(); refreshPois(); openDirections(); } } }, 'Leave now'),
        h('label', { class: `chip mini time${S.leaveAt ? ' on' : ''}` }, 'at ', timeInput)),
    ),
  );
}

function swapEnds() {
  const a = S.from ?? (myLonLat() ? { lonlat: myLonLat()!, label: 'Your location', mine: true } : null);
  const b = S.to;
  S.to = a; S.from = b?.mine ? null : b;
  S.userPicked = false;
  openDirections();
}

function isoClock(d: Date): string {
  const m = istTime(d).minutes;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function openDirections() {
  if (S.view !== 'directions') setView('directions');
  smap.setPlacePin(); smap.setHits([]);
  renderDirectionsTop();
  planRoutes();
}

let planSeq = 0;
async function planRoutes(opts: { quiet?: boolean } = {}) {
  const from = fromLonLat();
  const to = S.to?.lonlat;
  smap.setEndpoints(S.from ? from ?? undefined : undefined, to);
  if (!to || !from) {
    S.reply = null;
    smap.clearRoutes();
    clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'pad' },
      !to ? h('p', { class: 'hint' }, 'Where do you want to go? Search above, or ', h('button', { class: 'linkish', on: { click: () => startPick('to') } }, 'choose on the map'), '.')
        : [h('h3', null, 'Where are you starting from?'),
          h('p', null, S.loc.status === 'denied' ? 'Location is off, so we do not know where you are.' : S.loc.status === 'asking' || S.loc.status === 'idle' ? 'Finding your location…' : 'GPS is not available right now.'),
          h('div', { class: 'row2' },
            h('button', { class: 'btn primary', id: 'pick-start', on: { click: () => startPick('from') } }, icon('pin', 18), 'Choose start on map'),
            h('button', { class: 'btn', on: { click: () => (document.getElementById('f-from') as HTMLInputElement | null)?.focus() } }, 'Search start'))]));
    return;
  }
  if (!inCoverage(from) || !inCoverage(to)) { toast('Both points must be inside Delhi NCT for now.'); return; }
  const seq = ++planSeq;
  if (!opts.quiet) clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'loading small' }, h('div', { class: 'spinner' }), h('p', null, 'Checking which streets are busy and open right now…')));
  applyTheme();
  const when = now().toISOString();
  rpc<{ times: Partial<Record<Mode, number | null>> }>({ type: 'modeTimes', from, to, when, profile: S.settings.profile })
    .then((r) => { if (seq === planSeq && (S.view === 'directions' || S.view === 'details')) { S.modeTimes = r.times; updateModeTimes(); } }).catch(() => {});
  let reply: RouteReply;
  try {
    reply = (await rpc<{ reply: RouteReply }>({ type: 'route', from, to, mode: S.settings.mode, when, profile: S.settings.profile, pm25: S.air?.pm25 ?? null })).reply;
  } catch (err) {
    if (seq !== planSeq) return;
    S.reply = null;
    clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'pad' }, h('p', { class: 'error' }, 'Routing failed: ' + (err as Error).message)));
    return;
  }
  if (seq !== planSeq || (S.view !== 'directions' && S.view !== 'details')) return;
  const prevLabel = S.reply?.routes[S.selected]?.labels[0];
  S.reply = reply;
  // the fastest route is shown first; the user decides
  if (S.userPicked && prevLabel) S.selected = Math.max(0, reply.routes.findIndex((r) => r.labels[0] === prevLabel));
  else S.selected = 0;
  if (S.view === 'details') showDetails(); else renderRoutes();
  if (!opts.quiet && reply.routes.length) smap.fit(reply.routes.flatMap((x) => x.coords), fitPad());
}

function updateModeTimes() {
  for (const b of top.querySelectorAll<HTMLButtonElement>('.mode-tab')) {
    const m = b.dataset.mode as Mode;
    const t = S.modeTimes[m];
    b.querySelector('small')!.textContent = t ? fmtDuration(t) : t === null ? '—' : '';
  }
}

function mapPad() {
  const th = top.getBoundingClientRect().height, sh = sheet.getBoundingClientRect().height;
  return wide() ? { top: 40, bottom: 40, left: 440, right: 80 } : { top: th + 10, bottom: Math.min(sh, window.innerHeight * 0.6) + 10, left: 10, right: 10 };
}
function fitPad() {
  const th = top.getBoundingClientRect().height;
  const sh = Math.max(sheet.getBoundingClientRect().height, window.innerHeight * 0.38);
  return wide() ? { top: 70, bottom: 60, left: 450, right: 90 } : { top: th + 30, bottom: Math.min(sh, window.innerHeight * 0.52) + 20, left: 36, right: 76 };
}

function selectRoute(i: number, fromMap = false) {
  if (!S.reply || (S.view !== 'directions' && S.view !== 'details')) return;
  S.selected = i;
  S.userPicked = true;
  if (S.view === 'details') showDetails(); else renderRoutes();
  if (fromMap) (sheet.querySelector('.route-card.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function tierBadge(r: { tier: Tier }) {
  const t = TIER_INFO[r.tier];
  return h('span', { class: `tier tier-${r.tier}` }, tierSvg(r.tier, 13), t.label);
}

function renderRoutes() {
  const R = S.reply!;
  smap.showRoutes(R.routes, S.selected, { callouts: true, onSelect: (i) => selectRoute(i, true) });
  const adv = R.advice;
  const vehicleNote = S.settings.mode !== 'walk' && !S.onewayKnown;
  const sel = R.routes[S.selected];
  clear(sheet,
    h('div', { class: 'grip' }),
    R.error ? h('div', { class: 'pad' }, h('p', { class: 'error' }, R.error)) : null,
    adv && adv.level !== 'ok' ? h('div', { class: `advice advice-${adv.level}` },
      h('strong', null, adv.title), h('p', null, adv.body),
      adv.suggestMode ? h('button', { class: 'btn small', on: { click: () => { S.settings = save({ mode: adv.suggestMode! }); S.userPicked = false; openDirections(); } } },
        `Show ${MODE_INFO[adv.suggestMode].label.toLowerCase()} routes`) : null) : null,
    R.routes.length ? h('p', { class: 'decide' }, `${R.routes.length} route${R.routes.length > 1 ? 's' : ''}, fastest first. The colour shows how safe each is at ${clockText(now())}. You choose.`) : null,
    R.routes.length > 1 ? priorityPicker(R.routes, S.selected, (i) => selectRoute(i)) : null,
    h('ol', { class: 'route-list', 'aria-label': 'Routes, fastest first' },
      R.routes.map((r, i) => {
        const on = i === S.selected;
        return h('li', null, h('button', {
          class: `route-card${on ? ' sel' : ''}`, 'aria-pressed': on ? 'true' : 'false', 'data-tier': r.tier,
          on: { click: () => { if (S.selected === i) showDetails(); else selectRoute(i); } },
        },
        h('span', { class: 'swatch', style: { background: TIER_INFO[r.tier].color } }),
        h('span', { class: 'rc-body' },
          h('span', { class: 'rc-top' },
            h('span', { class: 'rc-time' }, fmtDuration(r.timeS)),
            h('span', { class: 'rc-sub' }, fmtDist(r.lengthM)),
            r.labels.filter((l) => l !== 'Also safest' && l !== 'Alternative' && l !== 'Also cleanest').map((l) => h('span', { class: `lbl lbl-${l.toLowerCase().replace(/\s+/g, '-')}` }, l === 'Cleanest air' ? [icon('leaf', 12), l] : l)),
            h('span', { class: 'rc-badge' }, tierBadge(r))),
          h('span', { class: `rc-prec prec-${r.tier}` }, icon(r.tier === 'green' ? 'police' : 'alert', 15), r.precautions.headline),
          airLine(r),
          on && r.precautions.items.length && r.tier !== 'green'
            ? h('span', { class: 'rc-items' }, r.precautions.items.slice(0, 2).map((t) => h('span', null, '• ', t))) : null)));
      })),
    R.note ? h('p', { class: 'note' }, R.note) : null,
    R.routes.some((x) => x.labels.includes('Also cleanest')) && R.routes.length > 1
      ? h('p', { class: 'note air-note' }, icon('leaf', 14), 'The fastest route is also the cleanest air here: less time outside beats a detour.') : null,
    vehicleNote ? h('p', { class: 'note' }, 'One-way streets are not in this map yet. Follow road signs.') : null,
    sel ? h('div', { class: 'actions sticky' },
      h('button', { class: 'btn', id: 'details-btn', on: { click: () => showDetails() } }, 'Precautions'),
      h('button', { class: 'btn primary', id: 'start', on: { click: () => startJourney() } }, icon('navigate', 18), 'Start')) : null,
  );
}

/** What Saans needs to know about the selected route. */
function routeSummary(): RouteSummary | null {
  const r = S.reply?.routes[S.selected];
  if (!r?.air || !['directions', 'details'].includes(S.view)) return null;
  return { mode: MODE_INFO[S.settings.mode].label.toLowerCase(), minutes: Math.round(r.timeS / 60), label: r.labels[0] ?? 'Selected',
    pctLess: r.air.pctVsFastest, avoided: r.air.avoided, areas: r.air.areas };
}

/** Live air for where the user is (or the map centre), refreshed every 30 min. */
async function refreshAir(): Promise<AirNow | null> {
  const p = myLonLat() ?? (smap ? [smap.map.getCenter().lng, smap.map.getCenter().lat] as LonLat : null);
  if (!p) return S.air;
  const v = await airAt(p, { server: isOnline() });
  if (v) { S.air = v; if (S.view === 'home') renderHome(); }
  return S.air;
}
/** Saans is loaded on first use (its own chunk), so the map opens faster. */
async function askSaans(ask?: string) {
  const { openSaans, closeSaans } = await import('./saans.ts');
  openSaans({
    air: refreshAir, route: routeSummary, online: async () => isOnline() || checkServer(),
    // looked up on the phone; the position itself never leaves it
    near: (it) => { const me = myLonLat(); return me && placesReady() ? nearbyFor(it, me, now(), { min: 5, max: 7 }) : me ? [] : null; },
    go: (p) => { closeSaans(); S.from = null; S.to = browsePlace(p); S.userPicked = false; S.reply = null; openDirections(); },
  }, { ask });
}

function havenLine(r: WorkerRoute): string {
  const parts: string[] = [];
  const order: PoiCat[] = ['police', 'hospital', 'pharmacy', 'station', 'fuel', 'shop', 'food'];
  const NOUN: Partial<Record<PoiCat, [string, string]>> = {
    police: ['police post', 'police posts'], hospital: ['hospital', 'hospitals'], pharmacy: ['medical store', 'medical stores'],
    station: ['metro/rail station', 'metro/rail stations'], fuel: ['petrol pump', 'petrol pumps'], shop: ['shop', 'shops'], food: ['eatery', 'eateries'],
  };
  for (const c of order) { const n = r.havens[c]; if (n) parts.push(`${n} ${NOUN[c]![n > 1 ? 1 : 0]}`); }
  return parts.length ? `Open on the way: ${parts.slice(0, 3).join(', ')}` : 'Few places open on the way';
}

// ---------- details ----------
function showDetails() {
  if (!S.reply?.routes.length) return;
  setView('details');
  const r = S.reply.routes[S.selected];
  smap.showRoutes(S.reply.routes, S.selected, { callouts: true, onSelect: (i) => selectRoute(i, true) });
  const contacts = S.settings.contacts;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const dark = darkness(now()) >= 0.5;
  clear(sheet,
    h('div', { class: 'grip' }),
    h('div', { class: 'summary' }, h('button', { class: 'back', 'aria-label': 'Back to routes', on: { click: () => { setView('directions'); renderRoutes(); } } }, icon('back', 24)),
      h('div', { class: 'summary-text' }, h('div', { class: 'big-time' }, fmtDuration(r.timeS), ' ', tierBadge(r)),
        h('div', { class: 'meta' }, `${fmtDist(r.lengthM)} by ${MODE_INFO[S.settings.mode].label.toLowerCase()}, arrive about ${clockText(new Date(now().getTime() + r.timeS * 1000))}`))),
    h('div', { class: 'pad' },
      h('div', { class: `prec-box prec-${r.tier}` },
        h('h3', null, r.tier === 'green' ? 'Precautions' : 'Precautions for this route'),
        h('p', { class: 'prec-head' }, r.precautions.headline),
        r.precautions.items.length ? h('ul', { class: 'prec-list' }, r.precautions.items.map((t) => h('li', null, t))) : null),
      h('h3', null, 'Why this colour'),
      h('ul', { class: 'facts' },
        h('li', null, h('b', null, pct(r.mainRoadShare)), ' on main roads'),
        dark ? h('li', null, h('b', null, pct(r.litShare)), ' on roads that are usually lit') : null,
        h('li', null, h('b', null, pct(r.policeShare)), ' within 500 m of a police station'),
        h('li', null, h('b', null, String(r.havenIds.length)), ` places open along the way at ${clockText(now())}`),
        h('li', null, havenLine(r))),
      airSection(r, S.reply.routes, S.air?.pm25 ?? null, clockText(now()), () => askSaans('How clean is the air on this route, and how can I breathe less on the way?')),
      r.dangerSpots.length ? [h('h3', null, 'Risky stretches'), h('ul', { class: 'spots' }, r.dangerSpots.map((d) =>
        h('li', null, h('button', { class: 'linkish', on: { click: () => smap.map.flyTo({ center: [d.lon, d.lat], zoom: 16.5 }) } },
          h('span', { class: 'warn-ic' }, '!'), `${fmtDist(d.lengthM)}${d.street ? ' on ' + d.street : ''}: ${d.reasons.join(', ') || 'quiet at this hour'}`))))] : null,
      r.havenList.length ? [h('h3', null, 'Safe places open on the way'), h('ul', { class: 'havens' }, r.havenList.slice(0, 8).map((p) =>
        h('li', null, h('span', { class: `pi cat-${p.cat}` }, icon(placeIcon(p.cat), 16)), h('span', null, p.name || CAT_INFO[p.cat].label),
          h('small', null, p.verified ? 'open now' : 'open now (estimated hours)'))))] : null,
      h('h3', null, 'Tell when I reach'),
      h('p', { class: 'fine lockline' }, icon('lock', 14), 'Your location stays on your phone. During the trip it is shared only for your live link and deleted when you arrive.'),
      contacts.length ? h('div', { class: 'chips' }, contacts.map((c) => h('button', {
        class: `chip${c.notify ? ' on' : ''}`, 'aria-pressed': c.notify ? 'true' : 'false',
        on: { click: () => { c.notify = !c.notify; S.settings = save({ contacts }); showDetails(); } },
      }, c.notify ? icon('check', 15, 2.4) : null, c.name)), h('button', { class: 'chip', on: { click: () => showContacts() } }, '+ Add')) :
        h('p', null, h('button', { class: 'linkish', on: { click: () => showContacts() } }, 'Add a trusted contact'), ' to send an arrival message.'),
      h('details', { class: 'steps' }, h('summary', null, 'Turn-by-turn directions'),
        h('ol', null, r.steps.map((s) => h('li', null, s.text, s.distM ? h('small', null, ` ${fmtDist(s.distM)}`) : null)))),
      h('p', { class: 'fine' }, 'Scores describe the street environment at this hour (open places, police, busy roads, lighting, parks, live reports and traveller reviews). They help you choose; they cannot guarantee safety.'),
    ),
    h('div', { class: 'actions sticky' }, h('button', { class: 'btn primary wide', id: 'start', on: { click: () => startJourney() } }, icon('navigate', 18), 'Start journey')),
  );
}

// ---------- live layers ----------
let safetySeq = 0;
async function refreshSafety() {
  if (!smap || !S.settings.layers.safety || smap.map.getZoom() < 13.5) return;
  const b = smap.map.getBounds();
  const seq = ++safetySeq;
  const r = await rpc<{ fc: any }>({ type: 'safetyLines', bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], when: now().toISOString(), profile: S.settings.profile, limit: 6000 });
  if (seq === safetySeq) smap.setSafety(r.fc);
}

let airSeq = 0;
async function refreshAirLayer() {
  if (!smap || !S.settings.layers.air || smap.map.getZoom() < 12.5) return;
  const b = smap.map.getBounds();
  const seq = ++airSeq;
  const r = await rpc<{ fc: any }>({ type: 'airLines', bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], limit: 6000 });
  if (seq === airSeq) smap.setAir(r.fc);
}

async function refreshReports(force = false) {
  if (!liveAvailable() || (!force && Date.now() - S.reportsAt < 20000)) return;
  try {
    const r = await live.list(S.bbox);
    S.reportsAt = Date.now();
    const changed = JSON.stringify(r.reports.map((x) => [x.id, x.confirms, x.dismisses])) !== JSON.stringify(S.reports.map((x) => [x.id, x.confirms, x.dismisses]));
    S.reports = r.reports;
    drawReports();
    if (!changed) return;
    await rpc({ type: 'reports', reports: r.reports, now: r.now });
    refreshSafety();
    if (S.view === 'directions' && S.reply) planRoutes({ quiet: true });
    if (S.view === 'home') renderHome();
  } catch { /* live reports are optional */ }
}

function drawReports() {
  const list = S.settings.layers.reports ? S.reports : [];
  smap.setReports(list.map((r) => ({ id: r.id, lon: r.lon, lat: r.lat, icon: REPORT_ICON[r.kind] ?? 'alert', label: REPORT_KINDS[r.kind]?.label ?? r.kind, danger: REPORT_KINDS[r.kind]?.danger ?? true, air: REPORT_KINDS[r.kind] ? isAirReport(r.kind) : false })),
    (id) => openReportPopup(id));
}

function ago(ms: number) { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; }

function openReportPopup(id: string) {
  const r = S.reports.find((x) => x.id === id);
  if (!r) return;
  const k = REPORT_KINDS[r.kind];
  const box = h('div', { class: 'rp' },
    h('b', { class: 'rp-title' }, icon(REPORT_ICON[r.kind] ?? 'alert', 18), k.label),
    h('div', { class: 'meta' }, `Reported ${ago(Date.now() - r.createdAt)} · ${r.confirms} confirmed${r.dismisses ? ` · ${r.dismisses} said gone` : ''}`),
    h('div', { class: 'meta' }, 'Is it still there?'),
    h('div', { class: 'row2' },
      h('button', { class: 'btn small', on: { click: () => vote(true) } }, 'Still there'),
      h('button', { class: 'btn small ghost', on: { click: () => vote(false) } }, 'Gone')));
  const pop = smap.popup([r.lon, r.lat], box);
  async function vote(still: boolean) {
    const me = myLonLat();
    if (!me) { toast('We need your location to confirm reports near you.'); return; }
    try {
      await live.vote(id, still, { lon: me[0], lat: me[1], acc: myAcc() });
      pop.remove();
      toast(still ? 'Thanks, confirmed.' : 'Thanks. It will disappear if others agree.');
      refreshReports(true);
    } catch (err) { toast((err as Error).message); }
  }
}

function openReport() {
  const me = S.journey && S.myPos ? [S.myPos.lon, S.myPos.lat] as LonLat : myLonLat();
  if (!liveAvailable()) { toast('Live reports need an internet connection.', 5000); return; }
  if (!me) {
    openModal(h('div', { class: 'modal-card' }, h('h2', null, 'Report a problem here'),
      h('p', null, 'You can only report what is happening near you, so we need your location.'),
      h('button', { class: 'btn primary wide', on: { click: () => { closeModal(); startPick('me'); } } }, 'Mark where I am on the map'),
      h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Cancel')));
    return;
  }
  const send = async (kind: ReportKind) => {
    try {
      const r = await live.report(kind, me, { lon: me[0], lat: me[1], acc: S.journey ? S.myPos!.acc : myAcc() });
      closeModal();
      toast(r.merged ? 'Thanks. Someone reported this too, so it now counts more.' : `Thanks. Others will see this for about ${REPORT_KINDS[kind].hours} h, and ${isAirReport(kind) ? 'clean-air routes' : 'routes'} will avoid it.`, 5000);
      refreshReports(true);
    } catch (err) { toast((err as Error).message, 5000); }
  };
  const kindBtn = (k: ReportKind) => h('button', { class: `report-kind${isAirReport(k) ? ' air' : REPORT_KINDS[k].danger ? '' : ' good'}`, 'data-kind': k, on: { click: () => send(k) } },
    h('span', { class: 'rk-ic' }, icon(REPORT_ICON[k], 24)), REPORT_KINDS[k].label);
  openModal(h('div', { class: 'modal-card' },
    h('h2', null, 'What is happening here?'),
    h('p', { class: 'fine' }, 'Your report is anonymous and expires in a few hours. Routes for everyone avoid this spot until then.'),
    h('h3', { class: 'rk-group' }, 'Safety'),
    h('div', { class: 'report-grid' }, (Object.keys(REPORT_KINDS) as ReportKind[]).filter((k) => !isAirReport(k)).map((k) => kindBtn(k))),
    h('h3', { class: 'rk-group' }, 'Air'),
    h('div', { class: 'report-grid' }, (Object.keys(REPORT_KINDS) as ReportKind[]).filter((k) => isAirReport(k)).map((k) => kindBtn(k))),
    h('p', { class: 'fine' }, 'In danger right now? Use SOS or call 112.'),
    h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Cancel')));
}

function openLayers() {
  const L = S.settings.layers;
  const toggle = (k: keyof typeof L, label: string, note: string) => h('label', { class: 'layer-row' },
    h('input', { type: 'checkbox', checked: L[k], 'data-layer': k, on: { change: (e: Event) => {
      const on = (e.target as HTMLInputElement).checked;
      S.settings = save({ layers: { ...S.settings.layers, [k]: on } });
      if (k === 'reports') drawReports(); else smap.setLayerVisible(k, on);
      if (k === 'safety' && on) refreshSafety();
      if (k === 'air') { smap.setLayerVisible('air', on); if (on) refreshAirLayer(); }
    } } }),
    h('span', null, h('b', null, label), h('small', null, note)));
  openModal(h('div', { class: 'modal-card' },
    h('h2', null, 'Map layers'),
    toggle('safety', 'Street safety now', 'Every street coloured by how safe it is at this hour (zoom in to see).'),
    h('div', { class: 'legend' }, (['green', 'yellow', 'red', 'darkred'] as Tier[]).map((t) => h('span', null, h('i', { style: { background: TIER_INFO[t].color } }), TIER_INFO[t].label))),
    toggle('air', 'Street air (estimate)', 'Streets coloured by how polluted the air usually is there: busy roads, industrial areas and landfills are darker.'),
    h('div', { class: 'legend air-legend' }, [['#2fbf9b', 'Cleaner'], ['#c9c446', 'Some traffic'], ['#ff9f0a', 'Busy road'], ['#d9480f', 'Industry'], ['#7b2cbf', 'Landfill / worst']].map(([c, l]) => h('span', null, h('i', { style: { background: c } }), l))),
    toggle('reports', 'Live reports', liveAvailable() ? `Problems other travellers reported in the last few hours${livePreview() ? ' (shared by everyone using this preview)' : ''}.` : 'Needs an internet connection.'),
    toggle('pois', 'Safe places', 'Police, hospitals, medical stores, metro and petrol pumps. Filled = open now.'),
    hasTraffic() ? toggle('traffic', 'Traffic', 'Live traffic speed on roads.') : null,
    h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Done')));
}

function openMenu() {
  openModal(h('div', { class: 'modal-card menu' },
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), 'SafeRaah'),
    h('button', { class: 'menu-row', id: 'menu-saans', on: { click: () => { closeModal(); askSaans(); } } }, h('span', { class: 'mi' }, icon('sparkle', 18)), 'Saans: clean-air assistant'),
    h('button', { class: 'menu-row', on: { click: () => { closeModal(); showCategory('safe'); } } }, h('span', { class: 'mi' }, icon('police', 18)), 'Safe places near me'),
    h('button', { class: 'menu-row', on: { click: () => { closeModal(); showContacts(); } } }, h('span', { class: 'mi' }, icon('contacts', 18)), 'Trusted contacts & settings'),
    h('button', { class: 'menu-row', on: { click: () => { closeModal(); openLayers(); } } }, h('span', { class: 'mi' }, icon('layers', 18)), 'Map layers'),
    h('button', { class: 'menu-row', on: { click: () => { closeModal(); showHelp(); } } }, h('span', { class: 'mi' }, icon('help', 18)), 'How to use SafeRaah'),
    h('a', { class: 'menu-row danger', href: telLink('112') }, h('span', { class: 'mi' }, icon('phone', 18)), 'Call 112 (emergency)'),
    h('a', { class: 'menu-row', href: telLink('1091') }, h('span', { class: 'mi' }, icon('phone', 18)), 'Women helpline 1091'),
    h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Close')));
}

// ---------- contacts & settings ----------
function showContacts() {
  const prev = S.view === 'contacts' ? 'home' : S.view;
  setView('contacts');
  clear(top);
  const st = S.settings;
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. Maa', 'aria-label': 'Contact name', maxlength: 30 });
  const phone = h('input', { type: 'tel', placeholder: 'Mobile, e.g. 98765 43210', 'aria-label': 'Contact mobile number', inputmode: 'tel' });
  const err = h('p', { class: 'error', hidden: true });
  const add = () => {
    const p = normalisePhone(phone.value);
    if (!name.value.trim()) { err.textContent = 'Enter a name.'; err.hidden = false; return; }
    if (!p) { err.textContent = 'Enter a valid mobile number (10 digits, or with +country code).'; err.hidden = false; return; }
    if (st.contacts.length >= 5) { err.textContent = 'You can save up to 5 contacts.'; err.hidden = false; return; }
    if (st.contacts.some((c) => c.phone === p)) { err.textContent = 'This number is already saved.'; err.hidden = false; return; }
    const c: Contact = { id: crypto.randomUUID(), name: name.value.trim(), phone: p, notify: true };
    S.settings = save({ contacts: [...st.contacts, c] });
    S.view = prev; showContacts();
  };
  const travName = h('input', { type: 'text', value: st.travellerName, placeholder: 'Your name (shown in messages)', 'aria-label': 'Your name', maxlength: 30 });
  travName.addEventListener('change', () => { S.settings = save({ travellerName: travName.value.trim() }); toast('Saved'); });
  clear(sheet,
    h('div', { class: 'summary' }, h('button', { class: 'back', 'aria-label': 'Back', on: { click: () => goBack(prev) } }, icon('back', 24)), h('h2', null, 'Contacts and settings')),
    h('div', { class: 'pad' },
      h('h3', null, 'Your name'), travName,
      h('h3', null, 'Trusted contacts'),
      st.contacts.length ? h('ul', { class: 'contacts' }, st.contacts.map((c) => h('li', null,
        h('div', null, h('b', null, c.name), h('small', null, c.phone)),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: c.notify, 'aria-label': `Send arrival message to ${c.name}`,
          on: { change: (e: Event) => { c.notify = (e.target as HTMLInputElement).checked; S.settings = save({ contacts: st.contacts }); } } }), 'Arrival message'),
        h('button', { class: 'icon-btn flat', 'aria-label': `Remove ${c.name}`, on: { click: () => { S.settings = save({ contacts: st.contacts.filter((x) => x.id !== c.id) }); S.view = prev; showContacts(); } } }, icon('close', 16))))) :
        h('p', { class: 'hint' }, 'Add up to 5 people who should know when you reach, and who get your SOS.'),
      h('div', { class: 'add-contact' }, name, phone, h('button', { class: 'btn primary', id: 'add-contact', on: { click: add } }, 'Add contact')), err,
      h('p', { class: 'fine' }, 'Contacts stay on this phone. Messages are sent from your own phone by SMS or WhatsApp.'),
      h('h3', null, 'Your privacy'),
      h('ul', { class: 'privacy' },
        h('li', null, 'Your location stays on this phone. Planning routes and guidance work without sending it anywhere.'),
        h('li', null, 'Only during a trip, and only to show your family the live link and to check you really reached, your position goes to the SafeRaah server. It is deleted the moment the trip ends.'),
        h('li', null, 'The two questions after a trip are optional and anonymous; no trip, route or comment is kept with your answer.'),
        h('li', null, 'Contacts and settings are kept only on this phone.')),
      h('button', { class: 'btn ghost wide', id: 'wipe', on: { click: () => {
        openModal(h('div', { class: 'modal-card' }, h('h2', null, 'Delete everything on this phone?'),
          h('p', null, 'Removes your contacts, name, family profile and settings from SafeRaah on this phone.'),
          h('div', { class: 'row2' }, h('button', { class: 'btn ghost', on: { click: () => closeModal() } }, 'Cancel'),
            h('button', { class: 'btn danger', id: 'wipe-ok', on: { click: () => {
              try { for (const k of Object.keys(localStorage)) if (k.startsWith('saferaah')) localStorage.removeItem(k); } catch { /* storage blocked */ }
              location.reload();
            } } }, 'Delete'))));
      } } }, 'Delete my data on this phone'),
      h('h3', null, 'Voice guidance'),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', id: 'voice-setting', checked: st.voice, on: { change: (e: Event) => { S.settings = save({ voice: (e.target as HTMLInputElement).checked }); } } }),
        'Speak the turns during a journey'),
      h('h3', null, 'Demo mode'),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: st.simulate, on: { change: (e: Event) => { S.settings = save({ simulate: (e.target as HTMLInputElement).checked }); } } }),
        'Simulate my movement (to try the app without walking)'),
    ),
  );
}

function goBack(prev: View) {
  if (prev === 'details' && S.reply) { setView('directions'); renderDirectionsTop(); showDetails(); }
  else if (prev === 'directions') { setView('directions'); renderDirectionsTop(); if (S.reply) renderRoutes(); else planRoutes(); }
  else if (prev === 'journey' && S.journey) { setView('journey'); renderJourney(); }
  else if (prev === 'arrived' && S.journey) { setView('arrived'); renderArrived(arrivalText(S.settings.travellerName, S.journey.dest.label, clockText(new Date())), 0); }
  else if (prev === 'place' && S.place) showPlace(S.place, false);
  else goHome();
}

// ---------- help ----------
const GUIDES = [
  ['plan', 'Find a place', 'Your blue dot shows where you are. Search, tap any spot on the map, or tap Police, Hospitals or Medical stores.'],
  ['routes', 'Choose a route', 'Tap Directions. The fastest route is picked first; the colours show how safe each one is now, with the precautions it needs. You decide.'],
  ['journey', 'Start the journey', 'Pick who gets your arrival message, then tap Start. The map follows you and finds a new safe route if you take a different turn.'],
  ['checkin', 'If you stop too long', 'We ask if you are OK. No answer in 30 seconds opens SOS.'],
  ['sos', 'SOS', 'One tap: call 112, or send your location to your contacts.'],
  ['review', 'Arrive and review', 'Your contacts get the arrival message. Rate how safe the streets felt.'],
];
function showHelp() {
  const prev = S.view === 'help' ? 'home' : S.view;
  setView('help');
  clear(top);
  clear(sheet, h('div', { class: 'summary' }, h('button', { class: 'back', 'aria-label': 'Back', on: { click: () => goBack(prev) } }, icon('back', 24)), h('h2', null, 'How to use SafeRaah')),
    h('div', { class: 'pad guides' }, GUIDES.map(([k, title, text]) => h('figure', { class: 'guide' },
      h('img', { src: `${BASE}help/${k}.gif`, alt: `Animation: ${title}`, loading: 'lazy', width: 240, height: 520,
        on: { error: (e: Event) => ((e.target as HTMLElement).style.display = 'none') } }),
      h('figcaption', null, h('b', null, title), h('span', null, text)))),
    h('h3', null, 'Live on the map'),
    h('p', null, 'Report: tell others about a dark street, harassment, a drunk group or someone following people. Reports expire in a few hours and routes avoid them. Layers: colour every street by how safe it is right now.'),
    h('h3', null, 'Helplines'), h('ul', { class: 'helplines' }, HELPLINES.map((x) => h('li', null, h('a', { href: telLink(x.n) }, x.n), ` ${x.label}`))),
    h('h3', null, 'How the colours are worked out'),
    h('p', null, 'Every street gets a score for the time you travel: are places like police stations, hospitals, medical stores and shops open nearby, is the road busy, is it usually lit, does it run through a park or empty land, what travellers reported in the last few hours, and what verified travellers said about it. Routes are coloured by their real score, so in daytime all routes can be green.'),
    h('p', { class: 'fine' }, 'Some areas of Delhi have fewer shops and places mapped on OpenStreetMap, so "nothing open nearby" there can partly mean "nothing mapped yet". Your reviews help correct this.'),
    h('p', { class: 'fine' }, `Map data © OpenStreetMap contributors (ODbL) via OpenMapTiles, snapshot ${S.snapshot || '31 Oct 2026'}. Covers all of Delhi NCT, including New Delhi, with the bordering edges of Gurugram, Faridabad, Noida and Ghaziabad.`)));
}

/** The route-that-turns-safe drawing on the welcome screen (the one big motion moment). */
function heroArt(): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="hero" viewBox="0 0 320 150" role="img" aria-label="A route turning from red to green">
    <defs><linearGradient id="hg" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#ff3b30"/><stop offset=".45" stop-color="#ff9f0a"/><stop offset="1" stop-color="#30b158"/></linearGradient></defs>
    <path d="M40 124 C 90 124, 92 70, 140 76 S 196 120, 226 92 S 250 52, 268 50" fill="none" stroke="currentColor" stroke-opacity=".08" stroke-width="16" stroke-linecap="round"/>
    <path class="road" d="M40 124 C 90 124, 92 70, 140 76 S 196 120, 226 92 S 250 52, 268 50" fill="none" stroke="url(#hg)" stroke-width="7" stroke-linecap="round"/>
    <circle class="start-dot" cx="40" cy="124" r="9" fill="#0a84ff" stroke="#fff" stroke-width="3"/>
    <g class="end-pin"><path d="M268 50 c-9 0 -15 -7 -15 -15 c0 -10 15 -24 15 -24 s15 14 15 24 c0 8 -6 15 -15 15z" fill="#30b158" stroke="#fff" stroke-width="2.5"/>
      <circle cx="268" cy="35" r="4.5" fill="#fff"/></g></svg>`;
  const wrap = h('div', null);
  wrap.appendChild(t.content.firstElementChild!);
  return wrap;
}

function showIntro() {
  const feat = (ic: string, title: string, text: string) =>
    h('div', { class: 'feat' }, h('span', { class: 'mi' }, icon(ic, 20)), h('div', null, h('b', null, title), h('span', null, text)));
  openModal(h('div', { class: 'modal-card intro' },
    heroArt(),
    h('h2', null, 'Reach home safely.'),
    h('p', { class: 'lead' }, 'A map of Delhi that shows how safe each route is right now — and lets you choose.'),
    feat('navigate', 'Fastest first, safer options beside it', 'Every route shows its colour and the precautions it needs.'),
    feat('voice', 'Spoken turns and a live link', 'Family can follow your trip and get a message when you reach.'),
    feat('lock', 'Your location stays on your phone', 'Trip data is deleted the moment you arrive.'),
    h('button', { class: 'btn primary wide', id: 'intro-contact', on: { click: () => { save({ seenIntro: true }); closeModal(); showContacts(); } } }, 'Add a trusted contact'),
    h('button', { class: 'btn ghost wide', on: { click: () => { save({ seenIntro: true }); closeModal(); } } }, 'Not now'),
  ));
}

// ---------- live trip viewer (for contacts) ----------
async function showTrack(shareId: string) {
  setView('track');
  clear(top);
  let first = true;
  const draw = async () => {
    let d: any;
    try { d = await api.share(shareId); } catch (err) {
      clear(sheet, h('div', { class: 'pad' }, h('h2', null, 'Trip not available'), h('p', null, (err as Error).message)));
      return false;
    }
    if (d.route.length > 1) smap.showRoutes([{ coords: d.route, tier: 'green', dangerSpots: [] } as unknown as WorkerRoute], 0);
    else smap.clearRoutes();
    smap.setEndpoints(d.route[0], d.dest ?? undefined);
    if (d.last) smap.setMe([d.last.lon, d.last.lat], d.last.acc ?? 0); else smap.setMe(undefined);
    if (first && d.route.length > 1) { smap.fit(d.route, fitPad()); first = false; }
    const statusText: Record<string, string> = { active: 'On the way', arrived: 'Reached safely', ended: 'Trip ended', sos: 'SOS: needs help now', expired: 'Trip expired' };
    const eta = new Date(d.startedAt + d.etaS * 1000);
    clear(sheet, h('div', { class: 'pad' },
      h('h2', null, `${d.name ? d.name + ': ' : ''}${statusText[d.status] ?? d.status}`),
      d.status === 'sos' ? h('a', { class: 'btn danger wide big', href: telLink('112') }, 'Call 112') : null,
      h('p', null, d.status === 'arrived' ? `Arrived at ${clockText(new Date(d.arrivedAt))}.` : `Expected by ${clockText(eta)}.`),
      d.last ? h('p', { class: 'meta' }, `Last seen ${Math.max(0, Math.round((Date.now() - d.last.t) / 60000))} min ago.`) : h('p', { class: 'meta' }, 'Waiting for the first location…'),
      d.status === 'active' || d.status === 'sos' ? h('p', { class: 'fine' }, 'This page updates every 10 seconds.')
        : h('p', { class: 'fine lockline' }, icon('lock', 14), 'The trip has ended, so its location data has been deleted.')));
    return d.status === 'active' || d.status === 'sos';
  };
  if (await draw()) { const t = setInterval(async () => { if (!(await draw())) clearInterval(t); }, 10000); }
}

// ---------- misc ----------
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && !checkTimer) closeModal(); });
if ('serviceWorker' in navigator && import.meta.env.PROD && !DEMO) {
  navigator.serviceWorker.register(BASE + 'sw.js').then(async () => {
    await navigator.serviceWorker.ready;
    // The first visit loads before the service worker controls the page, so the hashed
    // app bundles, fonts and map worker were never intercepted. Cache them now so the
    // next launch works with no signal at all.
    setTimeout(async () => {
      try {
        const urls = performance.getEntriesByType('resource').map((e) => e.name)
          .filter((u) => u.startsWith(location.origin) && !u.includes('/api/'));
        const c = await caches.open('saferaah-v1');
        await c.addAll([...new Set([new URL(BASE, location.href).href, ...urls])]);
      } catch { /* best effort */ }
    }, 4000);
  }).catch(() => {});
}
// screens other modules can open (see hooks in app.ts)
Object.assign(hooks, { renderFabs, openSos, goHome, openDirections, showContacts, drawMe });
boot();
