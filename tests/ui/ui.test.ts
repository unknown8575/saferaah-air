// @vitest-environment happy-dom
// UI renderers are pure functions of their inputs, so they are tested in a fake DOM
// without a browser: what is shown, what is announced to screen readers, what a tap does.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { h, clear, fmtDuration, fmtDist } from '../../web/src/dom.ts';
import { airHome, aqiCard, airLine, priorityPicker } from '../../web/src/airui.ts';
import { PlaceSearch, type Entry } from '../../web/src/search.ts';
import { parseOpenMeteo, smogOf, type WeatherHour, type AirNow } from '../../shared/air.ts';
import { dayPlan } from '../../shared/saans/plan.ts';
import type { WorkerRoute } from '../../web/src/worker.ts';

const hour = (o: Partial<WeatherHour>): WeatherHour => ({
  time: '2026-11-26T22:00',
  tempC: 14,
  humidity: 60,
  windMs: 4,
  windDir: 300,
  visibilityM: 8000,
  blhM: 1200,
  temp925C: 8,
  ...o,
});
function air(pm = 180, trapped = false): AirNow {
  const time: string[] = [],
    p25: number[] = [],
    p10: number[] = [];
  for (let i = 0; i < 48; i++) {
    time.push(`2026-11-${i < 24 ? 26 : 27}T${String(i % 24).padStart(2, '0')}:00`);
    p25.push(pm + (i % 24 === 15 ? -60 : 0));
    p10.push(pm * 1.6);
  }
  const a = parseOpenMeteo(
    { utc_offset_seconds: 19800, hourly: { time, pm2_5: p25, pm10: p10 } },
    new Date('2026-11-26T14:40:00Z'),
  )!;
  const now = trapped
    ? hour({ tempC: 9, temp925C: 11, windMs: 0.8, blhM: 120, visibilityM: 900, humidity: 88 })
    : hour({});
  a.weather = { now, smog: smogOf(now), nextTrap: null, hours: [] };
  return a;
}
const handlers = () => ({ onAsk: vi.fn(), onPlanTrip: vi.fn() });

describe('dom helpers', () => {
  it('UI-01 h() sets classes, attributes, CSS variables and listeners, and skips empty children', () => {
    const click = vi.fn();
    const el = h(
      'div',
      {
        class: 'a b',
        'aria-label': 'Go',
        'data-x': true,
        hidden: false,
        style: { '--band': 'red', color: 'blue' },
        on: { click },
      },
      'x',
      null,
      false,
      [1, h('i', null, 'y')],
    );
    expect(el.className).toBe('a b');
    expect(el.getAttribute('aria-label')).toBe('Go');
    expect(el.hasAttribute('data-x')).toBe(true);
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.style.getPropertyValue('--band')).toBe('red');
    expect(el.textContent).toBe('x1y');
    el.click();
    expect(click).toHaveBeenCalledOnce();
    clear(el, 'z');
    expect(el.textContent).toBe('z');
  });
  it('UI-02 durations and distances read naturally', () => {
    expect(fmtDuration(20)).toBe('1 min');
    expect(fmtDuration(47 * 60)).toBe('47 min');
    expect(fmtDuration(120 * 60)).toBe('2 h');
    expect(fmtDuration(125 * 60)).toBe('2 h 5 min');
    expect(fmtDist(434)).toBe('430 m');
    expect(fmtDist(4631)).toBe('4.6 km');
  });
});

describe('air-first home', () => {
  it('UI-03 shows one h1, the 24-hour AQI with its basis, weather, plan steps and actions', () => {
    const a = air(180);
    const on = handlers();
    const el = airHome({ air: a, plan: dayPlan(a, null), clock: '8:10 PM', familySet: false, ...on });
    document.body.replaceChildren(el);
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(el.querySelector('h1')!.textContent).toContain('Air near you');
    expect(el.querySelector('.aqi-ring')!.textContent).toBe(String(a.aqi.value));
    expect(el.textContent).toContain('24-hour AQI (CPCB method)');
    expect(el.querySelectorAll('.conditions li').length).toBe(5);
    expect(el.querySelector('.conditions')!.textContent).toContain('4.0 m/s');
    expect(el.querySelector('.best-time')!.textContent).toContain('Cleanest time to go out');
    expect(el.querySelectorAll('.home-plan li').length).toBeGreaterThan(0);
    expect(el.querySelector('#full-plan')!.textContent).toBe('Plan for my family');
    (el.querySelector('#plan-trip') as HTMLButtonElement).click();
    (el.querySelector('#aqi-card') as HTMLButtonElement).click();
    expect(on.onPlanTrip).toHaveBeenCalledOnce();
    expect(on.onAsk).toHaveBeenCalledOnce();
  });
  it('UI-04 a smog trap (inversion, still air) tells people to keep windows shut', () => {
    const a = air(320, true);
    const el = airHome({ air: a, plan: dayPlan(a, null), clock: '11:00 PM', familySet: true, ...handlers() });
    const smog = el.querySelector('.smog')!;
    expect(smog.getAttribute('role')).toBe('status');
    expect(smog.className).toMatch(/smog-(high|severe)/);
    expect(smog.textContent).toContain('inversion');
    expect(smog.textContent).toContain('Windows shut');
    expect(el.querySelector('#full-plan')!.textContent).toBe('Family plan');
  });
  it('UI-05 with no data it says so instead of showing a fake number', () => {
    const el = airHome({ air: null, plan: dayPlan(null, null), clock: '9:00 AM', familySet: false, ...handlers() });
    expect(el.querySelector('.aqi-ring')!.textContent).toBe('–');
    expect(el.textContent).toContain('Checking the air');
    expect(el.querySelector('.conditions')).toBeNull();
    expect(el.querySelector('.smog')).toBeNull();
    const card = aqiCard(null, () => {});
    expect(card.textContent).toContain('Checking the air near you');
  });
});

const route = (labels: string[], pct: number, tier: WorkerRoute['tier'] = 'green'): WorkerRoute =>
  ({
    labels,
    tier,
    timeS: 600,
    lengthM: 2000,
    air: { doseUg: 100, factor: 1.2, pctVsFastest: pct, busyM: 300, industryM: 0, areas: ['ITO'], avoided: [] },
  }) as unknown as WorkerRoute;

describe('route air UI', () => {
  it('UI-06 the air line compares with the fastest route in plain words', () => {
    expect(airLine(route(['Fastest'], 0))!.textContent).toBe('Air: passes ITO');
    expect(airLine(route(['Cleanest air'], 22))!.textContent).toBe('22% less PM2.5 breathed than fastest');
    expect(airLine(route(['Cleanest air'], 22))!.className).toContain('better');
    expect(airLine(route(['Safest'], -9))!.textContent).toBe('9% more PM2.5 breathed than fastest');
    expect(airLine(route(['Alternative'], 1))!.textContent).toBe('About the same air as fastest');
    expect(airLine({ ...route([], 0), air: undefined } as WorkerRoute)).toBeNull();
  });
  it('UI-07 the time / safety / air picker is a radio group that selects the matching route', () => {
    const routes = [route(['Fastest', 'Also cleanest'], 0), route(['Safest'], -5)];
    const pick = vi.fn();
    const el = priorityPicker(routes, 0, pick);
    expect(el.getAttribute('role')).toBe('radiogroup');
    const btns = [...el.querySelectorAll<HTMLButtonElement>('[role=radio]')];
    expect(btns.map((b) => b.dataset.prio)).toEqual(['fastest', 'safest', 'air']);
    expect(btns.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
    btns[1].click();
    expect(pick).toHaveBeenCalledWith(1);
  });
});

describe('offline place search', () => {
  const ps = new PlaceSearch(JSON.parse(readFileSync('web/public/data/search.json', 'utf8')) as Entry[]);
  it('UI-08 finds industrial hotspots by the names people use', () => {
    expect(ps.query('Okhla Industrial', 3)[0].name).toBe('Okhla Industrial Area');
    expect(ps.query('okhla industrial estate ph 2', 1)[0].name).toBe('Okhla Industrial Area Phase 2');
    expect(ps.query('Okhla Industrial', 1)[0].type).toBe('industrial');
    expect(ps.query('wazirpur', 1)[0].name).toBe('Wazirpur Industrial Area');
  });
  it('UI-09 exact names and nicknames come first; very short queries return nothing', () => {
    expect(ps.query('India Gate', 1)[0].name).toBe('India Gate');
    expect(ps.query('CP', 1)[0].name).toBe('CP (Connaught Place)');
    expect(ps.query('a')).toEqual([]);
  });
  it('UI-10 nearer places rank higher and duplicates within 300 m are merged', () => {
    const near = ps.query('Okhla', 8, [77.27, 28.53]);
    const names = near.map((x) => `${x.name}@${x.lon.toFixed(3)},${x.lat.toFixed(3)}`);
    expect(new Set(names).size).toBe(names.length);
    expect(near.length).toBeLessThanOrEqual(8);
  });
});

describe('on-device settings and messages', async () => {
  const store = await import('../../web/src/store.ts');
  const msg = await import('../../web/src/messages.ts');
  it("UI-11 settings live under this app's own key, with Family as the default traveller", () => {
    localStorage.clear();
    const s = store.load();
    expect(s.profile).toBe('general');
    expect(s.familySet).toBe(false);
    store.save({ travellerName: 'Asha' });
    expect(JSON.parse(localStorage.getItem('saferaah-air.v1')!).travellerName).toBe('Asha');
    expect(localStorage.getItem('saferaah.v1')).toBeNull();
    const id = store.deviceId();
    expect(store.deviceId()).toBe(id);
    expect(localStorage.getItem('saferaah-air.device')).toBe(id);
  });
  it('UI-12 Indian mobile numbers are normalised; anything else is refused', () => {
    expect(store.normalisePhone('98765 43210')).toBe('+919876543210');
    expect(store.normalisePhone('098765-43210')).toBe('+919876543210');
    expect(store.normalisePhone('919876543210')).toBe('+919876543210');
    expect(store.normalisePhone('+447911123456')).toBe('+447911123456');
    expect(store.normalisePhone('12345')).toBeNull();
    expect(store.normalisePhone('5876543210')).toBeNull();
  });
  it("UI-13 messages are pre-filled links sent from the user's own phone", () => {
    expect(msg.smsLink(['+911', '+912'], 'a b')).toBe('sms:+911,+912?body=a%20b');
    expect(msg.whatsappLink('+91 98765 43210', 'hi')).toBe('https://wa.me/919876543210?text=hi');
    expect(msg.telLink('112')).toBe('tel:112');
    expect(msg.sosText('Asha', 77.2, 28.6)).toContain('openstreetmap.org/?mlat=28.60000&mlon=77.20000');
    expect(msg.startText('', '', '9:00 PM', 'https://x/t')).toBe(
      'I started a trip to my destination, expected by 9:00 PM. Follow live: https://x/t (SafeRaah)',
    );
    expect(msg.arrivalText('Asha', 'Home', '9:05 PM')).toContain('reached Home safely');
    expect(
      msg.notifyPhones([
        { id: '1', name: 'a', phone: '+911', notify: true },
        { id: '2', name: 'b', phone: '+912', notify: false },
      ]),
    ).toEqual(['+911']);
    expect(msg.shareUrl('ab c')).toContain('?track=ab%20c');
  });
});

describe('route details: air section', async () => {
  const { airSection } = await import('../../web/src/airui.ts');
  it('UI-14 shows dose, comparison and areas, and is honest when cleaner air is less safe', () => {
    const fastest = route(['Fastest'], 0, 'green');
    const clean = {
      ...route(['Cleanest air'], 30, 'red'),
      air: { doseUg: 70, factor: 0.9, pctVsFastest: 30, busyM: 120, industryM: 400, areas: [], avoided: ['ITO'] },
    } as unknown as WorkerRoute;
    const ask = vi.fn();
    const els = airSection(clean, [fastest, clean], 180, '10:30 PM', ask)!;
    const box = h('div', null, els);
    expect(box.querySelector('h3')!.textContent).toBe('Air on this route');
    expect(box.textContent).toContain('≈70 µg of PM2.5 breathed');
    expect(box.textContent).toContain('30% less than on the fastest route');
    expect(box.textContent).toContain('near industrial land');
    expect(box.querySelector('.good')!.textContent).toBe('Avoids ITO');
    expect(box.querySelector('.tradeoff')!.textContent).toContain('10:30 PM');
    (box.querySelector('#ask-route') as HTMLButtonElement).click();
    expect(ask).toHaveBeenCalledOnce();
    const plain = h('div', null, airSection(fastest, [fastest, clean], null, '1:00 PM', ask)!);
    expect(plain.querySelector('.tradeoff')).toBeNull();
    expect(plain.textContent).not.toContain('µg of PM2.5 breathed');
    expect(airSection({ ...fastest, air: undefined } as WorkerRoute, [fastest], 100, '', ask)).toBeNull();
  });
});
