// The family profile form in Saans: who lives at home, cooking fuel, bedroom size and the
// daily commute. Kept only on the phone; Saans uses it to tailor the plan.
import { h } from './dom.ts';
import type { Family, Travel } from '../../shared/saans/plan.ts';

type Count = 'adults' | 'children' | 'elders';

/** − / + buttons for a count of people. */
function stepper(f: Family, key: Count, label: string, min: number): HTMLElement {
  const val = h('output', null, String(f[key]));
  const set = (d: number) => {
    f[key] = Math.max(min, Math.min(12, f[key] + d));
    val.textContent = String(f[key]);
  };
  const lower = label.toLowerCase();
  return h(
    'div',
    { class: 'fe-row' },
    h('span', null, label),
    h(
      'span',
      { class: 'stepper' },
      h('button', { type: 'button', 'aria-label': `Fewer ${lower}`, on: { click: () => set(-1) } }, '−'),
      val,
      h('button', { type: 'button', 'aria-label': `More ${lower}`, on: { click: () => set(1) } }, '+'),
    ),
  );
}

function toggle(f: Family, key: 'asthma' | 'pregnant', label: string): HTMLElement {
  return h(
    'label',
    { class: 'fe-row switch' },
    h('span', null, label),
    h('input', {
      type: 'checkbox',
      checked: f[key],
      on: { change: (e: Event) => (f[key] = (e.target as HTMLInputElement).checked) },
    }),
  );
}

/** A row of buttons where exactly one is chosen (a radio group). */
function segmented<T extends string>(opts: [T, string][], cur: T, pick: (v: T) => void, name: string): HTMLElement {
  const choose = (v: T, e: Event) => {
    pick(v);
    for (const b of (e.currentTarget as HTMLElement).parentElement!.children) {
      b.classList.toggle('on', b === e.currentTarget);
      b.setAttribute('aria-checked', b === e.currentTarget ? 'true' : 'false');
    }
  };
  return h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': name },
    opts.map(([v, l]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': v === cur ? 'true' : 'false',
          class: v === cur ? 'on' : '',
          on: { click: (e: Event) => choose(v, e) },
        },
        l,
      ),
    ),
  );
}

/** A range slider that shows its value next to the label. */
function slider(o: { min: number; max: number; value: number; label: string; unit: string; set: (v: number) => void }) {
  const out = h('output', null, `${o.value} ${o.unit}`);
  const input = h('input', {
    type: 'range',
    min: String(o.min),
    max: String(o.max),
    step: '1',
    value: String(o.value),
    'aria-label': o.label,
    on: {
      input: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        o.set(v);
        out.textContent = `${v} ${o.unit}`;
      },
    },
  });
  return { out, input };
}

const COOKING: [Family['cooking'], string][] = [
  ['lpg', 'LPG'],
  ['induction', 'Induction'],
  ['wood', 'Wood / coal'],
  ['kerosene', 'Kerosene'],
];
const COMMUTE: [Travel | 'none', string][] = [
  ['none', 'None'],
  ['car', 'Car'],
  ['twowheeler', '2-wheeler'],
  ['auto', 'Auto'],
  ['bus', 'Bus'],
  ['metro', 'Metro'],
];

function commuteBlock(state: { mode: Travel | 'none'; km: number }): HTMLElement {
  const km = slider({
    min: 1,
    max: 40,
    value: state.km,
    label: 'Commute distance one way in kilometres',
    unit: 'km',
    set: (v) => (state.km = v),
  });
  return h(
    'div',
    { class: 'fe-block' },
    h('span', null, 'Daily commute'),
    segmented(COMMUTE, state.mode, (v) => (state.mode = v), 'Commute mode'),
    h('span', { class: 'fe-km' }, 'One way ', km.out),
    km.input,
  );
}

/** The form; `onSave` gets the edited copy (the profile passed in is not changed). */
export function familyForm(profile: Family, onSave: (f: Family) => void, onCancel: () => void): HTMLElement {
  const f: Family = structuredClone(profile);
  const commute = { mode: (f.commute?.mode ?? 'none') as Travel | 'none', km: f.commute?.km ?? 8 };
  const room = slider({
    min: 6,
    max: 30,
    value: f.bedroomM2,
    label: 'Bedroom size in square metres',
    unit: 'm²',
    set: (v) => (f.bedroomM2 = v),
  });
  const submit = (e: Event) => {
    e.preventDefault();
    f.commute = commute.mode === 'none' ? null : { mode: commute.mode, km: commute.km };
    onSave(f);
  };
  return h(
    'form',
    { class: 'family-form', on: { submit } },
    h('h3', null, 'Your family'),
    h('p', { class: 'fe-note' }, 'Kept only on this phone. Saans uses it to tailor the plan.'),
    stepper(f, 'adults', 'Adults', 0),
    stepper(f, 'children', 'Children', 0),
    stepper(f, 'elders', 'Elders (60+)', 0),
    toggle(f, 'asthma', 'Someone has asthma or a lung condition'),
    toggle(f, 'pregnant', 'Someone is pregnant'),
    h(
      'div',
      { class: 'fe-block' },
      h('span', null, 'Cooking with'),
      segmented(COOKING, f.cooking, (v) => (f.cooking = v), 'Cooking fuel'),
    ),
    h('div', { class: 'fe-block' }, h('span', null, 'Bedroom size ', room.out), room.input),
    commuteBlock(commute),
    h(
      'div',
      { class: 'fe-actions' },
      h('button', { type: 'button', class: 'btn', on: { click: onCancel } }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary', id: 'family-save' }, 'Save'),
    ),
  );
}
