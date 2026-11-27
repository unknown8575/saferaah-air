// Floating map buttons: compass, locate, layers and report.
import { h, clear } from './dom.ts';
import { icon } from './icons.ts';
import { S, fabs, myLonLat, smap } from './app.ts';
import { followCamera } from './journey-view.ts';
import { openReport } from './layers.ts';
import { openLayers } from './menu.ts';
import { locate } from './here.ts';

// ---------- floating map buttons ----------
export const compassBtn = h(
  'button',
  {
    class: 'fab compass',
    'aria-label': 'Point the map north',
    hidden: true,
    on: { click: () => smap.map.easeTo({ bearing: 0, pitch: 0 }) },
  },
  h('span', { class: 'needle', 'aria-hidden': 'true' }),
);
export function renderCompass() {
  const b = smap?.map.getBearing() ?? 0;
  compassBtn.hidden = Math.abs(b) < 1;
  (compassBtn.firstChild as HTMLElement).style.transform = `rotate(${-b}deg)`;
}
export function renderFabs() {
  const v = S.view;
  const show = ['home', 'place', 'category', 'directions', 'details', 'journey'].includes(v);
  fabs.hidden = !show;
  if (!show) return;
  const J = S.journey;
  const locState = myLonLat() ? (S.follow ? 'follow' : 'on') : S.loc.status === 'denied' ? 'off' : 'searching';
  clear(
    fabs,
    compassBtn,
    v !== 'journey'
      ? h(
          'button',
          {
            class: 'fab',
            id: 'layers-btn',
            'aria-label': 'Map layers',
            title: 'Map layers',
            on: { click: () => openLayers() },
          },
          icon('layers', 22),
        )
      : null,
    h(
      'button',
      {
        class: 'fab report-fab',
        id: 'report-btn',
        'aria-label': 'Report smoke, dust or a problem here',
        title: 'Report',
        on: { click: () => openReport() },
      },
      icon('alert', 22),
    ),
    J
      ? S.follow
        ? null
        : h(
            'button',
            {
              class: 'fab wide-fab',
              id: 'recenter',
              on: {
                click: () => {
                  S.follow = true;
                  renderFabs();
                  if (S.myPos) followCamera(S.myPos);
                },
              },
            },
            icon('navigate', 18),
            'Re-centre',
          )
      : h(
          'button',
          {
            class: `fab locate ${locState}`,
            id: 'locate',
            'aria-label': 'Show my location',
            title: 'My location',
            on: { click: () => locate() },
          },
          icon(locState === 'follow' ? 'navigate' : 'locate', 22),
        ),
  );
  renderCompass();
}
