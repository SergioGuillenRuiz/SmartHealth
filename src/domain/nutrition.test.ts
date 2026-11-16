import { describe, expect, it } from 'vitest';
import { bmrKcalPerDay } from './estimation';
import {
  ACTIVITY_LEVEL,
  buildMeal,
  fractionOf,
  HEALTH_GOAL_IDS,
  HEALTH_GOALS,
  intakeOf,
  isHealthGoal,
  kcalFromMacros,
  nutritionTargets,
  proteinReferenceKg,
  scaleProduct,
  validateMealDraft,
  type MealDraft,
  type MealEntry,
} from './nutrition';

const man = { heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1990-06-15' } as const;
const woman = { heightCm: 160, weightKg: 52, sex: 'female', birthDate: '1990-06-15' } as const;
const DAY = '2026-10-16';

const meal = (patch: Partial<MealEntry> = {}): MealEntry => ({ id: 'm1', tsMs: 1_000, name: 'Comida', kcal: 500, source: 'manual', ...patch });

describe('intakeOf', () => {
  it('sin comidas no hay total (no anotar nada no es haber comido cero)', () => {
    expect(intakeOf([])).toBeNull();
  });

  it('suma calorías y solo los nutrientes que cada comida trae', () => {
    const total = intakeOf([meal({ kcal: 420.4, proteinG: 30, carbsG: 40.2, fatG: 10 }), meal({ id: 'm2', kcal: 300 }), meal({ id: 'm3', kcal: 80, carbsG: 15.4 })]);
    expect(total).toEqual({ kcal: 800, proteinG: 30, carbsG: 56, fatG: 10, fiberG: 0, sugarsG: 0, saltG: 0, meals: 3 });
  });

  it('suma la fibra, los azúcares y la sal de las comidas que los traen (la sal con una décima)', () => {
    const total = intakeOf([
      meal({ kcal: 400, fiberG: 4.4, sugarsG: 10.2, saltG: 1.84 }),
      meal({ id: 'm2', kcal: 300, fiberG: 3, saltG: 0.52 }),
      meal({ id: 'm3', kcal: 200 }), // una comida sin esos datos (antigua o a mano) no suma nada
    ]);
    expect(total).toMatchObject({ fiberG: 7, sugarsG: 10, saltG: 2.4, meals: 3 });
  });
});

describe('kcalFromMacros y validateMealDraft', () => {
  const blank: MealDraft = { name: '', kcal: null, proteinG: null, carbsG: null, fatG: null };

  it('calcula las calorías con 4 kcal por gramo de proteína e hidratos y 9 de grasa', () => {
    expect(kcalFromMacros({ proteinG: 30, carbsG: 50, fatG: 10 })).toBe(410);
    expect(kcalFromMacros({ proteinG: null, carbsG: null, fatG: 10 })).toBe(90);
    expect(kcalFromMacros({ proteinG: null, carbsG: null, fatG: null })).toBeNull();
  });

  it('una comida sin calorías ni nutrientes no vale; con nutrientes se calculan', () => {
    expect(validateMealDraft(blank)).toHaveLength(1);
    expect(validateMealDraft({ ...blank, carbsG: 20 })).toEqual([]);
    expect(validateMealDraft({ ...blank, kcal: 250 })).toEqual([]);
  });

  it('rechaza cifras imposibles', () => {
    expect(validateMealDraft({ ...blank, kcal: -5 })).toHaveLength(1);
    expect(validateMealDraft({ ...blank, kcal: 20_000 })).toHaveLength(1);
    expect(validateMealDraft({ ...blank, kcal: 300, proteinG: 5000 })).toHaveLength(1);
    expect(validateMealDraft({ ...blank, kcal: 300, name: 'x'.repeat(121) })).toHaveLength(1);
  });
});

describe('buildMeal', () => {
  const extra = { id: 'a', tsMs: 5, source: 'manual' } as const;

  it('el nombre vacío pasa a «Comida», se limpian los espacios y lo vacío no se guarda como cero', () => {
    expect(buildMeal({ name: '   ', kcal: 250.6, proteinG: null, carbsG: null, fatG: null }, extra)).toEqual({ id: 'a', tsMs: 5, name: 'Comida', kcal: 251, source: 'manual' });
    expect(buildMeal({ name: '  Arroz   con  pollo ', kcal: 600, proteinG: 33.33, carbsG: 70, fatG: 12.04 }, extra)).toMatchObject({ name: 'Arroz con pollo', proteinG: 33.3, carbsG: 70, fatG: 12 });
  });

  it('con las calorías vacías salen de los nutrientes', () => {
    expect(buildMeal({ name: 'Batido', kcal: null, proteinG: 25, carbsG: 10, fatG: 2 }, extra).kcal).toBe(158);
  });

  it('guarda el código de barras y los gramos si los hay', () => {
    expect(buildMeal({ name: 'Yogur', kcal: 90, proteinG: null, carbsG: null, fatG: null }, { id: 'b', tsMs: 7, source: 'barcode', barcode: '8480000123456', grams: 125 })).toMatchObject({ barcode: '8480000123456', grams: 125, source: 'barcode' });
  });
});

describe('nutritionTargets', () => {
  it('mantener peso: las calorías de mantenimiento (metabolismo basal × nivel de actividad)', () => {
    const t = nutritionTargets(man, DAY, 'maintain');
    expect(t.maintenanceKcal).toBeCloseTo(bmrKcalPerDay(man, DAY) * ACTIVITY_LEVEL, -1);
    expect(t.kcal).toBe(t.maintenanceKcal);
  });

  it('perder peso baja un 20 % y ganar masa sube un 10 %; definir pide más proteína que mantener', () => {
    const base = nutritionTargets(man, DAY, 'maintain');
    expect(nutritionTargets(man, DAY, 'lose').kcal / base.kcal).toBeCloseTo(0.8, 2);
    expect(nutritionTargets(man, DAY, 'muscle').kcal / base.kcal).toBeCloseTo(1.1, 2);
    expect(nutritionTargets(man, DAY, 'gain').kcal / base.kcal).toBeCloseTo(1.15, 2);
    expect(nutritionTargets(man, DAY, 'define').proteinG).toBeGreaterThan(base.proteinG);
    expect(nutritionTargets(man, DAY, 'define').proteinG).toBe(Math.round(80 * 1.9));
  });

  it('los hidratos son lo que queda tras la proteína y las grasas: las cuentas cuadran con las calorías', () => {
    for (const goal of HEALTH_GOAL_IDS) {
      const t = nutritionTargets(man, DAY, goal);
      expect(Math.abs(t.proteinG * 4 + t.carbsG * 4 + t.fatG * 9 - t.kcal), goal).toBeLessThanOrEqual(12);
      expect(t.carbsG).toBeGreaterThan(0);
    }
  });

  it('nunca propone menos que el suelo de su sexo ni que el metabolismo basal, aunque el objetivo sea bajar', () => {
    const small = { heightCm: 150, weightKg: 42, sex: 'female', birthDate: '1950-01-01' } as const;
    const t = nutritionTargets(small, DAY, 'lose');
    expect(t.kcal).toBeGreaterThanOrEqual(1200);
    expect(t.kcal).toBeGreaterThanOrEqual(Math.floor(bmrKcalPerDay(small, DAY) / 10) * 10);
    expect(nutritionTargets(woman, DAY, 'lose').kcal).toBeGreaterThanOrEqual(1200);
  });

  it('la proteína no pasa del 30 % de las calorías (mucho peso, pocas calorías)', () => {
    const heavy = { heightCm: 165, weightKg: 150, sex: 'female', birthDate: '1960-01-01' } as const;
    const t = nutritionTargets(heavy, DAY, 'define');
    expect((t.proteinG * 4) / t.kcal).toBeLessThanOrEqual(0.3 + 0.005);
  });

  it('con obesidad la proteína se calcula sobre un peso ajustado: lo que pasa del IMC 30 cuenta un cuarto, sin saltos', () => {
    const at = (weightKg: number) => ({ heightCm: 162, weightKg, sex: 'female', birthDate: '1982-03-14' }) as const;
    const limit = 30 * 1.62 * 1.62; // 78,7 kg
    expect(proteinReferenceKg(at(70))).toBe(70);
    expect(proteinReferenceKg(at(limit))).toBeCloseTo(limit, 6);
    expect(proteinReferenceKg(at(limit + 1))).toBeCloseTo(limit + 0.25, 6);
    expect(proteinReferenceKg(at(118))).toBeCloseTo(limit + 0.25 * (118 - limit), 6);
    // Nunca baja al engordar: la referencia crece con el peso.
    let before = 0;
    for (let w = 50; w <= 250; w += 5) {
      const now = proteinReferenceKg(at(w));
      expect(now).toBeGreaterThanOrEqual(before);
      before = now;
    }
    // 118 kg a 1,62 m perdiendo peso: ~159 g de proteína, no los 177 g (35 % del tope) que salían con el peso entero.
    expect(nutritionTargets(at(118), DAY, 'lose').proteinG).toBeLessThan(165);
    expect(nutritionTargets(at(118), DAY, 'lose').proteinG).toBeGreaterThan(140);
    // Con un peso normal, nada cambia.
    expect(nutritionTargets(man, DAY, 'define').proteinG).toBe(Math.round(80 * 1.9));
  });

  it('cada objetivo tiene nombre, explicación y reglas coherentes', () => {
    expect(HEALTH_GOAL_IDS).toEqual(['lose', 'define', 'maintain', 'muscle', 'gain']);
    for (const id of HEALTH_GOAL_IDS) {
      const rule = HEALTH_GOALS[id];
      expect(rule.label.length).toBeGreaterThan(3);
      expect(rule.hint.length).toBeGreaterThan(10);
      expect(rule.fatShare).toBeGreaterThan(0.2);
      expect(rule.fatShare).toBeLessThan(0.36);
      expect(isHealthGoal(id)).toBe(true);
    }
    expect(isHealthGoal('toString')).toBe(false);
    expect(isHealthGoal(3)).toBe(false);
  });
});

describe('metas con el mantenimiento medido', () => {
  it('con el mantenimiento medido de la persona, sustituye al de la fórmula en todos los objetivos', () => {
    const measured = nutritionTargets(man, DAY, 'maintain', { maintenanceKcal: 3100 });
    expect(measured.kcal).toBe(3100);
    expect(measured.maintenanceKcal).toBe(3100);
    expect(nutritionTargets(man, DAY, 'lose', { maintenanceKcal: 3100 }).kcal).toBe(2480);
    expect(nutritionTargets(man, DAY, 'muscle', { maintenanceKcal: 3100 }).kcal).toBe(3410);
    // Sin él, nada cambia respecto a la fórmula.
    expect(nutritionTargets(man, DAY, 'maintain', {})).toEqual(nutritionTargets(man, DAY, 'maintain'));
  });
});

describe('proteína y grasas realistas', () => {
  const heavy = { heightCm: 182, weightKg: 90, sex: 'male', birthDate: '1990-06-15' } as const;

  it('la proteína por kilo sigue la literatura: 1,6 perder, 1,9 definir, 1,4 mantener, 1,7 ganar músculo, 1,4 ganar peso', () => {
    expect(HEALTH_GOALS.lose.proteinPerKg).toBe(1.6);
    expect(HEALTH_GOALS.define.proteinPerKg).toBe(1.9);
    expect(HEALTH_GOALS.maintain.proteinPerKg).toBe(1.4);
    expect(HEALTH_GOALS.muscle.proteinPerKg).toBe(1.7);
    expect(HEALTH_GOALS.gain.proteinPerKg).toBe(1.4);
    // Ninguna pasa de 2 g/kg: por encima no hay ganancia medible.
    for (const id of HEALTH_GOAL_IDS) expect(HEALTH_GOALS[id].proteinPerKg).toBeLessThanOrEqual(2);
  });

  it('con 90 kg definiendo salen 167 g (el tope del 30 % de las calorías, que baja los 171 g de 1,9 g/kg), no los ~198 g de antes', () => {
    expect(nutritionTargets(heavy, DAY, 'define').proteinG).toBe(167);
  });

  it('las grasas nunca bajan de 0,7 g por kilo, aunque las calorías sean pocas', () => {
    const small = { heightCm: 160, weightKg: 70, sex: 'female', birthDate: '1990-06-15' } as const;
    const t = nutritionTargets(small, DAY, 'define');
    expect(t.fatG).toBeGreaterThanOrEqual(Math.round(70 * 0.7));
    expect(t.carbsG).toBeGreaterThanOrEqual(0);
  });
});

describe('fractionOf', () => {
  it('de 0 a 1, sin salirse y sin dividir por cero', () => {
    expect(fractionOf(500, 2000)).toBe(0.25);
    expect(fractionOf(3000, 2000)).toBe(1);
    expect(fractionOf(-5, 2000)).toBe(0);
    expect(fractionOf(500, 0)).toBe(0);
  });
});

describe('scaleProduct', () => {
  it('regla de tres sobre los 100 g', () => {
    expect(scaleProduct({ kcal: 61, proteinG: 3.5, carbsG: 4.7, fatG: 3.2 }, 125)).toEqual({ kcal: 76, proteinG: 4.4, carbsG: 5.9, fatG: 4, fiberG: null, sugarsG: null, saltG: null });
  });

  it('escala también la fibra, los azúcares y la sal si el producto los trae (y deja «sin dato» lo que no)', () => {
    expect(scaleProduct({ kcal: 250, proteinG: 8, carbsG: 40, fatG: 6, fiberG: 3.2, sugarsG: 12, saltG: 1.1 }, 150)).toMatchObject({ fiberG: 4.8, sugarsG: 18, saltG: 1.65 });
    expect(scaleProduct({ kcal: 250, proteinG: 8, carbsG: 40, fatG: 6, saltG: 0.8 }, 50)).toMatchObject({ fiberG: null, sugarsG: null, saltG: 0.4 });
  });
});
