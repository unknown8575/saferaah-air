// "Gym near me": the nearest places of a kind, with open state, from the on-device index.
import { h, clear, fmtDist } from './dom.ts';
import { icon, subIcon } from './icons.ts';
import { loadPlaces, placesReady, knownSubs, nearbyFor, type BrowsePlace } from './browse.ts';
import { matchIntent, kindCat, type Intent } from '../../shared/kinds.ts';
import { type LonLat } from '../../shared/geo.ts';
import { BASE, S, clockText, myLonLat, now, setView, sheet, smap, type Place, hooks, fitPad } from './app.ts';

// ---------- "gym near me": nearby places by kind ----------
export const intentFor = (q: string) => matchIntent(q, knownSubs());

/** Suggestion rows for a kind of place: the nearest 5–7, or similar places when none are close. */
export function intentRows(
  q: string,
  near: LonLat,
  pick: (p: BrowsePlace) => void,
  all: ((i: Intent) => void) | null,
  rerender: () => void,
): HTMLElement[] {
  const it = intentFor(q);
  if (!it) {
    if (!placesReady() && q.trim().length >= 3)
      loadPlaces(BASE).then(() => {
        if (intentFor(q)) rerender();
      });
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
  const rows: HTMLElement[] = [
    h(
      'li',
      { class: 'sect', role: 'presentation' },
      exact ? `${it.title} near ${isMe ? 'you' : 'here'}` : `No ${it.one} mapped nearby. Similar places:`,
    ),
  ];
  rows.push(
    ...res.map((p) =>
      h(
        'li',
        { role: 'option', tabindex: 0, class: 'kind-row', on: { click: () => pick(p) } },
        h('span', { class: `sic kind${p.similar ? ' sim' : ''}` }, icon(subIcon(p.sub), 18)),
        h(
          'span',
          { class: 'kr-main' },
          h('span', { class: 'kr-name' }, p.name),
          h('small', null, p.similar ? `Similar: ${p.label}` : p.label, ` · ${fmtDist(p.distM)}`),
        ),
        h(
          'span',
          { class: `open-pill ${p.open ? 'yes' : 'no'}` },
          p.open ? (p.verified ? 'Open' : 'Likely open') : 'Closed',
        ),
      ),
    ),
  );
  if (!res.length) rows.push(h('li', { class: 'empty' }, `Nothing like this is mapped within 15 km.`));
  else if (all)
    rows.push(
      h(
        'li',
        { role: 'option', tabindex: 0, class: 'see-all', id: 'see-all', on: { click: () => all(it) } },
        h('span', { class: 'sic me-ic' }, icon('map', 18)),
        h('span', null, `Show ${it.title.toLowerCase()} on the map`),
      ),
    );
  return rows;
}

export function browsePlace(p: BrowsePlace): Place {
  return { lonlat: [p.lon, p.lat], label: p.name, sub: p.label, kind: p.sub, cat: kindCat(p.sub), oh: p.oh };
}
export function openBrowsePlace(p: BrowsePlace) {
  hooks.showPlace(browsePlace(p), true);
}

/** All places of a kind near you, as a list and pins (like the category chips). */
type Found = ReturnType<typeof nearbyFor>[number];

/** One result: tap the row for its card, or the arrow for directions. */
function browseRow(p: Found): HTMLElement {
  const directions = () => {
    S.to = browsePlace(p);
    S.from = null;
    S.userPicked = false;
    hooks.openDirections();
  };
  return h(
    'li',
    null,
    h(
      'button',
      { class: 'place-row', on: { click: () => openBrowsePlace(p) } },
      h('span', { class: `pi cat-${kindCat(p.sub)}` }, icon(subIcon(p.sub), 18)),
      h(
        'div',
        null,
        h('b', null, p.name),
        h('small', null, `${p.similar ? 'Similar: ' : ''}${p.label} · ${fmtDist(p.distM)}`),
      ),
      h(
        'span',
        { class: `open-pill ${p.open ? 'yes' : 'no'}` },
        p.open ? (p.verified ? 'Open' : 'Likely open') : 'Closed',
      ),
    ),
    h(
      'button',
      { class: 'btn small go', 'aria-label': `Directions to ${p.name}`, on: { click: directions } },
      icon('navigate', 18),
    ),
  );
}

function browseHeading(it: Intent, exact: number, nearMe: boolean): HTMLElement {
  return h(
    'div',
    { class: 'list-head' },
    h('h2', null, exact ? `${it.title} nearby` : `Places like a ${it.one}`),
    h(
      'div',
      { class: 'meta' },
      exact
        ? `Nearest to ${nearMe ? 'you' : 'the map centre'}, open state at ${clockText(now())}`
        : `No ${it.one} is mapped near ${nearMe ? 'you' : 'here'}, so these are the closest similar places.`,
    ),
  );
}

export function showBrowse(it: Intent) {
  if (!placesReady()) {
    loadPlaces(BASE).then(() => showBrowse(it));
    return;
  }
  const me = myLonLat();
  const center: LonLat =
    me && smap.map.getBounds().contains(me) ? me : [smap.map.getCenter().lng, smap.map.getCenter().lat];
  setView('category');
  S.place = null;
  smap.setPlacePin();
  S.category = { key: `kind:${it.title}`, title: it.title, items: [] };
  hooks.renderSearchTop();
  const res = nearbyFor(it, center, now(), { min: 8, max: 25 });
  smap.setHits(
    res.map((p) => ({
      lon: p.lon,
      lat: p.lat,
      icon: subIcon(p.sub),
      open: p.open,
      label: `${p.name}, ${p.label}, ${p.open ? 'open' : 'closed'}`,
    })),
    (i) => openBrowsePlace(res[i]),
  );
  if (res.length) smap.fit([center, ...res.slice(0, 10).map((p) => [p.lon, p.lat] as LonLat)], fitPad());
  clear(
    sheet,
    h('div', { class: 'grip' }),
    browseHeading(it, res.filter((p) => !p.similar).length, !!me && center === me),
    h(
      'ul',
      { class: 'places' },
      res.length ? res.map(browseRow) : h('li', { class: 'empty' }, 'Nothing like this is mapped within 15 km yet.'),
    ),
    h('p', { class: 'note' }, 'Places come from OpenStreetMap; some shops may be missing or have moved.'),
  );
}
