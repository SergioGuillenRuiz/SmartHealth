import { describe, expect, it } from 'vitest';
import { SPORTS, sportById } from './sports';
import { estimateWorkout, type WorkoutRecord } from './workout';
import type { ResolvedProfile } from './profile';

const profile: ResolvedProfile = {
  date: '2026-01-01',
  heightCm: 178,
  weightKg: 80,
  sex: 'male',
  birthDate: '1985-06-15',
  extrapolated: false,
};

const start = new Date(2026, 6, 10, 18, 0, 0).getTime();
const min = 60_000;

const base = (over: Partial<WorkoutRecord>): WorkoutRecord => ({
  id: 'w1',
  sport: 'walk',
  startMs: start,
  endMs: start + 60 * min,
  pausedMs: 0,
  source: 'live',
  ...over,
});

const hrSeries = (bpm: number, minutes: number, everySec = 5): Array<[number, number]> =>
  Array.from({ length: Math.floor((minutes * 60) / everySec) }, (_, i) => [start + i * everySec * 1000, bpm]);

describe('catálogo de deportes', () => {
  it('ids únicos y METs razonables', () => {
    expect(new Set(SPORTS.map((s) => s.id)).size).toBe(SPORTS.length);
    for (const s of SPORTS) {
      expect(s.genericMet).toBeGreaterThanOrEqual(2);
      expect(s.genericMet).toBeLessThanOrEqual(12);
    }
  });
  it('un id desconocido cae en caminar', () => {
    expect(sportById('nope').id).toBe('walk');
  });
});

describe('estimateWorkout: distancia', () => {
  it('caminando usa los pasos reales del anillo (estimada)', () => {
    const e = estimateWorkout(base({ steps: 6000 }), profile);
    expect(e.distanceM).toBeGreaterThan(4300);
    expect(e.distanceM).toBeLessThan(4600);
    expect(e.distanceProvenance).toBe('estimated');
    expect(e.avgSpeedKmh).toBeCloseTo(4.4, 0);
  });

  it('en bici ignora los pasos del anillo (son vibraciones) y usa solo GPS o manual', () => {
    const noDistance = estimateWorkout(base({ sport: 'cycle', steps: 900 }), profile);
    expect(noDistance.distanceM).toBeNull();
    const gps = estimateWorkout(base({ sport: 'cycle', steps: 900, distanceM: 22_000, distanceSource: 'gps' }), profile);
    expect(gps.distanceM).toBe(22_000);
    expect(gps.distanceProvenance).toBe('phone');
    expect(gps.avgSpeedKmh).toBe(22);
    const manual = estimateWorkout(base({ sport: 'cycle', distanceM: 30_000, distanceSource: 'manual' }), profile);
    expect(manual.distanceProvenance).toBe('manual');
  });

  it('la pausa no cuenta para la velocidad', () => {
    const e = estimateWorkout(base({ sport: 'cycle', pausedMs: 30 * min, distanceM: 10_000, distanceSource: 'gps' }), profile);
    expect(e.activeMs).toBe(30 * min);
    expect(e.avgSpeedKmh).toBe(20);
  });
});

describe('estimateWorkout: calorías', () => {
  it('ciclismo con distancia: MET por velocidad (22 km/h durante 1 h, 80 kg → ~(9,3−1)×80 ≈ 660 kcal netas)', () => {
    const e = estimateWorkout(base({ sport: 'cycle', distanceM: 22_000, distanceSource: 'gps' }), profile);
    expect(e.kcalMethod).toBe('speed-met');
    expect(e.kcal).toBeGreaterThan(600);
    expect(e.kcal).toBeLessThan(720);
  });

  it('correr 10 km en 1 h usa el MET de 10 km/h (~9,9)', () => {
    const e = estimateWorkout(base({ sport: 'run', steps: 9000, distanceM: 10_000, distanceSource: 'gps' }), profile);
    expect(e.kcalMethod).toBe('speed-met');
    expect(e.kcal).toBeGreaterThan(680);
    expect(e.kcal).toBeLessThan(760);
  });

  it('sin velocidad pero con buena FC usa Keytel (menos el reposo)', () => {
    const e = estimateWorkout(base({ sport: 'gym', hr: hrSeries(130, 60) }), profile);
    expect(e.kcalMethod).toBe('hr');
    // 130 lpm, 80 kg, 41 años → ~12 kcal/min brutas − 1,2 en reposo ≈ 650 kcal/h netas
    expect(e.kcal).toBeGreaterThan(550);
    expect(e.kcal).toBeLessThan(750);
    expect(e.avgBpm).toBe(130);
  });

  it('si la FC cubre menos de la mitad del tiempo, cae al MET genérico', () => {
    const e = estimateWorkout(base({ sport: 'gym', hr: hrSeries(130, 20) }), profile);
    expect(e.kcalMethod).toBe('met');
    expect(e.kcal).toBeCloseTo((4.0 - 1) * 80 * 1, 0);
  });

  it('con FC baja (yoga, <90 lpm) no se usa Keytel porque deja de ser válida', () => {
    const e = estimateWorkout(base({ sport: 'yoga', hr: hrSeries(75, 60) }), profile);
    expect(e.kcalMethod).toBe('met');
    expect(e.kcal).toBeCloseTo((2.5 - 1) * 80, 0);
  });

  it('las calorías fijadas a mano mandan y se marcan como manuales', () => {
    const e = estimateWorkout(base({ sport: 'gym', kcalManual: 420 }), profile);
    expect(e).toMatchObject({ kcal: 420, kcalMethod: 'manual', kcalProvenance: 'manual' });
  });

  it('usa el peso del perfil vigente: 10 kg más → 12,5 % más kcal', () => {
    const light = estimateWorkout(base({ sport: 'hiit' }), { ...profile, weightKg: 80 });
    const heavy = estimateWorkout(base({ sport: 'hiit' }), { ...profile, weightKg: 90 });
    expect(heavy.kcal / light.kcal).toBeCloseTo(90 / 80, 2);
  });

  it('descarta muestras de FC imposibles', () => {
    const e = estimateWorkout(base({ sport: 'gym', hr: [...hrSeries(120, 60), [start + 1, 255], [start + 2, 0]] }), profile);
    expect(e.maxBpm).toBe(120);
    expect(e.minBpm).toBe(120);
  });
});

describe('estimateWorkout: estar quieto en un entreno a pie (el contador de pasos no cuenta ninguno)', () => {
  const sitting = (over: Partial<WorkoutRecord> = {}): WorkoutRecord => base({ sport: 'walk', steps: 0, endMs: start + 30 * min, ...over });

  it('media hora sentado con el contador en marcha: calorías de estar parado (≈ 0,3 MET netos), no las de pasear', () => {
    const e = estimateWorkout(sitting(), profile);
    // (1,3 − 1) MET × 80 kg × 0,5 h = 12 kcal; pasear (3,5 MET) serían 100.
    expect(e.kcal).toBe(12);
    expect(e.kcalMethod).toBe('speed-met');
    expect(e.avgSpeedKmh).toBeNull();
  });

  it('con un pulso de reposo (< 90) sigue siendo estar parado', () => {
    const e = estimateWorkout(sitting({ hr: hrSeries(72, 30) }), profile);
    expect(e.kcal).toBe(12);
  });

  it('sin la regla, sin contador de pasos (no se sabe si se anduvo) se mantiene el MET genérico', () => {
    const { steps: _steps, ...unknown } = sitting();
    const e = estimateWorkout(unknown, profile);
    expect(e.kcal).toBe(100);
    expect(e.kcalMethod).toBe('met');
  });

  it('con un pulso de esfuerzo (≥ 90) manda el pulso: puede ser una cinta con las manos en el pasamanos', () => {
    const e = estimateWorkout(sitting({ hr: hrSeries(130, 30) }), profile);
    expect(e.kcalMethod).toBe('hr');
    expect(e.kcal).toBeGreaterThan(100);
  });

  it('si el anillo sí contó pasos, se anduvo: la velocidad de los pasos manda (y no cambia nada)', () => {
    const e = estimateWorkout(base({ steps: 3300, endMs: start + 30 * min }), profile);
    expect(e.kcalMethod).toBe('speed-met');
    expect(e.avgSpeedKmh).toBeGreaterThan(4);
    expect(e.kcal).toBeGreaterThan(70);
  });

  it('si luego se sincronizan pasos del anillo en esa ventana, hubo paseo: se estima con ellos', () => {
    const e = estimateWorkout(sitting(), profile, 3300);
    expect(e.avgSpeedKmh).toBeGreaterThan(4);
    expect(e.kcal).toBeGreaterThan(70);
  });

  it('con la ruta del GPS (distancia) manda la velocidad, aunque el contador diga 0', () => {
    const e = estimateWorkout(sitting({ distanceM: 2500, distanceSource: 'gps' }), profile);
    expect(e.avgSpeedKmh).toBe(5);
    expect(e.kcal).toBeGreaterThan(70);
  });

  it('correr y senderismo igual; en bici o en el gimnasio el cero no significa nada y sigue el MET genérico', () => {
    expect(estimateWorkout(sitting({ sport: 'run' }), profile).kcal).toBe(12);
    expect(estimateWorkout(sitting({ sport: 'hike' }), profile).kcal).toBe(12);
    expect(estimateWorkout(sitting({ sport: 'gym' }), profile).kcal).toBe(Math.round((4.0 - 1) * 80 * 0.5));
    expect(estimateWorkout(sitting({ sport: 'cycle' }), profile).kcal).toBe(Math.round((6.8 - 1) * 80 * 0.5));
  });

  it('las calorías fijadas a mano siguen mandando', () => {
    expect(estimateWorkout(sitting({ kcalManual: 200 }), profile).kcal).toBe(200);
  });
});

describe('estimateWorkout: el GPS dio señal y no se avanzó (distancia 0 medida): sin anillo tampoco se anda sentado', () => {
  const still = (over: Partial<WorkoutRecord> = {}): WorkoutRecord => base({ sport: 'walk', endMs: start + 30 * min, distanceM: 0, distanceSource: 'gps', ...over });

  it('media hora quieto: calorías de estar parado, distancia 0 con origen en el móvil y sin velocidad media', () => {
    const e = estimateWorkout(still(), profile);
    expect(e.kcal).toBe(12); // (1,3 − 1) MET × 80 kg × 0,5 h; pasear serían 100
    expect(e.kcalMethod).toBe('speed-met');
    expect(e.distanceM).toBe(0);
    expect(e.distanceProvenance).toBe('phone');
    expect(e.avgSpeedKmh).toBeNull();
  });

  it('correr y hacer senderismo quietos también: nada de los 9,8 o 6 MET genéricos', () => {
    expect(estimateWorkout(still({ sport: 'run' }), profile).kcal).toBe(12);
    expect(estimateWorkout(still({ sport: 'hike' }), profile).kcal).toBe(12);
  });

  it('un pulso de esfuerzo (≥ 90) sigue mandando, por si el GPS no se movía y el cuerpo sí (cinta, bici estática)', () => {
    const e = estimateWorkout(still({ hr: hrSeries(130, 30) }), profile);
    expect(e.kcalMethod).toBe('hr');
    expect(e.kcal).toBeGreaterThan(100);
  });

  it('los pasos del anillo en la ventana ganan al «no se movió» del GPS (andar en cinta con el GPS quieto)', () => {
    const e = estimateWorkout(still(), profile, 2700, 1);
    expect(e.distanceM).toBeGreaterThan(1500);
    expect(e.distanceProvenance).toBe('estimated');
    expect(e.kcal).toBeGreaterThan(60);
  });

  it('en bici también (ronda 45): parado no se pedalea, y no suma las 7 kcal por minuto del MET de la bici', () => {
    const e = estimateWorkout(still({ sport: 'cycle' }), profile);
    expect(e.distanceM).toBe(0);
    expect(e.kcal).toBe(12); // el mismo reposo que a pie, no (6,8 − 1) × 80 × 0,5 = 232
    expect(e.idleMs).toBe(30 * min);
  });

  it('pero en un rodillo (el GPS no ve movimiento) el pulso de esfuerzo manda: se pedalea aunque no se avance', () => {
    const e = estimateWorkout(still({ sport: 'cycle', hr: hrSeries(135, 30) }), profile);
    expect(e.kcalMethod).toBe('hr');
    expect(e.kcal).toBeGreaterThan(150);
  });

  it('una distancia escrita a mano manda sobre el «no se movió»', () => {
    const e = estimateWorkout(still({ distanceM: 3000, distanceSource: 'manual' }), profile);
    expect(e.distanceM).toBe(3000);
    expect(e.distanceProvenance).toBe('manual');
  });
});

describe('estimateWorkout: energía minuto a minuto con la velocidad del GPS', () => {
  /** Una hora de bici: `moving` minutos a `kmh` y el resto parado (semáforos), con los metros de cada minuto. */
  const ride = (moving: number, kmh: number, sport: 'cycle' | 'walk' | 'run' = 'cycle'): WorkoutRecord => {
    const perMinute = (kmh * 1000) / 60;
    const splits = Array.from({ length: 60 }, (_, i) => (i < moving ? perMinute : 0));
    const total = Math.round(splits.reduce((a, b) => a + b, 0));
    return base({ sport, endMs: start + 60 * min, distanceM: total, distanceSource: 'gps', splitsM: splits.map(Math.round) });
  };

  it('con paradas gasta más que con la media: las paradas no «frenan» el resto', () => {
    // 45 min a 20 km/h y 15 min parado: 15 km en una hora = 15 km/h de media.
    const withStops = estimateWorkout(ride(45, 20), profile);
    const averaged = estimateWorkout({ ...ride(45, 20), splitsM: undefined }, profile);
    expect(withStops.kcalMethod).toBe('speed-met');
    expect(averaged.avgSpeedKmh).toBeCloseTo(15, 0);
    // A 15 km/h de media el MET sale ~5,5; a 20 km/h es ~7,6 y parado ~1,3: 0,75 × 6,6 + 0,25 × 0,3 > 4,5.
    expect(withStops.kcal).toBeGreaterThan(averaged.kcal * 1.1);
    expect(withStops.kcal).toBeLessThan(averaged.kcal * 1.5);
  });

  it('sin paradas da lo mismo que con la media', () => {
    const steady = estimateWorkout(ride(60, 18), profile);
    const averaged = estimateWorkout({ ...ride(60, 18), splitsM: undefined }, profile);
    expect(steady.kcal).toBeCloseTo(averaged.kcal, -1);
  });

  it('los minutos sin GPS (-1) se completan con la intensidad media de los demás, no cuentan como parados', () => {
    const full = ride(60, 18);
    const gap = { ...full, splitsM: full.splitsM!.map((m, i) => (i >= 20 && i < 30 ? -1 : m)) };
    const withGap = estimateWorkout({ ...gap, distanceM: gap.splitsM.filter((m) => m >= 0).reduce((a, b) => a + b, 0) }, profile);
    expect(withGap.kcal).toBeCloseTo(estimateWorkout(full, profile).kcal, -1);
  });

  it('si la distancia se corrigió a mano ya no valen esos minutos: se vuelve a la media', () => {
    const corrected = { ...ride(45, 20), distanceM: 30_000, distanceSource: 'manual' as const };
    const e = estimateWorkout(corrected, profile);
    expect(e.avgSpeedKmh).toBeCloseTo(30, 0);
    expect(e.kcal).toBe(estimateWorkout({ ...corrected, splitsM: undefined }, profile).kcal);
  });

  it('unos minutos que no cuadran con la distancia guardada se ignoran', () => {
    const odd = { ...ride(45, 20), distanceM: 40_000 };
    expect(estimateWorkout(odd, profile).kcal).toBe(estimateWorkout({ ...odd, splitsM: undefined }, profile).kcal);
  });

  it('en series (rápido y suave) cada minuto cuenta con su ritmo: andar cuesta menos por km que correr', () => {
    // 30 min alternando 1 min a 14 km/h y 1 min a 6 km/h: la media (10 km/h) trataría todo como correr.
    const splits = Array.from({ length: 30 }, (_, i) => Math.round(((i % 2 === 0 ? 14 : 6) * 1000) / 60));
    const total = splits.reduce((a, b) => a + b, 0);
    const record = base({ sport: 'run', endMs: start + 30 * min, distanceM: total, distanceSource: 'gps', splitsM: splits });
    const bySplits = estimateWorkout(record, profile).kcal;
    const averaged = estimateWorkout({ ...record, splitsM: undefined }, profile).kcal;
    expect(bySplits).toBeLessThan(averaged);
    expect(bySplits).toBeGreaterThan(averaged * 0.75);
  });

  it('el último minuto, si es parcial, se mide con lo que duró de verdad', () => {
    // 10 min y 30 s a 12 km/h: el último «minuto» solo trae 30 s de recorrido (100 m), no 200.
    const splits = [...Array.from({ length: 10 }, () => 200), 100];
    const record = base({ sport: 'cycle', endMs: start + 10.5 * min, distanceM: 2100, distanceSource: 'gps', splitsM: splits });
    const steady = estimateWorkout({ ...record, splitsM: undefined }, profile);
    expect(estimateWorkout(record, profile).kcal).toBeCloseTo(steady.kcal, -1);
  });

  it('en BiciMAD (sin MET por velocidad) la velocidad no cambia el MET, pero los minutos parados no cuentan como pedaleo: asistencia en lo que se avanza y reposo en lo demás', () => {
    const electric = { ...ride(45, 20), sport: 'bicimad' as const };
    const e = estimateWorkout(electric, profile);
    expect(e.kcalMethod).toBe('met');
    // 45 min con el MET de la asistencia (4,0) y 15 parado a (1,3 − 1): 180 + 6.
    expect(e.kcal).toBe(Math.round((4.0 - 1) * 80 * 0.75 + (1.3 - 1) * 80 * 0.25));
    expect(e.idleMs).toBe(15 * min);
  });

  it('en BiciMAD con pulso, las calorías salen del pulso aunque haya velocidad y distancia', () => {
    const electric = { ...ride(45, 20), sport: 'bicimad' as const, hr: hrSeries(125, 60) };
    expect(estimateWorkout(electric, profile).kcalMethod).toBe('hr');
  });
});

describe('estimateWorkout: subir cuestas al andar', () => {
  const gpsWalk = (over: Partial<WorkoutRecord> = {}): WorkoutRecord => base({ distanceM: 4500, distanceSource: 'gps', steps: 5500, ...over });

  it('suma lo que cuesta subir (0,009 kcal por kg y metro) cuando las calorías salen de la velocidad', () => {
    const flat = estimateWorkout(gpsWalk(), profile);
    const hill = estimateWorkout(gpsWalk({ ascentM: 100 }), profile);
    expect(flat.kcalMethod).toBe('speed-met');
    expect(hill.kcalMethod).toBe('speed-met');
    expect(hill.kcal - flat.kcal).toBeCloseTo(0.009 * 80 * 100, 0); // 72 kcal
    expect(hill.ascentM).toBe(100);
    expect(flat.ascentM).toBeNull();
  });

  it('también con el MET genérico (sin velocidad ni pulso)', () => {
    const flat = estimateWorkout(base({}), profile);
    const hill = estimateWorkout(base({ ascentM: 50 }), profile);
    expect(flat.kcalMethod).toBe('met');
    expect(hill.kcal - flat.kcal).toBeCloseTo(0.009 * 80 * 50, 0);
  });

  it('con el pulso no cambia nada: ya recoge el esfuerzo de la cuesta', () => {
    const withHr = { hr: hrSeries(120, 60) };
    const flat = estimateWorkout(base(withHr), profile);
    const hill = estimateWorkout(base({ ...withHr, ascentM: 100 }), profile);
    expect(flat.kcalMethod).toBe('hr');
    expect(hill.kcal).toBe(flat.kcal);
  });

  it('con las calorías fijadas a mano tampoco', () => {
    expect(estimateWorkout(gpsWalk({ kcalManual: 300, ascentM: 100 }), profile).kcal).toBe(300);
  });

  it('solo al andar: en bici o corriendo el desnivel medido no se suma', () => {
    for (const sport of ['cycle', 'run', 'hike'] as const) {
      const flat = estimateWorkout(gpsWalk({ sport }), profile);
      const hill = estimateWorkout(gpsWalk({ sport, ascentM: 100 }), profile);
      expect(hill.kcal).toBe(flat.kcal);
    }
  });
});


describe('estimateWorkout: ¿se está haciendo el ejercicio? (ronda 45)', () => {
  const gym = (over: Partial<WorkoutRecord> = {}): WorkoutRecord => base({ sport: 'gym', endMs: start + 60 * min, ...over });
  /** Un pulso que cambia con el minuto: `at(minuto)` lpm, una lectura cada 5 s. */
  const hrBy = (minutes: number, at: (minute: number) => number): Array<[number, number]> =>
    Array.from({ length: minutes * 12 }, (_, i) => [start + i * 5000, at(Math.floor(i / 12))] as [number, number]);

  it('una hora de «fuerza» con el pulso de reposo (55–75) casi no suma calorías: antes sumaba (4 − 1) × 80 = 240', () => {
    const e = estimateWorkout(gym({ hr: hrBy(60, (m) => 58 + (m % 5) * 4) }), profile);
    expect(e.kcal).toBeLessThan(25);
    expect(e.idleMs).toBe(60 * min);
    expect(e.kcalMethod).toBe('met');
  });

  it('con el pulso de esfuerzo (110–140) sigue dando lo de siempre', () => {
    const e = estimateWorkout(gym({ hr: hrBy(60, (m) => 110 + (m % 4) * 10) }), profile);
    expect(e.kcalMethod).toBe('hr');
    expect(e.idleMs).toBe(0);
    expect(e.kcal).toBeGreaterThan(150);
  });

  it('media hora de ejercicio y media de sofá (se olvidó la pausa): la mitad de lo que daba el MET, y lo dice', () => {
    const e = estimateWorkout(gym({ hr: hrBy(60, (m) => (m < 30 ? 118 : 62)) }), profile);
    expect(e.idleMs).toBe(30 * min);
    const exercising = estimateWorkout(gym({ endMs: start + 30 * min, hr: hrBy(30, () => 118) }), profile);
    // Keytel por tramos: lo del sofá aporta ~0 y lo de antes, lo suyo.
    expect(e.kcal).toBeGreaterThan(exercising.kcal * 0.8);
    expect(e.kcal).toBeLessThan(exercising.kcal * 1.2);
    // Y sin pulso suficiente para Keytel, el MET solo cuenta la parte activa.
    const lowSession = estimateWorkout(gym({ hr: hrBy(60, (m) => (m < 30 ? 100 : 62)) }), profile);
    expect(lowSession.kcalMethod).toBe('met');
    expect(lowSession.kcal).toBeCloseTo((4.0 - 1) * 80 * 0.5 + (1.3 - 1) * 80 * 0.5, -1);
  });

  it('sin pulso (o con muy poco) no se inventa nada: se sigue suponiendo ejercicio, como antes', () => {
    expect(estimateWorkout(gym(), profile).kcal).toBe(240);
    expect(estimateWorkout(gym({ hr: hrBy(1, () => 60) }), profile).kcal).toBe(240); // un solo minuto con pulso: puede ser el eco de la lectura anterior
  });

  it('el yoga (pulso bajo de verdad) no se toma por reposo con 70–85 lpm', () => {
    const e = estimateWorkout(base({ sport: 'yoga', hr: hrBy(60, (m) => 72 + (m % 3) * 5) }), profile);
    expect(e.idleMs).toBe(0);
    // Con la rampa entre el umbral (65 lpm en lo suave) y 10 lpm más, el primer tramo cuenta algo menos que entero: alrededor de 114, no 120.
    expect(e.kcal).toBeGreaterThan(105);
    expect(e.kcal).toBeLessThanOrEqual(Math.round((2.5 - 1) * 80));
  });

  it('un minuto aislado de pulso bajo no es ejercicio parado: lo que cuenta es el máximo del minuto', () => {
    const noisy: Array<[number, number]> = Array.from({ length: 60 * 12 }, (_, i) => [start + i * 5000, i % 7 === 0 ? 118 : 70] as [number, number]);
    expect(estimateWorkout(gym({ hr: noisy }), profile).idleMs).toBe(0);
  });

  it('las lecturas de reposo no suman con Keytel: de 60 lpm a 140 lpm la energía sube sin saltos', () => {
    const at = (bpm: number): number => estimateWorkout(gym({ hr: hrBy(60, () => bpm) }), profile).kcal;
    expect(at(62)).toBeLessThan(25);
    expect(at(95)).toBeGreaterThan(at(88));
    expect(at(88)).toBeGreaterThanOrEqual(at(82));
    for (let bpm = 80; bpm < 140; bpm += 2) expect(at(bpm + 2) - at(bpm)).toBeLessThan(120); // sin escalones
  });

  it('en bici con GPS se decide por la velocidad: parado no pedalea aunque el pulso esté alto (la subida del semáforo)', () => {
    const moving = 30;
    const splits = Array.from({ length: 60 }, (_, i) => (i < moving ? 400 : 0)); // 24 km/h y luego parado
    const record = base({ sport: 'cycle', distanceM: 400 * moving, distanceSource: 'gps', splitsM: splits });
    const e = estimateWorkout(record, profile);
    expect(e.idleMs).toBe(30 * min);
  });

  it('senderismo (sin MET por velocidad): a pie, con GPS minuto a minuto, los minutos casi parados no cuentan como ejercicio', () => {
    const splits = Array.from({ length: 60 }, (_, i) => (i < 40 ? 80 : 0)); // 4,8 km/h y 20 minutos de pausa de merienda sin pulsar «Pausa»
    const e = estimateWorkout(base({ sport: 'hike', distanceM: 3200, distanceSource: 'gps', splitsM: splits }), profile);
    expect(e.idleMs).toBe(20 * min);
    expect(e.kcal).toBe(Math.round((6.0 - 1) * 80 * (40 / 60) + (1.3 - 1) * 80 * (20 / 60)));
  });

  it('con las calorías escritas a mano, mandan: el tiempo parado se dice pero no cambia la cifra', () => {
    const e = estimateWorkout(gym({ kcalManual: 500, hr: hrBy(60, () => 62) }), profile);
    expect(e.kcal).toBe(500);
    expect(e.kcalMethod).toBe('manual');
  });
});
