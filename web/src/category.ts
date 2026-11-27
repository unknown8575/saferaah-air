// Category results: the nearest safe places of a kind (police, hospitals, pharmacies...).
import type { NearbyPlace } from './worker-api.ts';
import { h, clear, fmtDist } from './dom.ts';
import { icon, placeIcon } from './icons.ts';
import { CAT_INFO, type PoiCat } from '../../shared/places.ts';
import { type LonLat } from '../../shared/geo.ts';
import { S, clockText, myLonLat, now, rpc, setView, sheet, smap, fitPad } from './app.ts';
import { openDirections } from './directions.ts';
import { openPoi } from './place.ts';
import { CATS, SAFETY_CATS, renderSearchTop } from './searchbar.ts';

// ---------- category results ----------
type Cat = { key: string; label: string; icon: string; cats: PoiCat[] };
const SAFE: Cat = {
  key: 'safe',
  label: 'Safe places',
  icon: 'police',
  cats: ['police', 'hospital', 'pharmacy', 'clinic', 'station', 'fuel'],
};

const catOf = (key: string): Cat =>
  key === 'safe'
    ? SAFE
    : ((CATS.find((x) => x.key === key && x.cats) ?? SAFETY_CATS.find((x) => x.key === key))! as Cat);

const nameOf = (p: NearbyPlace) => p.name || CAT_INFO[p.cat].label;

function categoryRow(p: NearbyPlace): HTMLElement {
  const directions = () => {
    S.to = { lonlat: [p.lon, p.lat], label: nameOf(p) };
    S.from = null;
    S.userPicked = false;
    openDirections();
  };
  return h(
    'li',
    null,
    h(
      'button',
      { class: 'place-row', on: { click: () => openPoi(p.id) } },
      h('span', { class: `pi cat-${p.cat}` }, icon(placeIcon(p.cat), 18)),
      h('div', null, h('b', null, nameOf(p)), h('small', null, `${CAT_INFO[p.cat].label} · ${fmtDist(p.distM)}`)),
      h(
        'span',
        { class: `open-pill ${p.open ? 'yes' : 'no'}` },
        p.open ? (p.verified ? 'Open' : 'Likely open') : 'Closed',
      ),
    ),
    h(
      'button',
      { class: 'btn small go', 'aria-label': `Directions to ${nameOf(p)}`, on: { click: directions } },
      icon('navigate', 18),
    ),
  );
}

function showOnMap(places: NearbyPlace[], center: LonLat): void {
  smap.setHits(
    places.map((p) => ({
      lon: p.lon,
      lat: p.lat,
      icon: placeIcon(p.cat),
      open: p.open,
      label: `${nameOf(p)}, ${p.open ? 'open' : 'closed'}`,
    })),
    (i) => openPoi(places[i].id),
  );
  if (places.length) smap.fit([center, ...places.slice(0, 10).map((p) => [p.lon, p.lat] as LonLat)], fitPad());
}

export async function showCategory(key: string) {
  const c = catOf(key);
  const me = myLonLat();
  const center: LonLat =
    me && smap.map.getBounds().contains(me) ? me : [smap.map.getCenter().lng, smap.map.getCenter().lat];
  setView('category');
  S.place = null;
  smap.setPlacePin();
  S.category = { key, title: c.label, items: [] };
  renderSearchTop();
  clear(sheet, h('div', { class: 'grip' }), h('div', { class: 'loading small' }, h('div', { class: 'spinner' })));
  const r = await rpc<{ places: NearbyPlace[] }>({
    type: 'nearby',
    at: center,
    when: now().toISOString(),
    radiusM: 3000,
    cats: c.cats,
    sort: key === 'safe' ? 'open' : 'dist',
    limit: 25,
  });
  if (S.view !== 'category' || S.category?.key !== key) return;
  S.category.items = r.places;
  showOnMap(r.places, center);
  const where = me && center === me ? 'you' : 'the map centre';
  clear(
    sheet,
    h('div', { class: 'grip' }),
    h(
      'div',
      { class: 'list-head' },
      h('h2', null, `${c.label} nearby`),
      h('div', { class: 'meta' }, `Within 3 km of ${where}, open state at ${clockText(now())}`),
    ),
    h(
      'ul',
      { class: 'places' },
      r.places.length
        ? r.places.map(categoryRow)
        : h('li', { class: 'empty' }, 'Nothing like this is mapped within 3 km. Call 112 if you need help.'),
    ),
  );
}
