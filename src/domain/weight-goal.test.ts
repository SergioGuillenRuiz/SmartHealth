import { describe, expect, it } from 'vitest';
import { addDays } from './dates';
import {
  directionOfGoal,
  isTargetWeight,
  LOW_BMI,
  MAX_TARGET_KG,
  MIN_TARGET_KG,
  recentIntakeOf,
  startingTarget,
  trendDaysKnown,
  weightGoalPlan,
  weightTrendKgPerWeek,
  type WeightGoalInput,
} from './weight-goal';

const TODAY = '2026-10-31';

const input = (over: Partial<WeightGoalInput> = {}): WeightGoalInput => ({
  currentKg: 80,
  targetKg: 74,
  goal: 'lose',
  maintenanceKcal: 2400,
  plannedKcal: 1920, // −20 %
  trendKgPerWeek: null,
  heightCm: 178,
  ...over,
});

describe('peso objetivo: validación y valores de partida', () => {
  it('admite el mismo rango que el perfil y rechaza lo que no es un peso', () => {
    expect(isTargetWeight(74)).toBe(true);
    expect(isTargetWeight(72.5)).toBe(true);
    expect(isTargetWeight(MIN_TARGET_KG)).toBe(true);
    expect(isTargetWeight(MAX_TARGET_KG)).toBe(true);
    for (const bad of [24.9, 300.1, 0, -70, Number.NaN, Infinity, '74', null, undefined, {}]) expect(isTargetWeight(bad), String(bad)).toBe(false);
  });

  it('cada objetivo de salud empuja hacia un lado', () => {
    expect(['lose', 'define', 'maintain', 'muscle', 'gain'].map((g) => directionOfGoal(g as never))).toEqual(['lose', 'lose', 'keep', 'gain', 'gain']);
  });

  it('al fijar un peso objetivo se parte de uno cercano al actual, hacia el lado del objetivo de salud', () => {
    expect(startingTarget(79.7, 'lose')).toBe(75);
    expect(startingTarget(79.7, 'define')).toBe(75);
    expect(startingTarget(79.7, 'maintain')).toBe(80);
    expect(startingTarget(79.7, 'muscle')).toBe(85);
    expect(startingTarget(79.7, 'gain')).toBe(85);
    expect(startingTarget(null, 'lose')).toBe(65); // sin datos, desde 70
    expect(startingTarget(28, 'lose')).toBe(MIN_TARGET_KG); // nunca fuera de rango
    expect(startingTarget(299, 'gain')).toBe(MAX_TARGET_KG);
  });
});

describe('peso objetivo: ritmo real del peso', () => {
  /** Quien se pesa a diario y apunta cada día lo que marca: un peso por día, de hace `days` días a hoy, en línea recta. */
  const daily = (from: number, to: number, days: number): Array<{ day: string; kg: number }> =>
    Array.from({ length: days + 1 }, (_, i) => ({ day: addDays(TODAY, -(days - i)), kg: from + ((to - from) * i) / days }));

  it('la pendiente del peso de las últimas semanas, en kg por semana', () => {
    expect(weightTrendKgPerWeek(daily(85, 82, 42), TODAY)).toBe(-0.5);
    expect(weightTrendKgPerWeek(daily(70, 72, 56), TODAY)).toBe(0.25);
  });

  it('se supone que se pesa a diario: un peso que lleva semanas igual es un ritmo de cero, no «faltan pesadas»', () => {
    expect(weightTrendKgPerWeek([{ day: addDays(TODAY, -40), kg: 80 }], TODAY)).toBe(0);
    expect(weightTrendKgPerWeek([{ day: '2025-10-01', kg: 90 }], TODAY)).toBe(0); // anotado hace un año y sin cambios desde entonces
    // Dos semanas con un peso es lo mínimo; antes no hay ritmo que decir.
    expect(weightTrendKgPerWeek([{ day: addDays(TODAY, -14), kg: 80 }], TODAY)).toBe(0);
    expect(weightTrendKgPerWeek([{ day: addDays(TODAY, -13), kg: 80 }], TODAY)).toBeNull();
  });

  it('el peso que cambia una vez entre dos fechas se arrastra hasta el siguiente cambio: la recta sale de todos los días, no solo de los anotados', () => {
    // 84 hasta hace 29 días y 80 desde entonces (un escalón a mitad del periodo): la recta de todos los días baja del orden de 0,75 kg a la semana.
    const stepped = weightTrendKgPerWeek([{ day: addDays(TODAY, -56), kg: 84 }, { day: addDays(TODAY, -28), kg: 80 }], TODAY)!;
    expect(stepped).toBeLessThan(-0.5);
    expect(stepped).toBeGreaterThan(-0.9);
    // Y si el cambio fue ayer, apenas se nota en la recta de las últimas ocho semanas.
    expect(weightTrendKgPerWeek([{ day: addDays(TODAY, -56), kg: 84 }, { day: addDays(TODAY, -1), kg: 80 }], TODAY)!).toBeGreaterThan(-0.2);
  });

  it('sin ninguna pesada, o con una de hoy, o con menos de dos semanas de peso, no hay tendencia', () => {
    expect(weightTrendKgPerWeek([], TODAY)).toBeNull();
    expect(weightTrendKgPerWeek([{ day: TODAY, kg: 80 }], TODAY)).toBeNull();
    expect(weightTrendKgPerWeek([{ day: addDays(TODAY, -10), kg: 82 }, { day: TODAY, kg: 80 }], TODAY)).toBeNull(); // 10 días < 14
    expect(trendDaysKnown([], TODAY)).toBe(0);
    expect(trendDaysKnown([{ day: TODAY, kg: 80 }], TODAY)).toBe(0);
    expect(trendDaysKnown([{ day: addDays(TODAY, -5), kg: 80 }], TODAY)).toBe(5);
    expect(trendDaysKnown([{ day: '2025-01-01', kg: 80 }], TODAY)).toBe(56); // con tope en la ventana que se mira
  });

  it('no mira el futuro y lo no numérico se ignora', () => {
    const history = [...daily(82, 80, 28), { day: addDays(TODAY, 5), kg: 50 }]; // una pesada «futura» (un reloj descuadrado): no cuenta
    expect(weightTrendKgPerWeek(history, TODAY)).toBe(-0.5);
    expect(weightTrendKgPerWeek([{ day: addDays(TODAY, -28), kg: Number.NaN }, ...daily(81, 80, 14)], TODAY)).toBe(-0.5); // lo no finito se ignora
  });
});

describe('peso objetivo: el plan', () => {
  it('perder peso con un objetivo de salud que baja: cuadra, y dice cuánto tardaría por las calorías y por el ritmo real', () => {
    const plan = weightGoalPlan(input({ trendKgPerWeek: -0.3 }));
    expect(plan).toMatchObject({ deltaKg: -6, needs: 'lose', fit: 'ok', suggestedGoal: null, plannedKgPerWeek: -0.44, plannedWeeks: 14, measuredKgPerWeek: -0.3, measuredWeeks: 20 });
  });

  it('con «Definir» también cuadra para bajar', () => {
    expect(weightGoalPlan(input({ goal: 'define' })).fit).toBe('ok');
  });

  it('«Mantener peso» no lleva a un peso más bajo: choca, y lo que cuadraría es perder', () => {
    const plan = weightGoalPlan(input({ goal: 'maintain', plannedKcal: 2400 }));
    expect(plan).toMatchObject({ needs: 'lose', fit: 'conflict', suggestedGoal: 'lose', plannedKgPerWeek: 0, plannedWeeks: null });
  });

  it('un peso por encima del actual con un objetivo que baja choca, y lo que cuadraría es ganar', () => {
    const plan = weightGoalPlan(input({ targetKg: 86, goal: 'lose' }));
    expect(plan).toMatchObject({ deltaKg: 6, needs: 'gain', fit: 'conflict', suggestedGoal: 'gain', plannedWeeks: null });
  });

  it('subir con «Ganar masa muscular» o «Ganar peso» cuadra', () => {
    const muscle = weightGoalPlan(input({ targetKg: 84, goal: 'muscle', plannedKcal: 2640 }));
    expect(muscle).toMatchObject({ needs: 'gain', fit: 'ok', plannedKgPerWeek: 0.22, plannedWeeks: 18 });
    expect(weightGoalPlan(input({ targetKg: 84, goal: 'gain', plannedKcal: 2760 })).fit).toBe('ok');
  });

  it('a medio kilo o menos se da por alcanzado: con «Perder peso» o «Ganar peso» lo que cuadra es mantener; con «Mantener», todo en orden', () => {
    expect(weightGoalPlan(input({ targetKg: 79.7 }))).toMatchObject({ needs: 'reached', fit: 'reached', suggestedGoal: 'maintain', plannedWeeks: null, measuredWeeks: null });
    expect(weightGoalPlan(input({ targetKg: 80.4, goal: 'gain' }))).toMatchObject({ needs: 'reached', fit: 'reached', suggestedGoal: 'maintain' });
    expect(weightGoalPlan(input({ targetKg: 80.4, goal: 'maintain' }))).toMatchObject({ needs: 'reached', fit: 'ok', suggestedGoal: null });
  });

  it('el borde: medio kilo justo ya es alcanzado (con el paso de 0,5 kg se toca a menudo); 0,6 ya no', () => {
    expect(weightGoalPlan(input({ targetKg: 79.5 })).needs).toBe('reached');
    expect(weightGoalPlan(input({ targetKg: 80.5, goal: 'maintain' })).needs).toBe('reached');
    expect(weightGoalPlan(input({ targetKg: 80.5 })).fit).toBe('reached'); // «Perder peso» con medio kilo por encima: no se avisa de que «no baja»
    expect(weightGoalPlan(input({ targetKg: 79.4 })).needs).toBe('lose');
    expect(weightGoalPlan(input({ targetKg: 80.6 })).needs).toBe('gain');
  });

  it('con «Definir» o «Ganar masa muscular» el peso puede quedarse quieto mientras cambia el cuerpo: alcanzado no empuja a mantener', () => {
    for (const goal of ['define', 'muscle'] as const) {
      expect(weightGoalPlan(input({ targetKg: 79.8, goal }))).toMatchObject({ needs: 'reached', fit: 'ok', suggestedGoal: null });
    }
  });

  it('las cinco opciones de objetivo de salud frente a los tres destinos (bajar, estar y subir)', () => {
    const table = (['lose', 'define', 'maintain', 'muscle', 'gain'] as const).map((goal) =>
      [74, 80.3, 86].map((targetKg) => {
        const plan = weightGoalPlan(input({ goal, targetKg }));
        return `${plan.needs}/${plan.fit}/${plan.suggestedGoal ?? '-'}`;
      }),
    );
    expect(table).toEqual([
      ['lose/ok/-', 'reached/reached/maintain', 'gain/conflict/gain'], // perder
      ['lose/ok/-', 'reached/ok/-', 'gain/conflict/gain'], // definir
      ['lose/conflict/lose', 'reached/ok/-', 'gain/conflict/gain'], // mantener
      ['lose/conflict/lose', 'reached/ok/-', 'gain/ok/-'], // ganar músculo
      ['lose/conflict/lose', 'reached/reached/maintain', 'gain/ok/-'], // ganar peso
    ]);
  });

  it('guarda los días con peso conocido para decir cuánto falta cuando aún no hay ritmo real', () => {
    expect(weightGoalPlan(input()).trendDays).toBe(0);
    expect(weightGoalPlan(input({ trendDays: 5 })).trendDays).toBe(5);
  });

  it('el ritmo real solo da una fecha si el peso va hacia el objetivo y no está quieto', () => {
    expect(weightGoalPlan(input({ trendKgPerWeek: 0.3 })).measuredWeeks).toBeNull(); // sube y se quiere bajar
    expect(weightGoalPlan(input({ trendKgPerWeek: -0.05 })).measuredWeeks).toBeNull(); // quieto
    expect(weightGoalPlan(input({ trendKgPerWeek: -0.05 })).measuredKgPerWeek).toBe(-0.05); // pero se conserva para decirlo
    expect(weightGoalPlan(input({ trendKgPerWeek: null })).measuredKgPerWeek).toBeNull();
  });

  it('el plan por calorías no promete fechas si las calorías apenas mueven el peso', () => {
    expect(weightGoalPlan(input({ plannedKcal: 2380 })).plannedWeeks).toBeNull(); // −0,02 kg/semana
  });

  it('el IMC del peso objetivo avisa de un peso por debajo de lo saludable', () => {
    const low = weightGoalPlan(input({ targetKg: 55, heightCm: 178 }));
    expect(low.targetBmi).toBe(17.4);
    expect(low.targetBmi as number).toBeLessThan(LOW_BMI);
    expect(weightGoalPlan(input({ targetKg: 74, heightCm: 178 })).targetBmi).toBe(23.4);
    expect(weightGoalPlan(input({ heightCm: null })).targetBmi).toBeNull();
  });
});

describe('recentIntakeOf: lo que se come de verdad estos días', () => {
  const day = (back: number) => addDays('2026-10-31', -back);
  const logged = (entries: ReadonlyArray<[number, number]>): Map<string, number> => new Map(entries.map(([back, kcal]) => [day(back), kcal]));

  it('la media de los días anotados de las dos últimas semanas, sin hoy', () => {
    const intake = logged([[1, 2000], [2, 2200], [3, 1800], [4, 2000]]);
    intake.set('2026-10-31', 500); // hoy está a medias: no cuenta
    expect(recentIntakeOf(intake, '2026-10-31', 2400)).toEqual({ avgKcal: 2000, days: 4 });
  });

  it('con menos de cuatro días anotados no hay media de la que fiarse', () => {
    expect(recentIntakeOf(logged([[1, 2000], [2, 2200], [3, 1800]]), '2026-10-31', 2400)).toBeNull();
  });

  it('un día con menos de la mitad del mantenimiento se toma por incompleto y no cuenta', () => {
    const intake = logged([[1, 2000], [2, 2000], [3, 2000], [4, 2000], [5, 400], [6, 300]]);
    expect(recentIntakeOf(intake, '2026-10-31', 2400)).toEqual({ avgKcal: 2000, days: 4 });
  });

  it('lo anterior a dos semanas no entra', () => {
    expect(recentIntakeOf(logged([[1, 2000], [2, 2000], [3, 2000], [15, 2000], [20, 2000]]), '2026-10-31', 2400)).toBeNull();
  });
});

describe('weightGoalPlan con lo comido de verdad', () => {
  const base = { currentKg: 80, targetKg: 74, goal: 'lose' as const, maintenanceKcal: 2400, plannedKcal: 1920, trendKgPerWeek: null, heightCm: 178 };

  it('comiendo por debajo del mantenimiento: baja y llega en tantas semanas', () => {
    const plan = weightGoalPlan({ ...base, eaten: { avgKcal: 1950, days: 9 } });
    expect(plan.eatenKgPerWeek).toBe(-0.41);
    expect(plan.eatenWeeks).toBe(15);
    expect(plan.maintenanceKcal).toBe(2400);
  });

  it('comiendo en el mantenimiento o al revés no llega nunca', () => {
    expect(weightGoalPlan({ ...base, eaten: { avgKcal: 2400, days: 9 } }).eatenWeeks).toBeNull();
    expect(weightGoalPlan({ ...base, eaten: { avgKcal: 2900, days: 9 } }).eatenWeeks).toBeNull();
  });

  it('sin días anotados suficientes no hay cuenta, y con el peso alcanzado tampoco', () => {
    expect(weightGoalPlan(base)).toMatchObject({ eaten: null, eatenKgPerWeek: null, eatenWeeks: null });
    expect(weightGoalPlan({ ...base, targetKg: 79.8, eaten: { avgKcal: 1950, days: 9 } }).eatenWeeks).toBeNull();
  });
});
