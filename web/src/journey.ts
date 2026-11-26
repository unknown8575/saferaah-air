// Navigation: starting a journey, live guidance and the island, re-routing, check-ins and SOS,
// arrival and the optional two questions afterwards.
import { h, clear, fmtDuration, fmtDist } from './dom.ts';
import { icon } from './icons.ts';
import { save } from './store.ts';
import { api, isOnline, serverSms, type JourneyHandle } from './api.ts';
import { gpsSource, simulatedSource } from './location.ts';
import { smsLink, whatsappLink, telLink, shareUrl, arrivalText, startText, sosText, HELPLINES, notifyPhones } from './messages.ts';
import type { RouteReply, WorkerRoute } from './worker.ts';
import { TIER_INFO, type Tier } from '../../shared/router.ts';
import { MODE_INFO, WALK_KMH } from '../../shared/modes.ts';
import { JourneyMonitor, type Fix, type JourneyEvent } from '../../shared/journey.ts';
import { haversine, type LonLat } from '../../shared/geo.ts';
import { Guide, unlockSpeech, canSpeak, stopSpeaking, fmtShort, prepareNative, type NavInfo } from './nav.ts';
import { S, rpc, sheet, top, smap, toast, setView, myLonLat, clockText, TIER_RANK, tierIcon, wide, params, DEMO, hooks, type Pref, openModal, closeModal, checkTimer, setCheckTimer } from './app.ts';
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

export async function startJourney() {
  if (!S.reply?.routes.length || !S.to) return;
  unlockSpeech(); // browsers only allow speech that starts from a tap
  prepareNative();
  const sim = S.settings.simulate || DEMO;
  if (!sim && !S.loc.fix && !('geolocation' in navigator && S.loc.status !== 'denied')) {
    openModal(h('div', { class: 'modal-card' }, h('h2', null, 'Tracking needs your location'),
      h('p', null, 'To watch your journey and tell your contacts when you reach, SafeRaah needs GPS. Location is blocked here.'),
      h('p', { class: 'fine' }, 'You can try the journey with simulated movement instead.'),
      h('button', { class: 'btn primary wide', on: { click: () => { closeModal(); S.settings = save({ simulate: true }); startJourney(); } } }, 'Simulate the trip'),
      h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Cancel')));
    return;
  }
  const route = S.reply.routes[S.selected];
  const startedAt = Date.now();
  const monitor = new JourneyMonitor({
    mode: S.settings.mode, route: route.coords, segTier: route.segTier, dest: route.coords[route.coords.length - 1],
    etaS: route.timeS, startedAt,
  });
  let handle: JourneyHandle | null = null;
  if (isOnline()) {
    try {
      handle = await api.startJourney({ mode: S.settings.mode, route: route.coords, edges: route.edges, dest: route.coords[route.coords.length - 1],
        etaS: route.timeS, graphVersion: S.version, name: S.settings.travellerName || undefined, simulated: sim });
    } catch (err) { toast('Live sharing is unavailable: ' + (err as Error).message); }
  }
  const speedMps = S.settings.mode === 'walk' ? WALK_KMH / 3.6 : route.lengthM / route.timeS;
  const pauseAt = params.get('pause') ? { atFrac: Number(params.get('pause')), seconds: Number(params.get('pauseS') ?? 300) } : undefined;
  const source = sim ? simulatedSource(route.coords, speedMps, Number(params.get('speed') ?? 30), pauseAt) : gpsSource();
  let lastT = startedAt;
  const J: NonNullable<typeof S.journey> = {
    route, monitor, source, handle, pref: prefOf(route), pendingFixes: [], dest: S.to, startedAt, offRoute: false,
    clock: () => (sim ? lastT : Date.now()),
    tickTimer: setInterval(() => handleEvents(J.monitor.tick(J.clock())), 15000),
    pushTimer: setInterval(() => flushFixes(), 10000),
    lastReroute: 0, lastSaferCheck: startedAt, better: null,
    guide: new Guide(() => !S.settings.voice, S.settings.mode === 'walk'), islandOpen: false,
  };
  J.guide.start(route.steps[0]?.text ?? 'Follow the route', S.to.label);
  S.journey = J;
  S.follow = true;
  setView('journey');
  smap.setEndpoints(undefined, route.coords[route.coords.length - 1]);
  smap.showRoutes([route], 0);
  source.start((f) => {
    lastT = f.t;
    S.myPos = f;
    J.pendingFixes.push(f);
    const hd = headingAlong(J.route.coords, f);
    smap.setMe([f.lon, f.lat], f.acc, hd);
    if (S.follow) followCamera(f);
    handleEvents(J.monitor.feed(f));
    if (S.journey === J && J.clock() - J.lastSaferCheck > 300000) { J.lastSaferCheck = J.clock(); checkSaferRoute(); }
    if (S.view === 'journey') renderJourney();
  }, (msg) => toast(msg, 6000));
  // optional server SMS on start
  const phones = notifyPhones(S.settings.contacts);
  if (handle && serverSms() && phones.length) {
    api.notify(handle, phones, startText(S.settings.travellerName, S.to.label, clockText(new Date(startedAt + route.timeS * 1000)), shareUrl(handle.shareId))).catch(() => {});
  }
  renderJourney();
}

function nearestIdx(coords: LonLat[], f: { lon: number; lat: number }): number {
  let ni = 0, bd = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = (coords[i][0] - f.lon) ** 2 + (coords[i][1] - f.lat) ** 2;
    if (d < bd) { bd = d; ni = i; }
  }
  return ni;
}
/** Direction of travel: along the route ahead of you (heading-up navigation). */
function headingAlong(coords: LonLat[], f: { lon: number; lat: number }): number {
  const i = nearestIdx(coords, f);
  let j = i + 1;
  while (j < coords.length - 1 && haversine(coords[i][0], coords[i][1], coords[j][0], coords[j][1]) < 25) j++;
  const a = coords[Math.min(i, coords.length - 2)], b = coords[Math.min(j, coords.length - 1)];
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), dy = b[1] - a[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
export function followCamera(f: Fix) {
  const J = S.journey;
  if (!J) return;
  const bearing = headingAlong(J.route.coords, f);
  const th = top.getBoundingClientRect().height, sh = sheet.getBoundingClientRect().height;
  smap.map.easeTo({ center: [f.lon, f.lat], zoom: 17, bearing, pitch: 45, duration: 500,
    padding: wide() ? { top: 120, bottom: 80, left: 420, right: 40 } : { top: th + 40, bottom: sh + 60, left: 0, right: 0 } });
}

let lastStepIdx = -1;

export function renderJourney() {
  const J = S.journey;
  if (!J) return;
  const f = S.myPos;
  const coords = J.route.coords;
  const ni = f ? nearestIdx(coords, f) : 0;
  let remain = 0;
  for (let i = ni; i < coords.length - 1; i++) remain += haversine(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
  const remainS = J.route.lengthM > 0 ? J.route.timeS * (remain / J.route.lengthM) : 0;
  const next = J.route.steps.find((s) => s.idx > ni) ?? J.route.steps[J.route.steps.length - 1];
  let toNext = 0;
  for (let i = ni; i < Math.min(next.idx, coords.length - 1); i++) toNext += haversine(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
  if (next.idx !== lastStepIdx && 'vibrate' in navigator && lastStepIdx >= 0) navigator.vibrate?.(60);
  lastStepIdx = next.idx;
  const clockNow = new Date(J.clock());
  const segTier = J.route.segTier[Math.min(ni, J.route.segTier.length - 1)] ?? 'green';
  const steps = J.route.steps;
  const k = steps.indexOf(next);
  const after = steps[k + 1];
  const thenText = after && next.distM < (S.settings.mode === 'walk' ? 40 : 120) && next.turn !== 'arrive' ? after.text : undefined;
  const etaText = clockText(new Date(clockNow.getTime() + remainS * 1000));
  const info: NavInfo = { text: next.text, turn: next.turn, toNextM: toNext, thenText, remainM: remain, remainS, etaText, tier: segTier,
    ahead: riskAhead(J.route, ni, S.settings.mode === 'walk' ? 150 : 450), progress: J.route.lengthM ? 1 - remain / J.route.lengthM : 0, destLabel: J.dest.label };
  J.guide.update(k, info);
  // a persistent node, so a tap that lands while the island refreshes still counts
  let voiceBtn = top.querySelector<HTMLButtonElement>('#voice-toggle');
  if (!voiceBtn && canSpeak()) voiceBtn = h('button', { class: 'isl-voice', id: 'voice-toggle',
    on: { click: (e: Event) => { e.stopPropagation(); S.settings = save({ voice: !S.settings.voice }); if (!S.settings.voice) stopSpeaking(); renderJourney(); } } }) as HTMLButtonElement;
  if (voiceBtn) {
    voiceBtn.replaceChildren(icon(S.settings.voice ? 'voice' : 'mute', 18));
    voiceBtn.setAttribute('aria-pressed', S.settings.voice ? 'true' : 'false');
    voiceBtn.setAttribute('aria-label', S.settings.voice ? 'Mute voice guidance' : 'Turn on voice guidance');
  }
  // update the island in place: rebuilding it on every GPS fix would swallow taps
  let island = top.querySelector<HTMLElement>('#island');
  if (!island) {
    island = h('div', { role: 'status', id: 'island', tabindex: 0, on: { click: () => { const j = S.journey; if (j) { j.islandOpen = !j.islandOpen; renderJourney(); } } } });
    clear(top, island, h('div', { id: 'seg-slot' }));
  }
  island.className = `island tier-${segTier}${J.islandOpen ? ' open' : ''}`;
  island.setAttribute('aria-label', `${next.turn === 'arrive' ? '' : fmtDist(toNext) + ', '}${next.text}`);
  const sig = [next.text, fmtDist(toNext), etaText, J.islandOpen, S.settings.voice, segTier, thenText, info.ahead?.key, Math.round(info.progress * 50)].join('|');
  if (island.dataset.sig !== sig) {
    island.dataset.sig = sig;
    clear(island,
      h('span', { class: `isl-arrow turn-${next.turn}` }, icon(next.turn, 28, 2.4)),
      h('div', { class: 'isl-main' },
        next.turn !== 'arrive' ? h('b', { class: 'isl-dist in-dist' }, fmtDist(toNext)) : null,
        h('span', { class: 'isl-text' }, next.text)),
      h('span', { class: 'isl-side' }, voiceBtn, h('span', { class: 'isl-eta' }, etaText)),
      J.islandOpen ? h('div', { class: 'isl-more' },
        thenText ? h('div', null, 'Then: ', thenText) : after && next.turn !== 'arrive' ? h('div', null, `Next: ${after.text}`) : null,
        h('div', null, `Arrive ${etaText} · ${fmtShort(remain)} left · ${fmtDuration(remainS)}`),
        h('div', { class: 'isl-bar' }, h('i', { style: { width: `${Math.round(info.progress * 100)}%` } })),
        info.ahead ? h('div', { class: `isl-ahead tier-text-${info.ahead.tier}` }, `${tierIcon(info.ahead.tier)} ${info.ahead.tier === 'yellow' ? 'Quieter' : 'Risky'} stretch in ${fmtShort(info.ahead.inM)} (${fmtShort(info.ahead.lengthM)})`) : null) : null);
  }
  const slot = top.querySelector<HTMLElement>('#seg-slot')!;
  const warn = segTier !== 'green' ? `${tierIcon(segTier)}${segTier === 'yellow' ? ' Quieter stretch: stay alert' : ' Risky stretch: keep moving, stay on the main road'}` : '';
  if (slot.dataset.w !== warn) {
    slot.dataset.w = warn;
    clear(slot, warn ? h('div', { class: `seg-warn tier-${segTier}` }, warn) : null);
  }
  clear(sheet,
    J.offRoute ? h('div', { class: 'advice advice-caution' }, h('strong', null, J.rerouting ? 'Finding a new safe route…' : 'You left the route'),
      !J.rerouting ? h('button', { class: 'btn small', on: { click: () => autoReroute() } }, 'Find a new safe route') : null) : null,
    J.better && !J.dismissedBetter ? h('div', { class: 'advice advice-ok better' }, h('strong', null, 'Safer route available'),
      h('p', null, `${fmtDuration(J.better.timeS)} from here, ${TIER_INFO[J.better.tier].label.toLowerCase()}. ${J.better.precautions.headline}.`),
      h('div', { class: 'row2' }, h('button', { class: 'btn small primary', id: 'switch-route', on: { click: () => switchRoute(J.better!, 'Switched to the safer route') } }, 'Switch'),
        h('button', { class: 'btn small ghost', on: { click: () => { J.dismissedBetter = true; renderJourney(); } } }, 'Keep mine'))) : null,
    h('div', { class: 'journey-row' },
      h('div', null, h('div', { class: 'big-time' }, fmtDuration(remainS), h('span', { class: 'eta' }, clockText(new Date(clockNow.getTime() + remainS * 1000)))),
        h('div', { class: 'meta' }, `${fmtDist(remain)} left · ${MODE_INFO[S.settings.mode].label}`)),
      h('div', { class: 'journey-actions' },
        h('button', { class: 'btn', on: { click: () => shareTrip() } }, J.handle ? 'Share live' : 'Share'),
        h('button', { class: 'btn ghost', on: { click: () => endJourney(false) } }, 'End'))),
    J.handle ? h('p', { class: 'fine live' }, h('span', { class: 'live-dot' }), 'Live trip link is active') : h('p', { class: 'fine' }, isOnline() ? '' : navigator.onLine ? 'Live trip links and reviews need the SafeRaah server, which this website is not connected to yet. Guidance, check-ins and SOS still work.' : 'Offline: live sharing and reviews need an internet connection.'),
    (S.settings.simulate || DEMO) ? h('p', { class: 'fine' }, 'Demo mode: your movement is simulated.') : null,
  );
}

/** The next quieter or risky run of the route within `lookM` ahead (spoken once, shown in the island). */
function riskAhead(r: WorkerRoute, ni: number, lookM: number): NavInfo['ahead'] {
  const c = r.coords, t = r.segTier;
  if ((t[ni] ?? 'green') !== 'green') return undefined;
  let d = 0;
  for (let j = ni; j < c.length - 1 && d <= lookM; j++) {
    if (t[j] !== 'green') {
      let len = 0;
      for (let q = j; q < c.length - 1 && t[q] !== 'green'; q++) len += haversine(c[q][0], c[q][1], c[q + 1][0], c[q + 1][1]);
      if (len < 40) return undefined; // too short to mention
      return { tier: t[j] as Tier, lengthM: len, inM: d, key: j };
    }
    d += haversine(c[j][0], c[j][1], c[j + 1][0], c[j + 1][1]);
  }
  return undefined;
}


function handleEvents(evs: JourneyEvent[]) {
  const J = S.journey;
  if (!J) return;
  for (const e of evs) {
    if (e.type === 'arrived') { onArrived(); return; }
    if (e.type === 'off_route') { J.offRoute = true; autoReroute(); }
    if (e.type === 'back_on_route') J.offRoute = false;
    if (e.type === 'stopped') checkIn(`You have not moved for ${e.minutes} min${e.onRiskySegment ? ' on a quiet stretch' : ''}.`, 'stopped');
    if (e.type === 'overdue') checkIn(`You are ${e.minutesLate} min later than expected.`, 'overdue');
  }
}

/** Off the route: find a new route from where you are, keeping your choice (fastest / safest). */
async function autoReroute() {
  const J = S.journey;
  if (!J || J.rerouting || !S.myPos) return;
  if (J.clock() - J.lastReroute < 30000) return;
  J.rerouting = true;
  J.lastReroute = J.clock();
  renderJourney();
  try {
    const at = S.myPos;
    const r = await rpc<{ reply: RouteReply }>({ type: 'route', from: [at.lon, at.lat], to: J.dest.lonlat, mode: S.settings.mode,
      when: new Date(J.clock()).toISOString(), profile: S.settings.profile });
    const best = pickByPref(r.reply.routes, J.pref);
    if (best && S.journey === J) switchRoute(best, `New ${J.pref === 'fastest' ? 'fastest' : 'safe'} route from where you are`);
  } catch { toast('Could not find a new route. Head back to the blue line.'); } finally { J.rerouting = false; if (S.journey === J) renderJourney(); }
}

/** Every few minutes: has a clearly safer way appeared (night fell, live reports, shops closed)? */
async function checkSaferRoute() {
  const J = S.journey;
  if (!J || !S.myPos || J.dismissedBetter) return;
  const at = S.myPos;
  try {
    const r = await rpc<{ reply: RouteReply }>({ type: 'route', from: [at.lon, at.lat], to: J.dest.lonlat, mode: S.settings.mode,
      when: new Date(J.clock()).toISOString(), profile: S.settings.profile });
    const safest = pickByPref(r.reply.routes, 'safest');
    const same = pickByPref(r.reply.routes, J.pref);
    if (!safest || !same || S.journey !== J) return;
    if (TIER_RANK[safest.tier] < TIER_RANK[same.tier] && safest.timeS <= same.timeS + 420 && safest.meanRisk < same.meanRisk - 0.04) {
      J.better = safest;
      navigator.vibrate?.([80, 60, 80]);
      renderJourney();
    }
  } catch { /* try again next time */ }
}

function switchRoute(route: WorkerRoute, msg: string) {
  const J = S.journey;
  if (!J) return;
  J.route = route;
  J.monitor = new JourneyMonitor({ mode: S.settings.mode, route: route.coords, segTier: route.segTier, dest: route.coords[route.coords.length - 1],
    etaS: route.timeS, startedAt: J.clock() });
  if (S.myPos) J.monitor.feed(S.myPos);
  J.offRoute = false; J.better = null;
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
  try { await api.pushFixes(J.handle, batch); } catch { J.pendingFixes.unshift(...batch); }
}

async function shareTrip() {
  const J = S.journey;
  if (!J) return;
  const link = J.handle ? shareUrl(J.handle.shareId) : undefined;
  const text = startText(S.settings.travellerName, J.dest.label, clockText(new Date(J.startedAt + J.route.timeS * 1000)), link);
  if (navigator.share) {
    try { await navigator.share({ title: 'My trip', text, url: link }); return; } catch { /* cancelled */ }
  }
  showMessageSheet('Share your trip', text);
}

function showMessageSheet(title: string, text: string, onClose?: () => void) {
  const phones = notifyPhones(S.settings.contacts);
  openModal(h('div', { class: 'modal-card' },
    h('h2', null, title),
    h('p', { class: 'msg-preview' }, text),
    phones.length ? h('a', { class: 'btn primary wide', href: smsLink(phones, text) }, `Send SMS to ${S.settings.contacts.filter((c) => c.notify).map((c) => c.name).join(', ')}`) :
      h('p', null, 'No contacts selected. ', h('button', { class: 'linkish', on: { click: () => { closeModal(); hooks.showContacts(); } } }, 'Add a contact')),
    S.settings.contacts.filter((c) => c.notify).map((c) => h('a', { class: 'btn wide', href: whatsappLink(c.phone, text), target: '_blank', rel: 'noopener' }, `WhatsApp ${c.name}`)),
    h('button', { class: 'btn ghost wide', on: { click: () => { navigator.clipboard?.writeText(text).then(() => toast('Copied')); } } }, 'Copy text'),
    h('button', { class: 'btn ghost wide', on: { click: () => { closeModal(); onClose?.(); } } }, 'Close'),
  ));
}


function checkIn(reason: string, kind: 'stopped' | 'overdue') {
  if (!S.journey || checkTimer || S.journey.sos) return;
  let left = 30;
  const count = h('div', { class: 'countdown', 'aria-live': 'assertive' }, `0:${left}`);
  navigator.vibrate?.([200, 100, 200]);
  openModal(h('div', { class: 'modal-card checkin', role: 'alertdialog', 'aria-label': 'Are you OK?' },
    h('h2', null, 'Are you OK?'), h('p', null, reason), count,
    h('div', { class: 'row2' },
      h('button', { class: 'btn ok', id: 'im-ok', on: { click: () => { closeModal(); S.journey?.monitor.acknowledge(kind, S.journey.clock()); toast('Glad you are OK. We will keep watching the trip.'); } } }, "I'm OK"),
      h('button', { class: 'btn danger', on: { click: () => { closeModal(); openSos(); } } }, 'Send SOS')),
    h('p', { class: 'fine' }, 'If you do not answer, SOS opens automatically.'),
  ));
  setCheckTimer(setInterval(() => {
    left--;
    count.textContent = `0:${String(left).padStart(2, '0')}`;
    if (left <= 0) { closeModal(); openSos(true); }
  }, 1000));
}

export async function openSos(auto = false) {
  const J = S.journey;
  if (J) J.sos = true;
  const pos: LonLat = S.myPos ? [S.myPos.lon, S.myPos.lat] : myLonLat() ?? S.from?.lonlat ?? (smap ? [smap.map.getCenter().lng, smap.map.getCenter().lat] : [77.21, 28.61]);
  const link = J?.handle ? shareUrl(J.handle.shareId) : undefined;
  const text = sosText(S.settings.travellerName, pos[0], pos[1], link);
  const phones = S.settings.contacts.map((c) => c.phone);
  let serverNote = '';
  if (J?.handle) {
    try {
      const r = await api.sos(J.handle, phones, text);
      serverNote = r.smsSent ? `SOS SMS sent to ${r.smsSent} contact${r.smsSent > 1 ? 's' : ''}. ` : '';
    } catch { /* fall back to links */ }
  }
  navigator.vibrate?.([300, 100, 300, 100, 300]);
  openModal(h('div', { class: 'modal-card sos-card', role: 'alertdialog', 'aria-label': 'SOS' },
    h('h2', null, auto ? 'No answer, so SOS is open' : 'SOS'),
    serverNote ? h('p', null, serverNote) : null,
    h('a', { class: 'btn danger wide big', href: telLink('112') }, 'Call 112'),
    phones.length ? h('a', { class: 'btn primary wide', href: smsLink(phones, text) }, 'Send SOS SMS to all contacts') :
      h('p', null, 'You have no trusted contacts yet.'),
    S.settings.contacts.map((c) => h('a', { class: 'btn wide', href: whatsappLink(c.phone, text), target: '_blank', rel: 'noopener' }, `WhatsApp ${c.name}`)),
    h('details', null, h('summary', null, 'Other helplines'),
      h('ul', { class: 'helplines' }, HELPLINES.map((x) => h('li', null, h('a', { href: telLink(x.n) }, x.n), ` ${x.label}`)))),
    h('button', { class: 'btn ghost wide', on: { click: () => { closeModal(); if (J) J.sos = false; } } }, 'I am safe, close'),
  ));
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

async function endJourney(confirmed: boolean) {
  if (!confirmed) {
    openModal(h('div', { class: 'modal-card' }, h('h2', null, 'End this trip?'), h('p', null, 'Your contacts will not get an arrival message.'),
      h('div', { class: 'row2' }, h('button', { class: 'btn ghost', on: { click: () => closeModal() } }, 'Keep going'),
        h('button', { class: 'btn danger', on: { click: () => { closeModal(); endJourney(true); } } }, 'End trip'))));
    return;
  }
  stopJourney();
  const J = S.journey;
  J?.guide.stop();
  if (J?.handle) { await flushFixes(); api.finish(J.handle).catch(() => {}); }
  S.journey = null; S.myPos = null;
  leaveNav();
  hooks.drawMe();
  hooks.openDirections();
}

async function onArrived() {
  const J = S.journey!;
  stopJourney();
  J.guide.arrived(J.dest.label);
  await flushFixes();
  let result: any = null;
  if (J.handle) { try { result = await api.finish(J.handle); } catch { result = null; } }
  J.result = result;
  setView('arrived');
  leaveNav();
  clear(top);
  const msg = arrivalText(S.settings.travellerName, J.dest.label, clockText(new Date(J.clock())));
  const phones = notifyPhones(S.settings.contacts);
  let autoSent = 0;
  if (J.handle && serverSms() && phones.length) { try { autoSent = (await api.notify(J.handle, phones, msg)).smsSent; } catch { /* links below */ } }
  navigator.vibrate?.([100, 60, 100]);
  renderArrived(msg, autoSent);
}

export function renderArrived(msg: string, autoSent: number) {
  const J = S.journey!;
  const res = J.result;
  const names = S.settings.contacts.filter((c) => c.notify).map((c) => c.name);
  let rating = 0;
  const tags = new Set<string>();
  const TAGS: [string, string][] = [['well_lit', 'Well lit'], ['busy', 'Busy'], ['shops_open', 'Shops open'], ['police_seen', 'Police seen'],
    ['dark', 'Dark'], ['deserted', 'Deserted'], ['harassment', 'Harassment'], ['followed', 'Followed'], ['stray_dogs', 'Stray dogs'], ['bad_footpath', 'Bad footpath']];
  const stars = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': 'Safety rating' });
  const drawStars = () => clear(stars, [1, 2, 3, 4, 5].map((n) => h('button', {
    class: `star${n <= rating ? ' on' : ''}`, role: 'radio', 'aria-checked': n === rating ? 'true' : 'false', 'aria-label': `${n} of 5`,
    on: { click: () => { rating = n; drawStars(); submit.disabled = false; } } }, icon('star', 30, 1.6))));
  const submit = h('button', { class: 'btn primary', disabled: true, id: 'submit-review', on: { click: async () => {
    try {
      await api.review(J.handle!.id, res.reviewToken, rating, [...tags]);
      clear(reviewBox, h('p', { class: 'ok-msg' }, 'Thanks. Your answer helps others once enough travellers agree about these streets. Nothing about your trip was kept.'));
    } catch (err) { toast((err as Error).message); }
  } } }, 'Send');
  drawStars();
  const reviewBox = h('div', { class: 'review' });
  if (res?.eligible && res.reviewToken) {
    clear(reviewBox,
      h('p', { class: 'fine' }, 'Two quick questions, only if you want to answer. Anonymous: your trip\'s location was already deleted.'),
      h('h3', null, '1. How safe did the route feel?'), stars,
      h('h3', null, '2. What did you notice? (optional)'),
      h('div', { class: 'chips wrap' }, TAGS.map(([k, label]) => h('button', { class: 'chip', 'aria-pressed': 'false',
        on: { click: (e: Event) => { const b = e.currentTarget as HTMLElement; if (tags.has(k)) tags.delete(k); else tags.add(k); b.classList.toggle('on'); b.setAttribute('aria-pressed', String(tags.has(k))); } } }, label))),
      h('div', { class: 'row2' }, h('button', { class: 'btn ghost', id: 'skip-review', on: { click: () => clear(reviewBox, h('p', { class: 'fine' }, 'Skipped. Nothing about this trip is kept.')) } }, 'Skip'), submit));
  } else if (res) {
    clear(reviewBox, h('p', { class: 'fine' }, 'Reviews are only accepted from verified trips. This one could not be verified: ', res.reasons.join('; '), '.'));
  } else {
    clear(reviewBox, h('p', { class: 'fine' }, 'Reviews need an internet connection to verify your trip.'));
  }
  clear(sheet,
    h('div', { class: 'grip' }),
    h('div', { class: 'pad center' },
      h('div', { class: 'arrived-mark' }, icon('check', 40, 2.6)),
      h('h2', null, 'You reached'),
      h('p', null, J.dest.label),
      autoSent ? h('p', { class: 'ok-msg' }, `Arrival message sent to ${names.join(', ')}.`) :
        names.length ? h('a', { class: 'btn primary wide', href: smsLink(notifyPhones(S.settings.contacts), msg), id: 'send-arrival' }, `Tell ${names.join(', ')} you reached`) :
          h('p', null, h('button', { class: 'linkish', on: { click: () => hooks.showContacts() } }, 'Add a trusted contact'), ' to send arrival messages next time.'),
      names.length && !autoSent ? h('button', { class: 'btn wide', on: { click: () => showMessageSheet('Tell them you reached', msg) } }, 'Other ways to send') : null,
    ),
    h('div', { class: 'pad' }, reviewBox),
    h('div', { class: 'actions' }, h('button', { class: 'btn wide', id: 'done', on: { click: () => { S.journey = null; S.myPos = null; S.from = null; S.to = null; S.reply = null; hooks.goHome(); } } }, 'Done')),
  );
}

