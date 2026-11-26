// Route details: why a route is coloured as it is, its air, the safe places on the way and the turn list.
import { h, clear, fmtDuration, fmtDist } from './dom.ts';
import { icon, placeIcon } from './icons.ts';
import { save } from './store.ts';
import type { WorkerRoute } from './worker.ts';
import { TIER_INFO, type Tier } from '../../shared/router.ts';
import { CAT_INFO, type PoiCat } from '../../shared/places.ts';
import { MODE_INFO } from '../../shared/modes.ts';
import { airSection } from './airui.ts';
import { darkness } from '../../shared/time.ts';
import { S, clockText, now, setView, sheet, smap, tierSvg, hooks } from './app.ts';

import { showContacts } from './settings.ts';
import { startJourney } from './journey.ts';

export function tierBadge(r: { tier: Tier }) {
  const t = TIER_INFO[r.tier];
  return h('span', { class: `tier tier-${r.tier}` }, tierSvg(r.tier, 13), t.label);
}

export function havenLine(r: WorkerRoute): string {
  const parts: string[] = [];
  const order: PoiCat[] = ['police', 'hospital', 'pharmacy', 'station', 'fuel', 'shop', 'food'];
  const NOUN: Partial<Record<PoiCat, [string, string]>> = {
    police: ['police post', 'police posts'],
    hospital: ['hospital', 'hospitals'],
    pharmacy: ['medical store', 'medical stores'],
    station: ['metro/rail station', 'metro/rail stations'],
    fuel: ['petrol pump', 'petrol pumps'],
    shop: ['shop', 'shops'],
    food: ['eatery', 'eateries'],
  };
  for (const c of order) {
    const n = r.havens[c];
    if (n) parts.push(`${n} ${NOUN[c]![n > 1 ? 1 : 0]}`);
  }
  return parts.length ? `Open on the way: ${parts.slice(0, 3).join(', ')}` : 'Few places open on the way';
}

// ---------- details ----------
export function showDetails() {
  if (!S.reply?.routes.length) return;
  setView('details');
  const r = S.reply.routes[S.selected];
  smap.showRoutes(S.reply.routes, S.selected, { callouts: true, onSelect: (i) => hooks.selectRoute(i, true) });
  const contacts = S.settings.contacts;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const dark = darkness(now()) >= 0.5;
  clear(
    sheet,
    h('div', { class: 'grip' }),
    h(
      'div',
      { class: 'summary' },
      h(
        'button',
        {
          class: 'back',
          'aria-label': 'Back to routes',
          on: {
            click: () => {
              setView('directions');
              hooks.renderRoutes();
            },
          },
        },
        icon('back', 24),
      ),
      h(
        'div',
        { class: 'summary-text' },
        h('div', { class: 'big-time' }, fmtDuration(r.timeS), ' ', tierBadge(r)),
        h(
          'div',
          { class: 'meta' },
          `${fmtDist(r.lengthM)} by ${MODE_INFO[S.settings.mode].label.toLowerCase()}, arrive about ${clockText(new Date(now().getTime() + r.timeS * 1000))}`,
        ),
      ),
    ),
    h(
      'div',
      { class: 'pad' },
      h(
        'div',
        { class: `prec-box prec-${r.tier}` },
        h('h3', null, r.tier === 'green' ? 'Precautions' : 'Precautions for this route'),
        h('p', { class: 'prec-head' }, r.precautions.headline),
        r.precautions.items.length
          ? h(
              'ul',
              { class: 'prec-list' },
              r.precautions.items.map((t) => h('li', null, t)),
            )
          : null,
      ),
      h('h3', null, 'Why this colour'),
      h(
        'ul',
        { class: 'facts' },
        h('li', null, h('b', null, pct(r.mainRoadShare)), ' on main roads'),
        dark ? h('li', null, h('b', null, pct(r.litShare)), ' on roads that are usually lit') : null,
        h('li', null, h('b', null, pct(r.policeShare)), ' within 500 m of a police station'),
        h('li', null, h('b', null, String(r.havenIds.length)), ` places open along the way at ${clockText(now())}`),
        h('li', null, havenLine(r)),
      ),
      airSection(r, S.reply.routes, S.air?.pm25 ?? null, clockText(now()), () =>
        hooks.askSaans('How clean is the air on this route, and how can I breathe less on the way?'),
      ),
      r.dangerSpots.length
        ? [
            h('h3', null, 'Risky stretches'),
            h(
              'ul',
              { class: 'spots' },
              r.dangerSpots.map((d) =>
                h(
                  'li',
                  null,
                  h(
                    'button',
                    { class: 'linkish', on: { click: () => smap.map.flyTo({ center: [d.lon, d.lat], zoom: 16.5 }) } },
                    h('span', { class: 'warn-ic' }, '!'),
                    `${fmtDist(d.lengthM)}${d.street ? ' on ' + d.street : ''}: ${d.reasons.join(', ') || 'quiet at this hour'}`,
                  ),
                ),
              ),
            ),
          ]
        : null,
      r.havenList.length
        ? [
            h('h3', null, 'Safe places open on the way'),
            h(
              'ul',
              { class: 'havens' },
              r.havenList
                .slice(0, 8)
                .map((p) =>
                  h(
                    'li',
                    null,
                    h('span', { class: `pi cat-${p.cat}` }, icon(placeIcon(p.cat), 16)),
                    h('span', null, p.name || CAT_INFO[p.cat].label),
                    h('small', null, p.verified ? 'open now' : 'open now (estimated hours)'),
                  ),
                ),
            ),
          ]
        : null,
      h('h3', null, 'Tell when I reach'),
      h(
        'p',
        { class: 'fine lockline' },
        icon('lock', 14),
        'Your location stays on your phone. During the trip it is shared only for your live link and deleted when you arrive.',
      ),
      contacts.length
        ? h(
            'div',
            { class: 'chips' },
            contacts.map((c) =>
              h(
                'button',
                {
                  class: `chip${c.notify ? ' on' : ''}`,
                  'aria-pressed': c.notify ? 'true' : 'false',
                  on: {
                    click: () => {
                      c.notify = !c.notify;
                      S.settings = save({ contacts });
                      showDetails();
                    },
                  },
                },
                c.notify ? icon('check', 15, 2.4) : null,
                c.name,
              ),
            ),
            h('button', { class: 'chip', on: { click: () => showContacts() } }, '+ Add'),
          )
        : h(
            'p',
            null,
            h('button', { class: 'linkish', on: { click: () => showContacts() } }, 'Add a trusted contact'),
            ' to send an arrival message.',
          ),
      h(
        'details',
        { class: 'steps' },
        h('summary', null, 'Turn-by-turn directions'),
        h(
          'ol',
          null,
          r.steps.map((s) => h('li', null, s.text, s.distM ? h('small', null, ` ${fmtDist(s.distM)}`) : null)),
        ),
      ),
      h(
        'p',
        { class: 'fine' },
        'Scores describe the street environment at this hour (open places, police, busy roads, lighting, parks, live reports and traveller reviews). They help you choose; they cannot guarantee safety.',
      ),
    ),
    h(
      'div',
      { class: 'actions sticky' },
      h(
        'button',
        { class: 'btn primary wide', id: 'start', on: { click: () => startJourney() } },
        icon('navigate', 18),
        'Start journey',
      ),
    ),
  );
}
