// Trusted contacts and settings, the help guides and the first-run introduction.
import { h, clear } from './dom.ts';
import { icon } from './icons.ts';
import { save, normalisePhone, type Contact } from './store.ts';
import { telLink, arrivalText, HELPLINES } from './messages.ts';
import { BASE, S, clockText, closeModal, openModal, setView, sheet, toast, top, type View, hooks } from './app.ts';
import { renderArrived } from './arrived.ts';
import { renderJourney } from './journey-view.ts';

// ---------- contacts & settings ----------
/** Why a new contact can't be saved, or null when it can. */
function contactProblem(name: string, phone: string | null, contacts: Contact[]): string | null {
  if (!name.trim()) return 'Enter a name.';
  if (!phone) return 'Enter a valid mobile number (10 digits, or with +country code).';
  if (contacts.length >= 5) return 'You can save up to 5 contacts.';
  if (contacts.some((c) => c.phone === phone)) return 'This number is already saved.';
  return null;
}

/** Name and phone fields with an Add button. `reopen` redraws the screen after a change. */
function addContactForm(reopen: () => void): HTMLElement[] {
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. Maa', 'aria-label': 'Contact name', maxlength: 30 });
  const phone = h('input', {
    type: 'tel',
    placeholder: 'Mobile, e.g. 98765 43210',
    'aria-label': 'Contact mobile number',
    inputmode: 'tel',
  });
  const err = h('p', { class: 'error', hidden: true });
  const add = () => {
    const contacts = S.settings.contacts;
    const p = normalisePhone(phone.value);
    const problem = contactProblem(name.value, p, contacts);
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      return;
    }
    const c: Contact = { id: crypto.randomUUID(), name: name.value.trim(), phone: p!, notify: true };
    S.settings = save({ contacts: [...contacts, c] });
    reopen();
  };
  return [
    h(
      'div',
      { class: 'add-contact' },
      name,
      phone,
      h('button', { class: 'btn primary', id: 'add-contact', on: { click: add } }, 'Add contact'),
    ),
    err,
  ];
}

function contactRow(c: Contact, reopen: () => void): HTMLElement {
  const contacts = S.settings.contacts;
  return h(
    'li',
    null,
    h('div', null, h('b', null, c.name), h('small', null, c.phone)),
    h(
      'label',
      { class: 'switch' },
      h('input', {
        type: 'checkbox',
        checked: c.notify,
        'aria-label': `Send arrival message to ${c.name}`,
        on: {
          change: (e: Event) => {
            c.notify = (e.target as HTMLInputElement).checked;
            S.settings = save({ contacts });
          },
        },
      }),
      'Arrival message',
    ),
    h(
      'button',
      {
        class: 'icon-btn flat',
        'aria-label': `Remove ${c.name}`,
        on: {
          click: () => {
            S.settings = save({ contacts: contacts.filter((x) => x.id !== c.id) });
            reopen();
          },
        },
      },
      icon('close', 16),
    ),
  );
}

function contactList(reopen: () => void): HTMLElement {
  const contacts = S.settings.contacts;
  if (!contacts.length)
    return h('p', { class: 'hint' }, 'Add up to 5 people who should know when you reach, and who get your SOS.');
  return h(
    'ul',
    { class: 'contacts' },
    contacts.map((c) => contactRow(c, reopen)),
  );
}

function nameField(): HTMLInputElement {
  const travName = h('input', {
    type: 'text',
    value: S.settings.travellerName,
    placeholder: 'Your name (shown in messages)',
    'aria-label': 'Your name',
    maxlength: 30,
  });
  travName.addEventListener('change', () => {
    S.settings = save({ travellerName: travName.value.trim() });
    toast('Saved');
  });
  return travName;
}

const PRIVACY_POINTS = [
  'Your location stays on this phone. Planning routes and guidance work without sending it anywhere.',
  'Only during a trip, and only to show your family the live link and to check you really reached, your position goes to the SafeRaah Air server. It is deleted the moment the trip ends.',
  'The two questions after a trip are optional and anonymous; no trip, route or comment is kept with your answer.',
  'Contacts and settings are kept only on this phone.',
];

/** Remove every key this app keeps on the phone, then start again. */
function wipeAndReload(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('saferaah-air')) localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
  location.reload();
}

function confirmWipe(): void {
  openModal(
    h(
      'div',
      { class: 'modal-card' },
      h('h2', null, 'Delete everything on this phone?'),
      h('p', null, 'Removes your contacts, name, family profile and settings from SafeRaah Air on this phone.'),
      h(
        'div',
        { class: 'row2' },
        h('button', { class: 'btn ghost', on: { click: () => closeModal() } }, 'Cancel'),
        h('button', { class: 'btn danger', id: 'wipe-ok', on: { click: wipeAndReload } }, 'Delete'),
      ),
    ),
  );
}

/** A labelled on/off switch bound to one boolean setting. */
function settingSwitch(key: 'voice' | 'simulate', label: string, id?: string): HTMLElement {
  return h(
    'label',
    { class: 'switch' },
    h('input', {
      type: 'checkbox',
      id,
      checked: S.settings[key],
      on: { change: (e: Event) => (S.settings = save({ [key]: (e.target as HTMLInputElement).checked })) },
    }),
    label,
  );
}

export function showContacts() {
  const prev = S.view === 'contacts' ? 'home' : S.view;
  setView('contacts');
  clear(top);
  const reopen = () => {
    S.view = prev;
    showContacts();
  };
  clear(
    sheet,
    h(
      'div',
      { class: 'summary' },
      h('button', { class: 'back', 'aria-label': 'Back', on: { click: () => goBack(prev) } }, icon('back', 24)),
      h('h2', null, 'Contacts and settings'),
    ),
    h(
      'div',
      { class: 'pad' },
      h('h3', null, 'Your name'),
      nameField(),
      h('h3', null, 'Trusted contacts'),
      contactList(reopen),
      ...addContactForm(reopen),
      h(
        'p',
        { class: 'fine' },
        'Contacts stay on this phone. Messages are sent from your own phone by SMS or WhatsApp.',
      ),
      h('h3', null, 'Your privacy'),
      h(
        'ul',
        { class: 'privacy' },
        PRIVACY_POINTS.map((t) => h('li', null, t)),
      ),
      h('button', { class: 'btn ghost wide', id: 'wipe', on: { click: confirmWipe } }, 'Delete my data on this phone'),
      h('h3', null, 'Voice guidance'),
      settingSwitch('voice', 'Speak the turns during a journey', 'voice-setting'),
      h('h3', null, 'Demo mode'),
      settingSwitch('simulate', 'Simulate my movement (to try the app without walking)'),
    ),
  );
}

export function goBack(prev: View) {
  if (prev === 'details' && S.reply) {
    setView('directions');
    hooks.renderDirectionsTop();
    hooks.showDetails();
  } else if (prev === 'directions') {
    setView('directions');
    hooks.renderDirectionsTop();
    if (S.reply) hooks.renderRoutes();
    else hooks.planRoutes();
  } else if (prev === 'journey' && S.journey) {
    setView('journey');
    renderJourney();
  } else if (prev === 'arrived' && S.journey) {
    setView('arrived');
    renderArrived(arrivalText(S.settings.travellerName, S.journey.dest.label, clockText(new Date())), 0);
  } else if (prev === 'place' && S.place) hooks.showPlace(S.place, false);
  else hooks.goHome();
}

// ---------- help ----------
const GUIDES = [
  [
    'plan',
    'Find a place',
    'Your blue dot shows where you are. Search, tap any spot on the map, or tap Police, Hospitals or Medical stores.',
  ],
  [
    'routes',
    'Choose a route',
    'Tap Directions. The fastest route is picked first; the colours show how safe each one is now, with the precautions it needs. You decide.',
  ],
  [
    'journey',
    'Start the journey',
    'Pick who gets your arrival message, then tap Start. The map follows you and finds a new safe route if you take a different turn.',
  ],
  ['checkin', 'If you stop too long', 'We ask if you are OK. No answer in 30 seconds opens SOS.'],
  ['sos', 'SOS', 'One tap: call 112, or send your location to your contacts.'],
  ['review', 'Arrive and review', 'Your contacts get the arrival message. Rate how safe the streets felt.'],
];
export function showHelp() {
  const prev = S.view === 'help' ? 'home' : S.view;
  setView('help');
  clear(top);
  clear(
    sheet,
    h(
      'div',
      { class: 'summary' },
      h('button', { class: 'back', 'aria-label': 'Back', on: { click: () => goBack(prev) } }, icon('back', 24)),
      h('h2', null, 'How to use SafeRaah Air'),
    ),
    h(
      'div',
      { class: 'pad guides' },
      GUIDES.map(([k, title, text]) =>
        h(
          'figure',
          { class: 'guide' },
          h('img', {
            src: `${BASE}help/${k}.gif`,
            alt: `Animation: ${title}`,
            loading: 'lazy',
            width: 240,
            height: 520,
            on: { error: (e: Event) => ((e.target as HTMLElement).style.display = 'none') },
          }),
          h('figcaption', null, h('b', null, title), h('span', null, text)),
        ),
      ),
      h('h3', null, 'Live on the map'),
      h(
        'p',
        null,
        'Report: tell others about a dark street, harassment, a drunk group or someone following people. Reports expire in a few hours and routes avoid them. Layers: colour every street by how safe it is right now.',
      ),
      h('h3', null, 'Helplines'),
      h(
        'ul',
        { class: 'helplines' },
        HELPLINES.map((x) => h('li', null, h('a', { href: telLink(x.n) }, x.n), ` ${x.label}`)),
      ),
      h('h3', null, 'How the colours are worked out'),
      h(
        'p',
        null,
        'Every street gets a score for the time you travel: are places like police stations, hospitals, medical stores and shops open nearby, is the road busy, is it usually lit, does it run through a park or empty land, what travellers reported in the last few hours, and what verified travellers said about it. Routes are coloured by their real score, so in daytime all routes can be green.',
      ),
      h(
        'p',
        { class: 'fine' },
        'Some areas of Delhi have fewer shops and places mapped on OpenStreetMap, so "nothing open nearby" there can partly mean "nothing mapped yet". Your reviews help correct this.',
      ),
      h(
        'p',
        { class: 'fine' },
        `Map data © OpenStreetMap contributors (ODbL) via OpenMapTiles, snapshot ${S.snapshot || '31 Oct 2026'}. Covers all of Delhi NCT, including New Delhi, with the bordering edges of Gurugram, Faridabad, Noida and Ghaziabad.`,
      ),
    ),
  );
}

/** The route-that-turns-safe drawing on the welcome screen (the one big motion moment). */
function heroArt(): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="hero" viewBox="0 0 320 150" role="img" aria-label="A route turning from red to green">
    <defs><linearGradient id="hg" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#ff3b30"/><stop offset=".45" stop-color="#ff9f0a"/><stop offset="1" stop-color="#30b158"/></linearGradient></defs>
    <path d="M40 124 C 90 124, 92 70, 140 76 S 196 120, 226 92 S 250 52, 268 50" fill="none" stroke="currentColor" stroke-opacity=".08" stroke-width="16" stroke-linecap="round"/>
    <path class="road" d="M40 124 C 90 124, 92 70, 140 76 S 196 120, 226 92 S 250 52, 268 50" fill="none" stroke="url(#hg)" stroke-width="7" stroke-linecap="round"/>
    <circle class="start-dot" cx="40" cy="124" r="9" fill="#0a84ff" stroke="#fff" stroke-width="3"/>
    <g class="end-pin"><path d="M268 50 c-9 0 -15 -7 -15 -15 c0 -10 15 -24 15 -24 s15 14 15 24 c0 8 -6 15 -15 15z" fill="#30b158" stroke="#fff" stroke-width="2.5"/>
      <circle cx="268" cy="35" r="4.5" fill="#fff"/></g></svg>`;
  const wrap = h('div', null);
  wrap.appendChild(t.content.firstElementChild!);
  return wrap;
}

export function showIntro() {
  const feat = (ic: string, title: string, text: string) =>
    h(
      'div',
      { class: 'feat' },
      h('span', { class: 'mi' }, icon(ic, 20)),
      h('div', null, h('b', null, title), h('span', null, text)),
    );
  const done = () => {
    save({ seenIntro: true });
    closeModal();
  };
  openModal(
    h(
      'div',
      { class: 'modal-card intro' },
      heroArt(),
      h('h2', null, 'Breathe less smog, every day.'),
      h(
        'p',
        { class: 'lead' },
        'Live air for your part of Delhi, when to go out, which way to go, and what to fix at home — for your whole family.',
      ),
      feat(
        'wind',
        "Today's air and the weather behind it",
        'AQI the CPCB way, plus when an inversion will trap smog tonight.',
      ),
      feat(
        'route',
        'Cleanest-air routes',
        'Every route shows the PM2.5 you would breathe; one tap picks the cleanest.',
      ),
      feat(
        'sparkle',
        'Saans, your clean-air assistant',
        'A plan for your family, purifier sizes, masks and greener swaps, powered by Gemini.',
      ),
      feat('lock', 'Your location stays on your phone', 'Nothing about where you go is stored.'),
      h('button', { class: 'btn primary wide', id: 'intro-air', on: { click: () => done() } }, "See today's air"),
      h(
        'button',
        {
          class: 'btn ghost wide',
          id: 'intro-family',
          on: {
            click: () => {
              done();
              hooks.askSaans();
            },
          },
        },
        'Plan for my family',
      ),
    ),
  );
}
