// Opening Saans with what the app knows: live air, the selected route, places near you.
import { placesReady, nearbyFor } from './browse.ts';
import { checkServer, isOnline } from './api.ts';
import type { AirNow } from '../../shared/air.ts';
import { airAt } from './airnow.ts';
import { type LonLat } from '../../shared/geo.ts';
import { S, myLonLat, now, smap } from './app.ts';
import { browsePlace } from './nearby.ts';
import { renderHome } from './home.ts';
import { planRoutes, routeSummary } from './routes-panel.ts';
import { openDirections } from './directions.ts';

export async function refreshAir(): Promise<AirNow | null> {
  const p = myLonLat() ?? (smap ? ([smap.map.getCenter().lng, smap.map.getCenter().lat] as LonLat) : null);
  if (!p) return S.air;
  const v = await airAt(p, { server: isOnline() });
  const first = !S.airTried;
  const changed = !!v && v.aqi.value !== S.air?.aqi.value;
  S.airTried = true;
  if (v) S.air = v;
  if ((v || first) && S.view === 'home') renderHome();
  // routes planned before the air arrived get its dose scaling and the bad-air warning now
  if (changed && S.view === 'directions' && S.to) void planRoutes({ quiet: true });
  return S.air;
}
/** Saans is loaded on first use (its own chunk), so the map opens faster. */
export async function askSaans(ask?: string) {
  const { openSaans, closeSaans } = await import('./saans.ts');
  openSaans(
    {
      air: refreshAir,
      route: routeSummary,
      online: async () => isOnline() || checkServer(),
      // looked up on the phone; the position itself never leaves it
      near: (it) => {
        const me = myLonLat();
        return me && placesReady() ? nearbyFor(it, me, now(), { min: 5, max: 7 }) : me ? [] : null;
      },
      go: (p) => {
        closeSaans();
        S.from = null;
        S.to = browsePlace(p);
        S.userPicked = false;
        S.reply = null;
        openDirections();
      },
    },
    { ask },
  );
}
