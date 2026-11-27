// The home screen: the air-first summary over the map.
import { h, clear } from './dom.ts';
import { airHome } from './airui.ts';
import { dayPlan } from '../../shared/saans/plan.ts';
import { darkness } from '../../shared/time.ts';
import { haversine } from '../../shared/geo.ts';
import { S, clockText, myLonLat, now, setView, sheet, smap } from './app.ts';
import { drawMe } from './here.ts';
import { askSaans } from './ask.ts';
import { openDirections } from './directions.ts';
import { startPick } from './pick.ts';
import { renderSearchTop } from './searchbar.ts';

// ---------- home ----------
export function goHome() {
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

export function renderHome() {
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
        airFailed: S.airTried && !S.air,
        plan,
        clock: clockText(now()),
        familySet: st.familySet,
        onAsk: () => askSaans(),
        onPlanTrip: () => {
          openDirections();
          (document.getElementById('f-to') as HTMLInputElement | null)?.focus();
        },
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
