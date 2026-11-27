// Planning routes in the worker and the route list: time, safety, air and the time/safety/air picker.
import { h, clear, fmtDuration, fmtDist } from './dom.ts';
import { icon } from './icons.ts';
import { save } from './store.ts';
import type { RouteReply, WorkerRoute } from './worker.ts';
import type { LonLat } from '../../shared/geo.ts';
import { TIER_INFO } from '../../shared/router.ts';
import { MODE_INFO, type Mode } from '../../shared/modes.ts';
import { airLine, priorityPicker } from './airui.ts';
import type { RouteSummary } from '../../shared/saans/assistant.ts';
import { S, clockText, fromLonLat, inCoverage, now, rpc, sheet, smap, toast, top, fitPad } from './app.ts';
import { startJourney } from './journey.ts';
import { notifyPhones } from './messages.ts';
import { showDetails, tierBadge } from './details.ts';
import { openDirections } from './directions.ts';
import { applyTheme } from './theme.ts';
import { startPick } from './pick.ts';

export let planSeq = 0;
/** Without a destination or a start, say what is missing and how to give it. */
function askForEnds(hasTo: boolean): void {
  const status = S.loc.status;
  const why =
    status === 'denied'
      ? 'Location is off, so we do not know where you are.'
      : status === 'asking' || status === 'idle'
        ? 'Finding your location…'
        : 'GPS is not available right now.';
  const focusStart = () => (document.getElementById('f-from') as HTMLInputElement | null)?.focus();
  const body = !hasTo
    ? h(
        'p',
        { class: 'hint' },
        'Where do you want to go? Search above, or ',
        h('button', { class: 'linkish', on: { click: () => startPick('to') } }, 'choose on the map'),
        '.',
      )
    : [
        h('h3', null, 'Where are you starting from?'),
        h('p', null, why),
        h(
          'div',
          { class: 'row2' },
          h(
            'button',
            { class: 'btn primary', id: 'pick-start', on: { click: () => startPick('from') } },
            icon('pin', 18),
            'Choose start on map',
          ),
          h('button', { class: 'btn', on: { click: focusStart } }, 'Search start'),
        ),
      ];
  S.reply = null;
  smap.clearRoutes();
  clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'pad' }, body));
}

function showPlanning(): void {
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
}

/** The fastest time for every mode, for the mode tabs (in the background). */
function fetchModeTimes(from: LonLat, to: LonLat, when: string, seq: number): void {
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
}

/** Keep the same kind of route selected when routes are re-planned after the user picked one. */
function keepSelection(reply: RouteReply): void {
  const prevLabel = S.reply?.routes[S.selected]?.labels[0];
  S.reply = reply;
  // the fastest route is shown first; the user decides
  S.selected =
    S.userPicked && prevLabel
      ? Math.max(
          0,
          reply.routes.findIndex((r) => r.labels[0] === prevLabel),
        )
      : 0;
}

const onRoutesScreen = () => S.view === 'directions' || S.view === 'details';

/** The worker's route request: the trip, plus the air now and the contacts (both shape the advice). */
function routeRequest(from: LonLat, to: LonLat, when: string) {
  const air = S.air;
  const smog = air?.weather?.smog.level;
  return {
    type: 'route' as const,
    from,
    to,
    mode: S.settings.mode,
    when,
    profile: S.settings.profile,
    pm25: air?.pm25 ?? null,
    contacts: notifyPhones(S.settings.contacts).length,
    aqi: air ? { value: air.aqi.value, band: air.aqi.band } : null,
    smogTrapped: smog === 'high' || smog === 'severe',
  };
}

export async function planRoutes(opts: { quiet?: boolean } = {}) {
  const from = fromLonLat();
  const to = S.to?.lonlat;
  smap.setEndpoints(S.from ? (from ?? undefined) : undefined, to);
  if (!to || !from) return askForEnds(!!to);
  if (!inCoverage(from) || !inCoverage(to)) return toast('Both points must be inside Delhi NCT for now.');
  const seq = ++planSeq;
  if (!opts.quiet) showPlanning();
  applyTheme();
  const when = now().toISOString();
  fetchModeTimes(from, to, when, seq);
  let reply: RouteReply;
  try {
    reply = (await rpc<{ reply: RouteReply }>(routeRequest(from, to, when))).reply;
  } catch (err) {
    if (seq !== planSeq) return;
    S.reply = null;
    const msg = 'Routing failed: ' + (err as Error).message;
    clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'pad' }, h('p', { class: 'error' }, msg)));
    return;
  }
  if (seq !== planSeq || !onRoutesScreen()) return;
  keepSelection(reply);
  if (S.view === 'details') showDetails();
  else renderRoutes();
  if (!opts.quiet && reply.routes.length)
    smap.fit(
      reply.routes.flatMap((x) => x.coords),
      fitPad(),
    );
}

export function updateModeTimes() {
  for (const b of top.querySelectorAll<HTMLButtonElement>('.mode-tab')) {
    const m = b.dataset.mode as Mode;
    const t = S.modeTimes[m];
    b.querySelector('small')!.textContent = t ? fmtDuration(t) : t === null ? '—' : '';
  }
}

export function selectRoute(i: number, fromMap = false) {
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

/** "Walking is risky now: take an auto" and the like, with a button to switch mode. */
function adviceBox(adv: RouteReply['advice']): HTMLElement | null {
  if (!adv || adv.level === 'ok') return null;
  const mode = adv.suggestMode;
  const switchMode = () => {
    if (!mode) return;
    S.settings = save({ mode, modePicked: true });
    S.userPicked = false;
    openDirections();
  };
  return h(
    'div',
    { class: `advice advice-${adv.level}` },
    h('strong', null, adv.title),
    h('p', null, adv.body),
    mode
      ? h(
          'button',
          { class: 'btn small', on: { click: switchMode } },
          `Show ${MODE_INFO[mode].label.toLowerCase()} routes`,
        )
      : null,
  );
}

const HIDDEN_LABELS = new Set(['Also safest', 'Alternative', 'Also cleanest']);

function routeLabels(r: WorkerRoute): HTMLElement[] {
  return r.labels
    .filter((l) => !HIDDEN_LABELS.has(l))
    .map((l) =>
      h(
        'span',
        { class: `lbl lbl-${l.toLowerCase().replace(/\s+/g, '-')}` },
        l === 'Cleanest air' ? [icon('leaf', 12), l] : l,
      ),
    );
}

/** One route: time, length, labels, safety colour, precautions and air. Tap again for details. */
function routeCard(r: WorkerRoute, i: number): HTMLElement {
  const on = i === S.selected;
  const tap = () => (S.selected === i ? showDetails() : selectRoute(i));
  return h(
    'li',
    null,
    h(
      'button',
      {
        class: `route-card${on ? ' sel' : ''}`,
        'aria-pressed': on ? 'true' : 'false',
        'data-tier': r.tier,
        on: { click: tap },
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
          routeLabels(r),
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
}

/** Notes under the list: why fewer routes, "fastest is also cleanest", one-way streets. */
function routeNotes(R: RouteReply): (HTMLElement | null)[] {
  const fastestIsCleanest = R.routes.some((x) => x.labels.includes('Also cleanest')) && R.routes.length > 1;
  const vehicleNote = S.settings.mode !== 'walk' && !S.onewayKnown;
  return [
    R.note ? h('p', { class: 'note' }, R.note) : null,
    fastestIsCleanest
      ? h(
          'p',
          { class: 'note air-note' },
          icon('leaf', 14),
          'The fastest route is also the cleanest air here: less time outside beats a detour.',
        )
      : null,
    vehicleNote ? h('p', { class: 'note' }, 'One-way streets are not in this map yet. Follow road signs.') : null,
  ];
}

/** A keyboard user picked the trip with Enter: the selected route card takes focus when it is drawn. */
let focusRoutes = false;
export function focusRoutesWhenReady(): void {
  focusRoutes = true;
}

export function renderRoutes() {
  const R = S.reply;
  if (!R) return;
  smap.showRoutes(R.routes, S.selected, { callouts: true, onSelect: (i) => selectRoute(i, true) });
  const n = R.routes.length;
  clear(
    sheet,
    h('div', { class: 'grip' }),
    R.error ? h('div', { class: 'pad' }, h('p', { class: 'error' }, R.error)) : null,
    adviceBox(R.airAdvice),
    adviceBox(R.advice),
    n
      ? h(
          'p',
          { class: 'decide' },
          `${n} route${n > 1 ? 's' : ''}, fastest first. The colour shows how safe each is at ${clockText(now())}. You choose.`,
        )
      : null,
    n > 1 ? priorityPicker(R.routes, S.selected, (i) => selectRoute(i)) : null,
    h('ol', { class: 'route-list', 'aria-label': 'Routes, fastest first' }, R.routes.map(routeCard)),
    ...routeNotes(R),
    R.routes[S.selected]
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
  if (focusRoutes) {
    focusRoutes = false;
    sheet.querySelector<HTMLElement>('.route-card.sel')?.focus();
  }
}

/** What Saans needs to know about the selected route. */
export function routeSummary(): RouteSummary | null {
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
