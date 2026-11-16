// El perfil nutricional de un alimento por 100 g (o 100 ml): lo que dicen sus números, no su nombre. Sigue el esquema del Nutri-Score (Santé publique France, versión de 2017 con los
// umbrales de 2023 donde mejoran la proteína): suma puntos «malos» por la energía, los azúcares, la grasa saturada y la sal, resta puntos «buenos» por la proteína, la fibra y la fruta,
// verdura o legumbre, y la letra sale de la diferencia. docs/estimaciones.md → «Hoja de detalles de una comida» explica de dónde sale cada cifra y qué se aproxima.
//
// Lo que NO se tiene: la grasa saturada (solo la grasa total; se estima con una parte típica según el grupo del alimento) y el porcentaje de fruta, verdura y legumbre (solo se sabe
// si el nombre habla de ellas). Por eso el nombre entra aquí solo como PISTA de lo que los números no ven, nunca como veredicto.

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';
export type Produce = 'none' | 'some' | 'mostly';

/** La parte de la grasa total que se supone saturada, según lo que se sabe del alimento por su nombre. */
export type FatKind = 'healthy' | 'usual' | 'saturated';

const SAT_SHARE: Record<FatKind, number> = {
  // Aceite de oliva, frutos secos, pescado azul, aguacate: casi toda insaturada.
  healthy: 0.15,
  usual: 0.35,
  // Embutido, queso, bollería, fritura, comida rápida, mantequilla: mucha saturada (y transformada).
  saturated: 0.5,
};

export interface ProfileInput {
  kcal: number;
  /** Gramos (o mililitros) de la comida: hace falta saberlos para pasar a «por 100 g». */
  grams: number;
  proteinG: number;
  fatG: number;
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
  /** Cuánto de planta (fruta, verdura, legumbre) se supone: «mostly» si el nombre habla de ella y la comida es ligera como una planta; «some» si el nombre la nombra pero la comida es más densa (un plato con tomate); «none» si no. */
  produce: Produce;
  fatKind: FatKind;
  /** Lleva nombre de bebida (se puntúa con otra escala). */
  drink: boolean;
  /** Los azúcares son de la leche, la fruta o la verdura (no añadidos): no puntúan en contra. */
  naturalSugar: boolean;
}

export interface NutrientProfile {
  /** Nota con todo (energía, azúcares, grasa, sal, proteína, fibra, planta): de −2 (muy mala) a +2 (muy buena). */
  points: number;
  /** La misma nota sin los azúcares ni la sal: para sumarla a la valoración sin contarlos dos veces, porque «Sal y azúcar» ya puntúa por su cuenta. */
  corePoints: number;
  grade: Grade;
  /** Faltan la sal o los azúcares: no se puede asegurar que esté bien, y la nota no pasa de «buena». */
  partial: boolean;
  /** Lo bueno y lo malo que más pesa, de más a menos, con palabras cortas («mucha proteína», «mucho azúcar»). */
  good: string[];
  bad: string[];
  /** Lo bueno y lo malo juntos, de lo que más pesa a lo que menos: para contar una nota «normal» (ni buena ni mala) con lo que más destaca. */
  notable: string[];
}

const count = (value: number, thresholds: readonly number[]): number => thresholds.filter((limit) => value > limit).length;

// Umbrales por 100 g del Nutri-Score (cada umbral superado suma un punto).
const ENERGY_KJ = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350] as const;
const SUGARS = [4.5, 9, 13.5, 18, 22.5, 27, 31, 36, 40, 45] as const;
const SATURATED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const SALT = [0.225, 0.45, 0.675, 0.9, 1.125, 1.35, 1.575, 1.8, 2.025, 2.25] as const;
const PROTEIN = [2.4, 4.8, 7.2, 9.6, 12, 14, 17] as const;
const FIBER = [0.9, 1.9, 2.8, 3.7, 4.7] as const;
/** Los puntos de «planta»: más del 40 % del plato da 1, más del 60 % 2 y más del 80 % 5. «Casi todo planta» se toma como 3 (el término medio) y «algo» como 1. */
const PRODUCE_POINTS: Record<Produce, number> = { none: 0, some: 1, mostly: 3 };

const GRADES: readonly Grade[] = ['A', 'B', 'C', 'D', 'E'];
const POINTS: Record<Grade, number> = { A: 2, B: 1, C: 0, D: -1, E: -2 };

/** La letra: A hasta −1, B de 0 a 2, C de 3 a 10, D de 11 a 18 y E desde 19. */
export function gradeOf(score: number): Grade {
  return GRADES[score <= -1 ? 0 : score <= 2 ? 1 : score <= 10 ? 2 : score <= 18 ? 3 : 4]!;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * El perfil de un alimento sólido o de una bebida con leche. `null` si no se sabe cuánto pesaba (a partir de 20 g): sin eso no hay «por 100 g». Con una bebida corriente (agua, refresco, zumo…)
 * se usa {@link drinkProfile}.
 */
export function nutrientProfile(input: ProfileInput): NutrientProfile | null {
  if (input.grams < 20 || input.kcal < 0) return null;
  const k = 100 / input.grams;
  const kj = input.kcal * k * 4.184;
  const sugarKnown = input.sugarsG !== undefined;
  const saltKnown = input.saltG !== undefined;
  const sugars = (input.sugarsG ?? 0) * k;
  const salt = (input.saltG ?? 0) * k;
  const fiber = (input.fiberG ?? 0) * k;
  const protein = input.proteinG * k;
  const fat = input.fatG * k;
  const satFat = fat * SAT_SHARE[input.fatKind];

  const energyPts = count(kj, ENERGY_KJ);
  // Los azúcares de la leche, la fruta o la verdura no son añadidos: puntúan la mitad (la fruta con su fibra y la leche con su proteína compensan el resto).
  const sugarPts = input.naturalSugar ? Math.floor(count(sugars, SUGARS) / 2) : count(sugars, SUGARS);
  // Los aceites, los frutos secos y el pescado azul puntúan por la PROPORCIÓN de saturada en su grasa (la del Nutri-Score para los aceites), no por los gramos: tanta grasa buena no es mala.
  const fatPts = input.fatKind === 'healthy' ? count(fat > 0 ? (satFat / fat) * 100 : 0, [10, 16, 22, 28, 34, 40, 46, 52, 58, 64]) : count(satFat, SATURATED);
  const saltPts = count(salt, SALT);
  const proteinPts = count(protein, PROTEIN);
  const fiberPts = count(fiber, FIBER);
  const producePts = PRODUCE_POINTS[input.produce];

  const scoreOf = (negative: number): number => {
    const positive = proteinPts + fiberPts + producePts;
    // Con muchos puntos malos (11 o más) la proteína no compensa, salvo si el alimento es sobre todo planta: así un embutido o un bollo proteico no se salva por su proteína.
    if (negative >= 11 && producePts < 5) return negative - (fiberPts + producePts);
    return negative - positive;
  };
  const full = scoreOf(energyPts + sugarPts + fatPts + saltPts);
  const core = scoreOf(energyPts + fatPts);
  const grade = gradeOf(full);
  const partial = !saltKnown || !sugarKnown;
  // Sin la sal o los azúcares no se puede asegurar que sea buena: como mucho «buena», y solo «muy buena» con todo anotado. Una planta (fruta, verdura, legumbre) sí es segura sin ellos.
  const cap = (points: number): number => (partial && input.produce !== 'mostly' ? Math.min(points, 1) : points);

  const good: Array<[number, string]> = [];
  const bad: Array<[number, string]> = [];
  if (proteinPts >= 5) good.push([proteinPts, 'mucha proteína']);
  else if (proteinPts >= 3) good.push([proteinPts - 1, 'buena proteína']);
  if (fiber >= 2.8) good.push([fiberPts + 1, 'con fibra']);
  if (energyPts <= 1 && !input.drink) good.push([2, 'ligera']);
  if (sugarKnown && sugars < 1.5 && !input.naturalSugar && sugarPts === 0 && energyPts >= 2) good.push([2, 'sin azúcares']);
  if (saltKnown && saltPts === 0 && energyPts >= 2) good.push([1, 'poca sal']);
  if (sugarPts >= 3 && !input.naturalSugar) bad.push([sugarPts + 1, sugarPts >= 5 ? 'mucho azúcar' : 'bastante azúcar']);
  if (saltPts >= 3) bad.push([saltPts, saltPts >= 5 ? 'mucha sal' : 'bastante sal']);
  if (fatPts >= 4) bad.push([fatPts, 'mucha grasa']);
  if (energyPts >= 7) bad.push([energyPts - 1, 'muy densa']);
  if (fiber < 1 && energyPts >= 5 && input.fiberG !== undefined) bad.push([energyPts - 3, 'sin fibra']);
  const order = (list: Array<[number, string]>): string[] => [...list].sort((a, b) => b[0] - a[0]).map((entry) => entry[1]);

  return {
    points: cap(POINTS[grade]),
    corePoints: cap(POINTS[gradeOf(core)]),
    grade,
    partial,
    good: order(good),
    bad: order(bad),
    notable: order([...good, ...bad]),
  };
}

/**
 * El perfil de una bebida corriente (agua, café, refresco, zumo, cerveza…): por 100 ml, lo que cuenta son los azúcares y las calorías. Sin saber cuánto se bebió (a partir de 20 ml) no hay
 * perfil. El alcohol no se ve en los números (solo en el nombre) y lo pone a «mala» el que llama.
 */
export function drinkProfile(input: Pick<ProfileInput, 'kcal' | 'grams' | 'sugarsG' | 'fiberG'>): NutrientProfile | null {
  if (input.grams < 20) return null;
  const k = 100 / input.grams;
  const kcal = input.kcal * k;
  const sugars = input.sugarsG === undefined ? null : input.sugarsG * k;
  // Agua, infusión o café solo: casi sin calorías. Con azúcares conocidos o, si no, con las calorías.
  const sweet = sugars ?? kcal / 4;
  let points: number;
  if (kcal < 5) points = 2;
  else if (sweet < 1) points = 1;
  else if (sweet < 2.5) points = 0;
  else if (sweet < 6) points = -1;
  else points = -2;
  const grade: Grade = points === 2 ? 'A' : points === 1 ? 'B' : points === 0 ? 'C' : points === -1 ? 'D' : 'E';
  const good: string[] = kcal < 5 ? ['sin calorías'] : sweet < 2.5 ? ['poco azúcar'] : [];
  const bad: string[] = sweet >= 6 ? ['mucho azúcar'] : sweet >= 2.5 ? ['bastante azúcar'] : [];
  const shown = round1(sweet) >= 2.5 ? bad : [];
  return { points, corePoints: points, grade, partial: sugars === null, good, bad: shown, notable: [...good, ...shown] };
}
