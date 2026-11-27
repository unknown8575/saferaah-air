// Delhi time for "leave at" and the day/night map theme that follows it.
import { darkness, IST_OFFSET_MIN } from '../../shared/time.ts';
import { now, smap } from './app.ts';

export function timeToday(hhmm: string): Date {
  // interpret HH:MM as Delhi time today (or tomorrow if it already passed by > 1 h)
  const [hh, mm] = hhmm.split(':').map(Number);
  const nowIst = new Date(Date.now() + IST_OFFSET_MIN * 60000);
  const d = new Date(
    Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), hh, mm) - IST_OFFSET_MIN * 60000,
  );
  if (d.getTime() < Date.now() - 3600000) d.setTime(d.getTime() + 86400000);
  return d;
}

export function applyTheme() {
  const night = darkness(now()) >= 0.5;
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  smap?.setTheme(night ? 'night' : 'day');
}
