import { describe, expect, it } from 'vitest';
import type { WorkoutRecord } from '../domain/workout';
import { applyCorrections, contextOf, correctionProblems, MAX_DISTANCE_KM, MAX_ENERGY_KCAL, maxAverageKmh } from './workout-corrections';

const HOUR = 3_600_000;
const gpsRide: WorkoutRecord = { id: 'r', sport: 'cycle', startMs: 1, endMs: 1 + HOUR, pausedMs: 0, source: 'live', distanceM: 28_400, distanceSource: 'gps' };
const noDistance: WorkoutRecord = { id: 'n', sport: 'cycle', startMs: 1, endMs: 1 + HOUR, pausedMs: 0, source: 'live' };

describe('applyCorrections', () => {
  it('una distancia escrita sustituye a la del GPS y se marca como manual', () => {
    expect(applyCorrections(gpsRide, gpsRide, '9', '')).toMatchObject({ distanceM: 9000, distanceSource: 'manual' });
    expect(applyCorrections(gpsRide, gpsRide, '9,5', '')).toMatchObject({ distanceM: 9500 });
  });

  it('teclear una distancia y luego borrarla recupera la del GPS (antes se perdía la medida)', () => {
    const typed = applyCorrections(gpsRide, gpsRide, '9', '');
    expect(typed.distanceSource).toBe('manual');
    const cleared = applyCorrections(gpsRide, typed, '', '');
    expect(cleared).toMatchObject({ distanceM: 28_400, distanceSource: 'gps' });
  });

  it('sin nada medido que recuperar, vaciar el campo deja el entreno sin distancia', () => {
    const typed = applyCorrections(noDistance, noDistance, '12', '');
    expect(typed.distanceM).toBe(12_000);
    const cleared = applyCorrections(noDistance, typed, '', '');
    expect(cleared.distanceM).toBeUndefined();
    expect(cleared.distanceSource).toBeUndefined();
  });

  it('si al abrir la distancia ya era manual y se vacía, se quita (no hay otra que recuperar)', () => {
    const manual: WorkoutRecord = { ...noDistance, distanceM: 10_000, distanceSource: 'manual' };
    const cleared = applyCorrections(manual, manual, '', '');
    expect(cleared.distanceM).toBeUndefined();
  });

  it('las calorías escritas son manuales; vacías vuelven a la estimación', () => {
    const typed = applyCorrections(noDistance, noDistance, '', '640');
    expect(typed.kcalManual).toBe(640);
    expect(applyCorrections(noDistance, typed, '', '').kcalManual).toBeUndefined();
    expect(applyCorrections(noDistance, noDistance, '', '0').kcalManual).toBe(0);
    expect(applyCorrections(noDistance, noDistance, '', '1.500').kcalManual).toBe(1500); // no 2 kcal
  });

  it('no modifica el registro de entrada', () => {
    const before = JSON.stringify(gpsRide);
    applyCorrections(gpsRide, gpsRide, '5', '300');
    expect(JSON.stringify(gpsRide)).toBe(before);
  });
});

describe('límites de lo que se escribe a mano', () => {
  it('son más estrictos que lo que admite una copia de seguridad al restaurarse (si no, una copia propia no se podría volver a cargar)', () => {
    expect(MAX_DISTANCE_KM * 1000).toBeLessThanOrEqual(2_000_000);
    expect(MAX_ENERGY_KCAL).toBeLessThanOrEqual(50_000);
  });

  it('una distancia absurda no entra en el registro y se avisa', () => {
    expect(correctionProblems('100000', '').km).toMatch(/entre 0 y 500 km/);
    const out = applyCorrections(gpsRide, gpsRide, '100000', '');
    expect(out).toMatchObject({ distanceM: 28_400, distanceSource: 'gps' }); // se queda lo medido
  });

  it('unas calorías absurdas o negativas no entran y se avisa', () => {
    expect(correctionProblems('', '90000').kcal).toMatch(/entre 0 y 10 000/);
    expect(correctionProblems('', '90.000').kcal).toMatch(/entre 0 y 10 000/); // con punto de miles también
    expect(correctionProblems('', '-5').kcal).not.toBeNull();
    expect(applyCorrections(noDistance, noDistance, '', '90000').kcalManual).toBeUndefined();
  });

  it('lo que no es un número se avisa en vez de ignorarse sin decir nada', () => {
    expect(correctionProblems('abc', '').km).toMatch(/como un número/);
    expect(correctionProblems('', '12 mil').kcal).toMatch(/como un número/);
    expect(applyCorrections(noDistance, noDistance, 'abc', '').distanceM).toBeUndefined();
  });

  it('vacío y los valores en rango no dan problemas (también los límites exactos)', () => {
    expect(correctionProblems('', '')).toEqual({ km: null, kcal: null });
    expect(correctionProblems('500', '10000')).toEqual({ km: null, kcal: null });
    expect(correctionProblems('0', '0')).toEqual({ km: null, kcal: null });
    expect(correctionProblems('12,5', '640')).toEqual({ km: null, kcal: null });
  });
});

describe('una distancia tiene que ser posible en el tiempo que duró el entreno', () => {
  const walk = { sport: 'walk', activeMinutes: 30 } as const;
  const ride = { sport: 'cycle', activeMinutes: 270 } as const;

  it('500 km en media hora a pie es un error de escritura: se avisa y se descarta', () => {
    const problem = correctionProblems('500', '', walk).km;
    expect(problem).toMatch(/500 km en 30 min son 1000 km\/h/);
    expect(problem).toMatch(/caminar/);
    expect(correctionProblems('2,5', '', walk).km).toBeNull();
  });

  it('las cotas por deporte dejan pasar lo exigente pero real: media maratón en 1 h 45, 120 km en bici en 4 h 30, marcha atlética', () => {
    expect(correctionProblems('21,1', '', { sport: 'run', activeMinutes: 105 }).km).toBeNull();
    expect(correctionProblems('10', '', { sport: 'run', activeMinutes: 27 }).km).toBeNull(); // 22 km/h
    expect(correctionProblems('120', '', ride).km).toBeNull();
    expect(correctionProblems('100', '', { sport: 'cycle', activeMinutes: 150 }).km).toBeNull(); // 40 km/h
    expect(correctionProblems('7,5', '', { sport: 'walk', activeMinutes: 30 }).km).toBeNull(); // 15 km/h
  });

  it('5 km corriendo en 10 minutos (30 km/h) o en bici de alquiler a 50 km/h no son posibles', () => {
    expect(correctionProblems('5', '', { sport: 'run', activeMinutes: 10 }).km).toMatch(/30 km\/h/);
    expect(correctionProblems('50', '', { sport: 'bicimad', activeMinutes: 60 }).km).toMatch(/bicimad/);
    expect(correctionProblems('30', '', { sport: 'hike', activeMinutes: 120 }).km).toMatch(/senderismo/);
  });

  it('sin contexto (o sin tiempo conocido) no se compara, y una distancia que no se acepta no entra en el registro', () => {
    expect(correctionProblems('500', '').km).toBeNull();
    expect(correctionProblems('500', '', { sport: 'walk', activeMinutes: null }).km).toBeNull();
    expect(correctionProblems('500', '', { sport: 'walk', activeMinutes: 0.5 }).km).toBeNull(); // menos de un minuto: no se compara
    const slow: WorkoutRecord = { id: 's', sport: 'walk', startMs: 0, endMs: 30 * 60_000, pausedMs: 0, source: 'manual' };
    expect(applyCorrections(slow, slow, '500', '').distanceM).toBeUndefined();
    expect(applyCorrections(slow, slow, '2,5', '').distanceM).toBe(2500);
  });

  it('los minutos son los activos: los parones no cuentan (con el reloj de 2 h pero 30 min en marcha, 8 km a pie no valen)', () => {
    const paused = contextOf({ sport: 'walk', startMs: 0, endMs: 2 * 3_600_000, pausedMs: 90 * 60_000 });
    expect(paused.activeMinutes).toBe(30);
    expect(correctionProblems('8', '', paused).km).not.toBeNull();
    expect(correctionProblems('8', '', { sport: 'walk', activeMinutes: 120 }).km).toBeNull();
  });

  it('las cotas existen para cada deporte con distancia y crecen de a pie a bici', () => {
    expect(maxAverageKmh('hike')).toBeLessThan(maxAverageKmh('walk'));
    expect(maxAverageKmh('walk')).toBeLessThan(maxAverageKmh('run'));
    expect(maxAverageKmh('run')).toBeLessThan(maxAverageKmh('cycle'));
    expect(maxAverageKmh('bicimad')).toBeLessThan(maxAverageKmh('cycle'));
  });

  it('las unidades escritas valen: «2,5 km» y «300 kcal»', () => {
    expect(correctionProblems('2,5 km', '300 kcal', walk)).toEqual({ km: null, kcal: null });
    expect(applyCorrections(noDistance, noDistance, '2,5 km', '300 kcal')).toMatchObject({ distanceM: 2500, kcalManual: 300 });
  });
});
