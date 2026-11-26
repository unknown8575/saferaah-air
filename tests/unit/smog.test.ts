import { describe, it, expect } from 'vitest';
import {
  aqiFrom,
  naqi,
  parseOpenMeteo,
  parseWeather,
  parseSensors,
  smogOf,
  type WeatherHour,
} from '../../shared/air.ts';
import { dayPlan, DEFAULT_FAMILY } from '../../shared/saans/plan.ts';
import { compose, factsFor } from '../../shared/saans/assistant.ts';

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

/** 48 hours of fake air data starting midnight 26 Nov, IST */
function airJson(pm: (h: number) => number) {
  const time: string[] = [],
    p25: number[] = [],
    p10: number[] = [];
  for (let i = 0; i < 48; i++) {
    time.push(`2026-11-${i < 24 ? 26 : 27}T${String(i % 24).padStart(2, '0')}:00`);
    p25.push(pm(i));
    p10.push(pm(i) * 1.6);
  }
  return { utc_offset_seconds: 19800, hourly: { time, pm2_5: p25, pm10: p10 } };
}

describe('Indian NAQI the CPCB way', () => {
  it('TC-151b missing pollutants are handled honestly', () => {
    const only10 = aqiFrom(null, 300)!;
    expect(only10.main).toBe('PM10');
    expect(only10.band).toBe('poor');
    expect(aqiFrom(null, null)).toBeNull();
    expect(aqiFrom(Number.NaN, undefined)).toBeNull();
    expect(aqiFrom(-5, 80)!.main).toBe('PM10');
  });
  it('TC-152b the AQI uses the 24-hour average once 16+ hours are known, else it is labelled hourly', () => {
    // 100 µg/m³ all day, then a spike to 300 at the current hour (20:00 IST)
    const j = airJson((i) => (i === 20 ? 300 : 100));
    const a = parseOpenMeteo(j, new Date('2026-11-26T14:40:00Z'))!; // 20:10 IST
    expect(a.aqi.basis).toBe('24h');
    expect(a.avg24!.hours).toBe(21);
    expect(a.avg24!.pm25).toBeCloseTo((20 * 100 + 300) / 21, 5);
    expect(a.aqi.value).toBe(naqi(a.avg24!.pm25, a.avg24!.pm10).value);
    expect(a.pm25).toBe(300); // this hour is still shown as this hour
    const early = parseOpenMeteo(j, new Date('2026-11-26T01:40:00Z'))!; // 07:10 IST: only 8 hours so far
    expect(early.aqi.basis).toBe('hourly');
  });
});

describe('winter smog: weather that traps pollution', () => {
  it('TC-187 inversion + calm + shallow mixing is severe; a windy, well-mixed afternoon is low', () => {
    const night = smogOf(hour({ tempC: 9, temp925C: 11, windMs: 0.8, blhM: 120, humidity: 90, visibilityM: 900 }));
    expect(night.inversion).toBe(true);
    expect(night.stagnant).toBe(true);
    expect(night.level).toBe('severe');
    expect(night.reasons.join(' ')).toMatch(/inversion/);
    const day = smogOf(hour({ tempC: 24, temp925C: 17, windMs: 5, blhM: 1500, humidity: 40 }));
    expect(day.level).toBe('low');
    expect(
      smogOf(hour({ tempC: null, temp925C: null, windMs: null, blhM: null, humidity: null, visibilityM: null })).level,
    ).toBe('low');
  });
  it('TC-188 forecast parsing finds the next smog trap', () => {
    const time: string[] = [],
      t2: number[] = [],
      t925: number[] = [],
      wind: number[] = [],
      blh: number[] = [];
    for (let i = 0; i < 48; i++) {
      const h = i % 24;
      time.push(`2026-11-${i < 24 ? 26 : 27}T${String(h).padStart(2, '0')}:00`);
      const nightTime = h >= 21 || h <= 7;
      t2.push(nightTime ? 8 : 22);
      t925.push(nightTime ? 10 : 16);
      wind.push(nightTime ? 0.7 : 4);
      blh.push(nightTime ? 150 : 1400);
    }
    const w = parseWeather(
      {
        utc_offset_seconds: 19800,
        hourly: {
          time,
          temperature_2m: t2,
          temperature_925hPa: t925,
          wind_speed_10m: wind,
          boundary_layer_height: blh,
        },
      },
      new Date('2026-11-26T09:30:00Z'),
    )!; // 15:00 IST
    expect(w.smog.level).toBe('low');
    expect(w.nextTrap).toEqual({ start: '2026-11-26T21:00', end: '2026-11-27T07:00' });
    expect(parseWeather({})).toBeNull();
  });
  it('TC-189 community sensors: median of plausible PM2.5 readings, one per sensor', () => {
    const s = (id: number, p2: string) => ({
      sensor: { id },
      sensordatavalues: [
        { value_type: 'P1', value: '300' },
        { value_type: 'P2', value: p2 },
      ],
    });
    const g = parseSensors([s(1, '120'), s(2, '180'), s(3, '150'), s(3, '999'), s(4, '-3'), s(5, '5000')])!;
    expect(g.sensors).toBe(3);
    expect(g.pm25).toBe(150);
    expect(parseSensors([s(1, '100')])).toBeNull();
    expect(parseSensors('nope' as never)).toBeNull();
  });
  it('TC-190b the day plan warns about a smog trap and says what to do', () => {
    const a = parseOpenMeteo(
      airJson(() => 220),
      new Date('2026-11-26T14:40:00Z'),
    )!;
    a.weather = {
      now: hour({ tempC: 9, temp925C: 11, windMs: 0.8, blhM: 120 }),
      smog: smogOf(hour({ tempC: 9, temp925C: 11, windMs: 0.8, blhM: 120 })),
      nextTrap: null,
      hours: [],
    };
    const p = dayPlan(a, null);
    expect(p.items[0].id).toBe('trap');
    expect(p.items[0].detail).toMatch(/Windows shut/);
    expect(p.facts.join(' ')).toMatch(/Smog trap now: severe/);
  });
});

describe('Saans does not invent the family', () => {
  it('TC-184b with no profile, nothing personal is stated or assumed', () => {
    const facts = factsFor({ air: null, family: null }).join('\n');
    expect(facts).toMatch(/Family profile: NOT SET/);
    expect(facts).not.toMatch(/cooks with/);
    expect(facts).toMatch(/Delhi NCT only/);
    const a = compose('Which purifier for my bedroom?', { air: null, family: null });
    expect(a.text).toMatch(/a typical 12 m² bedroom/);
    expect(a.text).not.toMatch(/your 12 m²/);
    const withFam = compose('Which purifier for my bedroom?', {
      air: null,
      family: { ...DEFAULT_FAMILY, bedroomM2: 16 },
    });
    expect(withFam.text).toMatch(/your 16 m² bedroom/);
    expect(compose('greener commute and carbon footprint', { air: null, family: null }).text).not.toMatch(
      /your .* commute/i,
    );
  });
});
