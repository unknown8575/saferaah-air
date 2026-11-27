// Map gestures: tap a place, long-press anywhere, and naming a point by the nearest known place.
import { type LonLat } from '../../shared/geo.ts';
import { S, inCoverage, named, smap, toast, type Place } from './app.ts';
import { refreshAirLayer, refreshSafety } from './layers.ts';
import { openDirections } from './directions.ts';
import { renderCompass, renderFabs } from './fabs.ts';
import { updatePickLabel } from './pick.ts';
import { dropPin } from './place.ts';

// ---------- map gestures ----------
export function setupMapGestures() {
  const m = smap.map;
  const hitSomething = (pt: { x: number; y: number }) =>
    m.queryRenderedFeatures(
      [
        [pt.x - 8, pt.y - 8],
        [pt.x + 8, pt.y + 8],
      ],
      { layers: ['pois', 'routes-hit'].filter((l) => m.getLayer(l)) },
    ).length > 0;
  m.on('click', (e) => {
    if (hitSomething(e.point)) return;
    const p: LonLat = [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)];
    if (S.view === 'home' || S.view === 'place' || S.view === 'category') dropPin(p);
  });
  const longPress = (lngLat: { lng: number; lat: number }) => {
    const p: LonLat = [+lngLat.lng.toFixed(6), +lngLat.lat.toFixed(6)];
    if (S.view === 'directions' || S.view === 'details') {
      if (!inCoverage(p)) return outside();
      S.to = placeAt(p);
      S.userPicked = false;
      openDirections();
    } else if (S.view === 'home' || S.view === 'place' || S.view === 'category') dropPin(p);
  };
  m.on('contextmenu', (e) => longPress(e.lngLat));
  // iOS Safari never fires contextmenu on touch, so detect a long-press ourselves
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressAt: { x: number; y: number } | null = null;
  const cancel = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };
  m.on('touchstart', (e) => {
    if (e.originalEvent.touches.length !== 1) return cancel();
    pressAt = { x: e.point.x, y: e.point.y };
    const lngLat = e.lngLat;
    cancel();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      navigator.vibrate?.(30);
      longPress(lngLat);
    }, 600);
  });
  m.on('touchmove', (e) => {
    if (pressAt && Math.hypot(e.point.x - pressAt.x, e.point.y - pressAt.y) > 10) cancel();
  });
  m.on('touchend', cancel);
  m.on('touchcancel', cancel);
  m.on('movestart', (e) => {
    if (!(e as { originalEvent?: Event }).originalEvent) return;
    cancel();
    if (S.follow) {
      S.follow = false;
      renderFabs();
    }
  });
  m.on('rotate', () => renderCompass());
  let safetyTimer: ReturnType<typeof setTimeout>;
  m.on('moveend', () => {
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => {
      refreshSafety();
      refreshAirLayer();
    }, 250);
    if (S.view === 'pick') updatePickLabel();
  });
}

export function outside() {
  toast('That point is outside the area this map covers (Delhi NCT).');
}

/** A readable name for any point: a mapped place right there, or the street. */
export function nameFor(p: LonLat): { label: string; near?: string } {
  let best: { name: string } | null = null,
    bd = 250;
  for (const q of named) {
    const d = Math.hypot((q.lon - p[0]) * 97600, (q.lat - p[1]) * 111200);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  for (const q of S.pois) {
    if (!q.name) continue;
    const d = Math.hypot((q.lon - p[0]) * 97600, (q.lat - p[1]) * 111200);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  if (best && bd < 40) return { label: best.name };
  return { label: 'Dropped pin', near: best ? best.name : undefined };
}
export function placeAt(p: LonLat): Place {
  const n = nameFor(p);
  return {
    lonlat: p,
    label: n.label === 'Dropped pin' && n.near ? `Near ${n.near}` : n.label,
    sub: n.near && n.label === 'Dropped pin' ? `Near ${n.near}` : undefined,
  };
}
