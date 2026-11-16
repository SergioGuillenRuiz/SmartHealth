import { describe, expect, it } from 'vitest';
import { weightGoalPlan, type WeightGoalInput } from '../../domain/weight-goal';
import { monthOf, progressToward, startingWeight, weeksText, weightGoalVisual } from './weight-goal-visual';

const TODAY = '2026-10-31';

const input = (over: Partial<WeightGoalInput> = {}): WeightGoalInput => ({
  currentKg: 80,
  targetKg: 74,
  goal: 'lose',
  maintenanceKcal: 2400,
  plannedKcal: 1920, // −480 kcal al día ≈ −0,44 kg a la semana
  trendKgPerWeek: -0.3,
  eaten: { avgKcal: 2160, days: 10 }, // −240 kcal al día ≈ −0,22 kg a la semana
  heightCm: 178,
  ...over,
});

const visual = (over: Partial<WeightGoalInput> = {}, firstKg: number | null = 84, goal: WeightGoalInput['goal'] = 'lose') =>
  weightGoalVisual(weightGoalPlan(input({ goal, ...over })), goal, TODAY, firstKg);

describe('peso objetivo dibujado: camino recorrido', () => {
  it('el camino recorrido es la parte del trayecto de la primera pesada al objetivo que ya se ha hecho', () => {
    expect(progressToward(84, 80, 74)).toBeCloseTo(0.4);
    expect(progressToward(84, 74, 74)).toBe(1);
    expect(progressToward(70, 74, 80)).toBeCloseTo(0.4); // subiendo
  });

  it('nunca sale de 0 a 1 (ni si el peso va al revés ni si se pasó del objetivo)', () => {
    expect(progressToward(80, 83, 74)).toBe(0);
    expect(progressToward(84, 70, 74)).toBe(1);
    expect(progressToward(80, 80, 80)).toBe(1);
  });

  it('parte de la primera pesada solo si estaba del lado de donde se viene; si no, del peso de hoy', () => {
    expect(startingWeight(84, 80, 74)).toBe(84); // se baja desde 84
    expect(startingWeight(78, 80, 74)).toBe(80); // la primera pesada era menor: no hay camino que enseñar
    expect(startingWeight(null, 80, 74)).toBe(80);
    expect(startingWeight(70, 74, 80)).toBe(70); // subiendo
    expect(startingWeight(77, 74, 80)).toBe(74);
  });
});

describe('peso objetivo dibujado: plazos', () => {
  it('semanas y meses se dicen cortos', () => {
    expect(weeksText(1)).toBe('1 sem');
    expect(weeksText(14)).toBe('14 sem');
    expect(weeksText(105)).toBe('+2 años');
    expect(monthOf(7, TODAY)).toBe('hacia dic'); // del mismo año: sin año
    expect(monthOf(14, TODAY)).toBe('hacia feb 2027');
        expect(monthOf(105, TODAY)).toBeNull();
  });
});

describe('peso objetivo dibujado: las semanas salen de la cuenta que se ve', () => {
  // Con el ritmo a un solo decimal la cuenta de cabeza no salía (4,8 kg ÷ 0,4 = 12 semanas, y la tarjeta decía 11): kilos que faltan ÷ ritmo que se enseña = semanas que se dicen.
  const shownRate = (detail: string[]): number => Number((detail[0] ?? '').replace(/^[−+]/, '').replace(/ kg\/sem$/, '').replace(',', '.'));
  const weeks = (headline: string): number => Number(headline.replace(' sem', ''));

  it('en las tres tarjetas, los kilos que faltan entre el ritmo que se enseña dan (casi) las semanas que se dicen', () => {
    for (const trend of [-0.3, -0.28, -0.44, -0.62]) {
      for (const avgKcal of [2160, 2050, 1900]) {
        const v = visual({ trendKgPerWeek: trend, eaten: { avgKcal, days: 10 } });
        for (const s of v.scenarios) {
          const n = weeks(s.headline);
          const rate = shownRate(s.detail);
          expect(Math.abs(v.missingKg / rate - n)).toBeLessThanOrEqual(0.6 + n * 0.02); // lo que sobra es el redondeo del ritmo a dos decimales
        }
      }
    }
  });

  it('enseña el ritmo con dos decimales cuando hacen falta', () => {
    expect(visual().scenarios[0]?.detail[0]).toBe('−0,44 kg/sem');
    expect(visual().scenarios[1]?.detail[0]).toBe('−0,22 kg/sem');
    expect(visual().scenarios[2]?.detail[0]).toBe('−0,3 kg/sem'); // 0,30: no hace falta el segundo decimal
  });
});

describe('peso objetivo dibujado: las tres tarjetas', () => {
  it('con plan, comida y peso a favor, las tres dicen cuándo se llega, con el ritmo', () => {
    const v = visual();
    expect(v.needs).toBe('lose');
    expect(v.missingKg).toBe(6);
    expect(v.progress).toBeCloseTo(0.4);
    expect(v.scenarios.map((s) => [s.key, s.tone])).toEqual([
      ['plan', 'good'],
      ['eaten', 'good'],
      ['real', 'good'],
    ]);
    expect(v.scenarios[0]).toMatchObject({ headline: '14 sem', detail: ['−0,44\u00a0kg/sem', 'hacia feb 2027'] });
    expect(v.scenarios[2]?.headline).toBe('20 sem');
    expect(v.warns).toEqual([]);
  });

  it('sin días anotados ni pesadas suficientes, las tarjetas lo dicen sin inventar', () => {
    const v = visual({ eaten: null, trendKgPerWeek: null });
    expect(v.scenarios[1]).toMatchObject({ headline: '—', tone: 'none', detail: ['anota 4 días'] });
    expect(v.scenarios[2]).toMatchObject({ headline: '—', tone: 'none', detail: ['anota tu peso'] });
  });

  it('el ritmo real solo falta mientras lleve menos de dos semanas con un peso: se supone que se pesa a diario, y un peso sin cambios cuenta', () => {
    expect(visual({ trendKgPerWeek: null, trendDays: 5 }).scenarios[2]).toMatchObject({ headline: '—', tone: 'none', detail: ['faltan 9 días'] });
    expect(visual({ trendKgPerWeek: null, trendDays: 13 }).scenarios[2]).toMatchObject({ detail: ['faltan 1 día'] });
    // Con dos semanas de un mismo peso ya hay ritmo (cero): «Estable».
    expect(visual({ trendKgPerWeek: 0, trendDays: 30 }).scenarios[2]).toMatchObject({ headline: 'Estable', tone: 'steady' });
  });

  it('comer en mantenimiento o más, o un peso que sube, se dice sin rodeos', () => {
    const v = visual({ eaten: { avgKcal: 2400, days: 8 }, trendKgPerWeek: 0.05 });
    expect(v.scenarios[1]).toMatchObject({ headline: 'Sin cambio', tone: 'steady' });
    expect(v.scenarios[2]).toMatchObject({ headline: 'Estable', tone: 'steady' });
    const wrong = visual({ eaten: { avgKcal: 2800, days: 8 }, trendKgPerWeek: 0.4 });
    expect(wrong.scenarios[1]).toMatchObject({ headline: 'No llegas', tone: 'bad' });
    expect(wrong.scenarios[2]).toMatchObject({ headline: 'Al revés', tone: 'bad', detail: ['+0,4\u00a0kg/sem'] });
  });

  it('con un objetivo de salud que no lleva al peso, el plan no llega y se avisa en una línea que remite al perfil', () => {
    const v = visual({ goal: 'maintain', plannedKcal: 2400 }, 84, 'maintain');
    expect(v.scenarios[0]).toMatchObject({ headline: 'No llega', tone: 'bad', detail: ['con «Mantener peso»'] });
    expect(v.warns).toEqual(['«Mantener peso» no apunta a tu peso objetivo: cámbialo en el perfil.']);
  });

  it('un peso objetivo por debajo de un IMC saludable avisa; subir hacia él no', () => {
    const low = visual({ targetKg: 55, currentKg: 80 });
    expect(low.warns.some((w) => w.includes('IMC') && w.includes('por debajo de lo saludable'))).toBe(true);
    const up = visual({ currentKg: 50, targetKg: 56, goal: 'gain', plannedKcal: 2760 }, 48, 'gain');
    expect(up.warns).toEqual([]);
  });

  it('ya alcanzado: sin tarjetas, camino completo y un aviso si conviene pasar a mantener', () => {
    const v = visual({ targetKg: 79.8 });
    expect(v.needs).toBe('reached');
    expect(v.scenarios).toEqual([]);
    expect(v.progress).toBe(1);
    expect(v.warns).toEqual(['Para mantenerlo, elige «Mantener peso» en el perfil.']);
    expect(visual({ targetKg: 79.8, goal: 'maintain' }, 84, 'maintain').warns).toEqual([]);
  });

  it('no hay ninguna nota de plazos aproximados', () => {
    expect(Object.keys(visual())).not.toContain('approximate');
  });
});
