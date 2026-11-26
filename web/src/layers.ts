// Live map layers: street safety and street air colours, and live reports from other travellers.
import { h } from './dom.ts';
import { icon, REPORT_ICON } from './icons.ts';
import { live, liveAvailable } from './api.ts';
import { REPORT_KINDS, isAirReport, type ReportKind } from '../../shared/live.ts';
import { type LonLat } from '../../shared/geo.ts';
import { S, closeModal, myAcc, myLonLat, now, openModal, rpc, smap, toast, hooks } from './app.ts';

// ---------- live layers ----------
let safetySeq = 0;
export async function refreshSafety() {
  if (!smap || !S.settings.layers.safety || smap.map.getZoom() < 13.5) return;
  const b = smap.map.getBounds();
  const seq = ++safetySeq;
  const r = await rpc<{ fc: any }>({
    type: 'safetyLines',
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    when: now().toISOString(),
    profile: S.settings.profile,
    limit: 6000,
  });
  if (seq === safetySeq) smap.setSafety(r.fc);
}

let airSeq = 0;
export async function refreshAirLayer() {
  if (!smap || !S.settings.layers.air || smap.map.getZoom() < 12.5) return;
  const b = smap.map.getBounds();
  const seq = ++airSeq;
  const r = await rpc<{ fc: any }>({
    type: 'airLines',
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    limit: 6000,
  });
  if (seq === airSeq) smap.setAir(r.fc);
}

export async function refreshReports(force = false) {
  if (!liveAvailable() || (!force && Date.now() - S.reportsAt < 20000)) return;
  try {
    const r = await live.list(S.bbox);
    S.reportsAt = Date.now();
    const changed =
      JSON.stringify(r.reports.map((x) => [x.id, x.confirms, x.dismisses])) !==
      JSON.stringify(S.reports.map((x) => [x.id, x.confirms, x.dismisses]));
    S.reports = r.reports;
    drawReports();
    if (!changed) return;
    await rpc({ type: 'reports', reports: r.reports, now: r.now });
    refreshSafety();
    if (S.view === 'directions' && S.reply) hooks.planRoutes({ quiet: true });
    if (S.view === 'home') hooks.renderHome();
  } catch {
    /* live reports are optional */
  }
}

export function drawReports() {
  const list = S.settings.layers.reports ? S.reports : [];
  smap.setReports(
    list.map((r) => ({
      id: r.id,
      lon: r.lon,
      lat: r.lat,
      icon: REPORT_ICON[r.kind] ?? 'alert',
      label: REPORT_KINDS[r.kind]?.label ?? r.kind,
      danger: REPORT_KINDS[r.kind]?.danger ?? true,
      air: REPORT_KINDS[r.kind] ? isAirReport(r.kind) : false,
    })),
    (id) => openReportPopup(id),
  );
}

export function ago(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function openReportPopup(id: string) {
  const r = S.reports.find((x) => x.id === id);
  if (!r) return;
  const k = REPORT_KINDS[r.kind];
  const box = h(
    'div',
    { class: 'rp' },
    h('b', { class: 'rp-title' }, icon(REPORT_ICON[r.kind] ?? 'alert', 18), k.label),
    h(
      'div',
      { class: 'meta' },
      `Reported ${ago(Date.now() - r.createdAt)} · ${r.confirms} confirmed${r.dismisses ? ` · ${r.dismisses} said gone` : ''}`,
    ),
    h('div', { class: 'meta' }, 'Is it still there?'),
    h(
      'div',
      { class: 'row2' },
      h('button', { class: 'btn small', on: { click: () => vote(true) } }, 'Still there'),
      h('button', { class: 'btn small ghost', on: { click: () => vote(false) } }, 'Gone'),
    ),
  );
  const pop = smap.popup([r.lon, r.lat], box);
  async function vote(still: boolean) {
    const me = myLonLat();
    if (!me) {
      toast('We need your location to confirm reports near you.');
      return;
    }
    try {
      await live.vote(id, still, { lon: me[0], lat: me[1], acc: myAcc() });
      pop.remove();
      toast(still ? 'Thanks, confirmed.' : 'Thanks. It will disappear if others agree.');
      refreshReports(true);
    } catch (err) {
      toast((err as Error).message);
    }
  }
}

export function openReport() {
  const me = S.journey && S.myPos ? ([S.myPos.lon, S.myPos.lat] as LonLat) : myLonLat();
  if (!liveAvailable()) {
    toast('Live reports need an internet connection.', 5000);
    return;
  }
  if (!me) {
    openModal(
      h(
        'div',
        { class: 'modal-card' },
        h('h2', null, 'Report a problem here'),
        h('p', null, 'You can only report what is happening near you, so we need your location.'),
        h(
          'button',
          {
            class: 'btn primary wide',
            on: {
              click: () => {
                closeModal();
                hooks.startPick('me');
              },
            },
          },
          'Mark where I am on the map',
        ),
        h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Cancel'),
      ),
    );
    return;
  }
  const send = async (kind: ReportKind) => {
    try {
      const r = await live.report(kind, me, { lon: me[0], lat: me[1], acc: S.journey ? S.myPos!.acc : myAcc() });
      closeModal();
      toast(
        r.merged
          ? 'Thanks. Someone reported this too, so it now counts more.'
          : `Thanks. Others will see this for about ${REPORT_KINDS[kind].hours} h, and ${isAirReport(kind) ? 'clean-air routes' : 'routes'} will avoid it.`,
        5000,
      );
      refreshReports(true);
    } catch (err) {
      toast((err as Error).message, 5000);
    }
  };
  const kindBtn = (k: ReportKind) =>
    h(
      'button',
      {
        class: `report-kind${isAirReport(k) ? ' air' : REPORT_KINDS[k].danger ? '' : ' good'}`,
        'data-kind': k,
        on: { click: () => send(k) },
      },
      h('span', { class: 'rk-ic' }, icon(REPORT_ICON[k], 24)),
      REPORT_KINDS[k].label,
    );
  openModal(
    h(
      'div',
      { class: 'modal-card' },
      h('h2', null, 'What is happening here?'),
      h(
        'p',
        { class: 'fine' },
        'Your report is anonymous and expires in a few hours. Routes for everyone steer around it until then.',
      ),
      h('h3', { class: 'rk-group' }, 'Air'),
      h(
        'div',
        { class: 'report-grid' },
        (Object.keys(REPORT_KINDS) as ReportKind[]).filter((k) => isAirReport(k)).map((k) => kindBtn(k)),
      ),
      h('h3', { class: 'rk-group' }, 'Street safety'),
      h(
        'div',
        { class: 'report-grid' },
        (Object.keys(REPORT_KINDS) as ReportKind[]).filter((k) => !isAirReport(k)).map((k) => kindBtn(k)),
      ),
      h('p', { class: 'fine' }, 'In danger right now? Use SOS or call 112.'),
      h('button', { class: 'btn ghost wide', on: { click: () => closeModal() } }, 'Cancel'),
    ),
  );
}
