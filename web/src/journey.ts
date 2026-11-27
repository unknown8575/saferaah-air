// Navigation: starting a journey, live guidance and the island, re-routing, check-ins and SOS,
// arrival and the optional two questions afterwards.
import { h, clear } from './dom.ts';
import { save } from './store.ts';
import { api, isOnline, serverSms, type FinishResult, type JourneyHandle } from './api.ts';
import { gpsSource, simulatedSource } from './location.ts';
import { shareUrl, arrivalText, startText, notifyPhones } from './messages.ts';
import type { RouteReply, WorkerRoute } from './worker.ts';
import { WALK_KMH } from '../../shared/modes.ts';
import { JourneyMonitor, type Fix, type JourneyEvent } from '../../shared/journey.ts';
import { Guide, unlockSpeech, prepareNative } from './nav.ts';
import {
  S,
  rpc,
  top,
  smap,
  toast,
  setView,
  clockText,
  TIER_RANK,
  params,
  DEMO,
  hooks,
  type Pref,
  openModal,
  closeModal,
} from './app.ts';
import { checkIn } from './sos.ts';
import { renderArrived } from './arrived.ts';
import { followCamera, headingAlong, renderJourney } from './journey-view.ts';
// ---------- journey ----------
function prefOf(r: WorkerRoute): Pref {
  if (r.labels.includes('Fastest') && !r.labels.includes('Also safest')) return 'fastest';
  if (r.labels.includes('Safest') || r.labels.includes('Also safest')) return 'safest';
  return 'balanced';
}
function pickByPref(routes: WorkerRoute[], pref: Pref): WorkerRoute | undefined {
  if (!routes.length) return undefined;
  if (pref === 'fastest') return routes[0];
  if (pref === 'safest') return routes.reduce((a, b) => (b.meanRisk < a.meanRisk ? b : a));
  return routes.reduce((a, b) => (b.timeS * (1 + 2 * b.meanRisk) < a.timeS * (1 + 2 * a.meanRisk) ? b : a));
}

/** GPS is blocked: offer to try the trip with simulated movement instead. */
function offerSimulation(): void {
  const simulate = () => {
    closeModal();
    S.settings = save({ simulate: true });
    startJourney();
  };
  openModal(
    h(
      'div',
      { class: 'modal-card' },
      h('h2', null, 'Tracking needs your location'),
      h('p', null, 'To guide you and know when you reach, SafeRaah Air needs GPS. Location is blocked here.'),
      h('p', { class: 'fine' }, 'You can try the journey with simulated movement instead.'),
      h('button', { class: 'btn primary wide', on: { click: simulate } }, 'Simulate the trip'),
      h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Cancel'),
    ),
  );
}

/** Register the trip with the server for the live link (optional: guidance works without it). */
async function registerTrip(route: WorkerRoute, sim: boolean): Promise<JourneyHandle | null> {
  if (!isOnline()) return null;
  try {
    return await api.startJourney({
      mode: S.settings.mode,
      route: route.coords,
      edges: route.edges,
      dest: route.coords[route.coords.length - 1],
      etaS: route.timeS,
      graphVersion: S.version,
      name: S.settings.travellerName || undefined,
      simulated: sim,
    });
  } catch (err) {
    toast('Live sharing is unavailable: ' + (err as Error).message);
    return null;
  }
}

/** Real GPS, or movement along the route for demos (?speed=, ?pause= tune it). */
function positionSource(route: WorkerRoute, sim: boolean) {
  if (!sim) return gpsSource();
  const speedMps = S.settings.mode === 'walk' ? WALK_KMH / 3.6 : route.lengthM / route.timeS;
  const pauseAt = params.get('pause')
    ? { atFrac: Number(params.get('pause')), seconds: Number(params.get('pauseS') ?? 300) }
    : undefined;
  return simulatedSource(route.coords, speedMps, Number(params.get('speed') ?? 30), pauseAt);
}

/** Each GPS fix: move the dot and camera, check the trip, look for a safer route every 5 min. */
function onFix(J: Journey, f: Fix): void {
  S.myPos = f;
  J.pendingFixes.push(f);
  smap.setMe([f.lon, f.lat], f.acc, headingAlong(J.route.coords, f));
  if (S.follow) followCamera(f);
  handleEvents(J.monitor.feed(f));
  if (S.journey === J && J.clock() - J.lastSaferCheck > 300000) {
    J.lastSaferCheck = J.clock();
    checkSaferRoute();
  }
  if (S.view === 'journey') renderJourney();
}

/** Optional server SMS to contacts when the trip starts. */
function notifyStart(handle: JourneyHandle | null, route: WorkerRoute, startedAt: number, dest: string): void {
  const phones = notifyPhones(S.settings.contacts);
  if (!handle || !serverSms() || !phones.length) return;
  const eta = clockText(new Date(startedAt + route.timeS * 1000));
  api.notify(handle, phones, startText(S.settings.travellerName, dest, eta, shareUrl(handle.shareId))).catch(() => {});
}

type Journey = NonNullable<typeof S.journey>;

export async function startJourney() {
  if (!S.reply?.routes.length || !S.to) return;
  unlockSpeech(); // browsers only allow speech that starts from a tap
  prepareNative();
  const sim = S.settings.simulate || DEMO;
  if (!sim && !S.loc.fix && !('geolocation' in navigator && S.loc.status !== 'denied')) return offerSimulation();
  const route = S.reply.routes[S.selected];
  const dest = S.to;
  const startedAt = Date.now();
  const handle = await registerTrip(route, sim);
  const source = positionSource(route, sim);
  let lastT = startedAt;
  const J: Journey = {
    route,
    monitor: new JourneyMonitor({
      mode: S.settings.mode,
      route: route.coords,
      segTier: route.segTier,
      dest: route.coords[route.coords.length - 1],
      etaS: route.timeS,
      startedAt,
    }),
    source,
    handle,
    pref: prefOf(route),
    pendingFixes: [],
    dest,
    startedAt,
    offRoute: false,
    clock: () => (sim ? lastT : Date.now()),
    tickTimer: setInterval(() => handleEvents(J.monitor.tick(J.clock())), 15000),
    pushTimer: setInterval(() => flushFixes(), 10000),
    lastReroute: 0,
    lastSaferCheck: startedAt,
    better: null,
    guide: new Guide(() => !S.settings.voice, S.settings.mode === 'walk'),
    islandOpen: false,
  };
  J.guide.start(route.steps[0]?.text ?? 'Follow the route', dest.label);
  S.journey = J;
  S.follow = true;
  setView('journey');
  smap.setEndpoints(undefined, route.coords[route.coords.length - 1]);
  smap.showRoutes([route], 0);
  source.start(
    (f) => {
      lastT = f.t;
      onFix(J, f);
    },
    (msg) => toast(msg, 6000),
  );
  notifyStart(handle, route, startedAt, dest.label);
  renderJourney();
}

function handleEvents(evs: JourneyEvent[]) {
  const J = S.journey;
  if (!J) return;
  for (const e of evs) {
    if (e.type === 'arrived') {
      onArrived();
      return;
    }
    if (e.type === 'off_route') {
      J.offRoute = true;
      autoReroute();
    }
    if (e.type === 'back_on_route') J.offRoute = false;
    if (e.type === 'stopped')
      checkIn(`You have not moved for ${e.minutes} min${e.onRiskySegment ? ' on a quiet stretch' : ''}.`, 'stopped');
    if (e.type === 'overdue') checkIn(`You are ${e.minutesLate} min later than expected.`, 'overdue');
  }
}

/** Off the route: find a new route from where you are, keeping your choice (fastest / safest). */
export async function autoReroute() {
  const J = S.journey;
  if (!J || J.rerouting || !S.myPos) return;
  if (J.clock() - J.lastReroute < 30000) return;
  J.rerouting = true;
  J.lastReroute = J.clock();
  renderJourney();
  try {
    const at = S.myPos;
    const r = await rpc<{ reply: RouteReply }>({
      type: 'route',
      from: [at.lon, at.lat],
      to: J.dest.lonlat,
      mode: S.settings.mode,
      when: new Date(J.clock()).toISOString(),
      profile: S.settings.profile,
    });
    const best = pickByPref(r.reply.routes, J.pref);
    if (best && S.journey === J)
      switchRoute(best, `New ${J.pref === 'fastest' ? 'fastest' : 'safe'} route from where you are`);
  } catch {
    toast('Could not find a new route. Head back to the blue line.');
  } finally {
    J.rerouting = false;
    if (S.journey === J) renderJourney();
  }
}

/** Every few minutes: has a clearly safer way appeared (night fell, live reports, shops closed)? */
async function checkSaferRoute() {
  const J = S.journey;
  if (!J || !S.myPos || J.dismissedBetter) return;
  const at = S.myPos;
  try {
    const r = await rpc<{ reply: RouteReply }>({
      type: 'route',
      from: [at.lon, at.lat],
      to: J.dest.lonlat,
      mode: S.settings.mode,
      when: new Date(J.clock()).toISOString(),
      profile: S.settings.profile,
    });
    const safest = pickByPref(r.reply.routes, 'safest');
    const same = pickByPref(r.reply.routes, J.pref);
    if (!safest || !same || S.journey !== J) return;
    if (
      TIER_RANK[safest.tier] < TIER_RANK[same.tier] &&
      safest.timeS <= same.timeS + 420 &&
      safest.meanRisk < same.meanRisk - 0.04
    ) {
      J.better = safest;
      navigator.vibrate?.([80, 60, 80]);
      renderJourney();
    }
  } catch {
    /* try again next time */
  }
}

export function switchRoute(route: WorkerRoute, msg: string) {
  const J = S.journey;
  if (!J) return;
  J.route = route;
  J.monitor = new JourneyMonitor({
    mode: S.settings.mode,
    route: route.coords,
    segTier: route.segTier,
    dest: route.coords[route.coords.length - 1],
    etaS: route.timeS,
    startedAt: J.clock(),
  });
  if (S.myPos) J.monitor.feed(S.myPos);
  J.offRoute = false;
  J.better = null;
  J.guide.rerouted(msg.startsWith('Switched') ? 'Switched to the safer route.' : 'New route found.');
  smap.showRoutes([route], 0);
  if (J.handle) api.reroute(J.handle, route.coords, route.edges, route.timeS).catch(() => {});
  toast(msg);
  renderJourney();
}

async function flushFixes() {
  const J = S.journey;
  if (!J?.handle || !J.pendingFixes.length) return;
  const batch = J.pendingFixes.splice(0, 400);
  try {
    await api.pushFixes(J.handle, batch);
  } catch {
    J.pendingFixes.unshift(...batch);
  }
}

function stopJourney() {
  const J = S.journey;
  if (!J) return;
  J.source.stop();
  clearInterval(J.tickTimer);
  clearInterval(J.pushTimer);
}

function leaveNav() {
  S.follow = false;
  smap.map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 400 });
}

export async function endJourney(confirmed: boolean) {
  if (!confirmed) {
    openModal(
      h(
        'div',
        { class: 'modal-card' },
        h('h2', null, 'End this trip?'),
        h(
          'p',
          null,
          notifyPhones(S.settings.contacts).length
            ? 'Your contacts will not get an arrival message.'
            : 'Guidance stops here. You can plan this trip again any time.',
        ),
        h(
          'div',
          { class: 'row2' },
          h('button', { class: 'btn ghost', on: { click: () => closeModal() } }, 'Keep going'),
          h(
            'button',
            {
              class: 'btn danger',
              on: {
                click: () => {
                  closeModal();
                  endJourney(true);
                },
              },
            },
            'End trip',
          ),
        ),
      ),
    );
    return;
  }
  stopJourney();
  const J = S.journey;
  J?.guide.stop();
  if (J?.handle) {
    await flushFixes();
    api.finish(J.handle).catch(() => {});
  }
  S.journey = null;
  S.myPos = null;
  leaveNav();
  hooks.drawMe();
  hooks.openDirections();
}

async function onArrived() {
  const J = S.journey!;
  stopJourney();
  J.guide.arrived(J.dest.label);
  await flushFixes();
  let result: FinishResult | null = null;
  if (J.handle) {
    try {
      result = await api.finish(J.handle);
    } catch {
      result = null;
    }
  }
  J.result = result;
  setView('arrived');
  leaveNav();
  clear(top);
  const msg = arrivalText(S.settings.travellerName, J.dest.label, clockText(new Date(J.clock())));
  const phones = notifyPhones(S.settings.contacts);
  let autoSent = 0;
  if (J.handle && serverSms() && phones.length) {
    try {
      autoSent = (await api.notify(J.handle, phones, msg)).smsSent;
    } catch {
      /* links below */
    }
  }
  navigator.vibrate?.([100, 60, 100]);
  renderArrived(msg, autoSent);
}
