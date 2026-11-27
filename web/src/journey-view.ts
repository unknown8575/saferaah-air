// What you see while travelling: the island (next turn, distance, arrival time), the warning
// for a quieter or risky stretch, and the sheet below (re-route, safer route, share, end).
import { h, clear, fmtDuration, fmtDist } from './dom.ts';
import { icon } from './icons.ts';
import { save } from './store.ts';
import { isOnline } from './api.ts';
import type { WorkerRoute } from './worker.ts';
import { TIER_INFO, type Tier } from '../../shared/router.ts';
import { MODE_INFO } from '../../shared/modes.ts';
import type { Fix } from '../../shared/journey.ts';
import { haversine, type LonLat } from '../../shared/geo.ts';
import type { Step } from '../../shared/steps.ts';
import { canSpeak, stopSpeaking, fmtShort, type NavInfo } from './nav.ts';
import { S, sheet, top, smap, clockText, tierIcon, wide, DEMO } from './app.ts';
import { autoReroute, endJourney, switchRoute } from './journey.ts';
import { shareTrip } from './sos.ts';

type Journey = NonNullable<typeof S.journey>;

function nearestIdx(coords: LonLat[], f: { lon: number; lat: number }): number {
  let ni = 0;
  let bd = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = (coords[i][0] - f.lon) ** 2 + (coords[i][1] - f.lat) ** 2;
    if (d < bd) {
      bd = d;
      ni = i;
    }
  }
  return ni;
}

/** Length of the route line between two coordinate indexes. */
function lengthBetween(coords: LonLat[], from: number, to: number): number {
  let m = 0;
  for (let i = from; i < Math.min(to, coords.length - 1); i++)
    m += haversine(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
  return m;
}

/** Direction of travel: along the route ahead of you (heading-up navigation). */
export function headingAlong(coords: LonLat[], f: { lon: number; lat: number }): number {
  const i = nearestIdx(coords, f);
  let j = i + 1;
  while (j < coords.length - 1 && haversine(coords[i][0], coords[i][1], coords[j][0], coords[j][1]) < 25) j++;
  const a = coords[Math.min(i, coords.length - 2)];
  const b = coords[Math.min(j, coords.length - 1)];
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  const dy = b[1] - a[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

export function followCamera(f: Fix) {
  const J = S.journey;
  if (!J) return;
  const th = top.getBoundingClientRect().height;
  const sh = sheet.getBoundingClientRect().height;
  smap.map.easeTo({
    center: [f.lon, f.lat],
    zoom: 17,
    bearing: headingAlong(J.route.coords, f),
    pitch: 45,
    duration: 500,
    padding: wide()
      ? { top: 120, bottom: 80, left: 420, right: 40 }
      : { top: th + 40, bottom: sh + 60, left: 0, right: 0 },
  });
}

/** The next quieter or risky run of the route within `lookM` ahead (spoken once, shown in the island). */
function riskAhead(r: WorkerRoute, ni: number, lookM: number): NavInfo['ahead'] {
  const c = r.coords;
  const t = r.segTier;
  if ((t[ni] ?? 'green') !== 'green') return undefined;
  let d = 0;
  for (let j = ni; j < c.length - 1 && d <= lookM; j++) {
    if (t[j] !== 'green') {
      let q = j;
      while (q < c.length - 1 && t[q] !== 'green') q++;
      const len = lengthBetween(c, j, q);
      if (len < 40) return undefined; // too short to mention
      return { tier: t[j] as Tier, lengthM: len, inM: d, key: j };
    }
    d += haversine(c[j][0], c[j][1], c[j + 1][0], c[j + 1][1]);
  }
  return undefined;
}

/** Where you are on the route and what comes next. */
interface Progress {
  info: NavInfo;
  /** index of the next step in the route's step list */
  k: number;
  next: Step;
  after: Step | undefined;
  clockNow: Date;
}

function progressOf(J: Journey): Progress {
  const coords = J.route.coords;
  const steps = J.route.steps;
  const ni = S.myPos ? nearestIdx(coords, S.myPos) : 0;
  const remain = lengthBetween(coords, ni, coords.length - 1);
  const remainS = J.route.lengthM > 0 ? J.route.timeS * (remain / J.route.lengthM) : 0;
  const next = steps.find((s) => s.idx > ni) ?? steps[steps.length - 1];
  const k = steps.indexOf(next);
  const after = steps[k + 1];
  const walk = S.settings.mode === 'walk';
  const clockNow = new Date(J.clock());
  const info: NavInfo = {
    text: next.text,
    turn: next.turn,
    toNextM: lengthBetween(coords, ni, next.idx),
    thenText: after && next.distM < (walk ? 40 : 120) && next.turn !== 'arrive' ? after.text : undefined,
    remainM: remain,
    remainS,
    etaText: clockText(new Date(clockNow.getTime() + remainS * 1000)),
    tier: J.route.segTier[Math.min(ni, J.route.segTier.length - 1)] ?? 'green',
    ahead: riskAhead(J.route, ni, walk ? 150 : 450),
    progress: J.route.lengthM ? 1 - remain / J.route.lengthM : 0,
    destLabel: J.dest.label,
  };
  return { info, k, next, after, clockNow };
}

/** A persistent node, so a tap that lands while the island refreshes still counts. */
function voiceToggle(): HTMLButtonElement | null {
  let btn = top.querySelector<HTMLButtonElement>('#voice-toggle');
  if (!btn && canSpeak()) {
    const flip = (e: Event) => {
      e.stopPropagation();
      S.settings = save({ voice: !S.settings.voice });
      if (!S.settings.voice) stopSpeaking();
      renderJourney();
    };
    btn = h('button', { class: 'isl-voice', id: 'voice-toggle', on: { click: flip } }) as HTMLButtonElement;
  }
  if (!btn) return null;
  const on = S.settings.voice;
  btn.replaceChildren(icon(on ? 'voice' : 'mute', 18));
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', on ? 'Mute voice guidance' : 'Turn on voice guidance');
  return btn;
}

/** The island element (created once; tapping it opens or closes the details). */
function islandNode(): HTMLElement {
  const existing = top.querySelector<HTMLElement>('#island');
  if (existing) return existing;
  const toggleOpen = () => {
    const j = S.journey;
    if (!j) return;
    j.islandOpen = !j.islandOpen;
    renderJourney();
  };
  const island = h('div', { role: 'status', id: 'island', tabindex: 0, on: { click: toggleOpen } });
  clear(top, island, h('div', { id: 'seg-slot' }));
  return island;
}

/** The island opened: then / next step, arrival, progress and what lies ahead. */
function islandMore(p: Progress): HTMLElement {
  const { info, next, after } = p;
  const ahead = info.ahead;
  const then = info.thenText
    ? h('div', null, 'Then: ', info.thenText)
    : after && next.turn !== 'arrive'
      ? h('div', null, `Next: ${after.text}`)
      : null;
  return h(
    'div',
    { class: 'isl-more' },
    then,
    h('div', null, `Arrive ${info.etaText} · ${fmtShort(info.remainM)} left · ${fmtDuration(info.remainS)}`),
    h('div', { class: 'isl-bar' }, h('i', { style: { width: `${Math.round(info.progress * 100)}%` } })),
    ahead
      ? h(
          'div',
          { class: `isl-ahead tier-text-${ahead.tier}` },
          `${tierIcon(ahead.tier)} ${ahead.tier === 'yellow' ? 'Quieter' : 'Risky'} stretch in ${fmtShort(ahead.inM)} (${fmtShort(ahead.lengthM)})`,
        )
      : null,
  );
}

/** Update the island in place: rebuilding it on every GPS fix would swallow taps. */
function drawIsland(J: Journey, p: Progress, voiceBtn: HTMLElement | null): void {
  const { info, next } = p;
  const island = islandNode();
  island.className = `island tier-${info.tier}${J.islandOpen ? ' open' : ''}`;
  island.setAttribute('aria-label', `${next.turn === 'arrive' ? '' : fmtDist(info.toNextM) + ', '}${next.text}`);
  const sig = [
    next.text,
    fmtDist(info.toNextM),
    info.etaText,
    J.islandOpen,
    S.settings.voice,
    info.tier,
    info.thenText,
    info.ahead?.key,
    Math.round(info.progress * 50),
  ].join('|');
  if (island.dataset.sig === sig) return;
  island.dataset.sig = sig;
  clear(
    island,
    h('span', { class: `isl-arrow turn-${next.turn}` }, icon(next.turn, 28, 2.4)),
    h(
      'div',
      { class: 'isl-main' },
      next.turn !== 'arrive' ? h('b', { class: 'isl-dist in-dist' }, fmtDist(info.toNextM)) : null,
      h('span', { class: 'isl-text' }, next.text),
    ),
    h('span', { class: 'isl-side' }, voiceBtn, h('span', { class: 'isl-eta' }, info.etaText)),
    J.islandOpen ? islandMore(p) : null,
  );
}

/** The bar under the island while you are on a quieter or risky stretch. */
function drawSegmentWarning(tier: Tier): void {
  const slot = top.querySelector<HTMLElement>('#seg-slot')!;
  const warn =
    tier === 'green'
      ? ''
      : `${tierIcon(tier)}${tier === 'yellow' ? ' Quieter stretch: stay alert' : ' Risky stretch: keep moving, stay on the main road'}`;
  if (slot.dataset.w === warn) return;
  slot.dataset.w = warn;
  clear(slot, warn ? h('div', { class: `seg-warn tier-${tier}` }, warn) : null);
}

function offRouteBox(J: Journey): HTMLElement | null {
  if (!J.offRoute) return null;
  return h(
    'div',
    { class: 'advice advice-caution' },
    h('strong', null, J.rerouting ? 'Finding a new safe route…' : 'You left the route'),
    !J.rerouting
      ? h('button', { class: 'btn small', on: { click: () => autoReroute() } }, 'Find a new safe route')
      : null,
  );
}

function betterRouteBox(J: Journey): HTMLElement | null {
  const b = J.better;
  if (!b || J.dismissedBetter) return null;
  const keep = () => {
    J.dismissedBetter = true;
    renderJourney();
  };
  return h(
    'div',
    { class: 'advice advice-ok better' },
    h('strong', null, 'Safer route available'),
    h(
      'p',
      null,
      `${fmtDuration(b.timeS)} from here, ${TIER_INFO[b.tier].label.toLowerCase()}. ${b.precautions.headline}.`,
    ),
    h(
      'div',
      { class: 'row2' },
      h(
        'button',
        {
          class: 'btn small primary',
          id: 'switch-route',
          on: { click: () => switchRoute(b, 'Switched to the safer route') },
        },
        'Switch',
      ),
      h('button', { class: 'btn small ghost', on: { click: keep } }, 'Keep mine'),
    ),
  );
}

function liveLinkNote(J: Journey): HTMLElement {
  if (J.handle) return h('p', { class: 'fine live' }, h('span', { class: 'live-dot' }), 'Live trip link is active');
  const why = isOnline()
    ? ''
    : navigator.onLine
      ? 'Live trip links and reviews need the SafeRaah server, which this website is not connected to yet. Guidance, check-ins and SOS still work.'
      : 'Offline: live sharing and reviews need an internet connection.';
  return h('p', { class: 'fine' }, why);
}

function drawSheet(J: Journey, p: Progress): void {
  const { info } = p;
  clear(
    sheet,
    offRouteBox(J),
    betterRouteBox(J),
    h(
      'div',
      { class: 'journey-row' },
      h(
        'div',
        null,
        h('div', { class: 'big-time' }, fmtDuration(info.remainS), h('span', { class: 'eta' }, info.etaText)),
        h('div', { class: 'meta' }, `${fmtDist(info.remainM)} left · ${MODE_INFO[S.settings.mode].label}`),
      ),
      h(
        'div',
        { class: 'journey-actions' },
        h('button', { class: 'btn', on: { click: () => shareTrip() } }, J.handle ? 'Share live' : 'Share'),
        h('button', { class: 'btn ghost', on: { click: () => endJourney(false) } }, 'End'),
      ),
    ),
    liveLinkNote(J),
    S.settings.simulate || DEMO ? h('p', { class: 'fine' }, 'Demo mode: your movement is simulated.') : null,
  );
}

let lastStepIdx = -1;

export function renderJourney() {
  const J = S.journey;
  if (!J) return;
  const p = progressOf(J);
  if (p.next.idx !== lastStepIdx && 'vibrate' in navigator && lastStepIdx >= 0) navigator.vibrate?.(60);
  lastStepIdx = p.next.idx;
  J.guide.update(p.k, p.info);
  drawIsland(J, p, voiceToggle());
  drawSegmentWarning(p.info.tier);
  drawSheet(J, p);
}
