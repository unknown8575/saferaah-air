// After arrival: the arrival message for contacts, and the two optional questions that let a
// verified trip rate its streets anonymously.
import { h, clear } from './dom.ts';
import { icon } from './icons.ts';
import { api, type FinishResult } from './api.ts';
import { smsLink, notifyPhones } from './messages.ts';
import { S, sheet, toast, hooks } from './app.ts';
import { showMessageSheet } from './sos.ts';

const TAGS: [string, string][] = [
  ['well_lit', 'Well lit'],
  ['busy', 'Busy'],
  ['shops_open', 'Shops open'],
  ['police_seen', 'Police seen'],
  ['dark', 'Dark'],
  ['deserted', 'Deserted'],
  ['harassment', 'Harassment'],
  ['followed', 'Followed'],
  ['stray_dogs', 'Stray dogs'],
  ['bad_footpath', 'Bad footpath'],
];

/** Five stars as a radio group; `onPick` gets the rating. */
function starPicker(onPick: (n: number) => void): HTMLElement {
  const stars = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': 'Safety rating' });
  const draw = (rating: number) =>
    clear(
      stars,
      [1, 2, 3, 4, 5].map((n) =>
        h(
          'button',
          {
            class: `star${n <= rating ? ' on' : ''}`,
            role: 'radio',
            'aria-checked': n === rating ? 'true' : 'false',
            'aria-label': `${n} of 5`,
            on: {
              click: () => {
                draw(n);
                onPick(n);
              },
            },
          },
          icon('star', 30, 1.6),
        ),
      ),
    );
  draw(0);
  return stars;
}

/** Toggle chips for what the traveller noticed. */
function tagChips(tags: Set<string>): HTMLElement {
  const flip = (k: string) => (e: Event) => {
    const b = e.currentTarget as HTMLElement;
    if (tags.has(k)) tags.delete(k);
    else tags.add(k);
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', String(tags.has(k)));
  };
  return h(
    'div',
    { class: 'chips wrap' },
    TAGS.map(([k, label]) => h('button', { class: 'chip', 'aria-pressed': 'false', on: { click: flip(k) } }, label)),
  );
}

/** The two questions, for a verified trip only. */
function reviewQuestions(box: HTMLElement, tripId: string, reviewToken: string): HTMLElement[] {
  let rating = 0;
  const tags = new Set<string>();
  const send = async () => {
    try {
      await api.review(tripId, reviewToken, rating, [...tags]);
      clear(
        box,
        h(
          'p',
          { class: 'ok-msg' },
          'Thanks. Your answer helps others once enough travellers agree about these streets. Nothing about your trip was kept.',
        ),
      );
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const submit = h(
    'button',
    { class: 'btn primary', disabled: true, id: 'submit-review', on: { click: send } },
    'Send',
  );
  const skip = () => clear(box, h('p', { class: 'fine' }, 'Skipped. Nothing about this trip is kept.'));
  return [
    h(
      'p',
      { class: 'fine' },
      "Two quick questions, only if you want to answer. Anonymous: your trip's location was already deleted.",
    ),
    h('h3', null, '1. How safe did the route feel?'),
    starPicker((n) => {
      rating = n;
      submit.disabled = false;
    }),
    h('h3', null, '2. What did you notice? (optional)'),
    tagChips(tags),
    h(
      'div',
      { class: 'row2' },
      h('button', { class: 'btn ghost', id: 'skip-review', on: { click: skip } }, 'Skip'),
      submit,
    ),
  ];
}

function reviewBox(res: FinishResult | null | undefined, tripId: string | undefined): HTMLElement {
  const box = h('div', { class: 'review' });
  if (res?.eligible && res.reviewToken && tripId) clear(box, ...reviewQuestions(box, tripId, res.reviewToken));
  else if (res)
    clear(
      box,
      h(
        'p',
        { class: 'fine' },
        'Reviews are only accepted from verified trips. This one could not be verified: ',
        res.reasons.join('; '),
        '.',
      ),
    );
  else clear(box, h('p', { class: 'fine' }, 'Reviews need an internet connection to verify your trip.'));
  return box;
}

/** Sent automatically, a button to send it, or a prompt to add contacts. */
function arrivalMessage(msg: string, autoSent: number, names: string[]): (HTMLElement | null)[] {
  if (autoSent) return [h('p', { class: 'ok-msg' }, `Arrival message sent to ${names.join(', ')}.`)];
  if (!names.length)
    return [
      h(
        'p',
        null,
        h('button', { class: 'linkish', on: { click: () => hooks.showContacts() } }, 'Add a trusted contact'),
        ' to send arrival messages next time.',
      ),
    ];
  return [
    h(
      'a',
      { class: 'btn primary wide', href: smsLink(notifyPhones(S.settings.contacts), msg), id: 'send-arrival' },
      `Tell ${names.join(', ')} you reached`,
    ),
    h(
      'button',
      { class: 'btn wide', on: { click: () => showMessageSheet('Tell them you reached', msg) } },
      'Other ways to send',
    ),
  ];
}

function done(): void {
  S.journey = null;
  S.myPos = null;
  S.from = null;
  S.to = null;
  S.reply = null;
  hooks.goHome();
}

export function renderArrived(msg: string, autoSent: number) {
  const J = S.journey!;
  const names = S.settings.contacts.filter((c) => c.notify).map((c) => c.name);
  clear(
    sheet,
    h('div', { class: 'grip' }),
    h(
      'div',
      { class: 'pad center' },
      h('div', { class: 'arrived-mark' }, icon('check', 40, 2.6)),
      h('h2', null, 'You reached'),
      h('p', null, J.dest.label),
      ...arrivalMessage(msg, autoSent, names),
    ),
    h('div', { class: 'pad' }, reviewBox(J.result, J.handle?.id)),
    h('div', { class: 'actions' }, h('button', { class: 'btn wide', id: 'done', on: { click: done } }, 'Done')),
  );
}
