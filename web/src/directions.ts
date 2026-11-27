// The directions panel: start and destination fields, swap, travel mode and departure time.
import { h, clear, fmtDuration } from './dom.ts';
import { type Hit } from './search.ts';
import { icon, placeIcon } from './icons.ts';
import { save } from './store.ts';
import { MODE_INFO, MODES, type Mode } from '../../shared/modes.ts';
import { istTime } from '../../shared/time.ts';
import { type LonLat } from '../../shared/geo.ts';
import type { Profile } from '../../shared/risk.ts';
import { S, fromLonLat, myLonLat, search, setView, smap, top, type Place } from './app.ts';
import { browsePlace, intentFor, intentRows } from './nearby.ts';
import { explainNoLocation } from './here.ts';
import { goHome } from './home.ts';
import { applyTheme, timeToday } from './theme.ts';
import { startPick } from './pick.ts';
import { refreshPois, showPlace } from './place.ts';
import { planRoutes } from './routes-panel.ts';
import { typeLabel } from './searchbar.ts';

// ---------- directions ----------
type End = 'from' | 'to';

/** Set the start or the destination, then show directions again. */
function setEnd(which: End, p: Place | null): void {
  if (which === 'from') S.from = p;
  else S.to = p;
  S.userPicked = false;
  openDirections();
}

/** Picking a suggestion: a place, your own location, or "choose on map". */
function chooseEnd(which: End, hit: Hit | 'me' | 'map'): void {
  if (hit === 'map') return startPick(which);
  if (hit !== 'me') return setEnd(which, { lonlat: [hit.lon, hit.lat] as LonLat, label: hit.name });
  const me = myLonLat();
  if (!me) return explainNoLocation();
  setEnd(which, which === 'from' ? null : { lonlat: me, label: 'Your location', mine: true });
}

function row(run: () => void, ...kids: (HTMLElement | string | null)[]): HTMLElement {
  return h('li', { role: 'option', tabindex: 0, on: { click: run } }, ...kids);
}

/** Suggestions for a start / destination field. */
function endSuggestions(which: End, q: string, done: (then: () => void) => () => void, rerender: () => void) {
  const near = fromLonLat() ?? [77.215, 28.6];
  const hits = search.query(q, intentFor(q) ? 4 : 7, near as [number, number]);
  const items: HTMLElement[] = [
    row(
      done(() => chooseEnd(which, 'me')),
      h('span', { class: 'sic me-ic' }, icon('locate', 18)),
      'Your location',
      !myLonLat() ? h('small', null, 'not found yet') : null,
    ),
    // "gym": the nearest gyms (or similar) to the other end of the trip
    ...intentRows(q, near as LonLat, (p) => done(() => setEnd(which, browsePlace(p)))(), null, rerender),
    ...hits.map((x) =>
      row(
        done(() => chooseEnd(which, x)),
        h('span', { class: 'sic' }, icon(placeIcon(x.type), 18)),
        h('span', null, x.name),
        h('small', null, typeLabel(x.type)),
      ),
    ),
    row(
      done(() => chooseEnd(which, 'map')),
      h('span', { class: 'sic' }, icon('pin', 18)),
      'Choose on map',
    ),
  ];
  if (q.length >= 2 && !hits.length)
    items.splice(
      1,
      0,
      h('li', { class: 'empty' }, `No place called “${q}” in Delhi. Try a nearby metro station or market.`),
    );
  return items;
}

export function placeField(which: End): HTMLElement {
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
  const done = (then: () => void) => () => {
    list.hidden = true;
    input.blur();
    then();
  };
  const render = () => {
    clear(list, endSuggestions(which, input.value === 'Your location' ? '' : input.value, done, render));
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

/** Departure time changed (or reset to now): the theme, open places and routes follow it. */
function setLeaveAt(d: Date | null): void {
  S.leaveAt = d;
  applyTheme();
  refreshPois();
  openDirections();
}

function whoSelect(): HTMLSelectElement {
  const who = h(
    'select',
    { class: 'who-select', 'aria-label': 'Who is travelling', id: 'who' },
    (
      [
        ['general', 'Family'],
        ['child', 'Child alone'],
        ['woman', 'Woman alone'],
      ] as [Profile, string][]
    ).map(([v, l]) => h('option', { value: v, selected: S.settings.profile === v }, l)),
  );
  who.addEventListener('change', () => {
    S.settings = save({ profile: who.value as Profile });
    openDirections();
  });
  return who;
}

/** One tab per travel mode, each with its fastest time. */
function modeTabs(): HTMLElement {
  const pick = (m: Mode) => () => {
    if (m === S.settings.mode) return;
    S.settings = save({ mode: m });
    S.userPicked = false;
    openDirections();
  };
  return h(
    'div',
    { class: 'modes', role: 'tablist', 'aria-label': 'How are you travelling' },
    MODES.map((m) => {
      const t = S.modeTimes[m];
      const on = m === S.settings.mode;
      return h(
        'button',
        {
          class: `mode-tab${on ? ' on' : ''}`,
          role: 'tab',
          'aria-selected': on ? 'true' : 'false',
          'data-mode': m,
          on: { click: pick(m) },
        },
        icon(m, 20),
        h('span', { class: 'sr-only' }, `${MODE_INFO[m].label} `),
        h('small', null, t ? fmtDuration(t) : t === null ? '—' : ''),
      );
    }),
  );
}

function departureOptions(): HTMLElement {
  const timeInput = h('input', {
    type: 'time',
    class: 'time-input',
    'aria-label': 'Leave at',
    value: S.leaveAt ? isoClock(S.leaveAt) : '',
  });
  timeInput.addEventListener('change', () => setLeaveAt(timeInput.value ? timeToday(timeInput.value) : null));
  return h(
    'div',
    { class: 'dir-opts' },
    whoSelect(),
    h('button', { class: `chip mini${S.leaveAt ? '' : ' on'}`, on: { click: () => setLeaveAt(null) } }, 'Leave now'),
    h('label', { class: `chip mini time${S.leaveAt ? ' on' : ''}` }, 'at ', timeInput),
  );
}

export function renderDirectionsTop() {
  const close = () => (S.to ? showPlace(S.to, false) : goHome());
  clear(
    top,
    h(
      'div',
      { class: 'dir-panel' },
      h(
        'div',
        { class: 'dir-fields' },
        h('button', { class: 'back', 'aria-label': 'Close directions', on: { click: close } }, icon('back', 24)),
        h('div', { class: 'fields' }, placeField('from'), placeField('to')),
        h(
          'button',
          { class: 'swap', 'aria-label': 'Swap start and destination', id: 'swap', on: { click: () => swapEnds() } },
          icon('swap', 20),
        ),
      ),
      modeTabs(),
      departureOptions(),
    ),
  );
}

export function swapEnds() {
  const a = S.from ?? (myLonLat() ? { lonlat: myLonLat()!, label: 'Your location', mine: true } : null);
  const b = S.to;
  S.to = a;
  S.from = b?.mine ? null : b;
  S.userPicked = false;
  openDirections();
}

export function isoClock(d: Date): string {
  const m = istTime(d).minutes;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function openDirections() {
  if (S.view !== 'directions') setView('directions');
  smap.setPlacePin();
  smap.setHits([]);
  renderDirectionsTop();
  planRoutes();
}
