// The search bar and the chips under it (N95 masks, purifiers, parks, metro, hospital).
import { h, clear } from './dom.ts';
import { icon, placeIcon } from './icons.ts';
import { matchIntent, namesLead } from '../../shared/kinds.ts';
import { CAT_INFO, type PoiCat } from '../../shared/places.ts';
import { type LonLat } from '../../shared/geo.ts';
import { S, myLonLat, search, smap, top } from './app.ts';
import { openMenu } from './menu.ts';
import { intentFor, intentRows, openBrowsePlace, showBrowse } from './nearby.ts';
import { showCategory } from './category.ts';
import { goHome } from './home.ts';
import { openHit } from './place.ts';

// ---------- top: search bar & chips ----------
/** Shortcut chips under the search bar: what a family needs on a smoggy day. */
export const CATS: { key: string; label: string; icon: string; cats?: PoiCat[]; intent?: string }[] = [
  { key: 'n95', label: 'N95 masks', icon: 'pharmacy', intent: 'n95 mask' },
  { key: 'purifier', label: 'Purifiers', icon: 'fan', intent: 'air purifier' },
  { key: 'park', label: 'Parks', icon: 'park', intent: 'park' },
  { key: 'station', label: 'Metro', icon: 'station', cats: ['station'] },
  { key: 'hospital', label: 'Hospitals', icon: 'hospital', cats: ['hospital', 'clinic'] },
];
/** Safety shortcuts stay available from the menu ("Safe places near me") and search. */
export const SAFETY_CATS: { key: string; label: string; icon: string; cats: PoiCat[] }[] = [
  { key: 'police', label: 'Police', icon: 'police', cats: ['police'] },
  { key: 'pharmacy', label: 'Medical stores', icon: 'pharmacy', cats: ['pharmacy'] },
  { key: 'fuel', label: 'Petrol pumps', icon: 'fuel', cats: ['fuel'] },
];
/** A chip either lists nearby places of a kind (intent) or a map category. */
export function openCat(key: string) {
  const c = CATS.find((x) => x.key === key);
  if (c?.intent) {
    const it = matchIntent(c.intent);
    if (it) {
      showBrowse(it);
      return;
    }
  }
  showCategory(key);
}

/** An option row in the suggestion list. */
function optionRow(run: () => void, ic: string, label: string, note?: string): HTMLElement {
  return h(
    'li',
    { role: 'option', tabindex: 0, on: { click: run } },
    h('span', { class: 'sic' }, icon(ic, 18)),
    h('span', null, label),
    note ? h('small', null, note) : null,
  );
}

/** What the suggestion list shows for a query: kinds of place, places by name, or the chips. */
function suggestions(q: string, done: (then: () => void) => () => void, rerender: () => void): HTMLElement[] {
  const near = (myLonLat() ?? [smap.map.getCenter().lng, smap.map.getCenter().lat]) as LonLat;
  const hits = search.query(q, intentFor(q) ? 4 : 7, near as [number, number]);
  const kinds = intentRows(
    q,
    near,
    (p) => done(() => openBrowsePlace(p))(),
    (it) => done(() => showBrowse(it))(),
    rerender,
  );
  const byName = hits.map((x) =>
    optionRow(
      done(() => openHit(x)),
      placeIcon(x.type),
      x.name,
      typeLabel(x.type),
    ),
  );
  // "Khan Market" is that market; "market" alone lists the markets near you first
  const items: HTMLElement[] = namesLead(q, hits[0]?.name)
    ? [...byName, ...kinds]
    : [
        ...kinds,
        ...(kinds.length && hits.length ? [h('li', { class: 'sect', role: 'presentation' }, 'Places by name')] : []),
        ...byName,
      ];
  if (q.length >= 2 && !items.length)
    items.push(
      h(
        'li',
        { class: 'empty' },
        `No place called “${q}” in Delhi. Try a nearby metro station or market, or tap the map.`,
      ),
    );
  if (q.length < 2)
    for (const c of CATS)
      items.push(
        optionRow(
          done(() => openCat(c.key)),
          c.icon,
          `${c.label} near you`,
        ),
      );
  return items;
}

/** The search field with its suggestion list. */
function searchField(): { input: HTMLInputElement; list: HTMLElement } {
  const input = h('input', {
    type: 'search',
    id: 'q',
    class: 'search-input',
    autocomplete: 'off',
    enterkeyhint: 'search',
    placeholder: 'Search here',
    'aria-label': 'Search for a place in Delhi',
    value: S.view === 'place' && S.place ? S.place.label : '',
  });
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  const close = () => {
    list.hidden = true;
    input.blur();
  };
  /** close the list, then run */
  const done = (then: () => void) => () => {
    close();
    then();
  };
  const render = () => {
    clear(list, suggestions(input.value, done, render));
    list.hidden = false;
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => {
    input.select();
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const intent = intentFor(input.value);
      if (intent) done(() => showBrowse(intent))();
      else (list.querySelector('li[role=option]') as HTMLElement | null)?.click();
    }
    if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 200));
  return { input, list };
}

function catChips(): HTMLElement {
  const active = (key: string) => S.view === 'category' && S.category?.key === key;
  return h(
    'div',
    { class: 'catchips', role: 'toolbar', 'aria-label': 'Find nearby' },
    CATS.map((c) =>
      h(
        'button',
        {
          class: `chip cat${active(c.key) ? ' on' : ''}`,
          'data-cat': c.key,
          on: { click: () => (active(c.key) ? goHome() : openCat(c.key)) },
        },
        icon(c.icon, 17),
        c.label,
      ),
    ),
  );
}

export function renderSearchTop() {
  const { input, list } = searchField();
  const hasPlace = S.view === 'place' || S.view === 'category';
  clear(
    top,
    h(
      'div',
      { class: 'searchbar' },
      h(
        'button',
        { class: 'sb-btn', 'aria-label': 'Menu', id: 'menu', on: { click: () => openMenu() } },
        icon('menu', 22),
      ),
      input,
      hasPlace
        ? h('button', { class: 'sb-btn', 'aria-label': 'Clear', on: { click: () => goHome() } }, icon('close', 20))
        : h('span', { class: 'logo', 'aria-hidden': 'true', title: 'SafeRaah Air' }),
      list,
    ),
    catChips(),
  );
}

export function typeLabel(t: string): string {
  if (t === 'street') return 'Street';
  if (t === 'station') return 'Metro / rail';
  const extra: Record<string, string> = {
    landmark: 'Landmark',
    park: 'Park',
    market: 'Market',
    school: 'School / college',
    office: 'Office',
    suburb: 'Area',
    neighbourhood: 'Area',
    quarter: 'Area',
    locality: 'Area',
  };
  if (extra[t]) return extra[t];
  return (
    (CAT_INFO as Record<string, { label: string }>)[t]?.label ??
    (t === 'place' ? 'Place' : t.charAt(0).toUpperCase() + t.slice(1))
  );
}
