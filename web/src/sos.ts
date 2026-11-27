// Messages to trusted contacts: sharing the trip, the "Are you OK?" check-in, and SOS.
// Everything is sent from the user's own phone (SMS / WhatsApp links); the server may also
// send SMS when it has a provider (see server/routes/journeys.ts).
import { h } from './dom.ts';
import { api } from './api.ts';
import { smsLink, whatsappLink, telLink, shareUrl, startText, sosText, HELPLINES, notifyPhones } from './messages.ts';
import type { LonLat } from '../../shared/geo.ts';
import { S, smap, toast, myLonLat, clockText, hooks, openModal, closeModal, checkTimer, setCheckTimer } from './app.ts';

export async function shareTrip() {
  const J = S.journey;
  if (!J) return;
  const link = J.handle ? shareUrl(J.handle.shareId) : undefined;
  const text = startText(
    S.settings.travellerName,
    J.dest.label,
    clockText(new Date(J.startedAt + J.route.timeS * 1000)),
    link,
  );
  if (navigator.share) {
    try {
      await navigator.share({ title: 'My trip', text, url: link });
      return;
    } catch {
      /* cancelled */
    }
  }
  showMessageSheet('Share your trip', text);
}

export function showMessageSheet(title: string, text: string, onClose?: () => void) {
  const phones = notifyPhones(S.settings.contacts);
  openModal(
    h(
      'div',
      { class: 'modal-card' },
      h('h2', null, title),
      h('p', { class: 'msg-preview' }, text),
      phones.length
        ? h(
            'a',
            { class: 'btn primary wide', href: smsLink(phones, text) },
            `Send SMS to ${S.settings.contacts
              .filter((c) => c.notify)
              .map((c) => c.name)
              .join(', ')}`,
          )
        : h(
            'p',
            null,
            'No contacts selected. ',
            h(
              'button',
              {
                class: 'linkish',
                on: {
                  click: () => {
                    closeModal();
                    hooks.showContacts();
                  },
                },
              },
              'Add a contact',
            ),
          ),
      S.settings.contacts
        .filter((c) => c.notify)
        .map((c) =>
          h(
            'a',
            { class: 'btn wide', href: whatsappLink(c.phone, text), target: '_blank', rel: 'noopener' },
            `WhatsApp ${c.name}`,
          ),
        ),
      h(
        'button',
        {
          class: 'btn ghost wide',
          on: {
            click: () => {
              navigator.clipboard?.writeText(text).then(() => toast('Copied'));
            },
          },
        },
        'Copy text',
      ),
      h(
        'button',
        {
          class: 'btn ghost wide',
          on: {
            click: () => {
              closeModal();
              onClose?.();
            },
          },
        },
        'Close',
      ),
    ),
  );
}

export function checkIn(reason: string, kind: 'stopped' | 'overdue') {
  if (!S.journey || checkTimer || S.journey.sos) return;
  let left = 30;
  const count = h('div', { class: 'countdown', 'aria-live': 'assertive' }, `0:${left}`);
  navigator.vibrate?.([200, 100, 200]);
  openModal(
    h(
      'div',
      { class: 'modal-card checkin', role: 'alertdialog', 'aria-label': 'Are you OK?' },
      h('h2', null, 'Are you OK?'),
      h('p', null, reason),
      count,
      h(
        'div',
        { class: 'row2' },
        h(
          'button',
          {
            class: 'btn ok',
            id: 'im-ok',
            on: {
              click: () => {
                closeModal();
                S.journey?.monitor.acknowledge(kind, S.journey.clock());
                toast('Glad you are OK. We will keep watching the trip.');
              },
            },
          },
          "I'm OK",
        ),
        h(
          'button',
          {
            class: 'btn danger',
            on: {
              click: () => {
                closeModal();
                openSos();
              },
            },
          },
          'Send SOS',
        ),
      ),
      h('p', { class: 'fine' }, 'If you do not answer, SOS opens automatically.'),
    ),
  );
  setCheckTimer(
    setInterval(() => {
      left--;
      count.textContent = `0:${String(left).padStart(2, '0')}`;
      if (left <= 0) {
        closeModal();
        openSos(true);
      }
    }, 1000),
  );
}

export async function openSos(auto = false) {
  const J = S.journey;
  if (J) J.sos = true;
  const pos: LonLat = S.myPos
    ? [S.myPos.lon, S.myPos.lat]
    : (myLonLat() ?? S.from?.lonlat ?? (smap ? [smap.map.getCenter().lng, smap.map.getCenter().lat] : [77.21, 28.61]));
  const link = J?.handle ? shareUrl(J.handle.shareId) : undefined;
  const text = sosText(S.settings.travellerName, pos[0], pos[1], link);
  const phones = S.settings.contacts.map((c) => c.phone);
  let serverNote = '';
  if (J?.handle) {
    try {
      const r = await api.sos(J.handle, phones, text);
      serverNote = r.smsSent ? `SOS SMS sent to ${r.smsSent} contact${r.smsSent > 1 ? 's' : ''}. ` : '';
    } catch {
      /* fall back to links */
    }
  }
  navigator.vibrate?.([300, 100, 300, 100, 300]);
  openModal(
    h(
      'div',
      { class: 'modal-card sos-card', role: 'alertdialog', 'aria-label': 'SOS' },
      h('h2', null, auto ? 'No answer, so SOS is open' : 'SOS'),
      serverNote ? h('p', null, serverNote) : null,
      h('a', { class: 'btn danger wide big', href: telLink('112') }, 'Call 112'),
      phones.length
        ? h('a', { class: 'btn primary wide', href: smsLink(phones, text) }, 'Send SOS SMS to all contacts')
        : h('p', null, 'You have no trusted contacts yet.'),
      S.settings.contacts.map((c) =>
        h(
          'a',
          { class: 'btn wide', href: whatsappLink(c.phone, text), target: '_blank', rel: 'noopener' },
          `WhatsApp ${c.name}`,
        ),
      ),
      h(
        'details',
        null,
        h('summary', null, 'Other helplines'),
        h(
          'ul',
          { class: 'helplines' },
          HELPLINES.map((x) => h('li', null, h('a', { href: telLink(x.n) }, x.n), ` ${x.label}`)),
        ),
      ),
      h(
        'button',
        {
          class: 'btn ghost wide',
          on: {
            click: () => {
              closeModal();
              if (J) J.sos = false;
            },
          },
        },
        'I am safe, close',
      ),
    ),
  );
}
