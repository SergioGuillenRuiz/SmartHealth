import { describe, expect, it } from 'vitest';
import { adaptiveMaintenance, carriedWeights, KCAL_PER_KG, type AdaptiveInput } from './adaptive-intake';
import { addDays, type DayKey } from './dates';

const TODAY = '2026-10-19';
const ago = (n: number): DayKey => addDays(TODAY, -n);
const FORMULA = 2500;

/** Lo comido cada día entre hace `from` días y hace `to` días (ambos incluidos). */
function eaten(from: number, to: number, kcal: number | ((n: number) => number)): Map<DayKey, number> {
  const map = new Map<DayKey, number>();
  for (let n = from; n >= to; n--) map.set(ago(n), typeof kcal === 'number' ? kcal : kcal(n));
  return map;
}

/** Un peso anotado cada día, de hace `days` días a hoy, que va de `from` a `to` kg en línea recta (quien se pesa a diario y apunta lo que marca la báscula). */
function daily(days: number, from: number, to: number): Array<{ day: DayKey; kg: number }> {
  return Array.from({ length: days + 1 }, (_, i) => ({ day: ago(days - i), kg: from + ((to - from) * i) / days }));
}

const input = (over: Partial<AdaptiveInput>): AdaptiveInput => ({ today: TODAY, formulaKcal: FORMULA, floorKcal: 1700, intake: new Map(), weights: [], ...over });

describe('adaptiveMaintenance', () => {
  it('sin ningún peso es la fórmula, y con un peso de hace menos de dos semanas también', () => {
    expect(adaptiveMaintenance(input({ intake: eaten(60, 1, 2000) }))).toMatchObject({ kcal: FORMULA, source: 'formula', confidence: 0 });
    expect(adaptiveMaintenance(input({ intake: eaten(60, 1, 2000), weights: [{ day: ago(8), kg: 80 }] }))).toMatchObject({ source: 'formula', spanDays: 8 });
  });

  it('se supone que se pesa a diario: un peso anotado hace semanas que no ha cambiado son semanas de peso estable, no «faltan pesos»', () => {
    const result = adaptiveMaintenance(input({ intake: eaten(56, 1, 2000), weights: [{ day: ago(90), kg: 80 }] }));
    expect(result).toMatchObject({ source: 'adaptive', kcal: 2000, trendKgPerWeek: 0, spanDays: 56 });
    // Con el peso de hace 30 días: 30 días de datos, ni pocos ni todos: se mezcla con la fórmula.
    const partial = adaptiveMaintenance(input({ intake: eaten(30, 1, 2000), weights: [{ day: ago(30), kg: 80 }] }));
    expect(partial.source).toBe('mixed');
    expect(partial.kcal).toBeGreaterThan(2000);
    expect(partial.kcal).toBeLessThan(FORMULA);
  });

  it('quien baja dos kilos en seis semanas comiendo 2000 gasta ~2367: lo medido sustituye por completo a la fórmula', () => {
    const result = adaptiveMaintenance(input({ intake: eaten(42, 1, 2000), weights: daily(42, 80, 78) }));
    const expected = 2000 + (2 * KCAL_PER_KG) / 42;
    expect(result.source).toBe('adaptive');
    expect(result.confidence).toBe(1);
    expect(result.kcal).toBe(Math.round(expected));
    expect(result.trendKgPerWeek).toBeCloseTo(-0.33, 2);
    expect(result.loggedDays).toBe(42);
  });

  it('quien sube un kilo comiendo 2500 gasta menos de lo que la fórmula decía', () => {
    const result = adaptiveMaintenance(input({ intake: eaten(42, 1, 2500), weights: daily(42, 70, 71) }));
    expect(result.kcal).toBe(Math.round(2500 - KCAL_PER_KG / 42));
    expect(result.kcal).toBeLessThan(FORMULA);
  });

  it('con un peso estable el mantenimiento es lo que come', () => {
    // Un peso anotado al principio y un par de cambios de dos décimas: la báscula baila, el peso no se mueve.
    const result = adaptiveMaintenance(input({ intake: eaten(42, 1, 2900), weights: [{ day: ago(42), kg: 78 }, { day: ago(21), kg: 78.2 }, { day: ago(20), kg: 78 }] }));
    expect(result.kcal).toBeGreaterThan(2880);
    expect(result.kcal).toBeLessThan(2920);
  });

  it('menos de dos semanas entre el primer y el último peso no es una tendencia: un kilo de agua son 500 kcal al día', () => {
    const result = adaptiveMaintenance(input({ intake: eaten(10, 1, 2000), weights: [{ day: ago(10), kg: 80 }, { day: ago(0), kg: 79 }] }));
    expect(result).toMatchObject({ source: 'formula', kcal: FORMULA, spanDays: 10 });
  });

  it('con pocos días anotados, o anotados a medias, se queda en la fórmula', () => {
    const weights = [{ day: ago(42), kg: 80 }, { day: ago(0), kg: 78 }];
    expect(adaptiveMaintenance(input({ weights, intake: eaten(8, 1, 2000) })).source).toBe('formula'); // 8 días
    const sparse = new Map<DayKey, number>();
    for (let n = 42; n >= 1; n -= 3) sparse.set(ago(n), 2000); // uno de cada tres
    expect(adaptiveMaintenance(input({ weights, intake: sparse })).source).toBe('formula');
    // Días con una sola comida pequeña (menos de la mitad del mantenimiento) no cuentan como anotados.
    expect(adaptiveMaintenance(input({ weights, intake: eaten(42, 1, 600) })).source).toBe('formula');
  });

  it('hoy no cuenta: sus comidas están a medias', () => {
    const intake = eaten(42, 1, 2000);
    intake.set(TODAY, 300);
    const weights = [{ day: ago(42), kg: 80 }, { day: ago(0), kg: 78 }];
    expect(adaptiveMaintenance(input({ weights, intake })).kcal).toBe(adaptiveMaintenance(input({ weights, intake: eaten(42, 1, 2000) })).kcal);
  });

  it('entre las dos semanas y las seis se mezcla con la fórmula, y la mezcla crece sin saltos con los días', () => {
    const at = (span: number) => adaptiveMaintenance(input({ intake: eaten(span, 1, 2000), weights: daily(span, 80, 80 - (span / 42) * 2) }));
    const spans = [14, 22, 28, 35, 42];
    const results = spans.map(at);
    expect(results[0]!.source).toBe('formula');
    expect(results[results.length - 1]!.source).toBe('adaptive');
    expect(results.slice(1, -1).every((r) => r.source === 'mixed')).toBe(true);
    // Con la misma tendencia (−0,333 kg/semana), cada vez se aparta más de la fórmula hacia lo medido y nunca la sobrepasa.
    const measured = Math.round(2000 + (2 * KCAL_PER_KG) / 42);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.confidence).toBeGreaterThanOrEqual(results[i - 1]!.confidence);
      expect(results[i]!.kcal).toBeLessThanOrEqual(FORMULA);
      expect(results[i]!.kcal).toBeGreaterThanOrEqual(measured - 1);
    }
    expect(results[results.length - 1]!.kcal).toBe(measured);
  });

  it('una tendencia disparatada no lleva la meta más allá de un 40 % de la fórmula ni por debajo del 70 % ni del metabolismo basal', () => {
    const up = adaptiveMaintenance(input({ intake: eaten(42, 1, 1500), weights: daily(42, 90, 70) }));
    expect(up.kcal).toBe(FORMULA * 1.4);
    const down = adaptiveMaintenance(input({ intake: eaten(42, 1, 3400), weights: daily(42, 70, 90) }));
    expect(down.kcal).toBe(Math.round(FORMULA * 0.7));
    const floor = adaptiveMaintenance(input({ floorKcal: 2000, intake: eaten(42, 1, 3400), weights: daily(42, 70, 90) }));
    expect(floor.kcal).toBe(2000);
  });

  it('el último peso anterior al periodo se arrastra hasta él (no cambió) y los cambios de dentro mueven la recta', () => {
    const weights = [{ day: ago(100), kg: 82 }, { day: ago(30), kg: 80 }, { day: ago(15), kg: 79.5 }, { day: ago(0), kg: 79 }];
    const result = adaptiveMaintenance(input({ weights, intake: eaten(100, 1, 2200) }));
    expect(result.trendKgPerWeek).toBeLessThan(0);
    expect(result.spanDays).toBe(56); // la ventana: de hace 56 días a hoy
  });

  it('pesos futuros o sin número se ignoran', () => {
    const result = adaptiveMaintenance(input({ intake: eaten(42, 1, 2000), weights: [...daily(42, 80, 78), { day: addDays(TODAY, 5), kg: 50 }, { day: ago(3), kg: Number.NaN }] }));
    expect(result.kcal).toBe(Math.round(2000 + (2 * KCAL_PER_KG) / 42));
  });
});

describe('carriedWeights: el peso de cada día suponiendo que se pesa a diario', () => {
  it('hasta que se anota otro, el peso es el último; antes de la primera entrada no se sabe nada', () => {
    const series = carriedWeights([{ day: '2026-10-10', kg: 80 }, { day: '2026-10-13', kg: 79 }], '2026-10-08', '2026-10-15');
    expect(series.map((p) => `${p.day.slice(8)}:${p.kg}`)).toEqual(['10:80', '11:80', '12:80', '13:79', '14:79', '15:79']);
  });

  it('si el peso ya existía al empezar el periodo, la serie empieza ahí; lo futuro y lo no numérico se ignoran; sin entradas, vacía', () => {
    const series = carriedWeights([{ day: '2026-09-01', kg: 85 }, { day: '2026-10-20', kg: 1 }, { day: '2026-10-02', kg: Number.NaN }], '2026-10-01', '2026-10-03');
    expect(series).toEqual([{ day: '2026-10-01', kg: 85 }, { day: '2026-10-02', kg: 85 }, { day: '2026-10-03', kg: 85 }]);
    expect(carriedWeights([], '2026-10-01', '2026-10-03')).toEqual([]);
    expect(carriedWeights([{ day: '2026-10-05', kg: 80 }], '2026-10-01', '2026-10-03')).toEqual([]);
  });
});
