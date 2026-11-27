// Your location: the blue dot with accuracy and compass heading, the locate button, and what to do without GPS.
import { h } from './dom.ts';
import { DEMO, DEMO_ME, S, closeModal, myLonLat, openModal, smap, toast } from './app.ts';
import { renderFabs } from './fabs.ts';
import { renderHome } from './home.ts';
import { refreshAir } from './ask.ts';
import { startPick } from './pick.ts';
import { planRoutes } from './routes-panel.ts';

// ---------- your location (blue dot) ----------
export let watchId: number | null = null;
export function startLocating() {
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
    const hd = ev.webkitCompassHeading ?? (ev.absolute && ev.alpha != null ? 360 - ev.alpha : null);
    if (hd == null || S.journey) return;
    S.loc.heading = hd;
    drawMe();
  };
  window.addEventListener('deviceorientationabsolute' as 'deviceorientation', onOrient as EventListener);
  window.addEventListener('deviceorientation', onOrient as EventListener);
}

export function drawMe() {
  const f = S.loc.fix;
  if (f) smap.setMe([f.lon, f.lat], f.acc, S.loc.heading, false);
  else if (S.manualMe) smap.setMe(S.manualMe, 0, null, true);
  else smap.setMe(undefined);
}

export function locate() {
  (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<unknown> })
    .requestPermission?.()
    .catch(() => {});
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

export function explainNoLocation() {
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
