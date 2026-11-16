import { describe, expect, it } from 'vitest';
import { groupSleep, nightFacts, sleepRegularity, sleepRegularityOf, unrollClock, type SleepNight } from './sleep';
import type { SleepSessionRecord } from './types';

const at = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();

function session(startMs: number, endMs: number, stages: Array<['deep' | 'light' | 'rem' | 'awake', number]>): SleepSessionRecord {
  let cursor = startMs;
  const segments = stages.map(([stage, minutes]) => {
    const segment = { stage, startMs: cursor, durationSec: minutes * 60 };
    cursor += minutes * 60_000;
    return segment;
  });
  return { startMs, endMs, segments };
}

describe('groupSleep', () => {
  it('asigna la noche al día en que se despierta y suma las fases', () => {
    const s = session(at(8, 23, 10), at(9, 7, 0), [
      ['light', 200],
      ['deep', 90],
      ['rem', 120],
      ['light', 40],
      ['awake', 20],
    ]);
    const night = groupSleep([s]).get('2026-07-09')?.night;
    expect(night).toMatchObject({ day: '2026-07-09', deepSec: 5400, lightSec: 14400, remSec: 7200, awakeSec: 1200 });
    expect(night?.asleepSec).toBe(5400 + 14400 + 7200);
    expect(night?.inBedSec).toBe((7 * 60 + 50) * 60);
    expect(night?.hasStages).toBe(true);
    expect(groupSleep([s]).has('2026-07-08')).toBe(false);
  });

  it('dos sesiones nocturnas que acaban el mismo día forman una sola noche', () => {
    const a = session(at(8, 22, 30), at(9, 2, 0), [['light', 210]]);
    const b = session(at(9, 3, 30), at(9, 7, 30), [['deep', 60], ['light', 180]]);
    const night = groupSleep([a, b]).get('2026-07-09')?.night;
    expect(night?.sessions).toBe(2);
    expect(night?.startMs).toBe(at(8, 22, 30));
    expect(night?.endMs).toBe(at(9, 7, 30));
    expect(night?.asleepSec).toBe((210 + 60 + 180) * 60);
    // El hueco despierto entre sesiones no cuenta como tiempo en cama.
    expect(night?.inBedSec).toBe((210 + 240) * 60);
  });

  it('una sesión metida dentro de otra no acorta la noche: acaba cuando acaba la que más tarde acaba', () => {
    const long = session(at(8, 23, 0), at(9, 7, 0), [['light', 480]]);
    const nested = session(at(9, 1, 0), at(9, 2, 0), [['deep', 60]]);
    const night = groupSleep([long, nested]).get('2026-07-09')?.night;
    expect(night?.sessions).toBe(2);
    expect(night?.startMs).toBe(at(8, 23, 0));
    expect(night?.endMs).toBe(at(9, 7, 0));
  });

  it('una sesión de tarde es una siesta, no la noche', () => {
    const nap = session(at(9, 14, 0), at(9, 14, 40), [['light', 40]]);
    const day = groupSleep([nap]).get('2026-07-09');
    expect(day?.night).toBeNull();
    expect(day?.naps).toEqual([{ startMs: at(9, 14, 0), endMs: at(9, 14, 40), durationSec: 2400 }]);
  });

  it('quien duerme de día tiene su sueño principal, no una siesta (el punto medio pasa del mediodía)', () => {
    const s = session(at(9, 9, 30), at(9, 17, 30), [['light', 300], ['deep', 120], ['rem', 60]]);
    const day = groupSleep([s]).get('2026-07-09');
    expect(day?.night).toMatchObject({ startMs: at(9, 9, 30), endMs: at(9, 17, 30), deepSec: 7200, remSec: 3600 });
    expect(day?.naps).toEqual([]);
  });

  it('un sueño de día partido por un despertar largo sigue siendo uno solo', () => {
    const a = session(at(9, 9, 0), at(9, 12, 30), [['light', 210]]);
    const b = session(at(9, 13, 10), at(9, 17, 0), [['deep', 60], ['light', 170]]);
    const night = groupSleep([a, b]).get('2026-07-09')?.night;
    expect(night?.sessions).toBe(2);
    expect(night?.startMs).toBe(at(9, 9, 0));
    expect(night?.endMs).toBe(at(9, 17, 0));
  });

  it('con dos sueños en el día, el más largo es el principal y el otro una siesta', () => {
    const night = session(at(8, 23, 0), at(9, 7, 0), [['light', 400], ['deep', 80]]);
    const afternoon = session(at(9, 14, 0), at(9, 17, 30), [['light', 200]]);
    const day = groupSleep([afternoon, night]).get('2026-07-09');
    expect(day?.night?.startMs).toBe(at(8, 23, 0));
    expect(day?.night?.sessions).toBe(1);
    expect(day?.naps).toEqual([{ startMs: at(9, 14, 0), endMs: at(9, 17, 30), durationSec: 12_600 }]);
  });

  it('dos sueños de noche separados por más de dos horas no son uno: el más largo manda y el otro es una siesta', () => {
    const short = session(at(9, 0, 30), at(9, 2, 0), [['light', 90]]);
    const long = session(at(9, 6, 0), at(9, 10, 0), [['light', 240]]);
    const day = groupSleep([short, long]).get('2026-07-09');
    expect(day?.night?.startMs).toBe(at(9, 6, 0));
    expect(day?.naps).toEqual([{ startMs: at(9, 0, 30), endMs: at(9, 2, 0), durationSec: 5400 }]);
  });

  it('una siesta de tarde, aunque acabe a menos de dos horas de acostarse, no se junta con la noche', () => {
    const nap = session(at(8, 18, 0), at(8, 19, 30), [['light', 90]]);
    const night = session(at(8, 21, 0), at(9, 6, 0), [['light', 400], ['deep', 80]]);
    const grouped = groupSleep([nap, night]);
    expect(grouped.get('2026-07-09')?.night?.startMs).toBe(at(8, 21, 0));
    expect(grouped.get('2026-07-09')?.night?.sessions).toBe(1);
    expect(grouped.get('2026-07-08')?.naps).toHaveLength(1);
  });

  it('una noche que el anillo parte justo en la medianoche es una sola, del día en que acaba', () => {
    const a = session(at(8, 22, 30), at(8, 23, 50), [['light', 80]]);
    const b = session(at(9, 0, 30), at(9, 7, 0), [['light', 300], ['deep', 90]]);
    const grouped = groupSleep([b, a]);
    expect(grouped.has('2026-07-08')).toBe(false);
    const night = grouped.get('2026-07-09')?.night;
    expect(night?.sessions).toBe(2);
    expect(night?.startMs).toBe(at(8, 22, 30));
    expect(night?.endMs).toBe(at(9, 7, 0));
    expect(night?.inBedSec).toBe((80 + 390) * 60);
  });

  it('una siesta de tarde y la noche de más de dos horas después no se juntan', () => {
    const nap = session(at(8, 18, 0), at(8, 19, 0), [['light', 60]]);
    const night = session(at(8, 22, 30), at(9, 6, 30), [['light', 400], ['deep', 80]]);
    const grouped = groupSleep([nap, night]);
    expect(grouped.get('2026-07-09')?.night?.startMs).toBe(at(8, 22, 30));
    expect(grouped.get('2026-07-08')?.night).toBeNull();
    expect(grouped.get('2026-07-08')?.naps).toHaveLength(1);
  });

  it('un sueño que el anillo marca entero como siesta cuenta como dormido (no como cero horas)', () => {
    const napOnly: SleepSessionRecord = { startMs: at(9, 9, 0), endMs: at(9, 17, 0), segments: [{ stage: 'nap', startMs: at(9, 9, 0), durationSec: 8 * 3600 }] };
    const night = groupSleep([napOnly]).get('2026-07-09')?.night;
    expect(night?.asleepSec).toBe(8 * 3600);
    expect(night?.hasStages).toBe(false);
  });

  it('sin tramos (el anillo solo dice cuándo empezó y acabó) vale la duración de la cama', () => {
    const bare: SleepSessionRecord = { startMs: at(8, 23, 0), endMs: at(9, 6, 30), segments: [] };
    const night = groupSleep([bare]).get('2026-07-09')?.night;
    expect(night).toMatchObject({ inBedSec: 7.5 * 3600, asleepSec: 7.5 * 3600, hasStages: false });
  });

  it('si el anillo no distingue fases, solo se da la duración', () => {
    const only = session(at(8, 23, 0), at(9, 6, 30), [['light', 450]]);
    expect(groupSleep([only]).get('2026-07-09')?.night?.hasStages).toBe(false);
  });

  it('ignora sesiones de duración nula o negativa', () => {
    expect(groupSleep([{ startMs: at(9, 7), endMs: at(9, 7), segments: [] }]).size).toBe(0);
  });
});

function night(day: number, bedH: number, bedM: number, wakeH: number, wakeM: number, asleepMin: number): SleepNight {
  const end = at(day, wakeH, wakeM);
  const bedDay = bedH >= 12 ? day - 1 : day;
  return {
    day: `2026-07-${String(day).padStart(2, '0')}`,
    startMs: at(bedDay, bedH, bedM),
    endMs: end,
    deepSec: 0,
    lightSec: asleepMin * 60,
    remSec: 0,
    awakeSec: 0,
    asleepSec: asleepMin * 60,
    inBedSec: asleepMin * 60,
    segments: [],
    hasStages: false,
    sessions: 1,
    estimated: false,
  };
}

describe('sleepRegularity', () => {
  it('menos de 4 noches: no se opina', () => {
    expect(sleepRegularity([night(1, 23, 0, 7, 0, 440), night(2, 23, 0, 7, 0, 440), night(3, 23, 0, 7, 0, 440)])).toBeNull();
  });

  it('horarios casi idénticos → regularidad alta', () => {
    const r = sleepRegularity([
      night(1, 23, 0, 7, 0, 450),
      night(2, 23, 10, 7, 5, 440),
      night(3, 22, 55, 6, 55, 455),
      night(4, 23, 5, 7, 0, 445),
      night(5, 23, 0, 7, 10, 450),
    ]);
    expect(r?.label).toBe('alta');
    expect(r?.sdBedMin).toBeLessThan(10);
    expect(r?.meanBedMin).toBeGreaterThan(22 * 60 + 50);
    expect(r?.meanBedMin).toBeLessThan(23 * 60 + 10);
  });

  it('acostarse a las 23:30 y a las 00:30 es 1 hora de diferencia, no 23', () => {
    const r = sleepRegularity([
      night(1, 23, 30, 7, 0, 420),
      night(2, 0, 30, 8, 0, 420),
      night(3, 23, 30, 7, 0, 420),
      night(4, 0, 30, 8, 0, 420),
    ]);
    expect(r?.sdBedMin).toBeGreaterThan(25);
    expect(r?.sdBedMin).toBeLessThan(40);
  });

  it('horarios muy dispares → regularidad baja', () => {
    const r = sleepRegularity([
      night(1, 21, 30, 5, 30, 420),
      night(2, 1, 30, 9, 30, 420),
      night(3, 23, 0, 6, 0, 360),
      night(4, 2, 30, 11, 0, 480),
      night(5, 22, 0, 6, 30, 400),
    ]);
    expect(r?.label).toBe('baja');
  });
});

describe('nightFacts', () => {
  const nightOf = (stages: Array<['deep' | 'light' | 'rem' | 'awake' | 'nap', number]>): SleepNight => {
    const night = groupSleep([session(at(8, 23, 0), at(9, 7, 0), stages.filter(([s]) => s !== 'nap') as Array<['deep' | 'light' | 'rem' | 'awake', number]>)]).get('2026-07-09')?.night;
    if (!night) throw new Error('sin noche');
    if (!stages.some(([s]) => s === 'nap')) return night;
    // Con siestas dentro de la sesión: los tramos seguidos, uno a continuación del otro.
    let cursor = at(8, 23, 0);
    const segments = stages.map(([stage, minutes]) => {
      const segment = { stage, startMs: cursor, durationSec: minutes * 60 };
      cursor += minutes * 60_000;
      return segment;
    });
    return { ...night, segments };
  };

  it('cuenta los despertares de en medio y lo que tardó en dormirse; el despertar definitivo no cuenta', () => {
    const facts = nightFacts(
      nightOf([['awake', 10], ['light', 60], ['awake', 5], ['deep', 60], ['awake', 3], ['light', 30], ['rem', 40], ['awake', 8]]),
    );
    expect(facts).toEqual({ wakeUps: 2, fellAsleepAfterSec: 600 });
  });

  it('varios tramos despierto seguidos son un solo despertar', () => {
    expect(nightFacts(nightOf([['light', 60], ['awake', 4], ['awake', 3], ['deep', 60], ['light', 30]]))).toEqual({ wakeUps: 1, fellAsleepAfterSec: null });
  });

  it('una noche sin despertares', () => {
    expect(nightFacts(nightOf([['light', 60], ['deep', 60], ['rem', 30]]))).toEqual({ wakeUps: 0, fellAsleepAfterSec: null });
  });

  it('empezar menos de un minuto despierto no es tardar en dormirse', () => {
    expect(nightFacts(nightOf([['awake', 0.5], ['light', 60], ['deep', 60]]))?.fellAsleepAfterSec).toBeNull();
  });

  it('las siestas dentro de la sesión no cuentan como despertar', () => {
    expect(nightFacts(nightOf([['light', 60], ['nap', 20], ['deep', 60], ['light', 30]]))?.wakeUps).toBe(0);
  });

  describe('una noche que el anillo parte en dos sesiones por un despertar largo', () => {
    const night = (a: SleepSessionRecord, b: SleepSessionRecord): SleepNight => {
      const found = groupSleep([a, b]).get('2026-07-09')?.night;
      if (!found) throw new Error('sin noche');
      return found;
    };

    it('el hueco entre las sesiones es un despertar aunque ningún tramo diga «despierto»', () => {
      const a = session(at(8, 22, 30), at(9, 2, 0), [['light', 210]]);
      const b = session(at(9, 3, 30), at(9, 7, 30), [['deep', 60], ['light', 180]]);
      expect(nightFacts(night(a, b))).toEqual({ wakeUps: 1, fellAsleepAfterSec: null });
    });

    it('el hueco pegado a tramos «despierto» de las sesiones es el mismo despertar, no uno más', () => {
      const a = session(at(8, 22, 30), at(9, 2, 0), [['light', 200], ['awake', 10]]);
      const b = session(at(9, 3, 30), at(9, 7, 30), [['awake', 5], ['deep', 55], ['light', 180]]);
      expect(nightFacts(night(a, b))?.wakeUps).toBe(1);
    });

    it('un hueco de menos de diez minutos es redondeo de la medida, no un despertar', () => {
      const a = session(at(8, 22, 30), at(9, 2, 0), [['light', 210]]);
      const b = session(at(9, 2, 5), at(9, 7, 30), [['deep', 60], ['light', 260]]);
      expect(nightFacts(night(a, b))?.wakeUps).toBe(0);
    });

    it('con varios huecos largos cuenta cada uno', () => {
      const a = session(at(8, 22, 30), at(9, 1, 0), [['light', 150]]);
      const b = session(at(9, 2, 0), at(9, 4, 0), [['deep', 60], ['light', 60]]);
      const c = session(at(9, 5, 0), at(9, 7, 30), [['rem', 60], ['light', 90]]);
      const found = groupSleep([a, b, c]).get('2026-07-09')?.night;
      expect(found && nightFacts(found)?.wakeUps).toBe(2);
    });
  });

  it('sin fases (solo un tipo) o sin sueño no hay hechos que dar', () => {
    expect(nightFacts(nightOf([['light', 450]]))).toBeNull();
    expect(nightFacts(nightOf([['awake', 30], ['awake', 20]]))).toBeNull();
  });
});

describe('unrollClock y la regularidad con cualquier horario', () => {
  const at = (h: number, m = 0): number => h * 60 + m;

  it('desenrolla un grupo de horas cortando por el hueco más grande, no por una hora fija', () => {
    expect(unrollClock([at(23, 30), at(0, 30)])).toEqual({ values: [0, 60], start: at(23, 30) });
    // quien despierta de tarde: 17:40 y 18:40 son 1 h de diferencia, no 23 (con un corte fijo a las 18:00 quedaban en extremos opuestos)
    const wake = unrollClock([at(17, 40), at(18, 40), at(18, 10)]);
    expect(wake.start).toBe(at(17, 40));
    expect([...wake.values].sort((a, b) => a - b)).toEqual([0, 30, 60]);
    expect(unrollClock([])).toEqual({ values: [], start: 0 });
  });

  it('quien duerme de día (acostarse ~08:00, levantarse ~18:00 con noches que cruzan las 18:00) tiene una regularidad bien calculada', () => {
    const r = sleepRegularityOf([
      { bedMin: at(8, 15), wakeMin: at(17, 40), asleepSec: 9 * 3600 },
      { bedMin: at(8, 30), wakeMin: at(18, 40), asleepSec: 10 * 3600 },
      { bedMin: at(7, 50), wakeMin: at(18, 5), asleepSec: 10 * 3600 },
      { bedMin: at(8, 40), wakeMin: at(18, 20), asleepSec: 9.5 * 3600 },
    ]);
    expect(r?.label).toBe('alta');
    expect(r?.sdWakeMin).toBeLessThan(30);
    expect(r?.meanWakeMin).toBeGreaterThan(at(18, 0));
    expect(r?.meanWakeMin).toBeLessThan(at(18, 30));
    expect(r?.meanBedMin).toBeGreaterThan(at(8, 0));
    expect(r?.meanBedMin).toBeLessThan(at(8, 30));
  });
});

describe('groupSleep: el día que empieza a las 08:00', () => {
  const t = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();
  const session = (startMs: number, endMs: number) => ({ startMs, endMs, segments: [{ stage: 'light' as const, startMs, durationSec: Math.round((endMs - startMs) / 1000) }] });

  it('quien duerme de día (08:15–18:17) tiene su sueño en el mismo día con cualquier hora de inicio', () => {
    const sessions = [session(t(9, 8, 15), t(9, 18, 17))];
    expect(groupSleep(sessions).get('2026-07-09')?.night?.inBedSec).toBe(10 * 3600 + 2 * 60);
    expect(groupSleep(sessions, 8).get('2026-07-09')?.night?.inBedSec).toBe(10 * 3600 + 2 * 60);
    expect(groupSleep(sessions, 8).has('2026-07-08')).toBe(false);
  });

  it('una noche de 23:00 a 07:00 es del día anterior si el día empieza a las 08:00, y del siguiente si empieza a medianoche', () => {
    const sessions = [session(t(8, 23), t(9, 7))];
    expect(groupSleep(sessions).get('2026-07-09')?.night).not.toBeNull();
    expect(groupSleep(sessions, 8).get('2026-07-08')?.night).not.toBeNull();
    expect(groupSleep(sessions, 8).has('2026-07-09')).toBe(false);
  });

  it('un sueño que se acuesta de madrugada y se levanta a mediodía es del día en que se levanta', () => {
    const sessions = [session(t(9, 3), t(9, 11))];
    expect(groupSleep(sessions, 8).get('2026-07-09')?.night?.startMs).toBe(t(9, 3));
  });
});
