import { describe, expect, it } from 'vitest';
import { classifyName, mealFacts, mealFit, type CriterionKey } from './meal-fit';
import type { HealthGoal, NutritionTargets } from './nutrition';

const targets: NutritionTargets = { maintenanceKcal: 2400, kcal: 2400, proteinG: 130, carbsG: 280, fatG: 80, saltG: 5 };
const chicken = { kcal: 330, proteinG: 62, carbsG: 0, fatG: 7, grams: 200 }; // pechuga a la plancha
const pizza = { kcal: 800, proteinG: 30, carbsG: 95, fatG: 32, grams: 330 };
const oats = { kcal: 450, proteinG: 18, carbsG: 70, fatG: 10, grams: 300 };
const oil = { kcal: 450, proteinG: 0, carbsG: 0, fatG: 50, grams: 50 };
const levels = (meal: typeof chicken): Record<HealthGoal, string> =>
  Object.fromEntries((['lose', 'define', 'maintain', 'muscle', 'gain'] as const).map((goal) => [goal, mealFit(meal, goal, targets).level])) as Record<HealthGoal, string>;

describe('mealFacts: lo que dice una comida y cómo pesa en el día', () => {
  it('reparte la energía entre los tres nutrientes (suman el 100 %) y los pone frente a las metas del día', () => {
    const f = mealFacts(chicken, targets);
    expect(f.kcalDayShare).toBeCloseTo(330 / 2400, 5);
    expect(f.indicators.map((i) => i.key)).toEqual(['proteinG', 'carbsG', 'fatG', 'saltG']);
    // La proteína aporta 248 de las 311 kcal de los macros (62 g × 4 + 7 g × 9), y no de las 330 anotadas.
    expect(f.indicators[0]?.energyShare).toBeCloseTo(248 / 311, 5);
    expect(f.indicators[0]?.dayShare).toBeCloseTo(62 / 130, 5);
    const shares = f.indicators.slice(0, 3).map((i) => i.energyShare ?? 0);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(f.proteinPer100kcal).toBe(18.8);
  });

  it('los porcentajes suman el 100 % aunque las calorías anotadas no cuadren con los nutrientes (alcohol, fibra, etiqueta redondeada)', () => {
    const f = mealFacts({ kcal: 500, proteinG: 10, carbsG: 40, fatG: 10 }, targets); // los macros dan 290 kcal
    expect(f.indicators.slice(0, 3).reduce((sum, i) => sum + (i.energyShare ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it('la sal se compara con el máximo diario (5 g) y no aporta energía', () => {
    const f = mealFacts({ ...pizza, saltG: 2.5 }, targets);
    const salt = f.indicators[3];
    expect(salt?.grams).toBe(2.5);
    expect(salt?.dayShare).toBeCloseTo(0.5, 10);
    expect(salt?.energyShare).toBeNull();
    expect(mealFacts(pizza, targets).indicators[3]?.grams).toBeNull();
  });

  it('la densidad energética solo se sabe si se sabe cuánto pesaba', () => {
    expect(mealFacts(chicken, targets).kcalPer100g).toBe(165);
    expect(mealFacts(chicken, targets).density).toBe('medium');
    expect(mealFacts(oats, targets).density).toBe('medium');
    expect(mealFacts({ kcal: 60, proteinG: 1, carbsG: 12, fatG: 0.5, grams: 150 }, targets).density).toBe('low');
    expect(mealFacts(oil, targets).density).toBe('high');
    const noGrams = mealFacts({ kcal: 330, proteinG: 62, carbsG: 0, fatG: 7 }, targets);
    expect(noGrams.kcalPer100g).toBeNull();
    expect(noGrams.density).toBeNull();
  });

  it('con solo las calorías no hay nutrientes que repartir', () => {
    const f = mealFacts({ kcal: 500 }, targets);
    expect(f.hasMacros).toBe(false);
    expect(f.indicators.every((i) => i.grams === null && i.energyShare === null && i.dayShare === null)).toBe(true);
    expect(f.proteinPer100kcal).toBeNull();
  });
});

const GOALS = ['lose', 'define', 'maintain', 'muscle', 'gain'] as const;
const ORDER = ['poor', 'fair', 'good', 'great'];
const rank = (level: string): number => ORDER.indexOf(level);
const criterion = (meal: Parameters<typeof mealFit>[0], goal: HealthGoal, key: CriterionKey) => mealFit(meal, goal, targets).criteria.find((c) => c.key === key)!;

const plateOf = (name: string, over: Record<string, number> = {}) => ({ name, ...chicken, ...over });
const grilledChicken = plateOf('Pechuga de pollo a la plancha');
const cola = { name: 'Coca-Cola', kcal: 139, proteinG: 0, carbsG: 35, fatG: 0, sugarsG: 35, grams: 330 };
const banana = { name: 'Plátano', kcal: 90, proteinG: 1, carbsG: 23, fatG: 0.3, fiberG: 2.6, sugarsG: 12, grams: 100 };
const donut = { name: 'Donut de chocolate', kcal: 420, proteinG: 5, carbsG: 50, fatG: 22, sugarsG: 25, saltG: 0.5, grams: 100 };
const lentils = { name: 'Lentejas estofadas', kcal: 330, proteinG: 22, carbsG: 50, fatG: 4, fiberG: 14, sugarsG: 3, saltG: 1, grams: 350 };
const burger = { name: 'Hamburguesa con patatas', kcal: 900, proteinG: 38, carbsG: 85, fatG: 45, sugarsG: 9, saltG: 3.4, grams: 400 };

describe('mealFit: los cinco criterios', () => {
  it('siempre son los mismos cinco, en este orden, cada uno con su nombre, su nota, una palabra y, si hay, su cifra o motivo', () => {
    for (const goal of GOALS) {
      const fit = mealFit(grilledChicken, goal, targets);
      expect(fit.criteria.map((c) => c.key)).toEqual(['energy', 'protein', 'excess', 'satiety', 'health']);
      expect(fit.criteria.map((c) => c.label)).toEqual(['Densidad calórica', 'Densidad proteica', 'Sal y azúcar', 'Saciedad', 'Saludable']);
      for (const c of fit.criteria) {
        expect(['good', 'ok', 'bad', 'unknown']).toContain(c.rating);
        expect(c.value.length, c.value).toBeLessThan(21); // una o dos palabras
        expect((c.detail ?? '').length, c.detail ?? '').toBeLessThan(42); // y un motivo corto
      }
    }
  });

  it('la densidad calórica se dice en kcal por 100 g y solo se sabe con la cantidad; una bebida se compara aparte', () => {
    expect(criterion({ ...grilledChicken, grams: 400 }, 'lose', 'energy')).toMatchObject({ value: 'Baja', rating: 'good', detail: '83 kcal por 100 g' });
    expect(criterion(grilledChicken, 'lose', 'energy')).toMatchObject({ value: 'Media', rating: 'ok', detail: '165 kcal por 100 g' });
    expect(criterion(oil, 'lose', 'energy')).toMatchObject({ value: 'Muy alta', rating: 'bad' });
    expect(criterion(oil, 'gain', 'energy').rating).toBe('good'); // para ganar peso, cundir es bueno
    expect(criterion({ kcal: 330, proteinG: 62, carbsG: 0, fatG: 7 }, 'lose', 'energy')).toMatchObject({ value: '—', rating: 'unknown', detail: 'sin la cantidad' });
    expect(criterion(cola, 'lose', 'energy')).toMatchObject({ value: 'Bebida', detail: '42 kcal por 100 ml', rating: 'bad' });
  });

  it('la densidad proteica son los gramos de proteína por 100 kcal, con los gramos totales', () => {
    expect(criterion(grilledChicken, 'lose', 'protein')).toMatchObject({ value: 'Alta', rating: 'good', detail: '62\u00a0g · 18,8\u00a0g por 100 kcal' });
    expect(criterion(pizza, 'lose', 'protein')).toMatchObject({ value: 'Baja', rating: 'bad' });
    expect(criterion(banana, 'lose', 'protein').value).toBe('Baja');
    expect(criterion(oats, 'lose', 'protein')).toMatchObject({ value: 'Media', rating: 'ok' }); // 4 g por 100 kcal: lo justo para ser «media»
  });

  it('para ganar músculo importan los gramos de proteína de la toma: 62 g muy bien, 18 g justo, 3 g mal', () => {
    expect(criterion(grilledChicken, 'muscle', 'protein').rating).toBe('good');
    expect(mealFit({ kcal: 300, proteinG: 25, carbsG: 20, fatG: 8 }, 'muscle', targets).level).not.toBe('poor');
    expect(criterion({ kcal: 450, proteinG: 18, carbsG: 70, fatG: 10 }, 'muscle', 'protein').rating).toBe('ok');
    expect(mealFit({ kcal: 300, proteinG: 3, carbsG: 50, fatG: 8 }, 'muscle', targets).level).toBe('poor');
  });

  it('la sal se compara con el máximo diario y los azúcares con el 10 % de las calorías del día; la fruta y los lácteos naturales no cuentan como azúcar', () => {
    const lunch = { kcal: 500, proteinG: 30, carbsG: 50, fatG: 18 };
    expect(criterion({ ...lunch, saltG: 0.4 }, 'maintain', 'excess')).toMatchObject({ rating: 'good', value: 'Bajo', detail: 'sal 0,4\u00a0g' });
    expect(criterion({ ...lunch, saltG: 1 }, 'maintain', 'excess')).toMatchObject({ rating: 'ok', value: 'Moderado' });
    expect(criterion({ ...lunch, saltG: 1.8 }, 'maintain', 'excess')).toMatchObject({ rating: 'bad', value: 'Mucha sal' });
    expect(criterion({ ...lunch, saltG: 3 }, 'maintain', 'excess')).toMatchObject({ rating: 'bad', value: 'Muchísima sal' });
    expect(criterion({ ...lunch, sugarsG: 5 }, 'maintain', 'excess')).toMatchObject({ rating: 'good', detail: 'azúcares 5\u00a0g' });
    expect(criterion({ ...lunch, kcal: 300, sugarsG: 30 }, 'maintain', 'excess')).toMatchObject({ rating: 'bad', value: 'Mucho azúcar' });
    expect(criterion({ ...lunch, saltG: 3, sugarsG: 30 }, 'maintain', 'excess').value).toBe('Mucha sal y azúcar');
    expect(criterion(banana, 'lose', 'excess').rating).not.toBe('bad'); // 12 g de azúcar de la fruta
    expect(criterion({ ...banana, name: 'Sirope', sugarsG: 30, kcal: 120, grams: 40 }, 'lose', 'excess').rating).toBe('bad');
    expect(criterion(lunch, 'maintain', 'excess')).toMatchObject({ rating: 'unknown', value: '—' }); // sin datos de sal ni azúcar no se inventa
  });

  it('un azúcar alto en una comida enorme no cuenta si apenas pesa en sus calorías', () => {
    expect(criterion({ kcal: 1600, proteinG: 70, carbsG: 150, fatG: 70, sugarsG: 25 }, 'maintain', 'excess').rating).not.toBe('bad');
  });

  it('la saciedad sube con la proteína, la fibra y lo ligero, y baja con lo líquido, lo denso y lo azucarado', () => {
    expect(criterion({ ...lentils, name: 'Lentejas' }, 'lose', 'satiety').rating).toBe('good');
    expect(criterion(grilledChicken, 'lose', 'satiety').rating).not.toBe('bad');
    expect(criterion(cola, 'lose', 'satiety')).toMatchObject({ rating: 'bad', value: 'Baja' });
    expect(criterion(donut, 'lose', 'satiety').rating).toBe('bad');
    expect(criterion(oil, 'lose', 'satiety').rating).toBe('bad');
    expect(criterion(lentils, 'lose', 'satiety').detail).toMatch(/fibra/);
  });

  it('si es saludable lo dicen sus números (energía, azúcares, grasa, sal, proteína, fibra y planta) y el nombre solo da pistas', () => {
    expect(criterion(lentils, 'lose', 'health')).toMatchObject({ rating: 'good', value: 'Muy saludable', detail: 'legumbre · con fibra' });
    expect(criterion(banana, 'lose', 'health')).toMatchObject({ rating: 'good', value: 'Muy saludable' });
    expect(criterion(grilledChicken, 'lose', 'health')).toMatchObject({ rating: 'good', value: 'Saludable', detail: 'carne magra' });
    expect(criterion(donut, 'lose', 'health')).toMatchObject({ rating: 'bad', value: 'Nada saludable', detail: 'grasa saturada' });
    // Un nombre de fritura o de comida rápida resta un punto por lo que los números no ven (grasas transformadas), pero lo que no se puede comprobar no lo hunde del todo.
    expect(criterion({ ...grilledChicken, name: 'Pollo empanado' }, 'lose', 'health').rating).not.toBe('bad');
    expect(criterion({ ...grilledChicken, name: 'Chorizo' }, 'lose', 'health').value).toBe('Normal'); // los números son los de una pechuga, el nombre solo resta un punto
    expect(criterion(cola, 'lose', 'health')).toMatchObject({ rating: 'bad', value: 'Nada saludable', detail: null });
    expect(criterion(burger, 'lose', 'health')).toMatchObject({ rating: 'bad', value: 'Poco saludable' });
    // Sin nombre se juzga por lo que lleva: una pechuga sin nombre sigue siendo mucha proteína y casi nada más.
    expect(criterion({ ...chicken }, 'lose', 'health')).toMatchObject({ rating: 'good', value: 'Saludable', detail: null });
  });

  it('lo que dice «Saludable» no repite lo de las otras filas (sal, azúcar, proteína, densidad) ni se contradice: solo el tipo de alimento, la fibra y la grasa', () => {
    const repeated = /sal|az[uú]car|prote[ií]na|dens|ligera/;
    for (const meal of [lentils, banana, grilledChicken, donut, cola, burger, chicken, pizza, oil]) {
      const { detail } = criterion(meal as typeof chicken, 'lose', 'health');
      expect(detail ?? '', String((meal as { name?: string }).name)).not.toMatch(repeated);
      const { grams: _grams, ...noGrams } = meal as typeof chicken;
      expect(criterion(noGrams, 'lose', 'health').detail ?? '', `${String((meal as { name?: string }).name)} sin gramos`).not.toMatch(repeated);
    }
    // Sin gramos, la sal o el azúcar tampoco bajan esta nota en silencio: eso lo cuenta su fila.
    const noGrams = { name: 'Tostadas con tomate', kcal: 200, proteinG: 6, carbsG: 30, fatG: 6, saltG: 1.7, sugarsG: 3 };
    expect(criterion(noGrams, 'lose', 'health').detail ?? '').not.toMatch(/sal/);
  });

  it('una barrita de proteínas con poco azúcar y fibra NO es «poco saludable» solo porque su nombre suene a dulce (el fallo que se vio con una barrita real)', () => {
    const bar = { name: 'Barrita de proteínas', kcal: 220, proteinG: 18, carbsG: 22, fatG: 7, fiberG: 3, sugarsG: 5, saltG: 0.4, grams: 60 };
    expect(criterion(bar, 'define', 'health')).toMatchObject({ rating: 'ok', value: 'Normal' });
    // La misma barrita con mucho azúcar y sin fibra sí sale mal.
    expect(criterion({ ...bar, sugarsG: 30, carbsG: 38, fiberG: 0.5, proteinG: 6 }, 'define', 'health').rating).toBe('bad');
  });

  it('con el mismo nombre, los números deciden: un yogur con mucho azúcar sale peor que uno natural', () => {
    const natural = { name: 'Yogur', kcal: 70, proteinG: 8, carbsG: 5, fatG: 2, sugarsG: 5, saltG: 0.1, grams: 125 };
    const sweet = { name: 'Yogur', kcal: 180, proteinG: 4, carbsG: 32, fatG: 3, sugarsG: 30, saltG: 0.1, grams: 125 };
    expect(rank(criterion(natural, 'define', 'health').rating)).toBeGreaterThan(rank(criterion(sweet, 'define', 'health').rating));
  });

  it('sin saber cuánto pesaba la comida se cae a la heurística por el nombre (no hay «por 100 g»)', () => {
    const { grams: _grams, ...noGrams } = lentils;
    expect(criterion(noGrams, 'lose', 'health')).toMatchObject({ rating: 'good', detail: 'legumbre · con fibra' });
    const { grams: _g2, ...noGramsDonut } = donut;
    expect(criterion(noGramsDonut, 'lose', 'health').rating).toBe('bad');
  });

  it('sin la sal ni los azúcares anotados, un alimento que no es planta no pasa de «saludable»', () => {
    const plain = { name: 'Atún', kcal: 200, proteinG: 40, carbsG: 0, fatG: 4, grams: 150 };
    expect(criterion(plain, 'lose', 'health').value).toBe('Saludable');
    expect(criterion({ ...plain, sugarsG: 0, saltG: 0.3 }, 'lose', 'health').value).toBe('Muy saludable');
  });

  it('la pechuga a la plancha es muy buena para perder peso y definir, y buena para ganar músculo, mantener y ganar peso', () => {
    const l = levels(grilledChicken);
    expect(l.lose).toBe('great');
    expect(l.define).toBe('great');
    for (const goal of ['muscle', 'maintain', 'gain'] as const) expect(['good', 'great'], goal).toContain(l[goal]);
  });

  it('unas lentejas estofadas (proteína, fibra, ligeras) son muy buenas para casi todo', () => {
    const l = levels(lentils);
    expect(rank(l.lose)).toBeGreaterThanOrEqual(rank('good'));
    expect(rank(l.maintain)).toBeGreaterThanOrEqual(rank('good'));
  });

  it('una pizza entera no es buena para perder peso ni para definir, y cunde más para ganar peso', () => {
    const l = levels({ ...pizza, name: 'Pizza barbacoa' } as typeof chicken);
    expect(l.lose).toBe('poor');
    expect(l.define).toBe('poor');
    expect(rank(l.gain)).toBeGreaterThan(rank(l.lose));
  });

  it('el aceite solo (grasa pura) es mala para perder peso y para ganar músculo: sin proteína y muy denso', () => {
    const l = levels(oil);
    expect(l.lose).toBe('poor');
    expect(l.muscle).toBe('poor');
  });

  it('un refresco, un dónut y una hamburguesa con patatas salen mal para perder peso; una pechuga y unas lentejas, bien', () => {
    for (const bad of [cola, donut, burger]) expect(mealFit(bad, 'lose', targets).level, bad.name).toBe('poor');
    for (const good of [grilledChicken, lentils, banana]) expect(rank(mealFit(good, 'lose', targets).level), good.name).toBeGreaterThanOrEqual(rank('good'));
  });

  it('el nivel es la suma de los puntos de los cinco criterios (menos uno si la comida se lleva medio día)', () => {
    for (const meal of [grilledChicken, cola, banana, donut, lentils, burger, oats, pizza]) {
      for (const goal of GOALS) {
        const fit = mealFit(meal, goal, targets);
        const sum = Object.values(fit.points).reduce((a, b) => a + b, 0) - (fit.note !== null ? 1 : 0);
        const expected = sum >= 4 ? 'great' : sum >= 2 ? 'good' : sum >= -1 ? 'fair' : 'poor';
        expect(fit.level, `${(meal as { name?: string }).name ?? 'comida'} · ${goal}`).toBe(expected);
      }
    }
  });

  it('el mismo alimento no sale igual de bien para todos los objetivos: el nivel depende de lo que se busca', () => {
    expect(new Set(Object.values(levels(pizza))).size).toBeGreaterThan(1);
    expect(new Set(Object.values(levels(oats))).size).toBeGreaterThan(1);
  });

  it('una comida que se lleva más de la mitad de las calorías del día resta, salvo para ganar peso, y lo dice en una línea aparte', () => {
    const huge = { kcal: 1500, proteinG: 80, carbsG: 150, fatG: 60 };
    expect(mealFit(huge, 'maintain', targets).note).toBe('Más de la mitad de las calorías de tu día.');
    expect(mealFit(huge, 'gain', targets).note).toBeNull();
    expect(mealFit(oats, 'maintain', targets).note).toBeNull();
  });

  it('con solo las calorías anotadas dice que no se puede valorar y no dibuja criterios', () => {
    const fit = mealFit({ kcal: 600 }, 'lose', targets);
    expect(fit.level).toBe('unknown');
    expect(fit.criteria).toEqual([]);
    expect(fit.note).toMatch(/Solo se anotaron las calorías/);
  });

  it('el título dice el nivel y el objetivo', () => {
    for (const goal of GOALS) expect(mealFit(oats, goal, targets).headline).toMatch(/^(Muy buena|Buena|Normal|Poco adecuada) para /);
    expect(mealFit(oats, 'maintain', targets).headline).toMatch(/para mantener peso$/);
  });

  it('la sal resta puntos: la misma comida sale peor con 3 g de sal que sin ella', () => {
    const lunch = { name: 'Menú del día', kcal: 500, proteinG: 40, carbsG: 50, fatG: 18, grams: 400 };
    expect(rank(mealFit({ ...lunch, saltG: 3 }, 'maintain', targets).level)).toBeLessThan(rank(mealFit({ ...lunch, saltG: 0.5 }, 'maintain', targets).level));
  });

  it('el azúcar resta puntos y la fibra suma', () => {
    const base = { name: 'Desayuno', kcal: 400, proteinG: 15, carbsG: 60, fatG: 10, grams: 250 };
    const sweet = mealFit({ ...base, sugarsG: 35 }, 'maintain', targets);
    expect(sweet.points.excess).toBeLessThan(0);
    const fibre = mealFit({ ...base, fiberG: 8 }, 'maintain', targets);
    expect(fibre.points.health).toBeGreaterThanOrEqual(mealFit(base, 'maintain', targets).points.health);
    expect(criterion({ ...base, fiberG: 8 }, 'maintain', 'health').rating).not.toBe('bad');
  });
});

describe('classifyName: a qué grupo se parece un alimento', () => {
  it.each([
    ['Ensalada con pollo', 2, 'fruta y verdura'],
    ['Lentejas', 2, 'legumbre'],
    ['Salmón al horno', 1, 'pescado y marisco'],
    ['Pechuga a la plancha', 1, 'carne magra'],
    ['Pollo empanado', 0, 'fritura'],
    ['Tarta de manzana', -2, 'bollería y dulce'],
    ['Zumo de naranja', -1, 'zumo o batido'],
    ['Coca-Cola', -2, 'bebida azucarada'],
    ['Cerveza', -2, 'alcohol'],
    ['Patatas fritas', -2, 'snack o fritura'],
    ['Pizza cuatro quesos', -1, 'comida rápida'],
    ['Chorizo', -1, 'embutido'],
    ['Aguacate', 2, 'fruta y verdura'],
    ['Comida', 0, null],
  ])('%s → %i (%s)', (name, points, label) => {
    expect(classifyName(name)).toEqual({ points, label });
  });

  it('solo reconoce palabras enteras: «operación» no es una pera ni «aguacate» un agua', () => {
    expect(classifyName('Operación').points).toBe(0);
    expect(classifyName('Superación').points).toBe(0);
    expect(classifyName('Caldo').points).toBe(0);
    expect(classifyName('Peras').label).toBe('fruta y verdura'); // el plural sí
  });
});
