// The layers sheet and the main menu (air tools first, family safety in its own section).
import { h } from './dom.ts';
import { hasTraffic } from './map.ts';
import { icon } from './icons.ts';
import { save } from './store.ts';
import { liveAvailable, livePreview } from './api.ts';
import { telLink } from './messages.ts';
import { TIER_INFO, type Tier } from '../../shared/router.ts';
import { S, closeModal, openModal, smap, hooks } from './app.ts';
import { openSos } from './sos.ts';
import { drawReports, refreshAirLayer, refreshSafety } from './layers.ts';
import { showContacts, showHelp } from './settings.ts';

export function openLayers() {
  const L = S.settings.layers;
  const toggle = (k: keyof typeof L, label: string, note: string) =>
    h(
      'label',
      { class: 'layer-row' },
      h('input', {
        type: 'checkbox',
        checked: L[k],
        'data-layer': k,
        on: {
          change: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            S.settings = save({ layers: { ...S.settings.layers, [k]: on } });
            if (k === 'reports') drawReports();
            else smap.setLayerVisible(k, on);
            if (k === 'safety' && on) refreshSafety();
            if (k === 'air') {
              smap.setLayerVisible('air', on);
              if (on) refreshAirLayer();
            }
          },
        },
      }),
      h('span', null, h('b', null, label), h('small', null, note)),
    );
  openModal(
    h(
      'div',
      { class: 'modal-card' },
      h('h2', null, 'Map layers'),
      toggle('safety', 'Street safety now', 'Every street coloured by how safe it is at this hour (zoom in to see).'),
      h(
        'div',
        { class: 'legend' },
        (['green', 'yellow', 'red', 'darkred'] as Tier[]).map((t) =>
          h('span', null, h('i', { style: { background: TIER_INFO[t].color } }), TIER_INFO[t].label),
        ),
      ),
      toggle(
        'air',
        'Street air (estimate)',
        'Streets coloured by how polluted the air usually is there: busy roads, industrial areas and landfills are darker.',
      ),
      h(
        'div',
        { class: 'legend air-legend' },
        [
          ['#2fbf9b', 'Cleaner'],
          ['#c9c446', 'Some traffic'],
          ['#ff9f0a', 'Busy road'],
          ['#d9480f', 'Industry'],
          ['#7b2cbf', 'Landfill / worst'],
        ].map(([c, l]) => h('span', null, h('i', { style: { background: c } }), l)),
      ),
      toggle(
        'reports',
        'Live reports',
        liveAvailable()
          ? `Problems other travellers reported in the last few hours${livePreview() ? ' (shared by everyone using this preview)' : ''}.`
          : 'Needs an internet connection.',
      ),
      toggle('pois', 'Safe places', 'Police, hospitals, medical stores, metro and petrol pumps. Filled = open now.'),
      hasTraffic() ? toggle('traffic', 'Traffic', 'Live traffic speed on roads.') : null,
      h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Done'),
    ),
  );
}

/** A menu row that closes the menu, then does something. */
function menuRow(
  ic: string,
  label: string,
  run: () => void,
  opts: { id?: string; danger?: boolean } = {},
): HTMLElement {
  const go = () => {
    closeModal();
    run();
  };
  return h(
    'button',
    { class: `menu-row${opts.danger ? ' danger' : ''}`, id: opts.id, on: { click: go } },
    h('span', { class: 'mi' }, icon(ic, 18)),
    label,
  );
}

function callRow(number: string, label: string, danger = false): HTMLElement {
  return h(
    'a',
    { class: `menu-row${danger ? ' danger' : ''}`, href: telLink(number) },
    h('span', { class: 'mi' }, icon('phone', 18)),
    label,
  );
}

/** Air tools first; family safety (the optional add-on) in its own section. */
export function openMenu() {
  openModal(
    h(
      'div',
      { class: 'modal-card menu' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), 'SafeRaah'),
      menuRow('sparkle', 'Saans: clean-air assistant', () => hooks.askSaans(), { id: 'menu-saans' }),
      menuRow('layers', 'Map layers (street air, safety)', openLayers),
      menuRow('help', 'How to use SafeRaah', showHelp),
      h('h3', { class: 'menu-sect' }, 'Family safety'),
      menuRow('police', 'Safe places near me', () => hooks.showCategory('safe')),
      menuRow('contacts', 'Trusted contacts & settings', showContacts),
      menuRow('alert', 'SOS: alert my contacts', openSos, { id: 'menu-sos', danger: true }),
      callRow('112', 'Call 112 (emergency)', true),
      callRow('1091', 'Women helpline 1091'),
      h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Close'),
    ),
  );
}
