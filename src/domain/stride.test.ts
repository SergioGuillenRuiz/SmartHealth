import { describe, expect, it } from 'vitest';
import { baseStride } from './estimation';
import type { ProfileEntry } from './profile';
import { autoStrideEntry, learnStride, measureCalibrationWalk, MIN_LEARN_WALKS, observedStrideM } from './stride';
import type { WorkoutRecord } from './workout';

const MIN = 60_000;
const T0 = Date.UTC(2026, 5, 1, 9, 0, 0);

/** Un paseo con GPS: por defecto 20 min, 2 200 pasos (110 pasos/min) y 1 500 m, o sea 0,682 m por paso. */
function walk(n: number, o: Partial<WorkoutRecord> = {}): WorkoutRecord {
  const startMs = T0 + n * 24 * 60 * MIN;
  return {
    id: `w${n}`,
    sport: 'walk',
    startMs,
    endMs: startMs + 20 * MIN,
    pausedMs: 0,
    source: 'live',
    steps: 2200,
    distanceM: 1500,
    distanceSource: 'gps',
    splitsM: new Array<number>(20).fill(75),
    ...o,
  };
}

/** Un paseo cuya zancada observada es `strideM` (con los mismos pasos y duración). */
const walkWithStride = (n: number, strideM: number): WorkoutRecord => walk(n, { distanceM: Math.round(2200 * strideM) });

const profile: ProfileEntry = { date: '2026-01-01', heightCm: 175, weightKg: 75, sex: 'male', birthDate: '1990-05-05' };
const TODAY = '2026-06-20';

describe('observedStrideM: la zancada que mide un paseo con GPS', () => {
  it('distancia entre pasos', () => {
    expect(observedStrideM(walk(1))).toBeCloseTo(1500 / 2200, 6);
  });

  it('el tiempo en pausa no cuenta para la cadencia', () => {
    // 2 200 pasos en 20 min con 5 de pausa: 147 pasos/min activos, ya es correr.
    expect(observedStrideM(walk(1, { pausedMs: 5 * MIN }))).toBeNull();
    // Y con 2 min de pausa sigue siendo un paseo (122 pasos/min).
    expect(observedStrideM(walk(1, { pausedMs: 2 * MIN }))).not.toBeNull();
  });

  it.each([
    ['otro deporte', { sport: 'run' as const }],
    ['un registro a mano', { source: 'manual' as const }],
    ['sin distancia del GPS (escrita a mano)', { distanceSource: 'manual' as const }],
    ['pocos pasos', { steps: 500 }],
    ['poca distancia', { distanceM: 500 }],
    ['un paseo corto', { endMs: T0 + 24 * 60 * MIN + 7 * MIN }],
    ['cadencia de carrera', { steps: 3000 }],
    ['cadencia de ir parado', { steps: 1200 }],
    ['una zancada imposible', { distanceM: 9000 }],
    ['sin pasos', { steps: undefined }],
  ])('no sirve: %s', (_name, patch) => {
    expect(observedStrideM(walk(1, patch as Partial<WorkoutRecord>))).toBeNull();
  });

  it('un paseo con el GPS fallando buena parte del rato no mide la zancada (la distancia sería la de los pasos)', () => {
    const half = [...new Array<number>(10).fill(75), ...new Array<number>(10).fill(-1)];
    expect(observedStrideM(walk(1, { splitsM: half }))).toBeNull();
    const mostly = [...new Array<number>(17).fill(75), ...new Array<number>(3).fill(-1)];
    expect(observedStrideM(walk(1, { splitsM: mostly }))).not.toBeNull();
  });
});

describe('learnStride: la zancada de la persona según sus paseos', () => {
  const heightStrideM = baseStride(profile).meters; // 0,726 m

  it(`necesita al menos ${MIN_LEARN_WALKS} paseos`, () => {
    expect(learnStride([walkWithStride(1, 0.66), walkWithStride(2, 0.66)], heightStrideM)).toBeNull();
    expect(learnStride([walkWithStride(1, 0.66), walkWithStride(2, 0.66), walkWithStride(3, 0.66)], heightStrideM)).toEqual({ cm: 66, walks: 3 });
  });

  it('es la mediana: un paseo con el GPS descolocado no la mueve', () => {
    const walks = [0.66, 0.67, 0.65, 0.68, 0.9].map((stride, i) => walkWithStride(i + 1, stride));
    expect(learnStride(walks, heightStrideM)?.cm).toBeCloseTo(67, 0);
  });

  it('descarta las medidas que se apartan mucho de la zancada por altura', () => {
    // 0,40 m y 1,10 m están a más de un 30 % de 0,726 m: no cuentan, y con solo dos buenas no se aprende nada.
    const walks = [walkWithStride(1, 0.4), walkWithStride(2, 1.1), walkWithStride(3, 0.66), walkWithStride(4, 0.67)];
    expect(learnStride(walks, heightStrideM)).toBeNull();
  });

  it('paseos que no se parecen entre sí no miden nada', () => {
    const walks = [0.55, 0.7, 0.88].map((stride, i) => walkWithStride(i + 1, stride));
    expect(learnStride(walks, heightStrideM)).toBeNull();
  });

  it('con muchos paseos solo valen los 10 más recientes', () => {
    const old = Array.from({ length: 8 }, (_, i) => walkWithStride(i + 1, 0.6));
    const recent = Array.from({ length: 10 }, (_, i) => walkWithStride(i + 20, 0.7));
    expect(learnStride([...old, ...recent], heightStrideM)).toEqual({ cm: 70, walks: 10 });
  });
});

describe('autoStrideEntry: cuándo se ajusta la zancada', () => {
  const threeWalks = [1, 2, 3].map((n) => walkWithStride(n, 0.66));

  it('con tres paseos crea una entrada que solo fija la zancada, marcada como automática', () => {
    const entry = autoStrideEntry([profile], TODAY, threeWalks);
    expect(entry).toMatchObject({ date: TODAY, strideCm: 66, strideAuto: true, strideOnly: true, heightCm: 175, weightKg: 75 });
    expect(baseStride(entry as ProfileEntry)).toEqual({ meters: 0.66, source: 'learned' });
  });

  it('sin perfil no hace nada', () => {
    expect(autoStrideEntry([], TODAY, threeWalks)).toBeNull();
  });

  it('una zancada fijada por la persona manda siempre', () => {
    expect(autoStrideEntry([{ ...profile, strideCm: 70 }], TODAY, threeWalks)).toBeNull();
    // Aunque la calibración sea de una entrada anterior que solo la fija.
    const history: ProfileEntry[] = [profile, { ...profile, date: '2026-03-01', strideCm: 70, strideOnly: true }];
    expect(autoStrideEntry(history, TODAY, threeWalks)).toBeNull();
  });

  it('si ya vale la que se usa (menos de un 3 % de diferencia), no añade una entrada más', () => {
    const near = [1, 2, 3].map((n) => walkWithStride(n, 0.727)); // la de la altura es 72,6 cm
    expect(autoStrideEntry([profile], TODAY, near)).toBeNull();
  });

  it('una zancada ajustada antes se reajusta con paseos nuevos', () => {
    const first = autoStrideEntry([profile], '2026-06-10', threeWalks) as ProfileEntry;
    const later = [4, 5, 6].map((n) => walkWithStride(n, 0.7));
    const next = autoStrideEntry([profile, first], TODAY, [...threeWalks, ...later]);
    expect(next).toMatchObject({ date: TODAY, strideAuto: true, strideOnly: true });
    expect(next?.strideCm).toBeCloseTo(68, 0); // la mediana de los seis paseos
  });

  it('si hoy ya hay una entrada, se le pone la zancada en vez de crear otra', () => {
    const todays: ProfileEntry = { ...profile, date: TODAY, weightKg: 74 };
    const entry = autoStrideEntry([profile, todays], TODAY, threeWalks);
    expect(entry).toEqual({ ...todays, strideCm: 66, strideAuto: true });
  });

  it('con paseos que no sirven, no hace nada', () => {
    expect(autoStrideEntry([profile], TODAY, [walk(1, { sport: 'run' }), walk(2, { sport: 'run' }), walk(3, { sport: 'run' })])).toBeNull();
  });
});

describe('measureCalibrationWalk: la calibración guiada', () => {
  const HEIGHT_STRIDE = 0.74;
  /** Un paseo de calibración: 300 m en 4 minutos con los pasos que da una zancada de `strideM`. */
  const cal = (strideM: number, o: Partial<WorkoutRecord> = {}): WorkoutRecord =>
    walk(0, { endMs: T0 + 4 * MIN, distanceM: 300, steps: Math.round(300 / strideM), splitsM: [75, 75, 75, 75], ...o });

  it('saca la zancada de los metros del GPS y los pasos del anillo', () => {
    const out = measureCalibrationWalk(cal(0.72), HEIGHT_STRIDE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.measurement.cm).toBeCloseTo(72, 0);
    expect(out.measurement.verdict).toBe('good');
    expect(out.measurement.flaws).toEqual([]);
    expect(out.measurement.distanceM).toBe(300);
  });

  it('un paseo corto (150–250 m) sirve pero es solo aproximado, y por debajo de 150 m es poco fiable', () => {
    const fair = measureCalibrationWalk(cal(0.72, { distanceM: 200, steps: 278 }), HEIGHT_STRIDE);
    expect(fair.ok && fair.measurement.verdict).toBe('fair');
    const poor = measureCalibrationWalk(cal(0.72, { distanceM: 120, steps: 167 }), HEIGHT_STRIDE);
    expect(poor.ok && poor.measurement.verdict).toBe('poor');
    expect(poor.ok && poor.measurement.flaws).toContain('short');
  });

  it('por debajo de 100 m o 100 pasos no mide nada', () => {
    expect(measureCalibrationWalk(cal(0.72, { distanceM: 80, steps: 111 }), HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'too-short' });
    expect(measureCalibrationWalk(cal(0.72, { distanceM: 300, steps: 90 }), HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'too-short' });
  });

  it('sin distancia de GPS o sin pasos del anillo dice qué falta', () => {
    expect(measureCalibrationWalk(cal(0.72, { distanceSource: 'manual' }), HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'no-gps' });
    const { distanceM: _d, ...noDistance } = cal(0.72);
    expect(measureCalibrationWalk(noDistance, HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'no-gps' });
    const { steps: _s, ...noSteps } = cal(0.72);
    expect(measureCalibrationWalk(noSteps, HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'no-steps' });
    expect(measureCalibrationWalk(cal(0.72, { steps: 0 }), HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'no-steps' });
  });

  it('una zancada imposible (el anillo contó casi nada, o el GPS corrió de más) no se ofrece', () => {
    expect(measureCalibrationWalk(cal(0.72, { steps: 110 }), HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'implausible' }); // 2,7 m por paso
    expect(measureCalibrationWalk(cal(0.72, { distanceM: 100, steps: 400 }), HEIGHT_STRIDE)).toEqual({ ok: false, reason: 'implausible' }); // 25 cm
  });

  it('avisa de lo que resta fiabilidad: huecos del GPS, ir deprisa o salir muy lejos de la altura', () => {
    const gaps = measureCalibrationWalk(cal(0.72, { splitsM: [75, -1, -1, 75] }), HEIGHT_STRIDE);
    expect(gaps.ok && gaps.measurement.flaws).toContain('gps-gaps');
    expect(gaps.ok && gaps.measurement.verdict).toBe('poor'); // la mitad del paseo sin GPS
    const fast = measureCalibrationWalk(cal(0.72, { endMs: T0 + 2 * MIN }), HEIGHT_STRIDE); // 208 pasos/min: trotando
    expect(fast.ok && fast.measurement.flaws).toContain('cadence');
    const far = measureCalibrationWalk(cal(0.55, { endMs: T0 + 6 * MIN }), HEIGHT_STRIDE); // 26 % por debajo de la de su altura
    expect(far.ok && far.measurement.flaws).toContain('far-from-height');
    expect(far.ok && far.measurement.verdict).toBe('fair');
    const wayOff = measureCalibrationWalk(cal(0.45, { endMs: T0 + 7 * MIN }), HEIGHT_STRIDE); // 39 % por debajo
    expect(wayOff.ok && wayOff.measurement.verdict).toBe('poor');
  });

  it('a cadencia de marcha normal no corrige la zancada; trotando, sí (la zancada se alarga)', () => {
    const normal = measureCalibrationWalk(cal(0.72), HEIGHT_STRIDE);
    const jog = measureCalibrationWalk(cal(0.72, { endMs: T0 + 2 * MIN }), HEIGHT_STRIDE);
    expect(normal.ok && jog.ok).toBe(true);
    if (normal.ok && jog.ok) expect(jog.measurement.cm).toBeLessThan(normal.measurement.cm);
  });

  it('descuenta las pausas del tiempo activo al sacar la cadencia', () => {
    const paused = measureCalibrationWalk(cal(0.72, { endMs: T0 + 8 * MIN, pausedMs: 4 * MIN }), HEIGHT_STRIDE);
    const plain = measureCalibrationWalk(cal(0.72), HEIGHT_STRIDE);
    expect(paused.ok && plain.ok && paused.measurement.cadenceSpm === plain.measurement.cadenceSpm).toBe(true);
  });
});
