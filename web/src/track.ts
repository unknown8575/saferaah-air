// The live trip page a trusted contact opens from a shared link (no app needed).
import { h, clear } from './dom.ts';
import { icon } from './icons.ts';
import { api, type SharedTrip } from './api.ts';
import { telLink } from './messages.ts';
import type { WorkerRoute } from './worker.ts';
import { clockText, setView, sheet, smap, top, fitPad } from './app.ts';

// ---------- live trip viewer (for contacts) ----------
export async function showTrack(shareId: string) {
  setView('track');
  clear(top);
  let first = true;
  const draw = async () => {
    let d: SharedTrip;
    try {
      d = await api.share(shareId);
    } catch (err) {
      clear(
        sheet,
        h('div', { class: 'pad' }, h('h2', null, 'Trip not available'), h('p', null, (err as Error).message)),
      );
      return false;
    }
    if (d.route.length > 1)
      smap.showRoutes([{ coords: d.route, tier: 'green', dangerSpots: [] } as unknown as WorkerRoute], 0);
    else smap.clearRoutes();
    smap.setEndpoints(d.route[0], d.dest ?? undefined);
    if (d.last) smap.setMe([d.last.lon, d.last.lat], d.last.acc ?? 0);
    else smap.setMe(undefined);
    if (first && d.route.length > 1) {
      smap.fit(d.route, fitPad());
      first = false;
    }
    const statusText: Record<string, string> = {
      active: 'On the way',
      arrived: 'Reached safely',
      ended: 'Trip ended',
      sos: 'SOS: needs help now',
      expired: 'Trip expired',
    };
    const eta = new Date(d.startedAt + d.etaS * 1000);
    clear(
      sheet,
      h(
        'div',
        { class: 'pad' },
        h('h2', null, `${d.name ? d.name + ': ' : ''}${statusText[d.status] ?? d.status}`),
        d.status === 'sos' ? h('a', { class: 'btn danger wide big', href: telLink('112') }, 'Call 112') : null,
        h(
          'p',
          null,
          d.status === 'arrived'
            ? `Arrived at ${clockText(new Date(d.arrivedAt ?? Date.now()))}.`
            : `Expected by ${clockText(eta)}.`,
        ),
        d.last
          ? h('p', { class: 'meta' }, `Last seen ${Math.max(0, Math.round((Date.now() - d.last.t) / 60000))} min ago.`)
          : h('p', { class: 'meta' }, 'Waiting for the first location…'),
        d.status === 'active' || d.status === 'sos'
          ? h('p', { class: 'fine' }, 'This page updates every 10 seconds.')
          : h(
              'p',
              { class: 'fine lockline' },
              icon('lock', 14),
              'The trip has ended, so its location data has been deleted.',
            ),
      ),
    );
    return d.status === 'active' || d.status === 'sos';
  };
  if (await draw()) {
    const t = setInterval(async () => {
      if (!(await draw())) clearInterval(t);
    }, 10000);
  }
}
