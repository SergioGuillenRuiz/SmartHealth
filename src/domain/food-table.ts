// La tabla de alimentos (`src/data/foods/alimentos.txt`) leída a datos. El formato y lo que significa cada cifra están explicados en
// el propio archivo; aquí solo se lee y se comprueba cada línea (un error de escritura no puede acabar siendo un dato silencioso).

/** Las medidas caseras que se entienden: para cada alimento, cuántos gramos (o ml) son. */
export const MEASURES = [
  'vaso',
  'taza',
  'copa',
  'cana',
  'botellin',
  'lata',
  'botella',
  'brick',
  'jarra',
  'chupito',
  'bol',
  'cucharada',
  'cucharadita',
  'cucharon',
  'punado',
  'loncha',
  'rebanada',
  'rodaja',
  'trozo',
  'porcion',
  'plato',
  'onza',
  'sobre',
  'terron',
  'cazo',
  'chorrito',
  'bola',
  'filete',
  'bolsa',
  'dedo',
  'tarro',
  'tableta',
  'pizca',
  'racimo',
] as const;

export type Measure = (typeof MEASURES)[number];

const MEASURE_SET: ReadonlySet<string> = new Set(MEASURES);

/**
 * Los alimentos que cambian al cocinarlos de una forma u otra (`coc=` en la tabla). Las cifras de la línea son las del alimento ya
 * cocinado SIN grasa añadida (a la plancha o hervido); «frito», «empanado», «guisado»… suman lo que la cocina le añade
 * (ver `COOKING` en `food-text.ts`).
 */
export const COOK_CLASSES = ['carne', 'ave', 'pescado', 'azul', 'marisco', 'verdura', 'patata', 'seta'] as const;
export type CookClass = (typeof COOK_CLASSES)[number];
const COOK_SET: ReadonlySet<string> = new Set(COOK_CLASSES);

/**
 * Qué papel hace un alimento dentro de un plato (`rol=` en la tabla; los de `alimentos-bebidas*`, `-carnes`, `-pescados`, `-verduras`, `-frutas` y
 * `-salsas` lo traen por su archivo): decide a qué se pega cuando se nombra detrás de un plato («un kebab con cebolla y salsa blanca») y qué
 * ingrediente de ese plato sustituye. `proteina` es la carne o el pescado de un plato («de ternera»); `topping`, lo que se le añade encima (bacon,
 * jamón, huevo, atún) y nunca sustituye a nada. `bebida` y `guarnicion` solo se pegan a un menú que los tiene; `base` es el líquido en que se
 * prepara una bebida caliente («café con leche de avena»); `sabor` es lo que da el gusto a un helado, un yogur o un batido («de fresa»).
 */
export const FOOD_ROLES = ['bebida', 'base', 'proteina', 'topping', 'verdura', 'salsa', 'queso', 'guarnicion', 'sabor'] as const;
export type FoodRole = (typeof FOOD_ROLES)[number];
const ROLE_SET: ReadonlySet<string> = new Set(FOOD_ROLES);

/** El rol que traen por su archivo los alimentos que no dicen otro (por el nombre del archivo, sin el «.txt» ni lo que haya detrás de un segundo guion). */
const DEFAULT_ROLE_BY_FILE: Readonly<Record<string, FoodRole>> = {
  'alimentos-bebidas': 'bebida',
  'alimentos-carnes': 'proteina',
  'alimentos-pescados': 'proteina',
  'alimentos-verduras': 'verdura',
  'alimentos-frutas': 'sabor',
  'alimentos-salsas': 'salsa',
};

/** `alimentos-bebidas-marcas.txt` es de la familia `alimentos-bebidas`. */
function defaultRoleOf(file: string): FoodRole | null {
  const family = file.replace(/\.txt$/, '').split('-').slice(0, 2).join('-');
  return DEFAULT_ROLE_BY_FILE[family] ?? null;
}

/** Una pieza de un plato compuesto: qué alimento, cuánto (g, o ml si es un líquido) y, si es sustituible, de qué ingrediente es. */
export interface RecipePart {
  entry: FoodEntry;
  amount: number;
  /** Lo que se nombre con ese rol sustituye a esta pieza («kebab de pollo», «con cebolla»); `null`: va siempre. */
  slot: FoodRole | null;
}

export interface FoodEntry {
  name: string;
  /** Formas de decirlo, tal como están escritas (incluye el nombre). */
  aliases: readonly string[];
  /** Por cada 100 g (o 100 ml si es líquido). */
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Fibra, azúcares (parte de los hidratos) y sal por cada 100 g (o 100 ml). */
  fiberG: number;
  sugarsG: number;
  saltG: number;
  /** Se mide en mililitros (y pesa `density` g por ml). */
  liquid: boolean;
  density: number;
  /** Gramos de alcohol por cada 100 ml (ya contados en las calorías: solo sirve para comprobar la tabla). */
  alcoholG: number;
  /** Una ración habitual, en g (o ml). */
  serving: number;
  /** Lo que pesa una unidad natural («un huevo»), o `null`. */
  each: number | null;
  /** Lo que pesa cada medida casera, en g (o ml). */
  measures: Readonly<Partial<Record<Measure, number>>>;
  /** Se reconoce pero no suma (sal, ajo, limón…). */
  ignore: boolean;
  /** Cómo cambia al cocinarlo de otra forma («pollo frito», «verduras a la plancha»), o `null` si no se tiene en cuenta. */
  cook: CookClass | null;
  /** Es el pan o la masa que lleva algo dentro («un bocadillo de pavo y queso», «un wrap de pollo»): lo que se nombra después es relleno. */
  container: boolean;
  /** Lo que pesa entero («media tarta», «medio melón»): una fracción se calcula sobre esto, no sobre una ración. */
  whole: number | null;
  /** Cuánto se pone de este alimento cuando es relleno de un bocadillo, un sándwich o un wrap (g), o `null`: una ración pequeña. */
  filling: number | null;
  /** Su papel dentro de un plato, o `null` si no es un ingrediente («pizza», «café»). */
  role: FoodRole | null;
  /** Si es un plato compuesto (`= pieza + pieza…` en la tabla): sus piezas. Sus cifras salen de ellas. */
  recipe: readonly RecipePart[] | null;
  /** Es un menú (hamburguesa + patatas + bebida): «grande» o «mediano» cambia las patatas y la bebida, no la hamburguesa (`menu` en la tabla). */
  menu: boolean;
  /** Admite un sabor detrás («helado de fresa y vainilla», «yogur de melocotón», «mermelada de fresa»): el sabor no suma (`sabores` en la tabla). */
  flavored: boolean;
  /** Si al decir el sabor el alimento pasa a ser otro («yogur de fresa» no es el yogur natural): su nombre (`sabores=Yogur_de_sabores` en la tabla). */
  flavorTo: string | null;
  /** Puede ser el sabor de otro alimento («helado de piña») aunque tenga otro papel en los platos (`sabor` en la tabla; con el papel `sabor` ya lo es). */
  flavor: boolean;
  /** Se come por raciones («sushi», «maki», «dim sum»): sin decir cuántos, una ración entera y no una sola unidad (`conjunto` en la tabla). */
  bareServing: boolean;
  /** Es comida rápida (una hamburguesa, un kebab, un menú…): «con patatas» detrás son patatas fritas, no cocidas (`rapida` en la tabla). */
  fast: boolean;
  /** Lo que mide una unidad, en cm, si se pide por longitud («un sub de 30 cm»); `null` si no se pide así (`cm=` en la tabla). */
  lengthCm: number | null;
  /** En un plato compuesto: un peso dicho tras su nombre («una hamburguesa de 200 g») es el de la pieza con ese rol, no el del plato entero (`peso=proteina` en la tabla). */
  weightOf: FoodRole | null;
  /** En un plato compuesto: cuando se nombra tal alimento («de ternera»), se pone este otro («la torta de hamburguesa de ternera») (`como=` en la tabla). */
  like: ReadonlyMap<FoodEntry, FoodEntry> | null;
}

/** Las piezas de un plato compuesto tal como están escritas: se resuelven contra el resto de la tabla en `parseFoodTables`. */
interface RawRecipe {
  file: string;
  line: number;
  parts: Array<{ name: string; amount: number; slot: FoodRole | null }>;
  /** `como=Ternera:Torta_de_hamburguesa,…`: pares (lo que se nombra, lo que se pone); los guiones bajos son espacios. */
  like: Array<[string, string]>;
}

const foldName = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Lee la lista de piezas de un plato compuesto: «pan de kebab 100 + proteina:Carne de kebab 120 + verdura:Lechuga 25». Cada pieza es el nombre de un
 * alimento de la tabla y sus gramos (ml si es un líquido); un «rol:» delante la hace sustituible por lo que se nombre con ese rol.
 */
function parseRecipeParts(text: string, fail: (message: string) => never): RawRecipe['parts'] {
  return text
    .split(' + ')
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .map((piece) => {
      const match = /^(?:([a-z]+):)?(.+?)\s+(\d+(?:[.,]\d+)?)$/.exec(piece);
      if (!match) return fail(`cada pieza es «nombre gramos» (con «rol:» delante si es sustituible): «${piece}»`);
      const [, role, name = '', grams = ''] = match;
      if (role !== undefined && !ROLE_SET.has(role)) return fail(`rol desconocido «${role}» (${FOOD_ROLES.join(', ')})`);
      const amount = Number(grams.replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) return fail(`los gramos de «${name}» deben ser un número mayor que 0`);
      return { name: name.trim(), amount, slot: (role as FoodRole | undefined) ?? null };
    });
}

/**
 * Lee la tabla de alimentos. Lanza (con el archivo y el número de línea) si una línea está mal escrita. Un plato compuesto (`= pieza + pieza…` en lugar
 * de las cifras) se apunta en `recipes` para resolverlo cuando se tiene toda la tabla (`parseFoodTables`); sin ese mapa no se admiten.
 */
export function parseFoodTable(text: string, file = 'alimentos.txt', names: Set<string> = new Set(), recipes?: Map<FoodEntry, RawRecipe>): FoodEntry[] {
  const fail = (line: number, message: string): never => {
    throw new Error(`${file}, línea ${line}: ${message}`);
  };
  const positive = (value: string, line: number, what: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fail(line, `${what} debe ser un número mayor que 0 («${value}»)`);
    return n;
  };
  const entries: FoodEntry[] = [];
  text.split('\n').forEach((rawLine, index) => {
    const line = index + 1;
    const content = rawLine.trim();
    if (content === '' || content.startsWith('#')) return;
    const parts = content.split('|').map((part) => part.trim());
    if (parts.length !== 4) return fail(line, `se esperaban 4 columnas separadas por «|» y hay ${parts.length}`);
    const [name = '', aliasText = '', figures = '', extras = ''] = parts;
    if (name === '') return fail(line, 'falta el nombre');
    if (names.has(name)) return fail(line, `el nombre «${name}» está repetido`);
    names.add(name);

    const isRecipe = figures.startsWith('=');
    let kcal = 0;
    let proteinG = 0;
    let carbsG = 0;
    let fatG = 0;
    let fiberG = 0;
    let sugarsG = 0;
    let saltG = 0;
    let recipe: RawRecipe | null = null;
    if (isRecipe) {
      if (!recipes) return fail(line, 'un plato compuesto («= pieza + pieza») solo se lee con parseFoodTables');
      const pieces = parseRecipeParts(figures.slice(1), (message) => fail(line, message));
      if (pieces.length < 2) return fail(line, 'un plato compuesto lleva al menos dos piezas');
      recipe = { file, line, parts: pieces, like: [] };
    } else {
      const numbers = figures.split(/\s+/).map(Number);
      if (numbers.length !== 7 || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
        return fail(line, `las cifras deben ser 7 números (kcal proteínas hidratos grasas fibra azúcares sal): «${figures}»`);
      }
      [kcal = 0, proteinG = 0, carbsG = 0, fatG = 0, fiberG = 0, sugarsG = 0, saltG = 0] = numbers;
      if (kcal > 900 || proteinG > 100 || carbsG > 100 || fatG > 100 || fiberG > 80 || saltG > 100) return fail(line, `cifras imposibles por 100 g: «${figures}»`);
      // Los azúcares son una parte de los hidratos (los disponibles, sin la fibra): no pueden pasar de ellos.
      if (sugarsG > carbsG * 1.02 + 0.3) return fail(line, `los azúcares (${sugarsG}) no pueden ser más que los hidratos (${carbsG}): «${figures}»`);
    }

    const aliases = [name, ...aliasText.split(',').map((alias) => alias.trim()).filter((alias) => alias !== '')];
    const entry: FoodEntry = {
      name,
      aliases,
      kcal,
      proteinG,
      carbsG,
      fatG,
      fiberG,
      sugarsG,
      saltG,
      liquid: false,
      density: 1,
      alcoholG: 0,
      serving: 0,
      each: null,
      measures: {},
      ignore: false,
      cook: null,
      container: false,
      whole: null,
      filling: null,
      role: defaultRoleOf(file),
      recipe: null,
      menu: false,
      flavored: false,
      flavorTo: null,
      flavor: false,
      fast: false,
      bareServing: false,
      lengthCm: null,
      weightOf: null,
      like: null,
    };
    const measures: Partial<Record<Measure, number>> = {};
    for (const token of extras.split(/\s+/).filter((token) => token !== '')) {
      const [key = '', value] = token.split('=');
      if (key === 'liquido' && value === undefined) entry.liquid = true;
      else if (key === 'ignorar' && value === undefined) entry.ignore = true;
      else if (key === 'contenedor' && value === undefined) entry.container = true;
      else if (key === 'menu' && value === undefined) entry.menu = true;
      else if (key === 'sabor' && value === undefined) entry.flavor = true;
      else if (key === 'sabores') {
        entry.flavored = true;
        entry.flavorTo = value === undefined ? null : value.replace(/_/g, ' ');
      }
      else if (key === 'rapida' && value === undefined) entry.fast = true;
      else if (key === 'conjunto' && value === undefined) entry.bareServing = true;
      else if (value === undefined) return fail(line, `extra desconocido: «${token}»`);
      else if (key === 'rol') {
        if (value !== 'ninguno' && !ROLE_SET.has(value)) return fail(line, `rol= debe ser una de ${FOOD_ROLES.join(', ')} o ninguno («${value}»)`);
        entry.role = value === 'ninguno' ? null : (value as FoodRole);
      }
      else if (key === 'coc') {
        if (!COOK_SET.has(value)) return fail(line, `coc= debe ser una de ${COOK_CLASSES.join(', ')} («${value}»)`);
        entry.cook = value as CookClass;
      } else if (key === 'racion') entry.serving = positive(value, line, 'racion');
      else if (key === 'rell') entry.filling = positive(value, line, 'rell');
      else if (key === 'cm') entry.lengthCm = positive(value, line, 'cm');
      else if (key === 'peso') {
        if (!ROLE_SET.has(value)) return fail(line, `peso= debe ser un rol (${FOOD_ROLES.join(', ')}): «${value}»`);
        entry.weightOf = value as FoodRole;
      }
      else if (key === 'como') {
        if (!recipe) return fail(line, 'como= solo se usa en un plato compuesto');
        for (const pair of value.split(',')) {
          const [from, to] = pair.split(':').map((name) => name.replace(/_/g, ' ').trim());
          if (!from || !to) return fail(line, `como= lleva pares «lo que se nombra:lo que se pone»: «${pair}»`);
          recipe.like.push([from, to]);
        }
      }
      else if (key === 'entero') entry.whole = positive(value, line, 'entero');
      else if (key === 'ud') entry.each = positive(value, line, 'ud');
      else if (key === 'densidad') entry.density = positive(value, line, 'densidad');
      else if (key === 'alcohol') entry.alcoholG = positive(value, line, 'alcohol');
      else if (MEASURE_SET.has(key)) measures[key as Measure] = positive(value, line, key);
      else return fail(line, `medida o extra desconocido: «${key}»`);
    }
    if (!entry.ignore && entry.serving === 0 && recipe === null) return fail(line, 'falta racion=');
    const finished = { ...entry, measures };
    if (recipe) recipes?.set(finished, recipe);
    entries.push(finished);
  });
  if (entries.length === 0) throw new Error(`${file} está vacío.`);
  return entries;
}

/**
 * Lee la tabla entera, que va repartida en varios archivos (`alimentos*.txt`, uno por familia de alimentos). Los nombres no se pueden
 * repetir entre archivos; el orden es el del nombre de archivo.
 */
export function parseFoodTables(sources: Readonly<Record<string, string>>): FoodEntry[] {
  const names = new Set<string>();
  const recipes = new Map<FoodEntry, RawRecipe>();
  const entries = Object.keys(sources)
    .sort()
    .flatMap((path) => parseFoodTable(sources[path] ?? '', path.split('/').pop() ?? path, names, recipes));
  return recipes.size === 0 ? entries : resolveRecipes(entries, recipes);
}

/** Pone a cada plato compuesto sus piezas (los alimentos de la tabla) y calcula sus cifras por 100 g a partir de ellas. */
function resolveRecipes(entries: FoodEntry[], recipes: ReadonlyMap<FoodEntry, RawRecipe>): FoodEntry[] {
  const byName = new Map(entries.map((entry) => [foldName(entry.name), entry]));
  return entries.map((entry) => {
    const raw = recipes.get(entry);
    if (!raw) return entry;
    const fail = (line: number, message: string): never => {
      throw new Error(`${raw.file}, línea ${line}: ${message}`);
    };
    const parts = raw.parts.map((part): RecipePart => {
      const found = byName.get(foldName(part.name));
      if (!found) return fail(raw.line, `«${entry.name}» lleva «${part.name}», que no es un alimento de la tabla`);
      if (recipes.has(found)) return fail(raw.line, `«${entry.name}» lleva «${part.name}», que ya es un plato compuesto`);
      return { entry: found, amount: part.amount, slot: part.slot };
    });
    const like = new Map<FoodEntry, FoodEntry>();
    for (const [from, to] of raw.like) {
      const named = byName.get(foldName(from));
      const put = byName.get(foldName(to));
      if (!named || !put) return fail(raw.line, `«${entry.name}»: como=${from}:${to} nombra un alimento que no está en la tabla`);
      like.set(named, put);
    }
    let mass = 0;
    let kcal = 0;
    let proteinG = 0;
    let carbsG = 0;
    let fatG = 0;
    let fiberG = 0;
    let sugarsG = 0;
    let saltG = 0;
    for (const { entry: piece, amount } of parts) {
      const grams = piece.liquid ? amount * piece.density : amount;
      mass += grams;
      kcal += (piece.kcal * grams) / 100;
      proteinG += (piece.proteinG * grams) / 100;
      carbsG += (piece.carbsG * grams) / 100;
      fatG += (piece.fatG * grams) / 100;
      fiberG += (piece.fiberG * grams) / 100;
      sugarsG += (piece.sugarsG * grams) / 100;
      saltG += (piece.saltG * grams) / 100;
    }
    const per100 = (total: number): number => Math.round((total / mass) * 1000) / 10;
    const total = Math.round(mass);
    return {
      ...entry,
      kcal: Math.round((kcal / mass) * 1000) / 10,
      proteinG: per100(proteinG),
      carbsG: per100(carbsG),
      fatG: per100(fatG),
      fiberG: per100(fiberG),
      sugarsG: per100(sugarsG),
      saltG: Math.round((saltG / mass) * 10000) / 100,
      serving: entry.serving || total,
      each: entry.each ?? total,
      recipe: parts,
      like: like.size > 0 ? like : null,
    };
  });
}
