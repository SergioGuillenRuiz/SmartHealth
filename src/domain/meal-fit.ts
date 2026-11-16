import { drinkProfile, nutrientProfile, type FatKind, type NutrientProfile, type Produce } from './nutrient-profile';
import { HEALTH_GOALS, SALT_LIMIT_G, type HealthGoal, type MealEntry, type NutritionTargets } from './nutrition';

// Qué aporta una comida y cuánto encaja con lo que busca la persona. Se conocen las calorías, los tres macronutrientes (proteína, hidratos y grasas) y, si se anotaron, la
// fibra, los azúcares y la sal, además de los gramos y el nombre. De cada nutriente se dice cuánto pesa en la comida y en el día. La valoración mira cinco cosas, cada una con
// su nota visible: la densidad calórica, la densidad proteica, si lleva demasiada sal o azúcar, si sacia y si es un alimento saludable. docs/estimaciones.md → Hoja de detalles de
// una comida explica los umbrales y de dónde salen.

const KCAL_PER_G = { proteinG: 4, carbsG: 4, fatG: 9 } as const;

export type MacroKey = keyof typeof KCAL_PER_G;
/** Los cuatro indicadores de una comida: los tres macronutrientes y la sal. */
export type IndicatorKey = MacroKey | 'saltG';

export interface Indicator {
  key: IndicatorKey;
  /** Gramos de esa comida (`null`: no se anotaron). */
  grams: number | null;
  /** Parte de la energía de los tres macronutrientes que sale de este (0–1; los tres suman 1): `null` en la sal, que no aporta energía, o si no se anotaron. */
  energyShare: number | null;
  /** Parte de lo que se propone al día de ese nutriente (0–1 o más); en la sal, parte del máximo diario. */
  dayShare: number | null;
}

/** La densidad energética: pocas calorías por gramo llenan más (el WCRF llama baja a menos de 125 kcal/100 g y alta a más de 225). */
export type EnergyDensity = 'low' | 'medium' | 'high';

type MealNutrients = Pick<MealEntry, 'kcal' | 'proteinG' | 'carbsG' | 'fatG' | 'fiberG' | 'sugarsG' | 'saltG' | 'grams'> & { name?: string };

export interface MealFacts {
  /** Qué parte de las calorías del día que se proponen es esta comida (0–1 o más). */
  kcalDayShare: number;
  /** Proteína, hidratos, grasas y sal, en este orden. */
  indicators: Indicator[];
  /** `true` si se anotó algún macronutriente (con solo las calorías no se puede decir qué lleva). */
  hasMacros: boolean;
  /** Gramos de proteína por cada 100 kcal (una forma de medir cuánta proteína lleva para lo que aporta). */
  proteinPer100kcal: number | null;
  /** Calorías por 100 g, si se sabe cuánto pesaba (a partir de 20 g). */
  kcalPer100g: number | null;
  density: EnergyDensity | null;
}

const LOW_DENSITY = 125;
const HIGH_DENSITY = 225;

/** Lo que dice la comida y cómo pesa en el día. `targets` son las metas del día al que cuenta. */
export function mealFacts(meal: MealNutrients, targets: NutritionTargets): MealFacts {
  const kcal = Math.max(0, meal.kcal);
  const hasMacros = meal.proteinG !== undefined || meal.carbsG !== undefined || meal.fatG !== undefined;
  // Las partes de la energía se reparten entre lo que aportan los tres macronutrientes (no entre las calorías anotadas, que pueden incluir alcohol, fibra o el
  // redondeo de una etiqueta): así los tres suman el 100 %.
  const energy = hasMacros ? (meal.proteinG ?? 0) * KCAL_PER_G.proteinG + (meal.carbsG ?? 0) * KCAL_PER_G.carbsG + (meal.fatG ?? 0) * KCAL_PER_G.fatG : 0;
  const macros = (['proteinG', 'carbsG', 'fatG'] as const).map((key): Indicator => {
    const grams = hasMacros ? (meal[key] ?? 0) : null;
    return {
      key,
      grams,
      energyShare: grams !== null && energy > 0 ? (grams * KCAL_PER_G[key]) / energy : null,
      dayShare: grams !== null && targets[key] > 0 ? grams / targets[key] : null,
    };
  });
  const salt: Indicator = { key: 'saltG', grams: meal.saltG ?? null, energyShare: null, dayShare: meal.saltG !== undefined && targets.saltG > 0 ? meal.saltG / targets.saltG : null };
  const protein = macros[0]?.grams ?? null;
  const weight = meal.grams !== undefined && meal.grams >= 20 ? meal.grams : null;
  const kcalPer100g = weight === null ? null : Math.round((kcal / weight) * 100);
  return {
    kcalDayShare: targets.kcal > 0 ? kcal / targets.kcal : 0,
    indicators: [...macros, salt],
    hasMacros,
    proteinPer100kcal: protein !== null && kcal > 0 ? Math.round((protein / kcal) * 1000) / 10 : null,
    kcalPer100g,
    density: kcalPer100g === null ? null : kcalPer100g < LOW_DENSITY ? 'low' : kcalPer100g > HIGH_DENSITY ? 'high' : 'medium',
  };
}

// ───────────────────────────── cuánto encaja con el objetivo ─────────────────────────────

export type FitLevel = 'great' | 'good' | 'fair' | 'poor' | 'unknown';
/** Cómo sale una comida en un criterio: bien, así así, mal o sin datos para decirlo. */
export type Rating = 'good' | 'ok' | 'bad' | 'unknown';
export type CriterionKey = 'energy' | 'protein' | 'excess' | 'satiety' | 'health';

/** Uno de los cinco criterios de la valoración, listo para dibujarse: su nombre, cómo sale, una palabra y, debajo, la cifra o el motivo. */
export interface Criterion {
  key: CriterionKey;
  label: string;
  rating: Rating;
  /** Una o dos palabras: «Baja», «Alta», «Mucha sal», «Saludable»… («—» si no hay datos). */
  value: string;
  /** La cifra o el motivo, corto: «95 kcal por 100 g», «sal 3,2 g · azúcares 5 g»… */
  detail: string | null;
}

export interface MealFit {
  level: FitLevel;
  /** Una frase: «Muy buena para definir». */
  headline: string;
  /** Los cinco criterios, en este orden: densidad calórica, densidad proteica, sal y azúcar, saciedad y si es saludable. Vacío si solo se anotaron las calorías. */
  criteria: Criterion[];
  /** Una línea aparte si la comida se lleva medio día de calorías (`null` si no). */
  note: string | null;
  /** Para ver qué suma cada cosa: los puntos de cada criterio con el objetivo elegido. */
  points: Record<CriterionKey, number>;
}

const num = (n: number): string => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const g = (grams: number): string => `${num(grams)}\u00a0g`;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const LEVEL_WORD: Record<Exclude<FitLevel, 'unknown'>, string> = {
  great: 'Muy buena',
  good: 'Buena',
  fair: 'Normal',
  poor: 'Poco adecuada',
};

const plain = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Una palabra entera (o su plural) de entre las que se dan; el nombre ya va sin tildes y en minúsculas. */
const word = (patterns: string): RegExp => new RegExp(`(?<![a-z])(?:${patterns})(?:es|s)?(?![a-z])`);

// ── Qué alimento es, por su nombre ──
// Con solo las calorías y los macros no se distingue una ensalada de unas patatas fritas con los mismos nutrientes. Por el nombre se reconoce a qué grupo pertenece
// (fruta y verdura, legumbre, pescado… frente a bollería, refrescos, frituras, comida rápida…): es una heurística, no el Nutri-Score (que pide la grasa saturada y el
// porcentaje de fruta y verdura, que no se anotan). Una regla que «manda» (bebida azucarada, bollería, alcohol…) anula las buenas: una tarta de manzana no es fruta.

interface NameRule {
  re: RegExp;
  label: string;
  points: number;
  /** Anula a las reglas buenas del mismo nombre. */
  overrides?: boolean;
}

const NAME_RULES: readonly NameRule[] = [
  { re: word('legumbre|lenteja|garbanzo|alubia|judia|hummus|edamame|guisante|haba|soja'), label: 'legumbre', points: 2 },
  {
    re: word(
      'fruta|manzana|pera|platano|banana|naranja|mandarina|fresa|uva|sandia|melon|pina|kiwi|melocoton|albaricoque|cereza|ciruela|mango|papaya|arandano|frambuesa|higo|granada|pomelo|aguacate|verdura|hortaliza|ensalada|brocoli|coliflor|espinaca|acelga|lechuga|tomate|pepino|calabacin|berenjena|pimiento|zanahoria|cebolla|esparrago|alcachofa|champinon|seta|gazpacho|crudites|menestra',
    ),
    label: 'fruta y verdura',
    points: 2,
  },
  { re: word('pescado|merluza|bacalao|lubina|dorada|atun|salmon|sardina|caballa|boqueron|anchoa|trucha|gamba|marisco|calamar|pulpo|mejillon|almeja|langostino'), label: 'pescado y marisco', points: 1 },
  { re: word('pechuga|pavo|pollo|conejo|solomillo|ternera|lomo|jamon serrano|pato'), label: 'carne magra', points: 1 },
  { re: word('huevo|clara|tortilla francesa|revuelto'), label: 'huevo', points: 1 },
  { re: word('yogur natural|yogur griego|yogur desnatado|kefir|queso fresco|requeson|leche|cuajada|skyr'), label: 'lácteo natural', points: 1 },
  { re: word('avena|integral|quinoa|centeno|copos de avena|muesli sin azucar'), label: 'cereal integral', points: 1 },
  { re: word('nuez|nueces|almendra|avellana|pistacho|anacardo|cacahuete|frutos secos|pipas|chia|lino|aceite de oliva|aove|tofu|tempeh|seitan'), label: 'frutos secos y aceite de oliva', points: 1 },
  { re: word('refresco|cola|coca-cola|coca cola|fanta|sprite|pepsi|tonica|gaseosa|energetica|isotonic[ao]|horchata|nestea|aquarius|monster|redbull|red bull'), label: 'bebida azucarada', points: -2, overrides: true },
  {
    re: word('bolleria|croissant|donut|dona|napolitana|palmera|magdalena|bizcocho|galleta|helado|chuche|golosina|caramelo|gominola|chocolatina|barrita|tarta|pastel|flan|natilla|churro|gofre|mermelada|nutella|nocilla|cereales de desayuno|turron|polvoron|dulce|chocolate con leche|bombon|brownie|cookie|bunuelo(?!s? de (?:bacalao|queso|bacalhau|marisco|gambas|merluza))|torrija|rosquilla|roscon|pestino|mantecado|mazapan|sobao|berlina|cruasan|tiramisu|profiterol|eclair|crema catalana|panna cotta'),
    label: 'bollería y dulce',
    points: -2,
    overrides: true,
  },
  { re: word('patatas fritas|patatas chips|ganchitos|doritos|nachos|cheetos|pringles|snack|chips|palomitas(?! (?:al natural|naturales|sin aceite|sin mantequilla|al aire))'), label: 'snack o fritura', points: -2, overrides: true },
  { re: word('zumo|jugo|batido|smoothie'), label: 'zumo o batido', points: -1, overrides: true },
  { re: word('cerveza|vino|sangria|licor|cubata|whisky|ginebra|vodka|ron|champan|cava|vermut|alcohol|tinto de verano'), label: 'alcohol', points: -2, overrides: true },
  { re: word('frito|frita|empanado|empanada|rebozado|rebozada|croqueta|nugget|tempura|alitas|patatas bravas|calamares a la romana'), label: 'fritura', points: -1 },
  { re: word('embutido|chorizo|salchicha|salchichon|bacon|panceta|fiambre|mortadela|jamon york|morcilla|longaniza|sobrasada|foie|pate'), label: 'embutido', points: -1 },
  { re: word('hamburguesa|big mac|whopper|mcdonald|burger|kebab|pizza|perrito caliente|hot dog|taco bell|kfc|mcmenu'), label: 'comida rápida', points: -1 },
];

/** Cuántos puntos de «saludable» da el nombre (de −2 a +2) y a qué grupo se parece. */
export function classifyName(name: string): { points: number; label: string | null } {
  const text = plain(name);
  const hits = NAME_RULES.filter((rule) => rule.re.test(text));
  if (hits.length === 0) return { points: 0, label: null };
  const overriding = hits.filter((rule) => rule.overrides);
  if (overriding.length > 0) {
    const worst = overriding.reduce((a, b) => (b.points < a.points ? b : a));
    return { points: worst.points, label: worst.label };
  }
  const total = clamp(hits.reduce((sum, rule) => sum + rule.points, 0), -2, 2);
  // El grupo que se dice es el que más pesa en el sentido del resultado: con un resultado neutro o malo, lo malo («pollo empanado»: fritura).
  const pick = hits.reduce((a, b) => (total > 0 ? (b.points > a.points ? b : a) : b.points < a.points ? b : a));
  return { points: total, label: pick.label };
}

/** Se bebe (su cantidad es en mililitros): ahí la densidad por 100 g no sirve para decir si llena. */
const DRINK = word('refresco|cola|coca-cola|coca cola|fanta|sprite|pepsi|tonica|gaseosa|zumo|jugo|batido|smoothie|cerveza|vino|sangria|licor|cubata|whisky|ginebra|vodka|champan|cava|vermut|bebida|isotonic[ao]|energetica|horchata|mosto|leche|cafe|capuchino|latte|infusion|kefir|agua|caldo');
/** Los azúcares de la fruta, la verdura y los lácteos naturales no son azúcares añadidos: no se penalizan. */
const NATURAL_SUGAR = word('fruta|manzana|pera|platano|banana|naranja|mandarina|fresa|uva|sandia|melon|pina|kiwi|melocoton|albaricoque|cereza|ciruela|mango|papaya|arandano|frambuesa|higo|granada|pomelo|verdura|ensalada|tomate|zanahoria|remolacha|leche|yogur natural|yogur griego|kefir|queso|datil|pasa');

// ── Umbrales ──
/** Densidad energética (kcal por 100 g): baja por debajo de 125 y alta por encima de 225 (WCRF); por encima de 400 es de alimentos casi sin agua (aceites, bollería, frutos secos, snacks). */
const VERY_HIGH_DENSITY = 400;
/** Densidad proteica (g de proteína por 100 kcal): alta desde 7,5 (el 30 % de la energía), media desde 4 (el 16 %). */
const PROTEIN_HIGH = 7.5;
const PROTEIN_MEDIUM = 4;
/** Sal de una comida (parte del máximo diario) desde la que es «mucha» y desde la que es «muchísima». */
const SALT_MANY = 0.3;
const SALT_LOTS = 0.5;
const SALT_SOME = 0.15;
/** Azúcares de una comida (parte del 10 % de la energía del día, que es el tope de la OMS para los azúcares libres) desde la que son «muchos», «muchísimos» y «algunos»; y la parte de las calorías de la comida que deben ser azúcar para contar como muchos. */
const SUGAR_MANY = 0.35;
const SUGAR_LOTS = 0.6;
const SUGAR_SOME = 0.2;
const SUGAR_ENERGY_SHARE = 0.2;
/** Fibra (g por 100 kcal): 1,4 g por 100 kcal son los 14 g por 1000 kcal que recomienda la EFSA; desde 1,2 se cuenta como «con fibra». */
const FIBER_RICH = 1.2;

interface Scored {
  criterion: Criterion;
  /** Lo que suma o resta a la nota de la comida con el objetivo elegido. */
  points: number;
}

type Density = 'low' | 'medium' | 'high' | 'very-high';

function densityOf(kcalPer100g: number | null): Density | null {
  if (kcalPer100g === null) return null;
  return kcalPer100g < LOW_DENSITY ? 'low' : kcalPer100g > VERY_HIGH_DENSITY ? 'very-high' : kcalPer100g > HIGH_DENSITY ? 'high' : 'medium';
}

/** 1) La densidad calórica: pocas calorías por gramo llenan más y dejan margen; muchas cunden pero se pasan rápido. Para ganar peso, lo que cuenta es lo que aporta la comida. */
function energyCriterion(meal: MealNutrients, f: MealFacts, goal: HealthGoal, drink: boolean): Scored {
  const label = 'Densidad calórica';
  const density = densityOf(f.kcalPer100g);
  // Ganar peso: las calorías absolutas de la toma (con o sin saber lo que pesa).
  const gainPoints = meal.kcal >= 500 ? 2 : meal.kcal >= 300 ? 1 : meal.kcal < 150 ? -1 : 0;
  if (f.kcalPer100g === null || density === null) {
    return { criterion: { key: 'energy', label, rating: 'unknown', value: '—', detail: 'sin la cantidad' }, points: goal === 'gain' ? gainPoints : 0 };
  }
  if (drink) {
    // Lo que se bebe no se compara con la comida sólida: calorías líquidas, que sacian poco.
    const sweet = f.kcalPer100g >= 30;
    return {
      criterion: { key: 'energy', label, rating: sweet && goal !== 'gain' ? 'bad' : 'ok', value: 'Bebida', detail: `${f.kcalPer100g} kcal por 100 ml` },
      points: goal === 'gain' ? gainPoints : 0,
    };
  }
  const value = density === 'low' ? 'Baja' : density === 'medium' ? 'Media' : density === 'high' ? 'Alta' : 'Muy alta';
  let rating: Rating;
  let points: number;
  if (goal === 'lose' || goal === 'define') {
    rating = density === 'low' ? 'good' : density === 'medium' ? 'ok' : 'bad';
    points = density === 'low' ? 1 : density === 'medium' ? 0 : density === 'high' ? -1 : -2;
  } else if (goal === 'gain') {
    rating = density === 'high' || density === 'very-high' ? 'good' : 'ok';
    points = gainPoints;
  } else {
    rating = density === 'low' ? 'good' : density === 'very-high' ? 'bad' : 'ok';
    points = density === 'very-high' ? -1 : 0;
  }
  return { criterion: { key: 'energy', label, rating, value, detail: `${f.kcalPer100g} kcal por 100 g` }, points };
}

/** 2) La densidad proteica: gramos de proteína por cada 100 kcal. Para ganar músculo cuentan además los gramos de la toma (unos 25–40 g estimulan la síntesis muscular). */
function proteinCriterion(f: MealFacts, goal: HealthGoal): Scored {
  const label = 'Densidad proteica';
  const per = f.proteinPer100kcal;
  const grams = f.indicators[0]?.grams ?? 0;
  if (per === null) return { criterion: { key: 'protein', label, rating: 'unknown', value: '—', detail: null }, points: 0 };
  const value = per >= PROTEIN_HIGH ? 'Alta' : per >= PROTEIN_MEDIUM ? 'Media' : 'Baja';
  const detail = `${g(grams)} · ${num(per)}\u00a0g por 100 kcal`;
  let rating: Rating;
  let points = 0;
  if (goal === 'lose' || goal === 'define') {
    // En déficit la proteína sacia y protege el músculo (1,6–2,4 g/kg al día: Morton 2018, Helms 2014): es lo que más pesa.
    rating = per >= PROTEIN_HIGH ? 'good' : per < PROTEIN_MEDIUM ? 'bad' : 'ok';
    points = per >= 10 ? 3 : per >= PROTEIN_HIGH ? 2 : per >= 5 ? 1 : per < PROTEIN_MEDIUM ? -1 : 0;
  } else if (goal === 'maintain') {
    rating = per >= 8 ? 'good' : per < 2.5 ? 'bad' : 'ok';
    points = per >= 8 ? 2 : per >= PROTEIN_MEDIUM ? 1 : per < 2.5 ? -1 : 0;
  } else if (goal === 'muscle') {
    rating = grams >= 25 || (grams >= 15 && per >= PROTEIN_HIGH) ? 'good' : grams < 10 ? 'bad' : 'ok';
    points = grams >= 25 ? 2 : grams >= 15 ? 1 : grams < 10 ? -2 : 0;
  } else {
    rating = per >= PROTEIN_MEDIUM ? 'good' : 'ok';
    points = per >= PROTEIN_MEDIUM ? 1 : 0;
  }
  return { criterion: { key: 'protein', label, rating, value, detail }, points };
}

type Level3 = 'none' | 'some' | 'many' | 'lots';

interface SaltSugar {
  salt: Level3 | null;
  sugar: Level3 | null;
}

/** 3) Sal y azúcar: la sal frente al máximo diario (5 g) y los azúcares frente al 10 % de las calorías del día (OMS), sin contar los de la fruta ni los lácteos naturales. */
function saltSugarOf(meal: MealNutrients, name: string, targets: NutritionTargets): SaltSugar {
  let salt: Level3 | null = null;
  if (meal.saltG !== undefined && targets.saltG > 0) {
    const share = meal.saltG / SALT_LIMIT_G;
    salt = share >= SALT_LOTS ? 'lots' : share >= SALT_MANY ? 'many' : share >= SALT_SOME ? 'some' : 'none';
  }
  let sugar: Level3 | null = null;
  if (meal.sugarsG !== undefined) {
    const natural = NATURAL_SUGAR.test(name) && !classifyNameHasOverride(name);
    const limit = (Math.max(1, targets.kcal) * 0.1) / 4;
    const share = meal.sugarsG / limit;
    const ofEnergy = meal.kcal > 0 ? (meal.sugarsG * 4) / meal.kcal : 0;
    if (natural) sugar = share >= SUGAR_SOME ? 'some' : 'none';
    else if (share >= SUGAR_LOTS && ofEnergy >= SUGAR_ENERGY_SHARE) sugar = 'lots';
    else if (share >= SUGAR_MANY && ofEnergy >= SUGAR_ENERGY_SHARE) sugar = 'many';
    else sugar = share >= SUGAR_SOME ? 'some' : 'none';
  }
  return { salt, sugar };
}

const classifyNameHasOverride = (name: string): boolean => NAME_RULES.some((rule) => rule.overrides === true && rule.re.test(plain(name)));

const levelPoints: Record<Level3, number> = { none: 0, some: 0, many: -1, lots: -2 };

function excessCriterion(meal: MealNutrients, found: SaltSugar): Scored {
  const label = 'Sal y azúcar';
  const { salt, sugar } = found;
  if (salt === null && sugar === null) return { criterion: { key: 'excess', label, rating: 'unknown', value: '—', detail: 'sin datos' }, points: 0 };
  const parts = [meal.saltG !== undefined && `sal ${g(meal.saltG)}`, meal.sugarsG !== undefined && `azúcares ${g(meal.sugarsG)}`].filter(Boolean).join(' · ');
  const manySalt = salt === 'many' || salt === 'lots';
  const manySugar = sugar === 'many' || sugar === 'lots';
  const points = Math.max(-3, levelPoints[salt ?? 'none'] + levelPoints[sugar ?? 'none']);
  if (manySalt || manySugar) {
    const value = manySalt && manySugar ? 'Mucha sal y azúcar' : manySalt ? (salt === 'lots' ? 'Muchísima sal' : 'Mucha sal') : sugar === 'lots' ? 'Muchísimo azúcar' : 'Mucho azúcar';
    return { criterion: { key: 'excess', label, rating: 'bad', value, detail: parts }, points };
  }
  const some = salt === 'some' || sugar === 'some';
  return { criterion: { key: 'excess', label, rating: some ? 'ok' : 'good', value: some ? 'Moderado' : 'Bajo', detail: parts }, points };
}

/** 4) La saciedad: sacia lo que lleva proteína y fibra y pesa mucho para pocas calorías; sacia poco lo líquido, lo denso y lo azucarado. */
function satietyCriterion(meal: MealNutrients, f: MealFacts, goal: HealthGoal, drink: boolean, sugarMany: boolean): Scored {
  const label = 'Saciedad';
  const per = f.proteinPer100kcal ?? 0;
  const density = densityOf(f.kcalPer100g);
  let score = 0;
  const why: string[] = [];
  if (per >= PROTEIN_HIGH) {
    score++;
    why.push('mucha proteína');
  } else if (per < 2.5) {
    score--;
    why.push('poca proteína');
  }
  if (meal.fiberG !== undefined && meal.kcal > 0 && (meal.fiberG / meal.kcal) * 100 >= FIBER_RICH) {
    score++;
    why.push('con fibra');
  }
  if (drink) {
    if (per < PROTEIN_HIGH) {
      score--;
      why.push('es líquida');
    }
  } else if (density === 'low') {
    score++;
    why.push('ligera');
  } else if (density === 'high' || density === 'very-high') {
    score--;
    why.push('densa');
  }
  if (sugarMany) {
    score--;
    why.push('azúcares rápidos');
  }
  const rating: Rating = score >= 2 ? 'good' : score >= 0 ? 'ok' : 'bad';
  const value = score >= 2 ? 'Alta' : score >= 0 ? 'Media' : 'Baja';
  // Solo para perder peso y definir importa llenarse: con saciedad alta se suma y con baja se resta.
  const points = goal === 'lose' || goal === 'define' ? (score >= 2 ? 1 : score < 0 ? -1 : 0) : 0;
  return { criterion: { key: 'satiety', label, rating, value, detail: why.length > 0 ? why.slice(0, 2).join(' · ') : null }, points };
}

/** Lo que no se ve en los números y el nombre sí delata: embutido (nitritos y sal escondida), fritura y comida rápida (grasas transformadas), alcohol. Resta un punto. */
const HIDDEN_HARM = new Set(['alcohol', 'embutido', 'fritura', 'comida rápida', 'snack o fritura']);
/** Lo bueno que los números no ven: grasas insaturadas y omega-3 (pescado, frutos secos, aceite de oliva) y el grano entero. Suma un punto si la nota no es ya alta. */
const HIDDEN_GOOD = new Set(['pescado y marisco', 'frutos secos y aceite de oliva', 'cereal integral']);
/** Grasa «buena» o «mala» por el nombre, para saber qué parte de la grasa total es saturada. */
const HEALTHY_FAT = new Set(['pescado y marisco', 'frutos secos y aceite de oliva']);
const SATURATED_NAME = word('queso(?! fresco)|mantequilla|nata|panceta|bacon|chorizo|salchicha|sobrasada|foie|pate|morcilla|manteca|croissant|croissants|cruasan|bolleria|donut|helado|chocolate');
const SATURATED_LABEL = new Set(['embutido', 'bollería y dulce', 'snack o fritura', 'fritura', 'comida rápida', 'bebida azucarada']);
/** Bebidas que llevan proteína y grasa de verdad: se puntúan como un alimento y no con la escala de las bebidas. */
const MILKY = word('leche|kefir|bebida de soja|bebida de avena|bebida de almendra|bebida vegetal|batido de proteinas|yogur para beber');

/** El tipo de alimento tal como se dice en la fila «Saludable»: sin la palabra «azúcar», que ya tiene la suya. */
const groupText = (label: string | null): string | null => (label === 'bebida azucarada' ? 'refresco' : label);

/**
 * 5) Si es saludable: lo dicen sus NÚMEROS (el perfil tipo Nutri-Score por 100 g: energía, azúcares, grasa, sal, proteína, fibra y planta; `nutrient-profile.ts`) y, solo como pista de lo que
 * los números no ven, el nombre (embutido, fritura o alcohol restan un punto; pescado, frutos secos o grano entero suman uno). Sin saber cuánto pesaba la comida no hay «por 100 g» y se
 * cae a la heurística de siempre por el nombre, con la fibra a favor y la sal, los azúcares y la densidad en contra.
 */
function healthCriterion(meal: MealNutrients, f: MealFacts, drink: boolean): Scored {
  const label = 'Saludable';
  const name = plain(meal.name ?? '');
  const kind = classifyName(meal.name ?? '');
  const milky = MILKY.test(name);
  const weight = meal.grams !== undefined && meal.grams >= 20 ? meal.grams : null;
  let profile: NutrientProfile | null = null;
  if (weight !== null && f.hasMacros) {
    if (drink && !milky) {
      profile = drinkProfile({ kcal: meal.kcal, grams: weight, sugarsG: meal.sugarsG, fiberG: meal.fiberG });
      if (profile !== null && kind.label === 'alcohol') profile = { ...profile, points: -2, corePoints: -2, grade: 'E', bad: ['alcohol'], good: [], notable: ['alcohol'] };
      // Un zumo o un batido no es un refresco: sus azúcares vienen con vitaminas y, a veces, fibra.
      else if (profile !== null && kind.label === 'zumo o batido') profile = { ...profile, points: Math.max(profile.points, -1), corePoints: Math.max(profile.corePoints, -1) };
    } else {
      // Si el nombre habla de plantas: «casi todo planta» solo si la comida es tan ligera como una planta (hasta 130 kcal/100 g; 200 las legumbres); más densa, la planta es solo una parte.
      const plantName = kind.label === 'fruta y verdura' || kind.label === 'legumbre';
      const density = (meal.kcal / weight) * 100;
      const produce: Produce = !plantName ? 'none' : density <= (kind.label === 'legumbre' ? 200 : 130) ? 'mostly' : density <= 250 ? 'some' : 'none';
      const fatKind: FatKind = kind.label !== null && HEALTHY_FAT.has(kind.label) ? 'healthy' : (kind.label !== null && SATURATED_LABEL.has(kind.label)) || SATURATED_NAME.test(name) ? 'saturated' : 'usual';
      profile = nutrientProfile({
        kcal: meal.kcal,
        grams: weight,
        proteinG: meal.proteinG ?? 0,
        fatG: meal.fatG ?? 0,
        fiberG: meal.fiberG,
        sugarsG: meal.sugarsG,
        saltG: meal.saltG,
        produce,
        fatKind,
        drink,
        naturalSugar: NATURAL_SUGAR.test(name) && !classifyNameHasOverride(name),
      });
    }
  }
  if (profile === null) return healthFromName(meal);

  const plant = (kind.label === 'fruta y verdura' || kind.label === 'legumbre') && profile.good.length >= 0 && meal.grams !== undefined && (meal.kcal / meal.grams) * 100 <= (kind.label === 'legumbre' ? 200 : 130);
  const hidden = kind.label !== null && HIDDEN_HARM.has(kind.label) ? -1 : kind.label !== null && HIDDEN_GOOD.has(kind.label) ? 1 : 0;
  const lift = (points: number): number => {
    const adjusted = hidden < 0 ? points + hidden : hidden > 0 && points < 2 ? points + 1 : points;
    // Sin sal o azúcares anotados, ni el nombre sube la nota por encima de «saludable».
    return clamp(profile.partial && !plant ? Math.min(adjusted, 1) : adjusted, -2, 2);
  };
  const total = lift(profile.points);
  const value = total >= 2 ? 'Muy saludable' : total === 1 ? 'Saludable' : total === 0 ? 'Normal' : total === -1 ? 'Poco saludable' : 'Nada saludable';
  const rating: Rating = total >= 1 ? 'good' : total === 0 ? 'ok' : 'bad';
  // Lo que se dice aquí es solo lo que las otras filas NO dicen: de qué tipo de alimento es, la fibra y la calidad de la grasa. La sal, los azúcares, la proteína y la densidad ya tienen
  // su fila (y entran en esta nota por el perfil), así que no se repiten ni, de paso, se contradicen («Saludable» al lado de «mucha sal»).
  const groupWord = hidden !== 0 || kind.points > 0 ? groupText(kind.label) : null;
  const fatWord = profile.bad.includes('mucha grasa') ? 'grasa saturada' : kind.label !== null && HEALTHY_FAT.has(kind.label) && !drink ? 'grasa de buena calidad' : null;
  const fiberWord = profile.good.includes('con fibra') ? 'con fibra' : profile.bad.includes('sin fibra') ? 'sin fibra' : null;
  const lead = total >= 1 ? [groupWord, fiberWord === 'con fibra' ? fiberWord : null, fatWord === 'grasa de buena calidad' ? fatWord : null] : total <= -1 ? [groupWord, fatWord === 'grasa saturada' ? fatWord : null, fiberWord === 'sin fibra' ? fiberWord : null] : [groupWord, fiberWord, fatWord];
  const why = [...new Set(lead.filter((x): x is string => x !== null))].slice(0, 2);
  return { criterion: { key: 'health', label, rating, value, detail: why.length > 0 ? why.join(' · ') : null }, points: lift(profile.corePoints) };
}

/** Sin saber lo que pesa la comida: la heurística de siempre, por el grupo del nombre y con la fibra a favor. La sal, los azúcares y la densidad no se miran aquí: tienen su propia fila. */
function healthFromName(meal: MealNutrients): Scored {
  const label = 'Saludable';
  const kind = classifyName(meal.name ?? '');
  const rich = meal.fiberG !== undefined && meal.kcal > 0 && (meal.fiberG / meal.kcal) * 100 >= FIBER_RICH;
  const base = clamp(kind.points + (rich ? 1 : 0), -2, 2);
  const total = base;
  const value = total >= 2 ? 'Muy saludable' : total === 1 ? 'Saludable' : total === 0 ? 'Normal' : total >= -2 ? 'Poco saludable' : 'Nada saludable';
  const rating: Rating = total >= 1 ? 'good' : total === 0 ? 'ok' : 'bad';
  const why = [groupText(kind.label), rich ? 'con fibra' : null].filter((x): x is string => x !== null).slice(0, 2);
  return { criterion: { key: 'health', label, rating, value, detail: why.length > 0 ? why.join(' · ') : null }, points: base };
}

/**
 * Cuánto encaja una comida con el objetivo de salud, y los cinco criterios que lo explican (cada uno con su nota). Cada criterio suma o resta según lo que busca la persona:
 * perder peso y definir premian la proteína, lo ligero y lo que sacia; mantener, que no falte proteína; ganar músculo, los gramos de proteína de la toma; ganar peso, las calorías
 * que aporta. Para todos cuentan la sal y el azúcar, y si es un alimento saludable. Se suma: a partir de 4 puntos «muy buena», de 2 a 3 «buena», de −1 a 1 «normal» y de −2 para abajo
 * «poco adecuada». Con solo las calorías anotadas no se puede valorar y se dice.
 */
export function mealFit(meal: MealNutrients, goal: HealthGoal, targets: NutritionTargets): MealFit {
  const facts = mealFacts(meal, targets);
  const label = HEALTH_GOALS[goal].label;
  const empty = { energy: 0, protein: 0, excess: 0, satiety: 0, health: 0 };
  if (!facts.hasMacros || meal.kcal <= 0) {
    return { level: 'unknown', headline: 'Sin datos para valorarla', criteria: [], note: 'Solo se anotaron las calorías: no se sabe qué lleva.', points: empty };
  }
  const name = plain(meal.name ?? '');
  const drink = DRINK.test(name);
  const found = saltSugarOf(meal, name, targets);
  const sugarMany = found.sugar === 'many' || found.sugar === 'lots';
  const parts = [
    energyCriterion(meal, facts, goal, drink),
    proteinCriterion(facts, goal),
    excessCriterion(meal, found),
    satietyCriterion(meal, facts, goal, drink, sugarMany),
    healthCriterion(meal, facts, drink),
  ];
  // Una sola comida que se come medio día (más de la mitad de las calorías) pesa en cualquier objetivo menos en ganar peso.
  const big = facts.kcalDayShare > 0.5 && goal !== 'gain';
  const total = parts.reduce((sum, part) => sum + part.points, 0) - (big ? 1 : 0);
  const level: Exclude<FitLevel, 'unknown'> = total >= 4 ? 'great' : total >= 2 ? 'good' : total >= -1 ? 'fair' : 'poor';
  return {
    level,
    headline: `${LEVEL_WORD[level]} para ${label.toLowerCase()}`,
    criteria: parts.map((part) => part.criterion),
    note: big ? 'Más de la mitad de las calorías de tu día.' : null,
    points: { energy: parts[0]!.points, protein: parts[1]!.points, excess: parts[2]!.points, satiety: parts[3]!.points, health: parts[4]!.points },
  };
}
