// MapLibre map: the base map (basemap.ts) with the app's overlays (street colours, places,
// routes, markers) on top.
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 loads its tile worker from a separate self-contained module
import mlWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CAT_INFO, type Poi, type PoiCat } from '../../shared/places.ts';
import type { LonLat } from '../../shared/geo.ts';
import type { WorkerRoute } from './worker.ts';
import { icon } from './icons.ts';
import {
  AIR_COLOR,
  RISK_COLOR,
  TRAFFIC_KEY,
  baseStyle,
  calloutEl,
  calloutPoint,
  dangerPinEl,
  dangerPopupHtml,
  routeLines,
  circlePolygon,
  pinEl,
  type FeatureCollection,
  type Theme,
} from './basemap.ts';

export { loadBasemap, hasTraffic, escapeHtml, type Theme } from './basemap.ts';

maplibregl.setWorkerUrl(mlWorkerUrl);

export class SafeMap {
  map: MLMap;
  private markers: maplibregl.Marker[] = [];
  private callouts: maplibregl.Marker[] = [];
  private hitMarkers: maplibregl.Marker[] = [];
  private reportMarkers: maplibregl.Marker[] = [];
  private fromM?: maplibregl.Marker;
  private toM?: maplibregl.Marker;
  private placeM?: maplibregl.Marker;
  private meM?: maplibregl.Marker;
  private meEl?: HTMLElement;
  theme: Theme = 'day';
  ready: Promise<void>;
  private vis = { safety: true, traffic: false, pois: true, air: false };
  private safetyDim = false;
  private routeKey = '';
  private drawAnim = 0;

  constructor(
    el: HTMLElement,
    private base: string,
    private bounds: [number, number, number, number],
  ) {
    this.map = new maplibregl.Map({
      container: el,
      style: baseStyle('day', base, bounds),
      center: [77.17, 28.63],
      zoom: 10.6,
      maxBounds: [
        [bounds[0] - 0.08, bounds[1] - 0.06],
        [bounds[2] + 0.08, bounds[3] + 0.06],
      ],
      attributionControl: { compact: true },
      pitchWithRotate: false,
      bearingSnap: 12,
      maxPitch: 50,
    });
    this.ready = new Promise((res) =>
      this.map.once('load', () => {
        this.addOverlays();
        res();
      }),
    );
  }

  /** Layers drawn over the base map, bottom to top. */
  private addOverlays() {
    this.addTraffic();
    this.addStreetColours();
    this.addAccuracy();
    this.addPlaces();
    this.addRouteLines();
  }

  /** Live traffic tiles (only with a TomTom key). */
  private addTraffic() {
    const m = this.map;
    if (TRAFFIC_KEY) {
      m.addSource('traffic', {
        type: 'raster',
        tileSize: 256,
        tiles: [
          `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(TRAFFIC_KEY)}`,
        ],
        attribution: 'Traffic © TomTom',
      });
      m.addLayer({
        id: 'traffic',
        type: 'raster',
        source: 'traffic',
        minzoom: 10,
        layout: { visibility: this.vis.traffic ? 'visible' : 'none' },
        paint: { 'raster-opacity': 0.85 },
      });
    }
  }

  /** Every street coloured by estimated air or by safety right now. */
  private addStreetColours() {
    const m = this.map;
    const empty = { type: 'FeatureCollection' as const, features: [] };
    m.addSource('air', { type: 'geojson', data: empty });
    m.addLayer({
      id: 'air',
      type: 'line',
      source: 'air',
      minzoom: 12.5,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: this.vis.air ? 'visible' : 'none' },
      paint: {
        'line-color': AIR_COLOR as never,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12.5, 1.5, 16, 4, 18, 9],
        'line-opacity': 0.6,
        'line-blur': 1,
      },
    });
    m.addSource('safety', { type: 'geojson', data: empty });
    m.addLayer({
      id: 'safety',
      type: 'line',
      source: 'safety',
      minzoom: 13.5,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: this.vis.safety ? 'visible' : 'none' },
      paint: {
        'line-color': RISK_COLOR as never,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 1, 16, 2.6, 18, 6],
        'line-opacity': this.safetyDim ? 0.25 : 0.55,
      },
    });
  }

  /** The blue circle of GPS accuracy around you. */
  private addAccuracy() {
    const m = this.map;
    const empty = { type: 'FeatureCollection' as const, features: [] };
    m.addSource('acc', { type: 'geojson', data: empty });
    m.addLayer({ id: 'acc', type: 'fill', source: 'acc', paint: { 'fill-color': '#3d5afe', 'fill-opacity': 0.12 } });
    m.addLayer({
      id: 'acc-line',
      type: 'line',
      source: 'acc',
      paint: { 'line-color': '#3d5afe', 'line-opacity': 0.35, 'line-width': 1 },
    });
  }

  /** Safe places (open ones filled in) and their names when zoomed in. */
  private addPlaces() {
    const m = this.map;
    const empty = { type: 'FeatureCollection' as const, features: [] };
    m.addSource('pois', { type: 'geojson', data: empty });
    m.addLayer({
      id: 'pois',
      type: 'circle',
      source: 'pois',
      layout: { visibility: this.vis.pois ? 'visible' : 'none' },
      // the most important places first; shops and eateries only when zoomed right in
      filter: [
        'any',
        ['>=', ['zoom'], 17.2],
        ['all', ['>=', ['zoom'], 13], ['in', ['get', 'cat'], ['literal', ['police', 'hospital']]]],
        [
          'all',
          ['>=', ['zoom'], 15],
          ['in', ['get', 'cat'], ['literal', ['pharmacy', 'clinic', 'station', 'fuel', 'govt']]],
        ],
      ],
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12,
          ['match', ['get', 'cat'], ['police', 'hospital'], 3.5, 2],
          17,
          8,
        ],
        'circle-color': [
          'case',
          ['==', ['get', 'open'], 1],
          ['get', 'color'],
          this.theme === 'night' ? '#141433' : '#ffffff',
        ],
        'circle-stroke-color': ['case', ['==', ['get', 'open'], 1], '#ffffff', '#8a89a8'],
        'circle-stroke-width': 1.4,
      },
    });
    m.addLayer({
      id: 'poi-label',
      type: 'symbol',
      source: 'pois',
      minzoom: 16.2,
      filter: [
        'any',
        ['>=', ['zoom'], 17.5],
        ['in', ['get', 'cat'], ['literal', ['police', 'hospital', 'pharmacy', 'clinic', 'station', 'fuel', 'govt']]],
      ],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['noto'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-max-width': 9,
        'text-optional': true,
        visibility: this.vis.pois ? 'visible' : 'none',
      },
      paint: {
        'text-color': this.theme === 'night' ? '#c9c8ea' : '#3b3a5c',
        'text-halo-color': this.theme === 'night' ? '#141433' : '#ffffff',
        'text-halo-width': 1.5,
      },
    });
  }

  /** Route lines (the selected one on top, wider) and the live trip track. */
  private addRouteLines() {
    const m = this.map;
    const empty = { type: 'FeatureCollection' as const, features: [] };
    m.addSource('routes', { type: 'geojson', data: empty });
    m.addLayer({
      id: 'routes-casing',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'z'] },
      paint: {
        'line-color': ['case', ['==', ['get', 'sel'], 1], '#ffffff', this.theme === 'night' ? '#2a2950' : '#ffffff'],
        'line-width': ['case', ['==', ['get', 'sel'], 1], 12, 8],
        'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.8],
      },
    });
    m.addLayer({
      id: 'routes',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'z'] },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'sel'], 1], 8, 5],
        'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.5],
      },
    });
    // a wide invisible line so routes are easy to tap with a finger
    m.addLayer({
      id: 'routes-hit',
      type: 'line',
      source: 'routes',
      paint: { 'line-color': '#000', 'line-width': 26, 'line-opacity': 0.001 },
    });
    m.addSource('track', { type: 'geojson', data: empty });
    m.addLayer({
      id: 'track',
      type: 'line',
      source: 'track',
      paint: { 'line-color': '#2E2A78', 'line-width': 3, 'line-dasharray': [1, 1.5] },
    });
  }

  /** Last data for each overlay, re-applied after a style (day/night) change. */
  private overlay: Record<string, FeatureCollection> = {};
  private setOverlay(id: 'pois' | 'routes' | 'track' | 'safety' | 'acc' | 'air', data: FeatureCollection) {
    this.overlay[id] = data;
    this.ready.then(() => (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data as never));
  }

  setTheme(theme: Theme): Promise<void> {
    if (theme === this.theme) return this.ready;
    this.theme = theme;
    const prev = this.ready;
    this.ready = prev.then(async () => {
      const loaded = new Promise<void>((res) => this.map.once('style.load', () => res()));
      this.map.setStyle(baseStyle(theme, this.base, this.bounds), { diff: false });
      await loaded;
      this.addOverlays();
      for (const [id, data] of Object.entries(this.overlay))
        (this.map.getSource(id) as GeoJSONSource).setData(data as never);
    });
    return this.ready;
  }

  setLayerVisible(id: 'safety' | 'traffic' | 'pois' | 'air', on: boolean) {
    this.vis[id] = on;
    this.ready.then(() => {
      const ids = id === 'pois' ? ['pois', 'poi-label'] : [id];
      for (const l of ids)
        if (this.map.getLayer(l)) this.map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
    });
  }
  /** Fade the street-safety layer while routes are on screen, so the routes stand out. */
  dimSafety(dim: boolean) {
    if (this.safetyDim === dim) return;
    this.safetyDim = dim;
    this.ready.then(
      () => this.map.getLayer('safety') && this.map.setPaintProperty('safety', 'line-opacity', dim ? 0.25 : 0.55),
    );
  }
  setSafety(fc: FeatureCollection) {
    this.setOverlay('safety', fc);
  }
  setAir(fc: FeatureCollection) {
    this.setOverlay('air', fc);
  }

  setPois(pois: Poi[], open?: Uint8Array) {
    const colorOf: Partial<Record<PoiCat, string>> = {
      police: '#2E2A78',
      hospital: '#C2185B',
      clinic: '#C2185B',
      pharmacy: '#00897B',
      station: '#5E35B1',
      fuel: '#6D4C41',
      govt: '#455A64',
      liquor: '#9E9E9E',
    };
    const feats = pois
      .filter((p) => CAT_INFO[p.cat].haven >= 0.4 || p.cat === 'liquor')
      .map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        properties: {
          id: p.id,
          cat: p.cat,
          name: p.name,
          open: open ? open[p.id] : 1,
          color: colorOf[p.cat] ?? '#7E57C2',
        },
      }));
    this.setOverlay('pois', { type: 'FeatureCollection', features: feats });
  }

  onPoiClick(cb: (id: number) => void) {
    this.ready.then(() => {
      this.map.on('click', 'pois', (e) => {
        const f = e.features?.[0];
        if (f) {
          (e as unknown as { handled?: boolean }).handled = true;
          cb(Number(f.properties.id));
        }
      });
      this.map.on('mouseenter', 'pois', () => (this.map.getCanvas().style.cursor = 'pointer'));
      this.map.on('mouseleave', 'pois', () => (this.map.getCanvas().style.cursor = ''));
    });
  }

  showRoutes(
    routes: WorkerRoute[],
    selected: number,
    opts: { callouts?: boolean; onSelect?: (i: number) => void } = {},
  ) {
    const build = (frac: number) => routeLines(routes, selected, frac);
    // new routes draw themselves from start to destination; changing the selection does not
    const key = routes.map((r) => `${r.coords.length}:${Math.round(r.timeS)}`).join('|');
    const animate = !!opts.callouts && key !== this.routeKey && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.routeKey = key;
    cancelAnimationFrame(this.drawAnim);
    if (animate) {
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / 800);
        this.setOverlay('routes', build(1 - Math.pow(1 - k, 3)));
        if (k < 1) this.drawAnim = requestAnimationFrame(step);
      };
      this.drawAnim = requestAnimationFrame(step);
    } else this.setOverlay('routes', build(1));
    this.clearMarkers();
    for (const c of this.callouts) c.remove();
    this.callouts = [];
    if (opts.callouts && routes.length) {
      routes.forEach((r, i) => {
        const el = calloutEl(r, i, i === selected, animate, () => opts.onSelect?.(i));
        const mk = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] })
          .setLngLat(calloutPoint(routes, i))
          .addTo(this.map);
        if (i === selected) mk.getElement().style.zIndex = '3';
        this.callouts.push(mk);
      });
    }
    const r = routes[selected];
    if (r)
      for (const d of r.dangerSpots) {
        const pop = new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(dangerPopupHtml(d));
        this.markers.push(
          new maplibregl.Marker({ element: dangerPinEl(d) }).setLngLat([d.lon, d.lat]).setPopup(pop).addTo(this.map),
        );
      }
  }

  onRouteClick(cb: (i: number) => void) {
    this.ready.then(() => {
      this.map.on('click', 'routes-hit', (e) => {
        const f = e.features?.[0];
        if (f) {
          (e as unknown as { handled?: boolean }).handled = true;
          cb(Number(f.properties.i));
        }
      });
      this.map.on('mouseenter', 'routes-hit', () => (this.map.getCanvas().style.cursor = 'pointer'));
      this.map.on('mouseleave', 'routes-hit', () => (this.map.getCanvas().style.cursor = ''));
    });
  }

  clearRoutes() {
    cancelAnimationFrame(this.drawAnim);
    this.routeKey = '';
    this.setOverlay('routes', { type: 'FeatureCollection', features: [] });
    this.clearMarkers();
    for (const c of this.callouts) c.remove();
    this.callouts = [];
  }

  private clearMarkers() {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }

  setEndpoints(from?: LonLat, to?: LonLat) {
    const pin = (cls: string, label: string) => pinEl(cls, label);
    this.fromM?.remove();
    this.toM?.remove();
    this.fromM = this.toM = undefined;
    if (from) this.fromM = new maplibregl.Marker({ element: pin('pin-from', 'Start') }).setLngLat(from).addTo(this.map);
    if (to)
      this.toM = new maplibregl.Marker({ element: pin('pin-to', 'Destination'), anchor: 'bottom' })
        .setLngLat(to)
        .addTo(this.map);
  }

  /** The red pin for a place the user tapped or searched. */
  setPlacePin(p?: LonLat) {
    this.placeM?.remove();
    this.placeM = undefined;
    if (!p) return;
    const el = pinEl('pin-to pin-drop', 'Selected place');
    this.placeM = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(p).addTo(this.map);
  }

  /** Results of a category search (police, hospitals…) as tappable pins. */
  setHits(
    hits: { lon: number; lat: number; icon: string; open: boolean; label: string }[],
    onClick?: (i: number) => void,
  ) {
    for (const m of this.hitMarkers) m.remove();
    this.hitMarkers = hits.map((x, i) => {
      const el = document.createElement('button');
      el.className = `hit-pin${x.open ? '' : ' closed'}`;
      el.appendChild(icon(x.icon, 16, 2));
      el.setAttribute('aria-label', x.label);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick?.(i);
      });
      return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([x.lon, x.lat]).addTo(this.map);
    });
  }

  /** Live safety reports from other travellers. */
  setReports(
    list: { id: string; lon: number; lat: number; icon: string; label: string; danger: boolean; air?: boolean }[],
    onClick: (id: string, el: HTMLElement) => void,
  ) {
    for (const m of this.reportMarkers) m.remove();
    this.reportMarkers = list.map((r) => {
      const el = document.createElement('button');
      el.className = `report-pin${r.air ? ' air' : r.danger ? '' : ' good'}`;
      el.appendChild(icon(r.icon, 16, 2.1));
      el.dataset.id = r.id;
      el.setAttribute('aria-label', `Live report: ${r.label}`);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(r.id, el);
      });
      return new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(this.map);
    });
  }

  popup(at: LonLat, content: HTMLElement): maplibregl.Popup {
    return new maplibregl.Popup({ offset: 18, maxWidth: '280px' }).setLngLat(at).setDOMContent(content).addTo(this.map);
  }

  /** Blue dot with accuracy circle and a heading cone (when we know which way you face). */
  setMe(p?: LonLat, accM = 0, heading: number | null = null, manual = false) {
    if (!p) {
      this.meM?.remove();
      this.meM = undefined;
      this.setOverlay('acc', { type: 'FeatureCollection', features: [] });
      return;
    }
    if (!this.meM) {
      const el = document.createElement('div');
      el.className = 'me';
      el.innerHTML = '<div class="me-cone"></div><div class="me-dot"></div>';
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', 'You are here');
      this.meEl = el;
      this.meM = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'viewport' })
        .setLngLat(p)
        .addTo(this.map);
    } else this.meM.setLngLat(p);
    this.meEl!.classList.toggle('manual', manual);
    this.meEl!.classList.toggle('has-heading', heading != null);
    if (heading != null) this.meM.setRotation(heading);
    this.setOverlay('acc', {
      type: 'FeatureCollection',
      features:
        accM > 15
          ? [
              {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [circlePolygon(p[0], p[1], Math.min(accM, 2000))] },
                properties: {},
              },
            ]
          : [],
    });
  }

  setTrack(coords: LonLat[]) {
    this.setOverlay('track', {
      type: 'FeatureCollection',
      features:
        coords.length > 1
          ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
          : [],
    });
  }

  fit(coords: LonLat[], pad: maplibregl.PaddingOptions) {
    if (!coords.length) return;
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    for (const c of coords) b.extend(c);
    this.map.fitBounds(b, { padding: pad, maxZoom: 16.5, duration: 600, bearing: 0, pitch: 0 });
  }
}
