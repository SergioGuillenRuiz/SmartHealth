import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { atHourMs, type DayKey, addDays } from '../domain/dates';
import { classifyName, mealFit, type FitLevel } from '../domain/meal-fit';
import { nutritionTargets, type HealthGoal, type MealEntry } from '../domain/nutrition';
import type { ProfileEntry } from '../domain/profile';
import { familyOf, GOAL_SCALE, needsOf, rankRecipes, scaleRecipe } from '../domain/recipe-suggest';
import { RECIPE_FAMILIES } from '../domain/recipes';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { estimateMealFromText, draftOfAnalysis } from './food-text';
import { adviceFor, evaluateRecipe, repeatsOf, shouldSuggest } from './meal-habits';
import { profileHistory, settings } from './state';
import { installServices } from './services';
import { SimulatedTransport } from '../ble/sim/ring';
import { buildDemoDataset } from '../ble/sim/dataset';

const profile: ProfileEntry = { date: '2026-01-01', heightCm: 178, weightKg: 85, sex: 'male', birthDate: '1985-06-15' };
const GOALS: HealthGoal[] = ['lose', 'define', 'maintain', 'muscle', 'gain'];
const targetsFor = (goal: HealthGoal) => nutritionTargets(profile, '2026-10-10', goal);
const RANK: Record<FitLevel, number> = { unknown: -1, poor: 0, fair: 1, good: 2, great: 3 };

/** Lo que de verdad saldría de anotar este texto: la comida entera, con sus nutrientes. */
function mealOfText(text: string, id = 'm'): MealEntry {
  const result = estimateMealFromText(text);
  if (result.status !== 'ok') throw new Error(result.message);
  const d = draftOfAnalysis(result.analysis);
  return { id, tsMs: 0, name: text, kcal: Math.round(d.kcal ?? 0), proteinG: d.proteinG ?? 0, carbsG: d.carbsG ?? 0, fatG: d.fatG ?? 0, fiberG: d.fiberG ?? 0, sugarsG: d.sugarsG ?? 0, saltG: d.saltG ?? 0, source: 'text' };
}
const levelOfText = (text: string, goal: HealthGoal): FitLevel => mealFit(mealOfText(text), goal, targetsFor(goal)).level;

const all = RECIPE_FAMILIES.flatMap((family) => family.recipes.map((recipe) => ({ family, recipe })));

describe('las recetas', () => {
  it('son factibles: pocos pasos, poco tiempo, ingredientes con cantidad y cada paso con una acción que se dibuja', () => {
    for (const { recipe } of all) {
      expect(recipe.minutes, recipe.id).toBeLessThanOrEqual(20);
      // Un producto de súper no se cocina: sin pasos, y con lo que hay que mirar en la etiqueta. Todo lo demás, de 1 a 5 pasos.
      if (recipe.kind === 'product') {
        expect(recipe.steps, recipe.id).toEqual([]);
        expect(recipe.shop?.length ?? 0, recipe.id).toBeGreaterThan(15);
      } else {
        expect(recipe.steps.length, recipe.id).toBeGreaterThanOrEqual(1);
        expect(recipe.shop, recipe.id).toBeUndefined();
      }
      expect(recipe.steps.length, recipe.id).toBeLessThanOrEqual(5);
      expect(recipe.ingredients.length, recipe.id).toBeGreaterThanOrEqual(1);
      expect(recipe.change.length, recipe.id).toBeGreaterThan(20);
      for (const ingredient of recipe.ingredients) expect(ingredient.q, `${recipe.id}: ${ingredient.name}`).toBeGreaterThan(0);
      // Un paso no dura más que la receta entera (algunos pasos van a la vez: el horno mientras se prepara lo demás).
      for (const s of recipe.steps) expect(s.minutes ?? 0, `${recipe.id}: ${s.text}`).toBeLessThanOrEqual(recipe.minutes);
    }
    expect(new Set(all.map(({ recipe }) => recipe.id)).size).toBe(all.length);
  });

  it('cada tipo de plato tiene al menos dos recetas (el general, tres), y solo no se valoran las bebidas sin calorías o con alcohol y la gelatina sin azúcar', () => {
    for (const family of RECIPE_FAMILIES) expect(family.recipes.length, family.id).toBeGreaterThanOrEqual(family.id === 'general' ? 3 : 2);
    expect(all.filter(({ recipe }) => recipe.rated === false).map(({ recipe }) => recipe.id).sort()).toEqual([
      'agua-coco-bote',
      'agua-gas-limon',
      'agua-pepino-menta',
      'bebida-isotonica-cero',
      'cerveza-sin',
      'gelatina-sin-azucar',
      'kombucha-nevera',
      'limonada-sin-azucar',
      'refresco-zero',
      'soda-limon-vino',
      'te-frio-menta',
      'tonica-zero-limon',
    ]);
  });

  it('no todo es cocinar: casi todos los tipos traen también productos de súper (los de dulce, snack y bebida desde siempre), y las cuentas de unos y otros salen de la misma tabla', () => {
    const products = all.filter(({ recipe }) => recipe.kind === 'product');
    const withProducts = new Set(products.map(({ family }) => family.id));
    for (const id of ['dulce', 'snack', 'bebida', 'pasta', 'sopa', 'arroz', 'pizza', 'hamburguesa', 'kebab', 'bocadillo', 'carne', 'general']) expect(withProducts.has(id), id).toBe(true);
    expect(products.length).toBeGreaterThanOrEqual(25);
    expect(products.map(({ recipe }) => recipe.id)).toEqual(expect.arrayContaining(['gelatina-sin-azucar', 'skyr-natural', 'helado-proteico']));
    // La gelatina sin azúcar es casi cero calorías de verdad (no la de sobre con azúcar: 62 por 100 g).
    const gelatina = evaluateRecipe(all.find(({ recipe }) => recipe.id === 'gelatina-sin-azucar')!.recipe, 'maintain', targetsFor('maintain'))!;
    expect(gelatina.kcal).toBeLessThan(30);
  });

  it('todas se calculan con la tabla de alimentos y con cualquier objetivo, sin alimentos que no se entiendan', () => {
    for (const { recipe } of all) {
      for (const goal of GOALS) {
        const scaled = scaleRecipe(recipe, goal);
        const result = estimateMealFromText(scaled.text);
        expect(result.status, `${recipe.id} (${goal}): ${scaled.text}`).toBe('ok');
        if (result.status === 'ok') expect(result.analysis.unknown, `${recipe.id} (${goal})`).toEqual([]);
        expect(evaluateRecipe(recipe, goal, targetsFor(goal)), `${recipe.id} (${goal})`).not.toBeNull();
      }
    }
  });

  it('las que se valoran salen al menos «normal» con cualquier objetivo', () => {
    for (const { recipe } of all) {
      if (recipe.rated === false) continue;
      for (const goal of GOALS) {
        const evaluated = evaluateRecipe(recipe, goal, targetsFor(goal))!;
        expect(RANK[evaluated.level], `${recipe.id} con ${goal}: ${evaluated.level}`).toBeGreaterThanOrEqual(RANK.fair);
      }
    }
  });

  it('mejoran notablemente lo que sustituyen: la comida típica de cada tipo sale «poco adecuada» y cada receta suya, mejor', () => {
    const typical: ReadonlyArray<readonly [family: string, text: string]> = [
      ['pizza', 'una pizza margarita'],
      ['dulce', 'dos croissants'],
      ['snack', 'una bolsa de patatas fritas'],
      ['zumo', 'un zumo de naranja envasado'],
      ['fritura', 'unas patatas bravas'],
      ['bocadillo', 'un bocadillo de chorizo'],
      ['hamburguesa', 'una hamburguesa doble con queso y bacon'],
    ];
    for (const [familyId, text] of typical) {
      const before = levelOfText(text, 'maintain');
      expect(before, `${text}: ${before}`).toBe('poor');
      expect(familyOf(text).id, text).toBe(familyId);
      for (const recipe of RECIPE_FAMILIES.find((f) => f.id === familyId)!.recipes) {
        const after = evaluateRecipe(recipe, 'maintain', targetsFor('maintain'))!;
        expect(RANK[after.level], `${recipe.id}: ${after.level}`).toBeGreaterThan(RANK[before]);
      }
    }
  });
});

describe('familyOf: de qué tipo de plato es una comida', () => {
  it.each([
    ['Sobre de pasta instantánea', 'pasta'],
    ['Macarrones con queso', 'pasta'],
    ['Espaguetis a la carbonara', 'pasta'],
    ['Ramen de sobre', 'sopa'],
    ['Maruchan pollo', 'sopa'],
    ['Arroz tres delicias', 'arroz'],
    ['Paella de marisco', 'arroz'],
    ['Pizza barbacoa', 'pizza'],
    ['Big Mac', 'hamburguesa'],
    ['Whopper con queso', 'hamburguesa'],
    ['Kebab de ternera', 'kebab'],
    ['Bocadillo de chorizo', 'bocadillo'],
    ['Perrito caliente', 'bocadillo'],
    ['Croissant con chocolate', 'dulce'],
    ['Helado de vainilla', 'dulce'],
    ['Buñuelos', 'dulce'],
    ['Buñuelos de viento rellenos de crema', 'dulce'],
    ['Torrijas', 'dulce'],
    ['Rosquillas de anís', 'dulce'],
    ['Cruasán relleno', 'dulce'],
    ['Buñuelos de bacalao', 'fritura'],
    ['Patatas fritas de bolsa', 'snack'],
    ['Croquetas fritas', 'fritura'],
    ['Pollo empanado', 'fritura'],
    ['Coca-Cola', 'bebida'],
    ['Zumo de naranja', 'zumo'],
    ['Cerveza', 'alcohol'],
    ['Plato combinado raro', 'general'],
    ['', 'general'],
  ])('%s → %s', (name, family) => {
    expect(familyOf(name).id).toBe(family);
  });

  it('si el nombre no dice nada pero lo que lleva es casi todo azúcar, es un dulce; si no, el general', () => {
    expect(familyOf('Lo de la abuela', { kcal: 400, sugarsG: 40 }).id).toBe('dulce'); // 160 de 400 kcal en azúcar
    expect(familyOf('Lo de la abuela', { kcal: 400, sugarsG: 10 }).id).toBe('general');
    expect(familyOf('Lo de la abuela', { kcal: 400 }).id).toBe('general'); // sin dato de azúcares no se supone nada
    expect(familyOf('Lo de la abuela').id).toBe('general');
    expect(familyOf('Pizza barbacoa', { kcal: 400, sugarsG: 40 }).id).toBe('pizza'); // el nombre manda sobre lo que lleva
  });

  it('una comida con una bebida es de lo que se come, no de la bebida', () => {
    expect(familyOf('Hamburguesa con Coca-Cola').id).toBe('hamburguesa');
    expect(familyOf('Pizza y cerveza').id).toBe('pizza');
  });
});

describe('rankRecipes: qué recetas se proponen primero', () => {
  it('para una pasta de sobre: la de pasta con atún (menos sal y más proteína) y la de fideos van antes que la de gambas', () => {
    const meal = mealOfText('un sobre de pasta instantánea');
    const fit = mealFit(meal, 'lose', targetsFor('lose'));
    const ranked = rankRecipes(familyOf(meal.name), meal.name, needsOf(meal, fit));
    expect(ranked.map((r) => r.id).slice(0, 2).sort()).toEqual(['fideos-pollo-verduras', 'pasta-atun-tomate']);
  });

  it('unos buñuelos: recetas y productos dulces parecidos, nunca una ensalada ni la tostada salada; al menos una se compra hecha y una se prepara', () => {
    const meal = mealOfText('unos buñuelos de viento');
    const fit = mealFit(meal, 'lose', targetsFor('lose'));
    const family = familyOf(meal.name, meal);
    expect(family.id).toBe('dulce');
    const ranked = rankRecipes(family, meal.name, needsOf(meal, fit));
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.id)).not.toContain('tostada-tomate');
    expect(ranked.some((r) => r.kind === 'product')).toBe(true);
    expect(ranked.some((r) => r.kind !== 'product')).toBe(true);
    // Lo que se parece a una masa frita (tortitas) y lo que sustituye a un postre (gelatina sin azúcar) van antes que lo demás.
    expect(ranked.map((r) => r.id)).toEqual(expect.arrayContaining(['tortitas-avena-platano', 'gelatina-sin-azucar']));
  });

  it('el análisis completo de unos buñuelos da recetas de postre y alguna de súper, todas con sus calorías', () => {
    const meal: MealEntry = { ...mealOfText('unos buñuelos de viento'), id: 'b1' };
    const advice = adviceFor(meal, 'lose');
    expect(advice.family.id).toBe('dulce');
    expect(advice.results.length).toBe(3);
    expect(advice.results.some((result) => result.scaled.recipe.kind === 'product')).toBe(true);
    for (const result of advice.results) {
      expect(result.kcal, result.scaled.recipe.id).toBeGreaterThan(0);
    }
  });

  it('da como mucho tres, y las generales para lo que no es de ningún tipo', () => {
    expect(rankRecipes(familyOf('Big Mac'), 'Big Mac', []).length).toBeLessThanOrEqual(3);
    // Dos recetas de siempre y, como el tipo general ya tiene productos de súper, uno de ellos (siempre se mezclan los dos tipos).
    const general = rankRecipes(familyOf('Plato combinado raro'), 'Plato combinado raro', []);
    expect(general.map((r) => r.id).slice(0, 2)).toEqual(['pollo-plancha-ensalada', 'revuelto-verduras']);
    expect(general[2]?.kind).toBe('product');
  });

  it.each([
    ['Big Mac', 'hamburguesa-pavo'],
    ['Pizza margarita', 'pizza-wrap'],
    ['Kebab de ternera', 'wrap-pollo-yogur'],
    ['Croissant con chocolate', 'tostada-tomate'],
    ['Helado de chocolate', 'queso-batido-cacao'],
    ['Patatas fritas de bolsa', 'garbanzos-crujientes'],
    ['Bocadillo de chorizo', 'bocadillo-pavo'],
    ['Croquetas fritas', 'calamares-plancha'],
    ['Patatas bravas', 'patatas-horno-huevo'],
    ['Pollo empanado', 'pollo-avena-horno'],
    ['Cerveza', 'cerveza-sin'],
    ['Arroz tres delicias', 'arroz-huevo-verduras'],
    ['Zumo de naranja', 'fruta-entera'],
  ])('%s → empieza por %s', (name, first) => {
    expect(rankRecipes(familyOf(name), name, [])[0]?.id).toBe(first);
  });
});

describe('la ronda 53: más productos y más variedad', () => {
  it('hay muchos más productos de súper (60) y todos los tipos de plato tienen al menos uno', () => {
    const products = all.filter(({ recipe }) => recipe.kind === 'product');
    expect(products.length).toBeGreaterThanOrEqual(55);
    expect(all.length).toBeGreaterThanOrEqual(140);
    for (const family of RECIPE_FAMILIES) expect(family.recipes.some((recipe) => recipe.kind === 'product'), family.id).toBe(true);
  });

  it('con variedad, la misma comida no recibe siempre lo mismo, pero lo que encaja mejor va antes con cualquier semilla', () => {
    const meal = mealOfText('unas patatas fritas de bolsa');
    const fit = mealFit(meal, 'lose', targetsFor('lose'));
    const family = familyOf(meal.name, meal);
    const needs = needsOf(meal, fit);
    const sets = new Set(Array.from({ length: 24 }, (_, i) => rankRecipes(family, meal.name, needs, 3, `comida-${i}`).map((r) => r.id).join('|')));
    expect(sets.size).toBeGreaterThan(3);
    // Lo que se parece de verdad (closeTo) está siempre entre las tres, sea cual sea la semilla: «patatas fritas de bolsa» se parece a las patatas de bolsa y a los snacks.
    const close = rankRecipes(family, meal.name, needs).filter((recipe) => recipe.closeTo !== undefined && /patatas/.test(recipe.closeTo));
    expect(close.length).toBeGreaterThan(0);
    for (let i = 0; i < 24; i++) {
      const picked = rankRecipes(family, meal.name, needs, 3, `comida-${i}`);
      expect(picked.some((recipe) => recipe.closeTo !== undefined && /patatas/.test(recipe.closeTo)), `semilla ${i}`).toBe(true);
    }
  });

  it('con la misma semilla sale siempre lo mismo (nada es aleatorio) y sin semilla, el orden de siempre', () => {
    const meal = mealOfText('unos buñuelos de viento');
    const fit = mealFit(meal, 'lose', targetsFor('lose'));
    const family = familyOf(meal.name, meal);
    const needs = needsOf(meal, fit);
    const a = rankRecipes(family, meal.name, needs, 3, 'm1').map((r) => r.id);
    expect(rankRecipes(family, meal.name, needs, 3, 'm1').map((r) => r.id)).toEqual(a);
    expect(rankRecipes(family, meal.name, needs).map((r) => r.id)).toEqual(rankRecipes(family, meal.name, needs, 3, undefined).map((r) => r.id));
  });

  it('adviceFor usa el identificador de la comida: dos comidas iguales con distinto id pueden recibir ideas distintas, y siempre da tres', () => {
    const base = mealOfText('unas patatas fritas de bolsa');
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const advice = adviceFor({ ...base, id: `rep-${i}` }, 'lose');
      expect(advice.results.length).toBe(3);
      ids.add(advice.results.map((r) => r.scaled.recipe.id).join('|'));
    }
    expect(ids.size).toBeGreaterThan(2);
  });
});

describe('needsOf: lo que le falla a una comida', () => {
  it('una pasta de sobre falla en sal y en proteína; una bolsa de patatas, en ligereza y sal', () => {
    const noodles = mealOfText('un sobre de pasta instantánea');
    expect(needsOf(noodles, mealFit(noodles, 'lose', targetsFor('lose')))).toEqual(expect.arrayContaining(['salt']));
    const chips = mealOfText('una bolsa de patatas fritas');
    const needs = needsOf(chips, mealFit(chips, 'maintain', targetsFor('maintain')));
    expect(needs.length).toBeGreaterThan(0);
  });

  it('una comida buena no necesita nada', () => {
    const good = mealOfText('150 g de pechuga de pollo, 100 g de lechuga, 1 tomate');
    expect(needsOf(good, mealFit(good, 'maintain', targetsFor('maintain')))).toEqual([]);
  });
});

describe('scaleRecipe: la receta ajustada al objetivo', () => {
  const pasta = RECIPE_FAMILIES.find((f) => f.id === 'pasta')!.recipes[0]!;
  const amount = (goal: HealthGoal, name: string): number => scaleRecipe(pasta, goal).ingredients.find((i) => i.name === name)!.amount;

  it('para perder peso: más verdura y menos hidrato; para ganar músculo: más proteína y más hidrato', () => {
    expect(amount('maintain', 'pasta integral cocida')).toBe(200);
    expect(amount('lose', 'pasta integral cocida')).toBeLessThan(200);
    expect(amount('lose', 'tomate triturado')).toBeGreaterThan(150);
    expect(amount('muscle', 'pasta integral cocida')).toBeGreaterThan(200);
    expect(amount('muscle', 'atún al natural')).toBeGreaterThan(60);
    expect(amount('gain', 'pasta integral cocida')).toBeGreaterThan(amount('muscle', 'pasta integral cocida') - 1);
  });

  it('las cantidades salen a múltiplos de 5, las unidades y lo «fijo» no se tocan, y mantener deja la receta como está', () => {
    const eggs = RECIPE_FAMILIES.find((f) => f.id === 'arroz')!.recipes[1]!;
    for (const goal of GOALS) {
      for (const ingredient of scaleRecipe(eggs, goal).ingredients) {
        if (ingredient.unit === 'ud') expect(ingredient.amount).toBe(ingredient.q);
        else if (ingredient.role === 'fixed') expect(ingredient.amount).toBe(ingredient.q);
        else expect(ingredient.amount % 5, `${goal}: ${ingredient.name}`).toBe(0);
      }
    }
    for (const { recipe } of all) {
      const expected = recipe.ingredients.map((i) => (i.unit === 'ud' || i.role === 'fixed' || i.q % 5 === 0 ? i.q : Math.max(5, Math.round(i.q / 5) * 5)));
      expect(scaleRecipe(recipe, 'maintain').ingredients.map((i) => i.amount), recipe.id).toEqual(expected);
    }
    expect(Object.values(GOAL_SCALE.maintain).every((factor) => factor === 1)).toBe(true);
  });

  it('el texto que se calcula lleva las cantidades ajustadas, con el plural de las unidades', () => {
    expect(scaleRecipe(pasta, 'maintain').text).toBe('200 g de pasta integral, 60 g de atún al natural, 150 g de tomate, 5 g de aceite de oliva');
    const eggs = RECIPE_FAMILIES.find((f) => f.id === 'arroz')!.recipes[1]!;
    expect(scaleRecipe(eggs, 'maintain').text).toContain('2 huevos');
  });

  it('con «perder peso» una receta tiene menos calorías que con «ganar peso»', () => {
    for (const { recipe } of all) {
      // Solo las que llevan un hidrato que ajustar: el resto cambia sobre todo la verdura, que pesa poco en calorías.
      if (recipe.rated === false || !recipe.ingredients.some((i) => i.role === 'carb' && i.unit !== 'ud')) continue;
      const lose = evaluateRecipe(recipe, 'lose', targetsFor('lose'))!.kcal;
      const gain = evaluateRecipe(recipe, 'gain', targetsFor('gain'))!.kcal;
      expect(lose, recipe.id).toBeLessThanOrEqual(gain);
    }
  });
});

describe('adviceFor: el análisis completo de una comida', () => {
  it('da el tipo de plato, lo que pesa y las recetas ajustadas al objetivo', () => {
    const meal = mealOfText('un sobre de pasta instantánea');
    const advice = adviceFor(meal, 'lose');
    expect(advice.family.id).toBe('pasta');
    expect(advice.weak.length).toBeGreaterThan(0);
    expect(advice.results.length).toBe(3);
    expect(advice.results.every((r) => r.scaled.goal === 'lose')).toBe(true);
    expect(advice.results.every((r) => RANK[r.level] >= RANK.fair)).toBe(true);
  });
});

describe('shouldSuggest', () => {
  it('solo con la función activada, la comida poco adecuada y repetida 3 o más veces', () => {
    expect(shouldSuggest('poor', 3, true)).toBe(true);
    expect(shouldSuggest('poor', 5, true)).toBe(true);
    expect(shouldSuggest('poor', 2, true)).toBe(false);
    expect(shouldSuggest('fair', 9, true)).toBe(false);
    expect(shouldSuggest('unknown', 9, true)).toBe(false);
    expect(shouldSuggest('poor', 9, false)).toBe(false);
  });
});

describe('repeatsOf: cuántas veces se repite ESTA comida', () => {
  const TODAY: DayKey = '2026-10-19';
  let store: IdbStore;
  let counter = 0;
  const meal = (id: string, daysAgo: number, name: string, over: Partial<MealEntry> = {}): MealEntry => ({ ...mealOfText('un sobre de pasta instantánea', id), name, tsMs: atHourMs(addDays(TODAY, -daysAgo), 14), ...over });

  beforeEach(async () => {
    store = await openIdbStore(`habits-${++counter}`);
    installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: atHourMs(TODAY, 12), days: 1, seed: 1 })), now: () => atHourMs(TODAY, 12), demo: false });
    profileHistory.value = [profile];
    settings.value = { ...settings.value, healthGoal: 'lose' };
  });

  it('tres veces la misma comida poco adecuada en una semana: se repite; otras comidas poco adecuadas no cuentan', async () => {
    const noodles = [meal('a', 1, 'Sobre de pasta instantánea'), meal('b', 3, 'sobre de pasta instantanea'), meal('c', 5, '2 sobres de pasta instantánea')];
    for (const m of noodles) await store.putMeal(m);
    // Otras tres comidas poco adecuadas, distintas, la misma semana: no cuentan.
    for (const [i, name] of ['Pizza margarita', 'Big Mac', 'Bolsa de patatas fritas'].entries()) await store.putMeal({ ...mealOfText('una pizza margarita', `o${i}`), name, tsMs: atHourMs(addDays(TODAY, -2 - i), 21) });
    expect(await repeatsOf(noodles[0]!)).toBe(3);
    expect(await repeatsOf(noodles[2]!)).toBe(3);
  });

  it('dos veces no basta, y tres separadas por más de una semana tampoco', async () => {
    const two = [meal('a', 1, 'Sobre de pasta instantánea'), meal('b', 3, 'Sobre de pasta instantánea')];
    for (const m of two) await store.putMeal(m);
    expect(await repeatsOf(two[0]!)).toBe(2);
    const spread = meal('far', 12, 'Sobre de pasta instantánea');
    await store.putMeal(spread);
    expect(await repeatsOf(two[0]!)).toBe(2);
  });

  it('una comida igual que sale bien valorada no cuenta como repetida', async () => {
    const lights = [1, 3, 5].map((n) => ({ ...mealOfText('150 g de pechuga de pollo, 100 g de lechuga, 1 tomate', `l${n}`), tsMs: atHourMs(addDays(TODAY, -n), 14) }));
    for (const m of lights) await store.putMeal(m);
    expect(await repeatsOf(lights[0]!)).toBe(0);
  });

  it('la misma comida por código de barras cuenta aunque se llame distinto', async () => {
    const barcode = '8412345678941';
    const a = meal('a', 1, 'Maruchan pollo', { barcode, source: 'barcode' });
    const b = meal('b', 2, 'Fideos instantáneos pollo', { barcode: `0${barcode}`.slice(0, 13) === barcode ? barcode : barcode, source: 'barcode' });
    const c = meal('c', 4, 'Noodles de pollo', { barcode, source: 'barcode' });
    for (const m of [a, b, c]) await store.putMeal(m);
    expect(await repeatsOf(a)).toBe(3);
  });
});

describe('clasificación de nombres (se sigue usando para los tipos de plato sin palabra propia)', () => {
  it('las comidas rápidas sin nombre propio caen en hamburguesa, los embutidos en bocadillo', () => {
    expect(classifyName('menú McMenu').label).toBe('comida rápida');
    expect(familyOf('mcmenu grande').id).toBe('hamburguesa');
    expect(familyOf('fiambre y queso').id).toBeDefined();
  });
});
