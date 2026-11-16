import type { ProductHit } from './food-db-search';
import type { CookClass, FoodEntry, FoodRole, Measure } from './food-table';
import { MAX_MEAL_KCAL, MAX_MEAL_NAME, type MealDraft } from './nutrition';

// Calcular las calorías de lo que la persona escribe («dos huevos revueltos con una tostada y un café con leche») SIN internet ni IA:
// se reconocen los alimentos de la tabla (`alimentos.txt`), sus cantidades («200 g», «dos», «un vaso de», «media»…) y se suma. Es
// mucho menos listo que una IA (no entiende lo que no está en la tabla ni los platos raros), pero es instantáneo, gratuito, da siempre
// lo mismo y deja ver cada suposición. Lo que no entiende lo dice, en vez de sumarlo mal.

export interface TextItem {
  /** Cómo se llama en la tabla (con «×2» si son varias unidades). */
  name: string;
  /** Cantidad en gramos, o en mililitros si es un líquido. */
  amount: number;
  unit: 'g' | 'ml';
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Fibra, azúcares y sal en gramos; ausentes si el producto no los trae (un alimento de la tabla siempre los tiene). */
  fiberG?: number;
  sugarsG?: number;
  saltG?: number;
  /** No se dijo la cantidad (o su medida): es una ración habitual. */
  assumed: boolean;
  /** Si es un plato compuesto («kebab de ternera con cebolla y salsa blanca»): lo que lleva, pieza a pieza (suman lo de arriba). */
  parts?: TextItem[];
  /** Solo se sabe lo que dijo la persona («tteokbokki 400 kcal»): los gramos no se saben y los nutrientes son los de una comida media. */
  kcalOnly?: true;
}

export interface TextAnalysis {
  items: TextItem[];
  /** Lo que se ha supuesto, en frases (vacío si todo estaba dicho). */
  assumptions: string;
  /** Trozos del texto que no se han reconocido (no están sumados). */
  unknown: string[];
}

export const MAX_TEXT_CHARS = 1_000;
const MAX_ITEMS = 20;
const MAX_AMOUNT = 5_000;

// ───────────────────────────── palabras ─────────────────────────────

const foldAccents = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Las formas con que se puede escribir una palabra en singular o plural: dos palabras son la misma si comparten alguna. */
export function wordForms(word: string): string[] {
  const forms = [word];
  if (word.length >= 4 && word.endsWith('s')) forms.push(word.slice(0, -1));
  if (word.length >= 5 && word.endsWith('es')) forms.push(word.slice(0, -2));
  if (word.length >= 5 && word.endsWith('ces')) forms.push(`${word.slice(0, -3)}z`);
  return forms;
}

interface Token {
  raw: string;
  /** Sin acentos ni mayúsculas. */
  norm: string;
  kind: 'num' | 'word' | 'sep';
  value: number;
  /** Si se corrigió una errata: lo que se había escrito, y el aviso que se da si la corrección sirve de algo (si no, la palabra queda como se escribió). */
  original?: string;
  note?: string;
}

const TOKEN = /(\d+\s*\/\s*\d+)|(\d+(?:[.,]\d+)?)|(\p{L}+)|([%])|([^\s\p{L}\d]+)/gu;

/** «1½», «¼ l», «1.500 g»: lo que el teclado del móvil escribe y el reconocedor de números no entiende tal cual. */
function prepare(text: string): string {
  return text
    .replace(/(\d)\s*½/g, '$1,5')
    .replace(/(\d)\s*¼/g, '$1,25')
    .replace(/(\d)\s*¾/g, '$1,75')
    .replace(/½/g, '0,5')
    .replace(/¼/g, '0,25')
    .replace(/¾/g, '0,75')
    // Separador de miles a la española (1.500 → 1500); un 0 delante («0.250») es un decimal.
    .replace(/(?<![\d.,])([1-9]\d{0,2})((?:\.\d{3})+)(?![\d])/g, (_, head: string, groups: string) => head + groups.replace(/\./g, ''))
    // «coca-cola», «gin-tonic»: un guion entre letras es un espacio. Un apóstrofo entre letras («all'arrabbiata», «shepherd's pie», «mcdonald's») también.
    .replace(/(?<=\p{L})[-'’](?=\p{L})/gu, ' ')
    // «m&m's», «r&b»: un & pegado a letras es parte de un nombre y no separa nada; «arroz & pollo» es una «y». (Pasa igual con los alias de la tabla: «ben & jerry's».)
    .replace(/(?<=[\p{L}\d])&(?=[\p{L}\d])/gu, ' ')
    .replace(/\s&\s/g, ' y ');
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of prepare(text).matchAll(TOKEN)) {
    const [raw = '', fraction, number, word, percent] = match;
    if (fraction !== undefined) {
      const [a = 0, b = 1] = fraction.split('/').map((part) => Number(part.trim()));
      tokens.push({ raw, norm: raw, kind: 'num', value: b === 0 ? 0 : a / b });
    } else if (number !== undefined) {
      // «0,0» y «0.0» son lo mismo (y «00» también): la cifra se compara por su valor.
      const value = Number(number.replace(',', '.'));
      tokens.push({ raw, norm: String(value), kind: 'num', value });
    } else if (word !== undefined) {
      tokens.push({ raw, norm: foldAccents(word), kind: 'word', value: 0 });
    } else if (percent !== undefined) {
      // «yogur 0%», «chocolate 70%»: el porcentaje no es una cantidad.
      continue;
    } else {
      tokens.push({ raw, norm: raw, kind: 'sep', value: 0 });
    }
  }
  return dropSpoonSizes(liftLengths(dropClockTimes(tokens)));
}

/** «un sub de 30 cm de pavo»: lo largo que es va delante del alimento, como en «30 cm de sub de pavo» (el mismo orden que «un footlong de pavo»). */
function liftLengths(tokens: Token[]): Token[] {
  for (let i = 0; i + 4 < tokens.length; i++) {
    const [word, de, amount, unit, again] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!, tokens[i + 3]!, tokens[i + 4]!];
    if (word.kind === 'word' && de.norm === 'de' && amount.kind === 'num' && unit.kind === 'word' && lookupWord(LENGTHS, unit.norm) !== undefined && again.norm === 'de') {
      tokens.splice(i, 5, amount, unit, word, again);
    }
  }
  return tokens;
}

/** Qué cuchara es: «cucharadita DE CAFÉ de miel», «cucharada DE POSTRE de azúcar», «cucharada SOPERA de aceite». El tipo de cuchara no es un alimento ni cambia lo que se pide. */
const SPOON_TYPES: ReadonlySet<string> = new Set(['cafe', 'postre', 'te', 'sopa']);
const SPOON_ADJECTIVES: ReadonlySet<string> = new Set(['sopera', 'soperas', 'sopero', 'soperos', 'rasa', 'rasas', 'colmada', 'colmadas', 'llena', 'llenas', 'generosa', 'generosas', 'abundante', 'abundantes']);

function dropSpoonSizes(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    out.push(t);
    if (t.kind !== 'word' || !/^cuchar(a|ada|adas|adita|aditas)$/.test(t.norm)) continue;
    let j = i + 1;
    while (tokens[j]?.kind === 'word' && SPOON_ADJECTIVES.has(tokens[j]!.norm)) j++;
    if (tokens[j]?.norm === 'de' && SPOON_TYPES.has(tokens[j + 1]?.norm ?? '') && tokens[j + 2]?.norm === 'de') j += 2;
    i = j - 1;
  }
  return out;
}

/** «a las 3», «sobre las 14:30»: la hora a la que se comió no es una cantidad de comida. */
function dropClockTimes(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    const afterArticle = tokens[i + 2];
    // «14:00», «9:30 h» (en cualquier sitio: «almuerzo de 14:00 arroz con pollo») y «14h», «a las 3 horas»: una hora no es una cantidad de comida.
    if (t.kind === 'num' && next?.raw === ':' && afterArticle?.kind === 'num' && t.value <= 24 && afterArticle.value <= 59 && /^\d{1,2}$/.test(afterArticle.raw)) {
      i += 2;
      if (tokens[i + 1]?.kind === 'word' && ['h', 'hs', 'hrs', 'hora', 'horas'].includes(tokens[i + 1]!.norm)) i += 1;
      continue;
    }
    if (t.kind === 'num' && Number.isInteger(t.value) && t.value >= 0 && t.value <= 24 && next?.kind === 'word' && ['h', 'hs', 'hrs'].includes(next.norm)) {
      i += 1;
      continue;
    }
    if (t.kind === 'word' && ['a', 'sobre', 'hacia', 'desde', 'hasta', 'entre'].includes(t.norm) && next?.kind === 'word' && (next.norm === 'la' || next.norm === 'las') && afterArticle?.kind === 'num') {
      i += 2;
      // «14:30» llega como 14, «:», 30; y puede ir seguida de «h» u «horas».
      if (tokens[i + 1]?.raw === ':' && tokens[i + 2]?.kind === 'num') i += 2;
      if (tokens[i + 1]?.kind === 'word' && ['h', 'hs', 'hora', 'horas'].includes(tokens[i + 1]!.norm)) i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Los números hasta el 29 (una sola palabra). */
const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Readonly<Record<string, number>> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS: Readonly<Record<string, number>> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
};
const HALVES: Readonly<Record<string, number>> = { medio: 0.5, media: 0.5, mitad: 0.5 };
/** Todas las palabras que son (parte de) un número: una palabra suelta de la tabla no puede ser ninguna. */
const NUMBER_WORDS: Readonly<Record<string, number>> = { ...SMALL_NUMBERS, ...TENS, ...HUNDREDS, ...HALVES, mil: 1000 };

/** Un número en palabras de 1 a 999 («ciento cincuenta», «treinta y cinco», «doscientos», «veinte»), o `null`. */
function readBelowThousand(tokens: Token[], at: number): { value: number; next: number } | null {
  let i = at;
  let value = 0;
  let any = false;
  const word = (k: number): string => (tokens[k]?.kind === 'word' ? tokens[k]!.norm : '');
  if (Object.hasOwn(HUNDREDS, word(i))) {
    value += HUNDREDS[word(i)]!;
    i++;
    any = true;
  }
  if (Object.hasOwn(TENS, word(i))) {
    value += TENS[word(i)]!;
    i++;
    any = true;
    const units = SMALL_NUMBERS[word(i + 1)];
    if (word(i) === 'y' && units !== undefined && units >= 1 && units <= 9) {
      value += units;
      i += 2;
    }
  } else if (Object.hasOwn(SMALL_NUMBERS, word(i))) {
    value += SMALL_NUMBERS[word(i)]!;
    i++;
    any = true;
  }
  return any ? { value, next: i } : null;
}

/** Un número en palabras de 1 a 999.999 («mil doscientos», «dos mil»), o `null`. */
function readWordNumber(tokens: Token[], at: number): { value: number; next: number } | null {
  const head = readBelowThousand(tokens, at);
  const mil = (k: number): boolean => tokens[k]?.kind === 'word' && tokens[k]!.norm === 'mil';
  if (head && mil(head.next)) {
    const rest = readBelowThousand(tokens, head.next + 1);
    return { value: head.value * 1000 + (rest?.value ?? 0), next: rest?.next ?? head.next + 1 };
  }
  if (!head && mil(at)) {
    const rest = readBelowThousand(tokens, at + 1);
    return { value: 1000 + (rest?.value ?? 0), next: rest?.next ?? at + 1 };
  }
  return head;
}

/** «un par de», «una docena», «media docena»: multiplican el número que llevan delante. */
const MULTIPLIERS: Readonly<Record<string, number>> = { par: 2, docena: 12, decena: 10 };

/** «la tercera parte de la tarta», «una quinta parte»: la parte de un todo (1 / n). */
const ORDINAL_PARTS: Readonly<Record<string, number>> = { tercera: 3, cuarta: 4, quinta: 5, sexta: 6, septima: 7, octava: 8, novena: 9, decima: 10 };

/** Palabras que, tras «media», quitan que sea un número («a media mañana»). */
const NOT_HALF = new Set(['manana', 'tarde', 'noche', 'dia', 'hora', 'mediodia', 'vez']);

/** Las calorías dichas («300 kcal», «unas 450 calorías»): la persona sabe cuánto es y no hace falta adivinarlo. */
const ENERGY_WORDS: Readonly<Record<string, true>> = { kcal: true, kcals: true, cal: true, cals: true, caloria: true, calorias: true, kilocaloria: true, kilocalorias: true };

/** `scale`: «una tapa» es media ración, «un platazo», un plato y medio. */
type UnitKind =
  | { kind: 'mass'; factor: number }
  | { kind: 'volume'; factor: number; food?: string }
  | { kind: 'measure'; measure: Measure; scale?: number }
  | { kind: 'serving'; scale?: number }
  | { kind: 'each' };

const UNITS: Readonly<Record<string, UnitKind>> = {
  g: { kind: 'mass', factor: 1 }, gr: { kind: 'mass', factor: 1 }, grs: { kind: 'mass', factor: 1 }, gramo: { kind: 'mass', factor: 1 },
  kg: { kind: 'mass', factor: 1000 }, kgs: { kind: 'mass', factor: 1000 }, kilo: { kind: 'mass', factor: 1000 }, kilogramo: { kind: 'mass', factor: 1000 },
  ml: { kind: 'volume', factor: 1 }, cl: { kind: 'volume', factor: 10 }, dl: { kind: 'volume', factor: 100 }, l: { kind: 'volume', factor: 1000 },
  lt: { kind: 'volume', factor: 1000 }, litro: { kind: 'volume', factor: 1000 }, mililitro: { kind: 'volume', factor: 1 },
  vaso: { kind: 'measure', measure: 'vaso' }, vasito: { kind: 'measure', measure: 'vaso' }, copa: { kind: 'measure', measure: 'copa' },
  taza: { kind: 'measure', measure: 'taza' }, tazon: { kind: 'measure', measure: 'bol' }, bol: { kind: 'measure', measure: 'bol' }, cuenco: { kind: 'measure', measure: 'bol' },
  cana: { kind: 'measure', measure: 'cana' }, botellin: { kind: 'measure', measure: 'botellin' }, tercio: { kind: 'measure', measure: 'botellin' },
  lata: { kind: 'measure', measure: 'lata' }, botella: { kind: 'measure', measure: 'botella' }, brick: { kind: 'measure', measure: 'brick' }, jarra: { kind: 'measure', measure: 'jarra' },
  chupito: { kind: 'measure', measure: 'chupito' }, cucharada: { kind: 'measure', measure: 'cucharada' }, cuchara: { kind: 'measure', measure: 'cucharada' },
  cucharadita: { kind: 'measure', measure: 'cucharadita' }, cucharon: { kind: 'measure', measure: 'cucharon' }, punado: { kind: 'measure', measure: 'punado' },
  loncha: { kind: 'measure', measure: 'loncha' }, lamina: { kind: 'measure', measure: 'loncha' }, feta: { kind: 'measure', measure: 'loncha' },
  rebanada: { kind: 'measure', measure: 'rebanada' }, rodaja: { kind: 'measure', measure: 'rodaja' },
  trozo: { kind: 'measure', measure: 'trozo' }, pedazo: { kind: 'measure', measure: 'trozo' }, cacho: { kind: 'measure', measure: 'trozo' },
  porcion: { kind: 'measure', measure: 'porcion' }, plato: { kind: 'measure', measure: 'plato' }, platito: { kind: 'measure', measure: 'plato' },
  onza: { kind: 'measure', measure: 'onza' }, sobre: { kind: 'measure', measure: 'sobre' }, terron: { kind: 'measure', measure: 'terron' },
  cazo: { kind: 'measure', measure: 'cazo' }, scoop: { kind: 'measure', measure: 'cazo' }, chorrito: { kind: 'measure', measure: 'chorrito' }, chorro: { kind: 'measure', measure: 'chorrito' },
  bola: { kind: 'measure', measure: 'bola' }, filete: { kind: 'measure', measure: 'filete' }, bolsa: { kind: 'measure', measure: 'bolsa' }, paquete: { kind: 'measure', measure: 'bolsa' },
  dedo: { kind: 'measure', measure: 'dedo' }, tarro: { kind: 'measure', measure: 'tarro' }, bote: { kind: 'measure', measure: 'tarro' }, tarrina: { kind: 'measure', measure: 'tarro' },
  racion: { kind: 'serving' }, unidad: { kind: 'each' }, pieza: { kind: 'each' }, ud: { kind: 'each' }, uds: { kind: 'each' },
  azucarillo: { kind: 'measure', measure: 'terron' }, trocito: { kind: 'measure', measure: 'trozo' }, lonchita: { kind: 'measure', measure: 'loncha' },
  sobrecito: { kind: 'measure', measure: 'sobre' }, tableta: { kind: 'measure', measure: 'tableta' },
  pizca: { kind: 'measure', measure: 'pizca' }, pellizco: { kind: 'measure', measure: 'pizca' }, racimo: { kind: 'measure', measure: 'racimo' },
  cuna: { kind: 'measure', measure: 'trozo' }, tajada: { kind: 'measure', measure: 'rodaja' }, lasca: { kind: 'measure', measure: 'loncha' },
  // Una tapa es media ración; un platazo, un plato y medio.
  platillo: { kind: 'measure', measure: 'plato', scale: 0.6 }, puñadito: { kind: 'measure', measure: 'punado', scale: 0.7 }, punadito: { kind: 'measure', measure: 'punado', scale: 0.7 },
  golpe: { kind: 'measure', measure: 'chorrito' }, gota: { kind: 'measure', measure: 'pizca' }, biberon: { kind: 'measure', measure: 'vaso' },
  litrona: { kind: 'volume', factor: 1000, food: 'Cerveza' },
  tapa: { kind: 'serving', scale: 0.5 }, tapita: { kind: 'serving', scale: 0.4 }, platazo: { kind: 'measure', measure: 'plato', scale: 1.5 }, platote: { kind: 'measure', measure: 'plato', scale: 1.5 },
};

/** Medidas casera de un alimento que no las trae en la tabla, por tipo (sólido o líquido). */
const GENERIC_SOLID: Readonly<Partial<Record<Measure, number>>> = { cucharada: 12, cucharadita: 4, punado: 30, loncha: 20, rebanada: 30, rodaja: 25, trozo: 50, bol: 200, vaso: 150, taza: 150, lata: 100, onza: 6, sobre: 8, terron: 5, cazo: 30, bola: 60, filete: 150, cucharon: 60, tarro: 200, tableta: 100, pizca: 0.5, racimo: 150 };
const GENERIC_LIQUID: Readonly<Partial<Record<Measure, number>>> = { vaso: 200, taza: 250, copa: 100, cana: 200, botellin: 330, lata: 330, botella: 500, brick: 200, jarra: 500, chupito: 40, bol: 300, cucharada: 15, cucharadita: 5, cucharon: 60, chorrito: 10, dedo: 25, tarro: 250, pizca: 0.5 };

/** Si se pide una medida sin decir de qué («una caña», «un vaso»), de qué se supone. */
const MEASURE_DEFAULT_FOOD: Readonly<Partial<Record<Measure, string>>> = {
  filete: 'Ternera', cana: 'Cerveza', botellin: 'Cerveza', copa: 'Combinado', chupito: 'Licor', vaso: 'Agua', lata: 'Refresco de cola', terron: 'Azúcar',
};

const SIZES: Readonly<Record<string, number>> = {
  grande: 1.3, gran: 1.3, enorme: 1.6, gigante: 1.6, jumbo: 1.6, xl: 1.5, xxl: 1.8, extra: 1.3, pequeno: 0.7, pequena: 0.7, chico: 0.7, chica: 0.7, mini: 0.7, pequenito: 0.6,
  pequenita: 0.6, mediano: 1, mediana: 1, regular: 1, tall: 1, venti: 1.65, familiar: 1.5, individual: 0.8,
  doble: 2, doblada: 2, triple: 3,
  // «una barbaridad de turrón»: mucho.
  barbaridad: 2, burrada: 2, montonazo: 2, tonelada: 2, atracon: 2,
};

/** «doble» y «triple» no hacen más grande el plato: ponen más carne («una hamburguesa doble» lleva dos tortas y un solo pan). */
const MULTI_WORDS: ReadonlySet<string> = new Set(['doble', 'doblada', 'triple']);

const isMulti = (word: string): boolean => wordForms(word).some((form) => MULTI_WORDS.has(form));

/** Longitudes (en cm) que se dicen de un bocadillo largo: «un sub de 30 cm», «un footlong», «de 6 pulgadas». */
const LENGTHS: Readonly<Record<string, number>> = { cm: 1, centimetro: 1, pulgada: 2.54 };

/** Palabras que no cambian lo comido: relleno, el momento del día, adjetivos. */
const FILLER = new Set(
  (
    'me he hemos has ha comi comido comida comidas comer comiendo tome tomado tomar bebi bebido beber desayune desayuno desayunado almorce almuerzo almorzado meriende merienda cene cena cenado ' +
    'picoteo picotee hoy ayer anoche esta este estos estas mi mis su sus el la lo los las al para por en a ya solo sola unos unas algo bastante mucho mucha muchos muchas casi otro otra otros otras igual algunos algunas varios varias ' +
    'manana tarde noche mediodia madrugada natural casero casera caseros caseras fresco fresca frescos frescas rico rica buen buena bueno tipico tipica normal normales sabroso sabrosa ' +
    'calentito caliente frio fria templado crudo cruda variado variada completo completa entero entera tambien que es con medio media ahumado ahumada ahumados ahumadas salado salada salados saladas proteico proteica proteicos proteicas infantil infantiles nino ninos nina ninas bebe bebes llevar hipocalorica hipocaloricas dieta blanda blando merende merendamos cenamos comimos desayunamos almorzamos pedi pedimos fui fuimos restaurante restaurantes japones japonesa trabajo oficina entrenar entreno entrenamiento gimnasio fuerte ligera ligero hotel brunch postre postres ' +
    'menos aproximadamente aprox aproximado aproximada cerca alrededor rondando unas gas hecho hecha hechos hechas preparado preparada cocinado cocinada tipo estilo ' +
    // «mi segunda cerveza», «de primero lentejas y de segundo merluza», «repetí de paella»: el orden y el repetir no cambian lo que se comió. («Cuarto» y «quinto» no: son un cuarto de kilo y un quinto de cerveza.)
    'primer primera primero primeros primeras segundo segunda segundas tercer tercero tercera terceras cuarta sexta sexto septima septimo octava octavo novena noveno decima decimo repeti repetir repito repetimos repetido repitio repitiendo fue fueron era eran ' +
    'total aparte incluso encima antes relleno rellena rellenos rellenas glaseado glaseada glaseados glaseadas casa mama madre padre vecina vecino amiga amigo tia tio suegra cine bellota iberico iberica ibericos ibericas integral integrales persona personas comensal comensales merendar desayunar almorzar cenar picar tomando comiendo bebiendo hondo honda llano llana entre mixta mixtas como tupper tuper zampe zampado zampar rallado rallada troceado troceada monton montones ecologico ecologica bio artesano artesana artesanal menu dia del todo toda todos todas caja cubo bucket mcmenu supermercado instantaneo instantanea congelado congelada congelados congeladas precocinado precocinada envasado envasada bandeja pack pedi pedimos pedido tamano'
  ).split(' '),
);

/** Dichas delante de un producto («unas lays», «varios bollycaos») cuentan como decir que se comió algo concreto, aunque no digan cuánto. */
const SOME_WORDS: ReadonlySet<string> = new Set(['unos', 'unas', 'algunos', 'algunas', 'varios', 'varias']);

/** «con todo menos cebolla»: el «menos» que quita algo va detrás de una de estas. */
const ALL_WORDS: ReadonlySet<string> = new Set(['todo', 'todos', 'toda', 'todas']);

/** «y otro de ternera», «una caña y otra»: otra unidad de lo último. */
const ANOTHER: ReadonlySet<string> = new Set(['otro', 'otra', 'otros', 'otras']);

/** «y», «con», «más», «luego»…: terminan lo que se estaba contando y empieza otra cosa. */
const SEPARATORS = new Set(['y', 'e', 'con', 'mas', 'ademas', 'luego', 'despues', 'o', 'tambien', 'ni', 'pero']);

// ───────────────────────────── formas de cocinar ─────────────────────────────

/** De menor a mayor grasa añadida: si se dicen dos («rebozado y frito»), manda la última. */
const COOK_METHODS = ['crudo', 'hervido', 'plancha', 'horno', 'guisado', 'frito', 'empanado'] as const;
type CookMethod = (typeof COOK_METHODS)[number];

/** Cómo lo pone la persona (sin acentos) → qué forma de cocinar es. Las frases más largas ganan. */
const COOK_PHRASES: ReadonlyArray<readonly [string, CookMethod]> = [
  // crudo (las cifras de la tabla son las del alimento cocinado: crudo pesa más por el agua y lleva menos calorías por gramo)
  ['crudo', 'crudo'], ['cruda', 'crudo'], ['crudos', 'crudo'], ['crudas', 'crudo'], ['en crudo', 'crudo'], ['sin cocinar', 'crudo'], ['sin cocer', 'crudo'], ['peso en crudo', 'crudo'],
  // sin grasa añadida
  ['cocido', 'hervido'], ['cocida', 'hervido'], ['cocidos', 'hervido'], ['cocidas', 'hervido'], ['hervido', 'hervido'], ['hervida', 'hervido'], ['hervidos', 'hervido'], ['hervidas', 'hervido'],
  ['al vapor', 'hervido'], ['vapor', 'hervido'], ['escalfado', 'hervido'], ['escalfada', 'hervido'], ['pochado', 'hervido'], ['pochada', 'hervido'], ['en agua', 'hervido'],
  ['al natural', 'hervido'], ['al papillote', 'hervido'], ['en papillote', 'hervido'], ['a baja temperatura', 'hervido'], ['al micro', 'hervido'], ['al microondas', 'hervido'],
  // con un poco de aceite
  ['a la plancha', 'plancha'], ['plancha', 'plancha'], ['a la parrilla', 'plancha'], ['parrilla', 'plancha'], ['a la brasa', 'plancha'], ['brasa', 'plancha'], ['braseado', 'plancha'],
  ['braseada', 'plancha'], ['al grill', 'plancha'], ['grill', 'plancha'], ['a la sarten', 'plancha'], ['salteado', 'plancha'], ['salteada', 'plancha'], ['salteados', 'plancha'],
  ['salteadas', 'plancha'], ['a la espalda', 'plancha'], ['a la barbacoa', 'plancha'], ['barbacoa', 'plancha'], ['en airfryer', 'plancha'], ['airfryer', 'plancha'], ['al air fryer', 'plancha'],
  ['a la freidora de aire', 'plancha'], ['freidora de aire', 'plancha'], ['sin aceite', 'plancha'],
  // al horno
  ['al horno', 'horno'], ['horno', 'horno'], ['asado', 'horno'], ['asada', 'horno'], ['asados', 'horno'], ['asadas', 'horno'], ['gratinado', 'horno'], ['gratinada', 'horno'],
  ['gratinados', 'horno'], ['gratinadas', 'horno'], ['a la sal', 'horno'], ['tostado', 'horno'], ['tostada al horno', 'horno'], ['al forno', 'horno'], ['a la espetera', 'horno'],
  // guisado, en salsa
  ['guisado', 'guisado'], ['guisada', 'guisado'], ['guisados', 'guisado'], ['guisadas', 'guisado'], ['estofado', 'guisado'], ['estofada', 'guisado'], ['estofados', 'guisado'],
  ['estofadas', 'guisado'], ['en salsa', 'guisado'], ['en su salsa', 'guisado'], ['encebollado', 'guisado'], ['encebollada', 'guisado'], ['a la jardinera', 'guisado'],
  ['a la marinera', 'guisado'], ['en cazuela', 'guisado'], ['al vino', 'guisado'], ['a la riojana', 'guisado'], ['al curry', 'guisado'], ['a la cerveza', 'guisado'],
  ['a la vizcaina', 'guisado'], ['al chilindron', 'guisado'], ['a la cazuela', 'guisado'], ['en salsa verde', 'guisado'], ['en salsa de tomate', 'guisado'],
  ['en adobo', 'guisado'], ['adobado', 'guisado'], ['adobada', 'guisado'], ['en escabeche', 'guisado'], ['escabechado', 'guisado'], ['escabechada', 'guisado'],
  // frito
  ['frito', 'frito'], ['frita', 'frito'], ['fritos', 'frito'], ['fritas', 'frito'], ['freido', 'frito'], ['freida', 'frito'], ['freidos', 'frito'], ['freidas', 'frito'],
  ['al ajillo', 'frito'], ['en aceite', 'frito'], ['frito en aceite', 'frito'], ['en freidora', 'frito'], ['de freidora', 'frito'], ['a la freidora', 'frito'], ['con mucho aceite', 'frito'],
  // empanado o rebozado (y frito)
  ['empanado', 'empanado'], ['empanada', 'empanado'], ['empanados', 'empanado'], ['empanadas', 'empanado'], ['rebozado', 'empanado'], ['rebozada', 'empanado'],
  ['rebozados', 'empanado'], ['rebozadas', 'empanado'], ['a la romana', 'empanado'], ['en tempura', 'empanado'], ['tempura', 'empanado'], ['en gabardina', 'empanado'],
  ['a la milanesa', 'empanado'], ['milanesa', 'empanado'], ['crujiente', 'empanado'], ['crujientes', 'empanado'], ['a la andaluza', 'empanado'], ['villeroy', 'empanado'],
  ['panko', 'empanado'], ['frito y empanado', 'empanado'], ['empanado y frito', 'empanado'], ['rebozado y frito', 'empanado'], ['frito y rebozado', 'empanado'],
];

/**
 * Lo que la cocina le añade a 100 g de un alimento ya cocinado (las cifras de la tabla son SIN grasa añadida): proteína, hidratos y grasa
 * en gramos (las calorías salen de ellos). Son órdenes de magnitud de las tablas de fritos y asados, no un cálculo exacto: el aceite que
 * absorbe un filete depende de la sartén y del cocinero.
 */
interface CookDelta {
  p: number;
  c: number;
  f: number;
}
const delta = (p: number, c: number, f: number): CookDelta => ({ p, c, f });
const COOKING: Readonly<Record<CookClass, Partial<Record<CookMethod, CookDelta>>>> = {
  carne: { plancha: delta(0, 0, 1), horno: delta(0, 0, 1.5), guisado: delta(0, 3, 4), frito: delta(0, 0, 7), empanado: delta(1.5, 11, 8) },
  ave: { plancha: delta(0, 0, 1), horno: delta(0, 0, 1.5), guisado: delta(0, 3, 4), frito: delta(0, 0, 8), empanado: delta(1.5, 11, 9) },
  pescado: { plancha: delta(0, 0, 1), horno: delta(0, 0, 1.5), guisado: delta(0, 3, 3), frito: delta(0, 0, 6), empanado: delta(1.5, 11, 7) },
  azul: { plancha: delta(0, 0, 0.5), horno: delta(0, 0, 1), guisado: delta(0, 3, 2), frito: delta(0, 0, 4), empanado: delta(1.5, 10, 5) },
  marisco: { plancha: delta(0, 0, 1), horno: delta(0, 0, 1), guisado: delta(0, 3, 3), frito: delta(0, 0, 7), empanado: delta(1.5, 11, 8) },
  verdura: { plancha: delta(0, 0, 2), horno: delta(0, 0, 3), guisado: delta(0, 3, 4), frito: delta(0.3, 2, 10), empanado: delta(1.5, 12, 10) },
  patata: { plancha: delta(0, 0, 3), horno: delta(0, 0, 4), guisado: delta(0, 2, 3), frito: delta(0.5, 3, 11), empanado: delta(1.5, 12, 11) },
  seta: { plancha: delta(0, 0, 1.5), horno: delta(0, 0, 2), guisado: delta(0, 3, 4), frito: delta(0, 1, 8), empanado: delta(1.5, 11, 9) },
};

/**
 * Lo que la cocina le añade, además, en fibra, azúcares y sal por 100 g: el rebozado y las salsas de un guiso llevan algo de las tres, y lo que se fríe o se asa
 * en un bar o en una casa lleva la sal con que se cocina. Los alimentos de la tabla traen la sal de «sin cocinar con sal añadida».
 */
const COOKING_EXTRAS: Readonly<Partial<Record<CookMethod, { fiberG: number; sugarsG: number; saltG: number }>>> = {
  plancha: { fiberG: 0, sugarsG: 0, saltG: 0.1 },
  horno: { fiberG: 0, sugarsG: 0, saltG: 0.1 },
  guisado: { fiberG: 0.3, sugarsG: 1.5, saltG: 0.4 },
  frito: { fiberG: 0, sugarsG: 0, saltG: 0.2 },
  empanado: { fiberG: 0.5, sugarsG: 0.4, saltG: 0.5 },
};

/** Cómo se dice en el nombre de lo anotado. */
const COOK_LABEL: Readonly<Record<CookMethod, string>> = { crudo: 'crudo', hervido: 'cocido', plancha: 'a la plancha', horno: 'al horno', guisado: 'guisado', frito: 'frito', empanado: 'empanado' };

/** Cuánto pesa en crudo (por 100 g de crudo) respecto de lo cocinado: las cifras de la tabla se multiplican por esto. */
const RAW_FACTOR: Readonly<Record<CookClass, number>> = { carne: 0.74, ave: 0.7, pescado: 0.8, azul: 0.88, marisco: 0.85, verdura: 1, patata: 0.9, seta: 0.9 };

const strongerCook = (a: CookMethod | null, b: CookMethod): CookMethod => (a === null || COOK_METHODS.indexOf(b) > COOK_METHODS.indexOf(a) ? b : a);

// ───────────────────────────── índice de alimentos ─────────────────────────────

interface Alias {
  /** Palabras del alias, normalizadas. */
  words: string[];
  entry: FoodEntry;
  /** Un alias que empieza por «=» («=whopper doble»): si acaba en un tamaño, ese tamaño ya es del alimento y no se aplica otra vez. */
  literal: boolean;
}

interface Index {
  /** Las palabras (de 5 letras o más) que aparecen en algún alias, con en cuántos: para corregir una errata en «tortila de patatas». */
  vocabulary: Map<string, number>;
  /** Todas las palabras de todos los alias, tal como están escritas. */
  wordSet: Set<string>;
  /** Por cada forma de la primera palabra, los alias que empiezan así (los más largos primero). */
  byFirst: Map<string, Alias[]>;
  /** Alias de una sola palabra larga, para las erratas. */
  singles: Array<{ word: string; entry: FoodEntry }>;
  byName: Map<string, FoodEntry>;
}

const indexes = new WeakMap<readonly FoodEntry[], Index>();

/** Las palabras de un texto de la tabla, normalizadas (números como cifras). */
function wordsOf(text: string): string[] {
  return tokenize(text)
    .filter((t) => t.kind !== 'sep')
    .map((t) => t.norm);
}

function indexOf(table: readonly FoodEntry[]): Index {
  let index = indexes.get(table);
  if (index) return index;
  const byFirst = new Map<string, Alias[]>();
  const singles: Index['singles'] = [];
  const byName = new Map<string, FoodEntry>();
  const seen = new Set<string>();
  const vocabulary = new Map<string, number>();
  const wordSet = new Set<string>();
  for (const entry of table) {
    byName.set(entry.name, entry);
    for (const alias of entry.aliases) {
      const words = wordsOf(alias);
      if (words.length === 0) continue;
      const key = words.join(' ');
      if (seen.has(key)) continue; // un alias repetido: gana el primero (una prueba vigila que no ocurra)
      seen.add(key);
      for (const form of new Set(wordForms(words[0]!))) {
        const list = byFirst.get(form) ?? [];
        list.push({ words, entry, literal: alias.startsWith('=') });
        byFirst.set(form, list);
      }
      if (words.length === 1 && words[0]!.length >= 5 && !/\d/.test(words[0]!)) singles.push({ word: words[0]!, entry });
      for (const word of words) {
        wordSet.add(word);
        if (word.length >= 5 && !/\d/.test(word)) vocabulary.set(word, (vocabulary.get(word) ?? 0) + 1);
      }
    }
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.words.length - a.words.length);
  index = { vocabulary, wordSet, byFirst, singles, byName };
  indexes.set(table, index);
  return index;
}

/** El alias más largo que empieza en la palabra `at`, y cuántas palabras ocupa. */
function matchFood(words: string[], at: number, index: Index): { entry: FoodEntry; length: number; literal: boolean } | null {
  const candidates = new Map<Alias, true>();
  for (const form of wordForms(words[at]!)) for (const alias of index.byFirst.get(form) ?? []) candidates.set(alias, true);
  let best: { entry: FoodEntry; length: number; literal: boolean } | null = null;
  for (const alias of candidates.keys()) {
    if (alias.words.length > words.length - at) continue;
    if (best && alias.words.length <= best.length) continue;
    const same = alias.words.every((word, k) => {
      const other = words[at + k]!;
      return word === other || wordForms(word).some((form) => wordForms(other).includes(form));
    });
    if (same) best = { entry: alias.entry, length: alias.words.length, literal: alias.literal };
  }
  return best;
}

/** Las formas de cocinar de una sola palabra (una palabra suelta de la tabla no puede ser ninguna: taparía «pollo frito»). */
const COOK_WORDS: ReadonlySet<string> = new Set(COOK_PHRASES.filter(([phrase]) => !phrase.includes(' ')).map(([phrase]) => foldAccents(phrase)));

interface CookPhrase {
  words: string[];
  method: CookMethod;
}
const cookIndex = ((): Map<string, CookPhrase[]> => {
  const byFirst = new Map<string, CookPhrase[]>();
  for (const [phrase, method] of COOK_PHRASES) {
    const words = wordsOf(phrase);
    const list = byFirst.get(words[0]!) ?? [];
    list.push({ words, method });
    byFirst.set(words[0]!, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.words.length - a.words.length);
  return byFirst;
})();

/** La forma de cocinar que empieza en la palabra `at` («a la plancha», «frito»…) y cuántas palabras ocupa. */
function matchCook(words: string[], at: number): { method: CookMethod; length: number } | null {
  for (const form of wordForms(words[at]!)) {
    for (const phrase of cookIndex.get(form) ?? []) {
      if (phrase.words.length > words.length - at) continue;
      const same = phrase.words.every((word, k) => {
        const other = words[at + k]!;
        return word === other || wordForms(word).some((f) => wordForms(other).includes(f));
      });
      if (same) return { method: phrase.method, length: phrase.words.length };
    }
  }
  return null;
}

/** Dónde cae cada letra en un teclado QWERTY (el del móvil): (columna, fila), con las filas algo desplazadas como en el teclado de verdad. */
const KEY_POSITIONS: ReadonlyMap<string, readonly [number, number]> = (() => {
  const positions = new Map<string, readonly [number, number]>();
  (['qwertyuiop', 'asdfghjkl', 'zxcvbnm'] as const).forEach((row, y) => [...row].forEach((letter, x) => positions.set(letter, [x + [0, 0.25, 0.75][y]!, y])));
  return positions;
})();
/** Las confusiones de siempre al escribir en español (se escribe como suena). */
const SOUND_ALIKES: ReadonlyArray<readonly [string, string]> = [['b', 'v'], ['c', 'z'], ['c', 's'], ['c', 'k'], ['c', 'q'], ['k', 'q'], ['g', 'j'], ['s', 'z'], ['i', 'y'], ['x', 's']];

/**
 * ¿Es creíble que alguien escribiera `a` queriendo escribir `b`? Una vocal por otra, una tecla por su vecina o una confusión de sonido (b/v, c/z…).
 * Cambiar una letra por cualquier otra no vale: «pizca» no es «pizza», «tercera» no es «ternera» ni «harira» es «harina».
 */
function plausibleSwap(a: string, b: string, wordLength = Infinity): boolean {
  if (a === b) return true;
  // Una vocal por otra solo en palabras de seis letras o más: en una corta casi siempre es otra palabra («dough» no es «doogh», un alias del ayran).
  if ('aeiou'.includes(a) && 'aeiou'.includes(b) && wordLength >= 6) return true;
  if (SOUND_ALIKES.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return true;
  const [ax, ay] = KEY_POSITIONS.get(a) ?? [-9, -9];
  const [bx, by] = KEY_POSITIONS.get(b) ?? [9, 9];
  return Math.abs(ax - bx) <= 1.2 && Math.abs(ay - by) <= 1;
}

/** Distancia de edición (con intercambio de dos letras seguidas) si es de 1 como mucho; si no, 2. */
function closeEnough(a: string, b: string): boolean {
  // Las erratas rara vez cambian la primera letra: «montón» no es «wontón».
  if (a[0] !== b[0] || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const restA = a.slice(i);
  const restB = b.slice(i);
  if (restA.length === restB.length) {
    if (restA.slice(1) === restB.slice(1)) return plausibleSwap(restA[0]!, restB[0]!, a.length); // una letra cambiada, por otra que se confunde
    return restA.length >= 2 && restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2); // dos intercambiadas
  }
  return restA.length > restB.length ? restA.slice(1) === restB : restB.slice(1) === restA;
}

/** La entrada de la tabla a la que más se parece una palabra mal escrita (solo si es una y de un fallo), o `null`. */
function fuzzyFood(word: string, index: Index): FoodEntry | null {
  if (word.length < 5 || /\d/.test(word)) return null;
  const forms = [word, ...wordForms(word)];
  const found = new Set<FoodEntry>();
  for (const single of index.singles) if (forms.some((form) => closeEnough(form, single.word))) found.add(single.entry);
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * La palabra de la tabla a un fallo de `word` («tortila» → «tortilla», «desnatao» → «desnatado»), o `null` si no hay ninguna. Si hay varias
 * (género o número), la masculina; la errata no cambia la primera letra.
 */
function correctedWord(word: string, index: Index): string | null {
  if (word.length < 5 || /\d/.test(word)) return null;
  const forms = [word, ...wordForms(word)];
  const found: Array<{ word: string; uses: number }> = [];
  for (const [known, uses] of index.vocabulary) if (forms.some((form) => closeEnough(form, known))) found.push({ word: known, uses });
  if (found.length === 0) return null;
  // La más usada en la tabla («tortilla» antes que «tortita»); a igualdad, la masculina.
  return found.sort((a, b) => b.uses - a.uses || Number(b.word.endsWith('o')) - Number(a.word.endsWith('o')) || a.word.localeCompare(b.word))[0]!.word;
}

/** Las letras que en español suenan igual y se confunden al escribir (cada regla cambia UNA aparición): «croketas», «bacalao» con v, «amburguesa»… */
const SOUND_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/k(?=[ei])/, 'qu'], [/k(?=[aou])/, 'c'], [/z(?=[ei])/, 'c'], [/c(?=[ei])/, 'z'], [/s(?=[ei])/, 'c'], [/c(?=[ei])/, 's'], [/v/, 'b'], [/b/, 'v'], [/^/, 'h'], [/^h/, ''],
  [/ll/, 'y'], [/y(?=[aeiou])/, 'll'], [/g(?=[ei])/, 'j'], [/j(?=[ei])/, 'g'],
];

/** La palabra de la tabla que sale de cambiar en `word` hasta dos letras por otras que suenan igual («croketas» → «croquetas», «vacalao» → «bacalao»), o `null`. */
function phoneticWord(word: string, index: Index): string | null {
  const seen = new Set([word]);
  let level = [word];
  for (let depth = 0; depth < 2; depth++) {
    const next: string[] = [];
    for (const base of level) {
      for (const [rule, to] of SOUND_RULES) {
        const global = new RegExp(rule.source, 'g');
        for (let m = global.exec(base); m !== null; m = global.exec(base)) {
          if (m[0] === '') global.lastIndex++; // (la regla «^» no avanza sola)
          const variant = base.slice(0, m.index) + to + base.slice(m.index + m[0].length);
          if (variant.length >= 4 && !seen.has(variant)) {
            seen.add(variant);
            next.push(variant);
          }
        }
      }
    }
    level = next;
  }
  for (const variant of seen) if (variant !== word && wordForms(variant).some((form) => index.wordSet.has(form))) return variant;
  return null;
}

/** ¿Se entiende esta palabra tal cual (alimento, número, unidad, relleno…)? Si no, puede ser una errata. */
function isKnownWord(word: string, index: Index): boolean {
  const known = (form: string): boolean =>
    index.wordSet.has(form) || Object.hasOwn(NUMBER_WORDS, form) || Object.hasOwn(MULTIPLIERS, form) || Object.hasOwn(UNITS, form) || Object.hasOwn(ENERGY_WORDS, form) || Object.hasOwn(SIZES, form) || Object.hasOwn(ORDINAL_PARTS, form) || SEPARATORS.has(form) || FILLER.has(form) || COOK_WORDS.has(form) || NOT_HALF.has(form) || Object.hasOwn(LENGTHS, form) || form === 'footlong' || ['de', 'del', 'd', 'sin', 'y', 'e', 'o', 'a', 'x'].includes(form);
  return wordForms(word).some(known);
}

/** Corrige las erratas de una letra en las palabras que no se entienden (y apunta cada corrección en la propia palabra). */
function autocorrect(tokens: Token[], index: Index): void {
  for (const t of tokens) {
    if (t.kind !== 'word' || t.norm.length < 5 || isKnownWord(t.norm, index)) continue;
    const fixed = correctedWord(t.norm, index) ?? phoneticWord(t.norm, index);
    if (fixed === null) continue;
    t.original = t.raw;
    t.note = `Entendí «${t.raw}» como ${fixed}.`;
    t.norm = fixed;
    t.raw = fixed;
  }
}

/**
 * Lo que está mal en la tabla como vocabulario (lo vigila una prueba): una forma de decir repetida en dos alimentos (gana la primera, y
 * la segunda no se entendería nunca) o una palabra suelta que ya es una cantidad, una medida o un relleno (taparía a esa palabra).
 */
export function aliasProblems(table: readonly FoodEntry[]): string[] {
  const problems: string[] = [];
  const owner = new Map<string, string>();
  const reserved = (word: string): string | null => {
    for (const form of wordForms(word)) {
      if (Object.hasOwn(NUMBER_WORDS, form)) return 'un número';
      if (Object.hasOwn(MULTIPLIERS, form)) return 'un multiplicador (par, docena…)';
      if (Object.hasOwn(UNITS, form)) return 'una unidad o medida';
      if (Object.hasOwn(ENERGY_WORDS, form)) return 'una unidad de energía (kcal)';
      if (Object.hasOwn(SIZES, form)) return 'un tamaño';
      if (COOK_WORDS.has(form)) return 'una forma de cocinar';
      if (SEPARATORS.has(form) || FILLER.has(form)) return 'una palabra de relleno';
    }
    return null;
  };
  for (const entry of table) {
    for (const alias of entry.aliases) {
      const words = wordsOf(alias);
      if (words.length === 0) {
        problems.push(`«${alias}» (${entry.name}) no tiene palabras`);
        continue;
      }
      const key = words.join(' ');
      const previous = owner.get(key);
      if (previous !== undefined && previous !== entry.name) problems.push(`«${alias}» está en «${previous}» y en «${entry.name}»`);
      else owner.set(key, entry.name);
      const clash = words.length === 1 ? reserved(words[0]!) : null;
      if (clash) problems.push(`«${alias}» (${entry.name}) es ${clash}: taparía esa palabra`);
    }
  }
  return problems;
}

// ───────────────────────────── análisis ─────────────────────────────

type Part =
  | { t: 'num'; value: number; ofServing: boolean }
  | { t: 'unit'; unit: UnitKind; word: string }
  | { t: 'size'; factor: number; multi: boolean; said: string }
  | { t: 'length'; cm: number }
  | { t: 'food'; entry: FoodEntry; said: string; fuzzy: boolean }
  | { t: 'paren'; value: number; unit: UnitKind | null; word: string }
  | { t: 'cook'; method: CookMethod }
  | { t: 'plus'; value: number }
  | { t: 'de' }
  | { t: 'sin' }
  /** «otro», «otra»: otra unidad de lo último que se dijo («un kebab de pollo y otro de ternera»). */
  | { t: 'another' }
  /** `word`: la palabra o el signo que separa («con», «y», «,»). */
  | { t: 'sep'; word?: string }
  /** `soft`: una coma, que no acaba lo que se estaba contando si lo que sigue es otro ingrediente («con lechuga, tomate y cebolla»). */
  | { t: 'hard'; soft?: boolean }
  /** `some`: «unos», «unas», «varios»…: no dicen cuánto pero sí que es algo que se comió. */
  | { t: 'fill'; some?: boolean; whole?: boolean }
  | { t: 'unk'; raw: string }
  /** «300 kcal», «(450 calorías)»: lo que la persona sabe de lo que comió. */
  | { t: 'energy'; kcal: number };

/** «la tercera parte DE UNA pizza»: el «de una» que sigue a una parte no es otra cantidad. */
function skipOfArticle(tokens: Token[], at: number): number {
  const of = tokens[at]?.norm;
  if (of !== 'de' && of !== 'del') return at;
  return ['un', 'una', 'el', 'la'].includes(tokens[at + 1]?.norm ?? '') ? at + 2 : at + 1;
}

/** Lee un número («dos», «1,5», «media», «una docena», «dos y medio», «dos o tres», «un poco de») que empieza en `at`. */
function readNumber(tokens: Token[], at: number): { value: number; next: number; ofServing: boolean } | null {
  const first = tokens[at]!;
  let value: number;
  let next = at + 1;
  // «la tercera parte de la tarta», «una quinta parte»: 1 / n.
  if (first.kind === 'word' && lookupWord(ORDINAL_PARTS, first.norm) !== undefined && /^partes?$/.test(tokens[at + 1]?.norm ?? '')) {
    return { value: 1 / lookupWord(ORDINAL_PARTS, first.norm)!, next: skipOfArticle(tokens, at + 2), ofServing: false };
  }
  // «poquito de arroz», «un poco de»: la mitad de una ración.
  if (first.kind === 'word' && ['poco', 'poquito', 'poca', 'poquita'].includes(first.norm) && tokens[at + 1]?.norm === 'de') return { value: 0.5, next: at + 1, ofServing: true };
  if (first.kind === 'num') value = first.value;
  else if (first.kind === 'word' && Object.hasOwn(HALVES, first.norm)) {
    value = HALVES[first.norm]!;
    if (NOT_HALF.has(tokens[at + 1]?.norm ?? '')) return null;
    // «la mitad de una pizza», «la mitad del bocadillo»: el «de una» no es otra cantidad.
    if (first.norm === 'mitad' && (tokens[at + 1]?.norm === 'de' || tokens[at + 1]?.norm === 'del')) {
      next = at + 2;
      if (['un', 'una', 'el', 'la'].includes(tokens[next]?.norm ?? '')) next++;
      return { value, next, ofServing: false };
    }
  } else if (first.kind === 'word' && readWordNumber(tokens, at)) {
    const words = readWordNumber(tokens, at)!;
    value = words.value;
    next = words.next;
  } else if (first.kind === 'word' && Object.hasOwn(MULTIPLIERS, first.norm)) {
    value = 1; // «par de», «docena de» sin número delante
    next = at;
  } else return null;

  for (;;) {
    const word = tokens[next];
    if (word?.kind === 'word' && lookupWord(MULTIPLIERS, word.norm) !== undefined) {
      value *= lookupWord(MULTIPLIERS, word.norm)!;
      next++;
    } else if (word?.kind === 'word' && (word.norm === 'cuarto' || word.norm === 'cuartos') && value >= 1 && Number.isInteger(value)) {
      value *= 0.25;
      next++;
    } else if (word?.kind === 'word' && lookupWord(ORDINAL_PARTS, word.norm) !== undefined && /^partes?$/.test(tokens[next + 1]?.norm ?? '') && value >= 1 && Number.isInteger(value)) {
      value /= lookupWord(ORDINAL_PARTS, word.norm)!; // «una tercera parte», «dos terceras partes»
      next = skipOfArticle(tokens, next + 2);
    } else break;
  }
  if (tokens[next]?.norm === 'y' && (tokens[next + 1]?.norm === 'medio' || tokens[next + 1]?.norm === 'media') && Number.isInteger(value) && value >= 1) {
    value += 0.5;
    next += 2;
  } else if (tokens[next]?.norm === 'o' && value > 0) {
    const other = readNumber(tokens, next + 1);
    if (other && other.next > next + 1 && !other.ofServing && other.value > 0) {
      value = (value + other.value) / 2;
      next = other.next;
    }
  }
  const after = tokens[next]?.norm;
  if (after === 'poco' || after === 'poquito' || after === 'poca' || after === 'poquita') return { value: 0.5, next: next + 1, ofServing: true };
  return { value, next, ofServing: false };
}

/** La palabra que une el alimento `k` con lo anterior: «con», «y», una coma, «de»… (o `null` si empieza una frase). */
function connectorBefore(parts: readonly Part[], k: number): string | null {
  for (let j = k - 1; j >= 0; j--) {
    const before = parts[j]!;
    if (before.t === 'fill' || before.t === 'size' || before.t === 'cook' || before.t === 'length' || before.t === 'hard') continue;
    if (before.t === 'de') return 'de';
    if (before.t === 'sep') return before.word ?? null;
    return null;
  }
  return null;
}

/** Con comida rápida, «patatas» son patatas fritas (no la patata cocida de la tabla). */
const FAST_FOOD_POTATO = { generic: 'Patata cocida', fried: 'Patatas fritas' } as const;

/** «de 200 g» («de 1,5 kg», «de 33 cl») detrás de un alimento: el peso o el volumen y su unidad. */
function weightAfterDe(parts: readonly Part[], k: number): { value: number; unit: UnitKind; word: string } | null {
  const amount = parts[k + 2];
  const unit = parts[k + 3];
  const after = parts[k + 4];
  if (amount?.t !== 'num' || amount.ofServing || unit?.t !== 'unit' || (unit.unit.kind !== 'mass' && unit.unit.kind !== 'volume')) return null;
  if (after !== undefined && after.t !== 'sep' && after.t !== 'cook' && after.t !== 'hard') return null;
  return { value: amount.value, unit: unit.unit, word: unit.word };
}

/** «de 9» detrás de un alimento que se cuenta por unidades («mcnuggets de 9»): el número y cuántas partes ocupa (el «de», el número y, si lo hay, «unidades»). */
function countOf(parts: readonly Part[], k: number): { value: number; used: number } | null {
  const count = parts[k + 2];
  const after = parts[k + 3];
  if (count?.t !== 'num' || count.ofServing || !Number.isInteger(count.value) || count.value < 2) return null;
  if (after === undefined || after.t === 'sep' || after.t === 'hard' || after.t === 'cook') return { value: count.value, used: 2 };
  if (after.t === 'unit' && after.unit.kind === 'each') return { value: count.value, used: 3 };
  return null;
}

/** Una cifra suelta detrás de un alimento («croquetas 6», «arroz 200»): de 1 a 24 son unidades (si se cuenta por unidades) y de 25 en adelante, gramos (o ml). */
function bareQuantity(entry: FoodEntry, value: number): Pick<Pending, 'num' | 'unit'> | null {
  if (Number.isInteger(value) && value >= 1 && value <= 24 && entry.each !== null) return { num: value, unit: null };
  if (value >= 25 && value <= 5000) return { num: value, unit: { unit: { kind: entry.liquid ? 'volume' : 'mass', factor: 1 }, word: entry.liquid ? 'ml' : 'g' } };
  return null;
}

const lookupWord = <T>(table: Readonly<Record<string, T>>, word: string): T | undefined => {
  for (const form of wordForms(word)) if (Object.hasOwn(table, form)) return table[form];
  return undefined;
};

function classify(tokens: Token[], index: Index): { parts: Part[]; notes: string[] } {
  const parts: Part[] = [];
  const notes: string[] = [];
  autocorrect(tokens, index);
  // Las palabras corregidas que acaban sin entenderse vuelven a como se escribieron (y no se avisa de la corrección): así se buscan tal cual entre los productos.
  const unsolved = new Set<Token>();
  const words = tokens.filter((t) => t.kind !== 'sep').map((t) => t.norm);
  // Posición de cada token entre las palabras (los separadores no cuentan).
  const wordIndex: number[] = [];
  let n = 0;
  for (const t of tokens) wordIndex.push(t.kind === 'sep' ? -1 : n++);

  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]!;
    if (t.kind === 'sep') {
      // «croquetas (6)», «pizza (4 porciones)», «arroz (200 g)»: la cantidad entre paréntesis es de lo que acaba de decirse.
      const amount = tokens[i + 1];
      if ((t.raw === '(' || t.raw === '[') && amount?.kind === 'num') {
        const maybeUnit = tokens[i + 2];
        // «tarta de queso (300 kcal)»: las calorías de lo que acaba de decirse.
        const closingEnergy = tokens[i + 3];
        if (maybeUnit?.kind === 'word' && lookupWord(ENERGY_WORDS, maybeUnit.norm) !== undefined && closingEnergy?.kind === 'sep' && (closingEnergy.raw === ')' || closingEnergy.raw === ']')) {
          parts.push({ t: 'energy', kcal: amount.value });
          i += 4;
          continue;
        }
        const unit = maybeUnit?.kind === 'word' ? lookupWord(UNITS, maybeUnit.norm) : undefined;
        const closing = tokens[unit ? i + 3 : i + 2];
        if (closing?.kind === 'sep' && (closing.raw === ')' || closing.raw === ']')) {
          parts.push({ t: 'paren', value: amount.value, unit: unit ?? null, word: maybeUnit?.norm ?? '' });
          i += unit ? 4 : 3;
          continue;
        }
      }
      parts.push({ t: 'sep', word: t.raw });
      if (/[.;]/.test(t.raw)) parts.push({ t: 'hard' });
      else if (t.raw.includes(',')) parts.push({ t: 'hard', soft: true });
      i++;
      continue;
    }
    // Los alimentos se buscan sobre palabras seguidas (sin separadores entre ellas).
    let run = 0;
    while (i + run < tokens.length && tokens[i + run]!.kind !== 'sep') run++;
    const food = matchFood(words.slice(wordIndex[i]!, wordIndex[i]! + run), 0, index);
    if (food && tokens[i + food.length]?.raw === ':' && food.length === run) {
      // «sushi: 8 nigiris y 6 makis»: un alimento seguido de dos puntos es el título de la lista, no una ración.
      i += food.length;
      continue;
    }
    if (food) {
      // «footlong de atún»: lo largo que es va delante del alimento, como si se hubiera dicho aparte («30 cm»).
      if (words[wordIndex[i]!] === 'footlong') parts.push({ t: 'length', cm: 30 });
      parts.push({ t: 'food', entry: food.entry, said: tokens.slice(i, i + food.length).map((x) => x.raw).join(' '), fuzzy: false });
      // «patatas grandes», «coca cola pequeña»: si lo reconocido acaba en un tamaño, vale como si se hubiera dicho aparte (en un menú, «grande» es de eso).
      const lastWord = words[wordIndex[i]! + food.length - 1];
      // («extra» no: es una categoría —«cerveza extra», «aceite virgen extra»—, no un tamaño).
      const endsInSize = !food.literal && food.length > 1 && lastWord !== undefined && lastWord !== 'extra' ? lookupWord(SIZES, lastWord) : undefined;
      if (endsInSize !== undefined && lastWord !== undefined) parts.push({ t: 'size', factor: endsInSize, multi: isMulti(lastWord), said: lastWord });
      i += food.length;
      continue;
    }
    // «300 kcal», «450 calorías»: lo que dice la persona; no son gramos ni unidades.
    if (t.kind === 'num' && tokens[i + 1]?.kind === 'word' && lookupWord(ENERGY_WORDS, tokens[i + 1]!.norm) !== undefined) {
      parts.push({ t: 'energy', kcal: t.value });
      i += 2;
      continue;
    }
    // «30 cm», «6 pulgadas»: lo largo que es un bocadillo (solo cuenta en los que se piden así: `cm=` en la tabla).
    const lengthWord = tokens[i + 1]?.kind === 'word' ? lookupWord(LENGTHS, tokens[i + 1]!.norm) : undefined;
    if (t.kind === 'num' && lengthWord !== undefined) {
      parts.push({ t: 'length', cm: t.value * lengthWord });
      i += 2;
      continue;
    }
    if (t.norm === 'footlong') {
      parts.push({ t: 'length', cm: 30 });
      i++;
      continue;
    }
    const num = readNumber(tokens, i);
    if (num) {
      parts.push({ t: 'num', value: num.value, ofServing: num.ofServing });
      i = num.next;
      continue;
    }
    if (t.kind === 'num') {
      i++;
      continue;
    }
    const cook = matchCook(words, wordIndex[i]!);
    if (cook && wordIndex[i]! + cook.length <= wordIndex[i]! + run) {
      parts.push({ t: 'cook', method: cook.method });
      i += cook.length;
      continue;
    }
    // «huevos sobre tostada», «salmón sobre pan»: ahí «sobre» es una preposición. Es la medida (un sobre de azúcar) solo con «de» detrás o sin nada detrás.
    const afterSobre = tokens[i + 1];
    if (/^sobres?$/.test(t.norm) && afterSobre?.kind === 'word' && afterSobre.norm !== 'de') {
      parts.push({ t: 'fill' });
      i++;
      continue;
    }
    const unit = lookupWord(UNITS, t.norm);
    if (unit && tokens[i + 1]?.raw === ':') {
      // «tapas: croquetas y bravas»: una medida seguida de dos puntos es el título de la lista, no una cantidad.
      parts.push({ t: 'fill' });
    } else if (unit) {
      parts.push({ t: 'unit', unit, word: t.norm });
      // «una taza y media», «ración y media».
      const joiner = tokens[i + 1];
      const half = tokens[i + 2];
      if (joiner?.norm === 'y' && (half?.norm === 'medio' || half?.norm === 'media') && !NOT_HALF.has(tokens[i + 3]?.norm ?? '')) {
        parts.push({ t: 'plus', value: 0.5 });
        i += 2;
      }
    } else if (t.norm === 'de' || t.norm === 'del' || t.norm === 'd') {
      parts.push({ t: 'de' });
    } else if (t.norm === 'sin' || t.norm === 'excepto' || t.norm === 'salvo' || (t.norm === 'menos' && ALL_WORDS.has(tokens[i - 1]?.norm ?? ''))) {
      // «con todo menos cebolla», «de todo excepto la salsa» (pero no «más o menos 200 g»): lo que viene se quita.
      parts.push({ t: 'sin' });
    } else if (ANOTHER.has(t.norm)) {
      parts.push({ t: 'another' });
    } else if (lookupWord(SIZES, t.norm) !== undefined) {
      parts.push({ t: 'size', factor: lookupWord(SIZES, t.norm)!, multi: isMulti(t.norm), said: t.raw });
    } else if (SEPARATORS.has(t.norm)) {
      parts.push({ t: 'sep', word: t.norm });
    } else if (FILLER.has(t.norm) || wordForms(t.norm).some((form) => FILLER.has(form))) {
      parts.push({ t: 'fill', some: SOME_WORDS.has(t.norm), whole: /^enter[oa]s?$/.test(t.norm) });
    } else {
      const guess = fuzzyFood(t.norm, index);
      if (guess) {
        parts.push({ t: 'food', entry: guess, said: t.raw, fuzzy: true });
        notes.push(`Entendí «${t.raw}» como ${guess.name.toLowerCase()}.`);
      } else {
        parts.push({ t: 'unk', raw: t.original ?? t.raw });
        unsolved.add(t);
      }
    }
    i++;
  }
  for (const t of tokens) if (t.note !== undefined && !unsolved.has(t)) notes.push(t.note);
  return { parts, notes };
}

interface Pending {
  /** Se dijo en plural y sin número («huevos fritos», «croquetas»): varias unidades, o sea, una ración. */
  plural: boolean;
  num: number | null;
  ofServing: boolean;
  unit: { unit: UnitKind; word: string } | null;
  size: number | null;
  /** «Doble» o «triple»: más carne en el plato, no un plato más grande. */
  multi: number | null;
  /** Lo largo que se pidió (cm), para los bocadillos que se piden por longitud. */
  cm: number | null;
  /** Lo que pesa (o mide) cada uno, dicho tras el nombre: «una hamburguesa de 200 g», «dos filetes de 300 g». */
  weight: { value: number; unit: UnitKind } | null;
  /** La medida casera que se dijo antes de dar los gramos o mililitros («un filete de 300 g», «una lata de 330 ml»): sirve para saber de qué alimento se habla si no se dice. */
  carrier: Measure | null;
  /** Cómo se cocinó, si se dijo («pollo frito», «a la plancha»). */
  cook: CookMethod | null;
  /** Se dijo «entero» de algo que se compra entero («un pollo asado entero», «una tarta entera»): pesa lo que pesa entero, no una ración. */
  entire: boolean;
}

const fresh = (): Pending => ({ plural: false, num: null, ofServing: false, unit: null, size: null, multi: null, cm: null, weight: null, carrier: null, cook: null, entire: false });

/** ¿Lo dicho acaba en plural («huevos», «croquetas»)? */
const isPlural = (said: string): boolean => {
  const words = said.split(/\s+/).map(foldAccents);
  return [words[0], words[words.length - 1]].some((word) => word !== undefined && word.length > 3 && word.endsWith('s') && wordForms(word).length > 1);
};

const fmtCount = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10).replace('.', ','));

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** La cantidad de un alimento según lo que se dijo; `assumed` si se tuvo que suponer. */
function quantity(entry: FoodEntry, p: Pending): { amount: number; assumed: boolean; count: number | null } {
  // Un bocadillo pedido por longitud («de 30 cm») es tantas veces el de la tabla como veces cabe su medida; «doble» pone el doble de todo salvo en un plato compuesto.
  const length = entry.lengthCm !== null && p.cm !== null ? p.cm / entry.lengthCm : 1;
  const size = (p.size ?? 1) * (p.multi ?? 1) * length;
  const unit = p.unit?.unit;
  const num = p.num;
  // «Dos filetes de 300 g»: cada uno pesa lo dicho.
  if (p.weight !== null) {
    const each = p.weight.unit.kind === 'mass' ? (p.weight.value * p.weight.unit.factor) / (entry.liquid ? entry.density : 1) : p.weight.value * (p.weight.unit.kind === 'volume' ? p.weight.unit.factor : 1);
    return { amount: (num ?? 1) * each * size, assumed: false, count: num };
  }
  // Una masa en un líquido se pasa a mililitros (los líquidos se cuentan en ml).
  if (unit?.kind === 'mass') return { amount: ((num ?? 1) * unit.factor) / (entry.liquid ? entry.density : 1), assumed: false, count: null };
  if (unit?.kind === 'volume') return { amount: (num ?? 1) * unit.factor, assumed: false, count: null };
  if (unit?.kind === 'measure') {
    const specific = entry.measures[unit.measure];
    const generic = (entry.liquid ? GENERIC_LIQUID : GENERIC_SOLID)[unit.measure];
    // «plato», «porción»: sin medida propia, una ración.
    const assumed = specific === undefined && generic === undefined && unit.measure !== 'plato' && unit.measure !== 'porcion';
    return { amount: (num ?? 1) * (specific ?? generic ?? entry.serving) * size * (unit.scale ?? 1), assumed, count: null };
  }
  if (unit?.kind === 'serving') return { amount: (num ?? 1) * entry.serving * size * (unit.scale ?? 1), assumed: false, count: null };
  if (unit?.kind === 'each') return entry.each !== null ? { amount: (num ?? 1) * entry.each * size, assumed: false, count: num ?? 1 } : { amount: (num ?? 1) * entry.serving * size, assumed: true, count: null };
  if (p.entire && entry.whole !== null) return { amount: (num ?? 1) * entry.whole * size, assumed: false, count: null };
  if (num !== null && p.ofServing) return { amount: num * entry.serving, assumed: true, count: null };
  // «media tarta», «medio melón»: una fracción de algo que se compra entero se calcula sobre lo que pesa entero.
  if (num !== null && num < 1 && entry.whole !== null) return { amount: num * entry.whole * size, assumed: false, count: null };
  // «diez cacahuetes», «quince patatas fritas»: muchas unidades de algo que la tabla no cuenta por unidades; cada una pesa la décima parte de una ración.
  if (num !== null && num >= 7 && Number.isInteger(num) && entry.each === null && !entry.liquid) return { amount: (num * entry.serving * size) / 10, assumed: true, count: num };
  if (num !== null) return entry.each !== null ? { amount: num * entry.each * size, assumed: false, count: num } : { amount: num * entry.serving * size, assumed: false, count: null };
  // Sin cantidad: «un café» es una unidad natural si la hay (y «huevos» o «croquetas», en plural, una ración); si no, una ración.
  if (entry.each !== null && !p.plural && !entry.bareServing) return { amount: entry.each * size, assumed: true, count: 1 };
  return { amount: entry.serving * size, assumed: true, count: null };
}

/** Cuánto relleno se pone por defecto de un alimento que no trae `rell=` en la tabla. */
const FILLING_DEFAULT_G = 40;

function itemOf(entry: FoodEntry, p: Pending, asFilling: boolean): TextItem {
  // Lo que va dentro de un bocadillo, un sándwich o un wrap («un bocadillo de pavo y queso») o encima de un plato («una tortilla con cebolla») se cuenta
  // como relleno (lo que se pone de eso), no como una ración entera.
  const filling = asFilling && !entry.container && entry.role !== 'bebida' && p.num === null && p.unit === null;
  const q = filling ? { amount: (entry.filling ?? Math.min(entry.serving, FILLING_DEFAULT_G)) * (p.size ?? 1), assumed: false, count: null } : quantity(entry, p);
  const amount = Math.min(MAX_AMOUNT, Math.round(q.amount * 10) / 10);
  const mass = entry.liquid ? amount * entry.density : amount;
  const factor = mass / 100;
  // La forma de cocinar solo cuenta en los alimentos que cambian con ella (`coc=` en la tabla); en los demás se ignora.
  const raw = p.cook === 'crudo' && entry.cook !== null ? RAW_FACTOR[entry.cook] : 1;
  const added = p.cook !== null && p.cook !== 'crudo' && entry.cook !== null ? COOKING[entry.cook][p.cook] : undefined;
  const proteinG = (entry.proteinG + (added?.p ?? 0)) * raw;
  const carbsG = (entry.carbsG + (added?.c ?? 0)) * raw;
  const fatG = (entry.fatG + (added?.f ?? 0)) * raw;
  const kcal = (entry.kcal + (added ? 4 * added.p + 4 * added.c + 9 * added.f : 0)) * raw;
  const extra = added !== undefined && p.cook !== null ? COOKING_EXTRAS[p.cook] : undefined;
  const fiberG = (entry.fiberG + (extra?.fiberG ?? 0)) * raw;
  const sugarsG = (entry.sugarsG + (extra?.sugarsG ?? 0)) * raw;
  const saltG = (entry.saltG + (extra?.saltG ?? 0)) * raw;
  const how = (added || raw !== 1) && p.cook ? ` (${COOK_LABEL[p.cook]})` : '';
  return {
    name: `${q.count !== null && q.count !== 1 ? `${entry.name} ×${fmtCount(q.count)}` : entry.name}${how}`,
    amount: Math.round(amount),
    unit: entry.liquid ? 'ml' : 'g',
    kcal: Math.round(kcal * factor),
    proteinG: round1(proteinG * factor),
    carbsG: round1(carbsG * factor),
    fatG: round1(fatG * factor),
    fiberG: round1(fiberG * factor),
    sugarsG: round1(sugarsG * factor),
    saltG: round2(saltG * factor),
    assumed: q.assumed,
  };
}

// ───────────────────────────── platos compuestos ─────────────────────────────

// «Un kebab de ternera con cebolla y salsa blanca»: un plato compuesto (`= pieza + pieza…` en la tabla) trae sus piezas de serie (pan, carne,
// verdura, salsa…) y lo que se nombra detrás las ajusta. Un ingrediente sustituye a la pieza de su mismo rol si el plato la marca como sustituible
// («con cebolla» quita la lechuga y el tomate de serie; «de ternera» cambia la carne); si no, se suma («hamburguesa con queso y bacon»). «Sin cebolla»
// la quita, y «doble de queso», «extra de salsa» la multiplican. Lo que no es un ingrediente del plato («y un café») lo cierra y cuenta aparte.

/** Los roles que se pegan a cualquier plato, aunque no los lleve de serie («hamburguesa con queso»). */
const ADDITIVE_ROLES: ReadonlySet<FoodRole> = new Set<FoodRole>(['proteina', 'topping', 'queso', 'verdura', 'salsa', 'guarnicion']);

/** Las palabras tras las que se sigue hablando del mismo plato («con cebolla y salsa blanca», «con lechuga, tomate y cebolla»). */
const DISH_CONNECTORS: ReadonlySet<string> = new Set(['con', 'y', 'e', 'ni', ',']);

/** Lo mismo para un plato que no es compuesto («una tortilla con cebolla y pimientos», «un bocadillo de jamón más queso»). */
const HOST_CONNECTORS: ReadonlySet<string> = new Set([...DISH_CONNECTORS, 'mas']);

/** Entre los sabores de un helado o un batido («de fresa y vainilla»). */
const FLAVOR_CONNECTORS: ReadonlySet<string> = new Set(['y', 'e', ',']);

/** Lo que se pone dentro o encima de otro plato («una tortilla con cebolla», «huevos con bacon»), no una ración aparte. */
const GARNISH_ROLES: ReadonlySet<FoodRole> = new Set<FoodRole>(['proteina', 'topping', 'verdura', 'salsa', 'queso']);

const isGarnish = (entry: FoodEntry): boolean => !entry.container && entry.role !== null && GARNISH_ROLES.has(entry.role);

/** Lo que se está contando: un bocadillo o similar (todo lo que se nombre detrás es relleno suyo) o cualquier otro plato (solo los ingredientes que se le echan). */
type Host = 'container' | 'plain';

interface DishPart {
  entry: FoodEntry;
  /** Lo que pesa una vez (g, o ml si es un líquido); se multiplica por `mult` (el «doble de») y por la cantidad del plato. */
  amount: number;
  mult: number;
  slot: FoodRole | null;
}

interface DishMention {
  kind: 'de' | 'con' | 'sin';
  /** Cómo lo dijo la persona («ternera», «salsa blanca»): es lo que lleva el nombre del plato. */
  label: string;
}

interface Dish {
  entry: FoodEntry;
  /** Cómo se pidió el plato entero (cantidad, tamaño). */
  pending: Pending;
  /** Dónde está su alimento entre los calculados. */
  itemIndex: number;
  parts: DishPart[];
  mentions: DishMention[];
  /** Los roles sustituibles del plato, y cuáles ya se han cambiado por lo que se nombró. */
  slots: ReadonlySet<FoodRole>;
  replaced: Set<FoodRole>;
}

function startDish(entry: FoodEntry, pending: Pending, itemIndex: number): Dish {
  const recipe = entry.recipe ?? [];
  return {
    entry,
    pending,
    itemIndex,
    parts: recipe.map((part) => ({ entry: part.entry, amount: part.amount, mult: 1, slot: part.slot })),
    mentions: [],
    slots: new Set(recipe.flatMap((part) => (part.slot === null ? [] : [part.slot]))),
    replaced: new Set(),
  };
}

/** ¿Lo nombrado detrás del plato es un ingrediente suyo? Lo que se reconoce pero no suma (la sal) se da por dicho sin cambiar nada. */
function bindsToDish(entry: FoodEntry, dish: Dish): boolean {
  if (entry.recipe !== null) return false;
  if (entry.ignore) return true;
  return entry.role !== null && (dish.slots.has(entry.role) || ADDITIVE_ROLES.has(entry.role));
}

/** Lo que se pone de un ingrediente: lo habitual como relleno, o lo que llevaba cada pieza que sustituye. */
function amountOfIngredient(dish: Dish, entry: FoodEntry, role: FoodRole): number {
  // Lo que sustituye a una pieza del plato (la carne, la bebida del menú) pesa lo que ella; lo que se añade, lo que se pone de relleno.
  const originals = (dish.entry.recipe ?? []).filter((part) => part.slot === role);
  if (originals.length > 0) return originals.reduce((sum, part) => sum + part.amount, 0) / originals.length;
  // Un acompañamiento («con patatas», «con arroz») es una ración; lo demás, lo que se echa por encima.
  if (role === 'guarnicion') return entry.serving;
  return entry.filling ?? Math.min(entry.serving, FILLING_DEFAULT_G);
}

function addIngredient(dish: Dish, entry: FoodEntry, factor: number, kind: 'de' | 'con', label: string): void {
  if (entry.ignore || entry.role === null) return;
  const role = entry.role;
  const slotted = dish.slots.has(role);
  if (slotted && !dish.replaced.has(role)) {
    dish.parts = dish.parts.filter((part) => part.slot !== role);
    dish.replaced.add(role);
  }
  const already = dish.parts.find((part) => part.entry === entry);
  if (already) {
    already.mult *= factor;
  } else {
    dish.parts.push({ entry, amount: amountOfIngredient(dish, entry, role), mult: factor, slot: slotted ? role : null });
    dish.mentions.push({ kind, label });
  }
  // Si el plato llevaba una sola pieza de ese rol (la carne), lo que se nombra se reparte lo que ella pesaba («kebab de ternera y pollo»).
  const originals = (dish.entry.recipe ?? []).filter((part) => part.slot === role);
  if (slotted && originals.length === 1) {
    const mine = dish.parts.filter((part) => part.slot === role);
    for (const part of mine) part.amount = originals[0]!.amount / mine.length;
  }
}

/** Las palabras generales que, en un «sin», quitan todo lo de su grupo («sin salsa», «sin verdura», «sin ensalada», «sin queso»). */
const GENERIC_GROUP: Readonly<Record<string, readonly FoodRole[]>> = {
  Salsa: ['salsa'],
  Verduras: ['verdura'],
  Ensalada: ['verdura', 'guarnicion'],
  Queso: ['queso'],
  Bebida: ['bebida'],
};

/** «Sin patatas» quita las patatas, no el resto del acompañamiento (la ensalada). */
const POTATOES: ReadonlySet<string> = new Set(['Patata cocida', 'Patatas fritas', 'Patatas de cadena']);

/** Lo que quita de un plato una palabra general en un «sin» («sin salsa», «sin queso», «sin patatas»); nada si la palabra no es general. */
function genericParts(dish: Dish, entry: FoodEntry): DishPart[] {
  if (POTATOES.has(entry.name)) return dish.parts.filter((part) => POTATOES.has(part.entry.name));
  const groups = GENERIC_GROUP[entry.name] ?? [];
  return dish.parts.filter((part) => groups.some((group) => part.slot === group || part.entry.role === group));
}

function removeIngredient(dish: Dish, entry: FoodEntry, label: string): void {
  const exact = dish.parts.filter((part) => part.entry === entry);
  if (exact.length > 0) dish.parts = dish.parts.filter((part) => part.entry !== entry);
  else {
    // «Sin salsa», «sin queso»: si no llevaba justo eso, se quita todo lo de ese grupo que llevara de serie («sin cebolla» en algo que no la lleva no quita la lechuga).
    const gone = genericParts(dish, entry);
    dish.parts = dish.parts.filter((part) => !gone.includes(part));
    for (const group of GENERIC_GROUP[entry.name] ?? []) if (dish.slots.has(group)) dish.replaced.add(group);
  }
  dish.mentions.push({ kind: 'sin', label });
}

/** ¿Lleva el plato ahora lo que se nombra (esa pieza o, si es una palabra general como «salsa», algo de su grupo)? */
function dishHas(dish: Dish, entry: FoodEntry): boolean {
  return dish.parts.some((part) => part.entry === entry) || genericParts(dish, entry).length > 0;
}

/** «Con ensalada» en un plato que ya lleva su verdura (un kebab, una hamburguesa): es esa verdura, no una ensalada más. */
const isTheirSalad = (dish: Dish, entry: FoodEntry): boolean =>
  entry.name === 'Ensalada' && dish.parts.some((part) => part.entry.role === 'verdura') && !dish.parts.some((part) => part.entry === entry);

/** «a, b y c» */
const listed = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`);

/** El nombre del plato con lo que se pidió: «Kebab de ternera con cebolla y salsa blanca». */
function dishName(dish: Dish): string {
  // «Café con leche con leche desnatada» → «Café con leche desnatada»: lo que afina la última palabra del nombre va pegado a ella.
  const tail = dish.entry.name.slice(dish.entry.name.lastIndexOf(' ') + 1).toLowerCase();
  const refines = (mention: DishMention): boolean => mention.kind === 'con' && mention.label.toLowerCase().startsWith(`${tail} `);
  const names = (kind: DishMention['kind']): string =>
    listed([...new Set(dish.mentions.filter((mention) => mention.kind === kind && !refines(mention)).map((mention) => mention.label))]);
  const refined = listed([...new Set(dish.mentions.filter(refines).map((mention) => mention.label.slice(tail.length + 1)))]);
  const de = names('de');
  const con = names('con');
  const sin = names('sin');
  const many = dish.pending.multi === 2 ? ' doble' : dish.pending.multi === 3 ? ' triple' : '';
  return `${dish.entry.name}${refined ? ` ${refined}` : ''}${many}${de ? ` de ${de}` : ''}${con ? ` con ${con}` : ''}${sin ? ` sin ${sin}` : ''}`.slice(0, MAX_MEAL_NAME);
}

/** Lo calculado de un plato compuesto con lo que lleva ahora: una pieza por ingrediente y su suma. */
function dishItem(dish: Dish): TextItem {
  const { entry, pending } = dish;
  // En un menú, «grande» o «mediano» cambia las patatas y la bebida, no la hamburguesa; «doble» pone más carne, no un plato más grande.
  const sides = entry.menu ? (pending.size ?? 1) : 1;
  // «Una hamburguesa de 200 g»: el peso es el de la carne (`peso=proteina`); lo demás del plato se queda como estaba.
  const weighed = entry.weightOf !== null && pending.weight?.unit.kind === 'mass' ? pending.weight.value * pending.weight.unit.factor * (pending.num ?? 1) : null;
  const q = quantity(entry, { ...pending, weight: weighed === null ? pending.weight : null, size: entry.menu ? null : pending.size, multi: null, cm: null });
  const amount = Math.min(MAX_AMOUNT, q.amount);
  // Las cantidades de la tabla son las del plato con sus piezas de serie; si se cambian, lo que se pidió (una unidad, 300 g) sigue siendo eso.
  const factor = amount / (entry.each ?? entry.serving);
  let mass = 0;
  let kcal = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  let fiberG = 0;
  let sugarsG = 0;
  let saltG = 0;
  const wanted = weighed === null ? null : dish.parts.filter((part) => part.slot === entry.weightOf).reduce((sum, part) => sum + part.amount * part.mult * factor, 0);
  const heavier = weighed !== null && wanted !== null && wanted > 0 ? weighed / wanted : 1;
  const parts = dish.parts.map((part): TextItem => {
    const scale = part.slot === entry.weightOf && weighed !== null ? heavier : part.slot === 'proteina' ? (pending.multi ?? 1) : part.slot === 'bebida' || part.slot === 'guarnicion' ? sides : 1;
    const piece = part.amount * part.mult * factor * scale;
    const grams = part.entry.liquid ? piece * part.entry.density : piece;
    mass += grams;
    kcal += (part.entry.kcal * grams) / 100;
    proteinG += (part.entry.proteinG * grams) / 100;
    carbsG += (part.entry.carbsG * grams) / 100;
    fatG += (part.entry.fatG * grams) / 100;
    fiberG += (part.entry.fiberG * grams) / 100;
    sugarsG += (part.entry.sugarsG * grams) / 100;
    saltG += (part.entry.saltG * grams) / 100;
    return {
      name: part.entry.name,
      amount: Math.round(piece),
      unit: part.entry.liquid ? 'ml' : 'g',
      kcal: Math.round((part.entry.kcal * grams) / 100),
      proteinG: round1((part.entry.proteinG * grams) / 100),
      carbsG: round1((part.entry.carbsG * grams) / 100),
      fatG: round1((part.entry.fatG * grams) / 100),
      fiberG: round1((part.entry.fiberG * grams) / 100),
      sugarsG: round1((part.entry.sugarsG * grams) / 100),
      saltG: round2((part.entry.saltG * grams) / 100),
      assumed: false,
    };
  });
  const name = dishName(dish);
  return {
    name: q.count !== null && q.count !== 1 ? `${name} ×${fmtCount(q.count)}` : name,
    // Una bebida compuesta se cuenta en ml sumando lo que lleva (el café y la leche, el polvo de cacao y la leche).
    amount: Math.round(entry.liquid ? parts.reduce((total, part) => total + part.amount, 0) : mass),
    unit: entry.liquid ? 'ml' : 'g',
    kcal: Math.round(kcal),
    proteinG: round1(proteinG),
    carbsG: round1(carbsG),
    fatG: round1(fatG),
    fiberG: round1(fiberG),
    sugarsG: round1(sugarsG),
    saltG: round2(saltG),
    assumed: q.assumed,
    parts,
  };
}

// ───────────────────────────── productos envasados ─────────────────────────────

/**
 * Cómo se busca un producto por las palabras de su nombre y su marca en la base de productos de la app (`food-db-search.ts`). Sin él, el análisis solo
 * usa la tabla de alimentos; con él, lo que la tabla no entiende («kinder bueno white», «tarta de la abuela») se busca entre los productos envasados.
 */
export type ProductLookup = (words: readonly string[]) => readonly ProductHit[];

/**
 * Lo que se supone que pesa un producto envasado cuando ni se dice cuánto ni la base trae su ración, según lo calórico que es por 100 g (una chocolatina
 * o unas patatas de bolsa se comen en 30 g; un yogur, un plato o una bebida, en cantidades mayores).
 */
const productDefaultG = (kcalPer100: number): number => (kcalPer100 >= 450 ? 30 : kcalPer100 >= 250 ? 50 : kcalPer100 >= 120 ? 100 : 200);

/** Una parte del texto entre dos «con», «y», comas…: sus palabras (las de los alimentos reconocidos y las que no) y dónde empiezan sus alimentos. */
interface Segment {
  start: number;
  words: string[];
  /** Las mismas palabras tal como se escribieron (con tildes y mayúsculas): el nombre de lo que se anota si hay que ponerle uno. */
  raw: string[];
  unknownFrom: number;
  pending: Pending | null;
  /** Se dijo cuánto («una», «dos», «una bolsa de», «unas»): sin eso, una palabra desconocida suelta no se busca entre los productos. */
  cue: boolean;
}

/** El nombre de un producto envasado tal como se anota: el suyo y, si no lo lleva ya, su marca. */
function productName(hit: ProductHit): string {
  const brand = hit.brand.trim();
  const name = hit.name.trim();
  const letters = (text: string): string => foldAccents(text).replace(/[^a-z0-9]/g, '');
  const withBrand = brand !== '' && !letters(name).includes(letters(brand)) ? `${name} (${brand})` : name;
  return withBrand.slice(0, 60);
}

/** Lo calculado de un producto envasado: sus cifras son las de su etiqueta (por 100 g) y la cantidad, la dicha o su ración. */
function productItem(hit: ProductHit, p: Pending, replacedG: number): TextItem {
  const unit = p.unit?.unit;
  const size = (p.size ?? 1) * (p.multi ?? 1);
  let grams: number;
  let assumed = false;
  if (unit?.kind === 'mass' || unit?.kind === 'volume') grams = (p.num ?? 1) * unit.factor;
  else if (unit?.kind === 'measure' && GENERIC_SOLID[unit.measure] !== undefined) {
    grams = (p.num ?? 1) * GENERIC_SOLID[unit.measure]! * size;
    assumed = true;
  } else {
    // Sin cantidad: la ración de la etiqueta; si no la trae, lo que la tabla había supuesto para eso mismo («pizza de trufa»); y si no, lo habitual.
    grams = (p.num ?? 1) * (hit.servingG ?? (replacedG > 0 ? replacedG : productDefaultG(hit.kcal))) * size;
    assumed = true;
  }
  const amount = Math.min(MAX_AMOUNT, Math.round(grams * 10) / 10);
  const factor = amount / 100;
  return {
    name: productName(hit),
    amount: Math.round(amount),
    unit: 'g',
    kcal: Math.round(hit.kcal * factor),
    proteinG: round1(hit.proteinG * factor),
    carbsG: round1(hit.carbsG * factor),
    fatG: round1(hit.fatG * factor),
    ...(hit.fiberG !== undefined ? { fiberG: round1(hit.fiberG * factor) } : {}),
    ...(hit.sugarsG !== undefined ? { sugarsG: round1(hit.sugarsG * factor) } : {}),
    ...(hit.saltG !== undefined ? { saltG: round2(hit.saltG * factor) } : {}),
    assumed,
  };
}

/** Calcula lo que dice `text` con la tabla de alimentos (y, si se le da, buscando en la base de productos lo que la tabla no entiende). Nunca lanza. */
// ───────────────────────────── calorías dichas ─────────────────────────────

// «Tteokbokki 400 kcal», «croissant de 300 kcal», «300 kcal de pasta»: si la persona sabe cuántas calorías es (las ve en la carta, en la etiqueta o en otra app),
// vale más que cualquier suposición de la tabla. Con un alimento de la tabla se ajusta la cantidad a esas calorías; con algo que no está se anota tal cual, con
// el nombre que se escribió.

/** Cómo se reparten las calorías de una comida de la que no se sabe qué lleva: una comida media (18 % proteínas, 47 % hidratos, 35 % grasas). */
const AVERAGE_SPLIT = { p: 0.18, c: 0.47, f: 0.35 } as const;

/** Una comida de la que solo se sabe lo que dijo la persona (sus calorías): los nutrientes son los de una comida media y los gramos no se saben. */
function energyItem(name: string, kcal: number): TextItem {
  const clean = name.trim().replace(/\s+/g, ' ');
  const total = Math.round(Math.min(MAX_MEAL_KCAL, kcal));
  return {
    name: clean === '' ? 'Comida' : `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`.slice(0, 60),
    amount: 0,
    unit: 'g',
    kcal: total,
    proteinG: round1((AVERAGE_SPLIT.p * total) / 4),
    carbsG: round1((AVERAGE_SPLIT.c * total) / 4),
    fatG: round1((AVERAGE_SPLIT.f * total) / 9),
    assumed: false,
    kcalOnly: true,
  };
}

/** `item` con las calorías que dijo la persona (la cantidad y los nutrientes, en proporción), o `null` si no se puede: casi no tiene calorías o saldría una cantidad imposible. */
function scaleToKcal(item: TextItem, kcal: number): TextItem | null {
  if (item.kcal < 10 || item.kcalOnly === true) return null;
  const factor = kcal / item.kcal;
  if (item.amount * factor > MAX_AMOUNT) return null;
  const scale = (x: TextItem): TextItem => ({
    ...x,
    amount: Math.round(x.amount * factor),
    kcal: Math.round(x.kcal * factor),
    proteinG: round1(x.proteinG * factor),
    carbsG: round1(x.carbsG * factor),
    fatG: round1(x.fatG * factor),
    ...(x.fiberG !== undefined ? { fiberG: round1(x.fiberG * factor) } : {}),
    ...(x.sugarsG !== undefined ? { sugarsG: round1(x.sugarsG * factor) } : {}),
    ...(x.saltG !== undefined ? { saltG: round2(x.saltG * factor) } : {}),
    assumed: false,
    ...(x.parts !== undefined ? { parts: x.parts.map(scale) } : {}),
  });
  return { ...scale(item), kcal: Math.round(kcal) };
}

export function analyzeMealText(text: string, table: readonly FoodEntry[], lookup?: ProductLookup): TextAnalysis {
  const index = indexOf(table);
  const { parts, notes } = classify(tokenize(text.slice(0, MAX_TEXT_CHARS)), index);
  const items: TextItem[] = [];
  const unknown: string[] = [];
  let pending = fresh();
  let negate = false;
  let phrase: string[] = [];
  let skipped = 0;
  // Tras un bocadillo, un sándwich o un wrap ('container') y tras cualquier otro plato ('plain'), lo que se nombra sin cantidad y se pone dentro o encima
  // (queso, tomate, bacon, una salsa…) es relleno: lo que se pone de eso, no una ración. Dura hasta que se dice una cantidad, se nombra otra cosa o acaba la frase.
  let host = null as Host | null;
  // El papel de lo que se está contando: otra verdura detrás de una verdura («tomate y lechuga») es otra cosa, no su relleno.
  let hostRole = null as FoodRole | null;
  // Si lo que se está contando es comida rápida: «con patatas» son patatas fritas.
  let hostFast = false;
  // La palabra que une lo que viene con lo anterior («con», «y», una coma): detrás de «y» o de una coma, una carne o un pescado es otro plato, no un relleno.
  let connector = null as string | null;
  // Tras una coma: el plato sigue solo si lo que viene es otro relleno («con lechuga, tomate y cebolla»).
  let afterComma = false;
  // Lo último que se dijo era un «sin»: «sin tomate ni lechuga» sigue quitando.
  let negating = false;
  // «Sin tomate y lechuga»: tras un «sin», un «y» o una coma quitan también lo que viene si el plato lo lleva (si no, es otra cosa que se añade).
  let softNegate = false;
  // Tras un helado, un batido o una mermelada, «de fresa y vainilla» es el sabor: no suma nada y se apunta en el nombre.
  let flavorState = null as 'host' | 'de' | 'chain' | null;
  let flavorAt = -1;
  const flavors = new Map<number, { entry: FoodEntry; said: string[]; pending: Pending }>();
  // El último alimento anotado y si desde entonces se ha dicho alguna cosa más: «helado de chocolate, dos bolas» (la cantidad llega después).
  let last = null as { entry: FoodEntry; pending: Pending; index: number } | null; // (se cambia desde `emit`)
  // El plato compuesto del que se está hablando («un kebab de ternera con cebolla y…»): lo que se nombra detrás de él son sus ingredientes.
  let dish = null as Dish | null; // (se cambia desde `emit`: sin el `as`, TypeScript daría por hecho que sigue siendo `null`)
  // El último plato compuesto anotado, para la cantidad que se diga después: «pizza margarita, una porción».
  let lastDish = null as Dish | null;

  // Las calorías que la persona dijo: «croissant 300 kcal» (las de lo que acaba de decirse, que se aplican al final a ese alimento) y «300 kcal de tarta»
  // (las de lo que viene: `pendingEnergy` espera al alimento o a las palabras que no se entienden). Sin nada que las lleve, son una «Comida».
  const energyFor = new Map<number, number>();
  let pendingEnergy = null as number | null;
  const flushPhrase = (): void => {
    if (phrase.length > 0) {
      if (pendingEnergy !== null) {
        // «400 kcal de tteokbokki»: no está en la tabla, pero la persona dice cuánto es.
        addEnergyItem(phrase.join(' '), pendingEnergy);
        pendingEnergy = null;
      } else unknown.push(phrase.join(' '));
    }
    phrase = [];
  };
  const addEnergyItem = (name: string, kcal: number): void => {
    if (items.length >= MAX_ITEMS) {
      skipped++;
      return;
    }
    segment.pending ??= { ...pending };
    items.push(energyItem(name, kcal));
  };
  const productNotes: string[] = [];
  let segment: Segment = { start: 0, words: [], raw: [], unknownFrom: 0, pending: null, cue: false };
  /**
   * Al acabar una parte del texto con palabras que la tabla no entiende («kinder bueno white», «tarta de la abuela»), se buscan TODAS sus palabras
   * (las entendidas y las no) entre los productos envasados de la app; si hay uno que las lleva todas, ese producto sustituye a lo que la tabla había
   * calculado para esa parte. Si no hay ninguno, todo queda como estaba: lo entendido sumado y lo demás avisado.
   */
  const resolveSegment = (): void => {
    const unknownPhrases = unknown.slice(segment.unknownFrom);
    if (lookup === undefined || unknownPhrases.length === 0) return;
    const words = [...new Set(segment.words)].filter((word) => word !== '' && !/^\d+$/.test(word));
    if (words.length === 0 || words.length > 8 || words.join('').length < 4) return;
    // Una sola palabra desconocida («fuera», «ligera», «pasado») solo se busca si se dijo cuánto («una lays», «bolsa de lays»): sin eso es mucho más probable
    // que sea una palabra cualquiera de la frase que un producto, y no hay que inventarse una comida.
    if (words.length === 1 && !segment.cue) return;
    const hits = lookup(words);
    // Con una sola palabra («king», «lays») solo vale un producto que se llame así o de esa marca, no uno que la lleve por dentro («Bizcocho King»).
    const startsWith = (text: string, word: string): boolean => {
      const first = foldAccents(text).split(/[^a-z0-9]+/).find((token) => token !== '') ?? '';
      return first === word || wordForms(first).some((form) => wordForms(word).includes(form));
    };
    const hit = words.length > 1 ? hits[0] : hits.find((candidate) => startsWith(candidate.name, words[0]!) || startsWith(candidate.brand, words[0]!));
    if (hit === undefined) return;
    const replacedG = items.slice(segment.start).reduce((sum, replaced) => sum + (replaced.unit === 'g' ? replaced.amount : 0), 0);
    const item = productItem(hit, segment.pending ?? pending, replacedG);
    items.splice(segment.start, items.length - segment.start, item);
    unknown.splice(segment.unknownFrom);
    productNotes.push(`«${words.join(' ')}» lo busqué en la base de productos de la app: ${item.name}, ${fmtCount(hit.kcal)} kcal por 100 g.`);
    for (const at of [...flavors.keys()]) if (at >= segment.start) flavors.delete(at);
    dish = null;
    lastDish = null;
    last = null;
    host = null;
    hostFast = false;
    flavorState = null;
  };
  const startSegment = (): void => {
    segment = { start: items.length, words: [], raw: [], unknownFrom: unknown.length, pending: null, cue: false };
  };
  /** ¿Es `entry`, dicho sin cantidad tras el plato que se está contando, un relleno suyo? */
  const fits = (entry: FoodEntry): boolean =>
    host !== null &&
    isGarnish(entry) &&
    !(entry.role === hostRole && entry.role !== 'topping') &&
    !(host === 'plain' && entry.role === 'proteina' && connector !== 'con' && connector !== 'de');
  const fillsHost = (entry: FoodEntry): boolean => pending.num === null && pending.unit === null && fits(entry);
  const emit = (entry: FoodEntry): void => {
    if (entry.ignore) return;
    if (items.length >= MAX_ITEMS) {
      skipped++;
      return;
    }
    segment.pending ??= { ...pending };
    flavorState = entry.flavored ? 'host' : null;
    flavorAt = items.length;
    if (entry.flavored) flavors.set(flavorAt, { entry, said: [], pending: { ...pending } });
    if (entry.recipe !== null) {
      dish = startDish(entry, { ...pending }, items.length);
      lastDish = dish;
      items.push(dishItem(dish));
      last = null;
      host = 'plain';
      hostRole = null;
      hostFast = entry.fast;
      return;
    }
    lastDish = null;
    const quantified = pending.num !== null || pending.unit !== null;
    const garnish = fillsHost(entry);
    items.push(itemOf(entry, pending, garnish));
    last = { entry, pending: { ...pending }, index: items.length - 1 };
    if (entry.container) {
      host = 'container';
      hostRole = null;
      hostFast = entry.fast;
    } else if (entry.role === 'bebida' || entry.role === 'base') host = null;
    else if (!garnish && (host !== 'container' || quantified)) {
      host = 'plain';
      hostRole = entry.role;
      hostFast = entry.fast;
    }
  };
  const finish = (): void => {
    // Una medida sin alimento («una caña», «dos copas»): el alimento de siempre para esa medida.
    if (pending.unit !== null) {
      const measure = pending.unit.unit.kind === 'measure' ? pending.unit.unit.measure : pending.carrier;
      const name = measure !== null ? MEASURE_DEFAULT_FOOD[measure] : pending.unit.unit.kind === 'volume' ? pending.unit.unit.food : undefined;
      const entry = name !== undefined ? index.byName.get(name) : undefined;
      if (entry) emit(entry);
      else if (lastDish && lastDish.itemIndex === items.length - 1 && lastDish.pending.num === null && lastDish.pending.unit === null) {
        // Lo mismo con un plato compuesto: «pizza margarita, una porción».
        lastDish.pending = { ...lastDish.pending, num: pending.num, unit: pending.unit, size: pending.size ?? lastDish.pending.size };
        items[lastDish.itemIndex] = dishItem(lastDish);
      } else if (last && last.index === items.length - 1 && last.pending.num === null && last.pending.unit === null && items[last.index]) {
        // La cantidad de lo anterior, dicha después: «pizza de pepperoni, una porción grande».
        items[last.index] = itemOf(last.entry, { ...last.pending, num: pending.num, unit: pending.unit, size: pending.size ?? last.pending.size }, false);
      } else if (pending.unit.unit.kind !== 'mass' && pending.unit.unit.kind !== 'volume') {
        // «unas tapas», «un trozo»: una medida de nada. No se suma y se avisa (con una masa o un volumen suelto, «200 g», se hace lo de siempre: nada).
        unknown.push(`${pending.num !== null ? `${fmtCount(pending.num)} ` : ''}${pending.unit.word}`.trim());
      }
    } else if (pending.num !== null && !pending.ofServing) {
      // Una cifra suelta detrás de lo que cuenta («croquetas, 6», «hamburguesa x2», «arroz 200»): las pequeñas son unidades y las grandes, gramos.
      const dishLate = lastDish && lastDish.itemIndex === items.length - 1 && lastDish.pending.num === null && lastDish.pending.unit === null ? lastDish : null;
      if (dishLate) {
        const how = bareQuantity(dishLate.entry, pending.num);
        if (how) {
          dishLate.pending = { ...dishLate.pending, ...how };
          items[dishLate.itemIndex] = dishItem(dishLate);
        }
      } else if (last && last.index === items.length - 1 && last.pending.num === null && last.pending.unit === null && items[last.index]) {
        const how = bareQuantity(last.entry, pending.num);
        if (how) items[last.index] = itemOf(last.entry, { ...last.pending, ...how }, false);
      }
    }
    flushPhrase();
    if (pendingEnergy !== null) {
      addEnergyItem('', pendingEnergy); // «he comido unas 500 kcal»: sin decir qué, una comida
      pendingEnergy = null;
    }
    resolveSegment();
    pending = fresh();
    negate = false;
    startSegment();
  };

  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    switch (part.t) {
      case 'num': {
        dish = null;
        softNegate = false;
        segment.cue = true;
        // «dos filetes de 200 g», «una lata de 330 ml»: la cifra tras la medida y un «de» es lo que pesa o mide cada una, no cuántas son.
        const after = parts[k + 1];
        if (pending.unit?.unit.kind === 'measure' && pending.weight === null && parts[k - 1]?.t === 'de' && !part.ofServing && after?.t === 'unit' && (after.unit.kind === 'mass' || after.unit.kind === 'volume')) {
          pending.weight = { value: part.value, unit: after.unit };
          k++;
          break;
        }
        pending.num = part.value;
        pending.ofServing = part.ofServing;
        host = null;
        flavorState = null;
        break;
      }
      case 'unit':
        dish = null;
        softNegate = false;
        segment.cue = true;
        if (pending.unit?.unit.kind === 'measure' && (part.unit.kind === 'mass' || part.unit.kind === 'volume')) pending.carrier = pending.unit.unit.measure;
        pending.unit = { unit: part.unit, word: part.word };
        host = null;
        flavorState = null;
        break;
      case 'hard':
        if (part.soft) afterComma = true;
        else {
          host = null;
          hostFast = false;
          flavorState = null;
        }
        break;
      case 'size':
        if (dish !== null && !part.multi && dish.pending.size === null && pending.num === null && pending.unit === null && pending.size === null && parts[k + 1]?.t !== 'de' && parts[k + 1]?.t !== 'food') {
          // «una pizza de telepizza familiar», «un kebab de pollo con cebolla grande»: el tamaño dicho al final es del plato (no el de «extra de queso»).
          dish.pending = { ...dish.pending, size: part.factor };
          items[dish.itemIndex] = dishItem(dish);
        } else if (part.multi) pending.multi = part.factor;
        else pending.size = part.factor;
        break;
      case 'length':
        pending.cm = part.cm;
        break;
      case 'de':
        if (flavorState === 'host') flavorState = 'de';
        break;
      case 'cook':
        pending.cook = strongerCook(pending.cook, part.method);
        break;
      case 'plus':
        pending.num = (pending.num ?? 1) + part.value;
        break;
      case 'sin':
        negate = true;
        break;
      case 'another': {
        // «un kebab de pollo y otro de ternera», «una caña y otra», «una tostada con tomate y otra con jamón»: otra unidad de lo último, que se cuenta aparte
        // (con lo que se diga detrás). Si lo que sigue es un alimento («y otra tostada»), no hay nada que repetir.
        softNegate = false; // («un kebab sin cebolla y otro de ternera»: el «sin» era del primero)
        negating = false;
        let ahead = k + 1;
        while (parts[ahead]?.t === 'fill') ahead++;
        const next = parts[ahead];
        const again = lastDish && lastDish.itemIndex === items.length - 1 ? lastDish : last && last.index === items.length - 1 ? last : null;
        if (again && (next === undefined || next.t === 'sep' || next.t === 'hard' || next.t === 'de' || next.t === 'sin')) {
          const before = 'pending' in again ? again.pending : fresh();
          pending = { ...fresh(), size: before.size, unit: before.unit, num: before.unit ? 1 : null };
          host = null;
          dish = null;
          emit(again.entry);
          pending = fresh();
        }
        break;
      }
      case 'sep':
        // «trabajo: un tupper», «tapas: croquetas»: lo que no se entiende justo antes de los dos puntos es el título de la lista, no una comida.
        if (part.word === ':' && phrase.length > 0) {
          segment.words.length = Math.max(0, segment.words.length - phrase.length);
          segment.raw.length = Math.max(0, segment.raw.length - phrase.length);
          phrase = [];
        }
        // «tteokbokki, 400 kcal», «pizza, 800 kcal»: la coma no cierra lo que describen esas calorías.
        if (part.word === ',' && parts[k + 1]?.t === 'hard' && parts[k + 2]?.t === 'energy') break;
        finish();
        // «sin tomate ni lechuga»: el «ni» sigue con lo mismo; «sin tomate y lechuga» también, si el plato lleva lo que viene.
        negate = part.word === 'ni' && negating;
        softNegate = negating && dish !== null && (part.word === 'y' || part.word === 'e' || part.word === ',');
        if (!softNegate && part.word !== 'ni' && part.word !== ',') negating = false;
        // Tras «con», «y» o una coma se sigue con los ingredientes del plato; cualquier otra cosa («luego», un punto) lo cierra.
        if (dish !== null && (part.word === undefined || !DISH_CONNECTORS.has(part.word))) dish = null;
        if (part.word !== undefined && SEPARATORS.has(part.word) && !HOST_CONNECTORS.has(part.word)) {
          host = null;
          hostFast = false;
        }
        if (flavorState !== null && part.word !== undefined && SEPARATORS.has(part.word) && !FLAVOR_CONNECTORS.has(part.word)) flavorState = null;
        break;
      case 'energy': {
        const kcal = part.kcal;
        if (!(kcal >= 1) || kcal > MAX_MEAL_KCAL) {
          unknown.push(`${fmtCount(kcal)} kcal`); // una cifra imposible no se suma, se avisa
          break;
        }
        // ¿De qué son? De lo último que se dijo («croissant 300 kcal», «una pizza de 800 kcal», «tarta de queso (300 kcal)») o de lo que viene («300 kcal de tarta»).
        let j = k - 1;
        let viaDe = false;
        for (; j >= 0; j--) {
          const before = parts[j]!;
          if (before.t === 'de') viaDe = true;
          else if (!(before.t === 'fill' || (before.t === 'sep' && before.word === ',') || (before.t === 'hard' && before.soft === true))) break;
        }
        const before = j >= 0 ? parts[j] : undefined;
        if (phrase.length > 0) {
          // Palabras que la tabla no entiende («pozole rojo 400 kcal», «pizza flurbo 800 kcal»): todo lo de este trozo es una sola comida, con las calorías dichas.
          const name = segment.raw.join(' ');
          items.splice(segment.start);
          unknown.splice(segment.unknownFrom);
          for (const at of [...flavors.keys()]) if (at >= segment.start) flavors.delete(at);
          for (const at of [...energyFor.keys()]) if (at >= segment.start) energyFor.delete(at);
          phrase = [];
          dish = null;
          lastDish = null;
          last = null;
          host = null;
          hostFast = false;
          flavorState = null;
          addEnergyItem(name, kcal);
        } else if (before?.t === 'food' && items.length > 0) {
          // «dos croissants de 300 kcal»: con «de» y varias unidades, son las calorías de cada una.
          const each = viaDe && last !== null && last.index === items.length - 1 && last.pending.unit === null && last.pending.num !== null && last.pending.num > 1 ? last.pending.num : 1;
          energyFor.set(items.length - 1, Math.min(MAX_MEAL_KCAL, kcal * each));
        } else pendingEnergy = kcal;
        break;
      }
      case 'unk':
        phrase.push(part.raw);
        segment.pending ??= { ...pending };
        segment.words.push(foldAccents(part.raw).replace(/[^a-z0-9]/g, ''));
        segment.raw.push(part.raw);
        break;
      case 'food': {
        flushPhrase();
        connector = connectorBefore(parts, k);
        const soft = softNegate;
        softNegate = false;
        // «uramaki california», «sushi roll»: dos formas de decir lo MISMO, una pegada a la otra, son un solo alimento.
        const prev = parts[k - 1];
        const sameBefore = (last !== null && last.entry === part.entry && last.index === items.length - 1) || (lastDish !== null && lastDish.entry === part.entry && lastDish.itemIndex === items.length - 1);
        if (prev?.t === 'food' && prev.entry === part.entry && sameBefore && pending.num === null && pending.unit === null) {
          pending = fresh();
          negate = false;
          break;
        }
        // «un cubo de pollo frito de kfc»: «de» y otra forma de decir lo MISMO que acaba de contarse es de dónde es o de qué marca, no otro plato igual.
        if (connector === 'de' && last !== null && last.entry === part.entry && last.index === items.length - 1 && pending.num === null && pending.unit === null && pending.weight === null) {
          pending = fresh();
          negate = false;
          break;
        }
        if ((flavorState === 'de' || flavorState === 'chain') && (part.entry.role === 'sabor' || part.entry.flavor)) {
          // «helado de fresa y vainilla»: el sabor no suma nada, solo se apunta en el nombre.
          flavors.get(flavorAt)?.said.push(part.said.toLowerCase());
          flavorState = 'chain';
          pending = fresh();
          negate = false;
          break;
        }
        flavorState = null;
        if (!part.entry.ignore) {
          segment.words.push(...wordsOf(part.said));
          segment.raw.push(...part.said.split(/\s+/).filter((word) => word !== ''));
        }
        if (afterComma) {
          afterComma = false;
          if (host !== null && !fits(part.entry)) host = null;
        }
        negating = negate;
        if (dish !== null) {
          // Algunos platos ponen otra cosa que lo nombrado («de ternera» en una hamburguesa es la torta de ternera, no un filete).
          const ingredient = dish.entry.like?.get(part.entry) ?? part.entry;
          if (soft && !negate && pending.num === null && pending.unit === null && bindsToDish(ingredient, dish) && dishHas(dish, ingredient)) {
            negate = true; // «sin tomate y lechuga»: el «sin» sigue sobre lo que el plato lleva
            negating = true;
          }
          if (pending.num === null && pending.unit === null && bindsToDish(ingredient, dish)) {
            // Un ingrediente del plato: lo cambia en vez de contarse aparte («kebab de ternera», «con cebolla», «sin salsa», «doble de queso»).
            let label = (part.fuzzy ? part.entry.name : part.said).toLowerCase();
            // «con desnatada» → «con leche desnatada»: si lo dicho es la última palabra de un nombre más largo, vale el nombre.
            const fullName = part.entry.name.toLowerCase();
            if (parts[k - 1]?.t !== 'de' && !label.includes(' ') && fullName !== label && fullName.endsWith(` ${label}`)) label = fullName;
            if (negate) removeIngredient(dish, ingredient, label);
            else if (isTheirSalad(dish, ingredient)) {
              // «Un kebab con ensalada»: la verdura de siempre del plato, no una ensalada aparte.
            } else {
              // «con extra de queso», «con doble de bacon»: va con «con» aunque lleve un «de» delante.
              const hostSize = parts[k - 3] as Part | undefined;
              const sizedBefore =
                parts[k - 1]?.t === 'de' && parts[k - 2]?.t === 'size' && !(hostSize?.t === 'food' && hostSize.entry === dish.entry) ? (parts[k - 2] as Extract<Part, { t: 'size' }>) : null;
              if (sizedBefore) label = `${sizedBefore.said.toLowerCase()} de ${label}`;
              const kind = parts[k - 1]?.t === 'de' && !sizedBefore ? 'de' : 'con';
              // «con patatas grandes», «con coca cola pequeña»: el tamaño dicho detrás es de ese ingrediente (no de una marca: «pizza de telepizza familiar»).
              const sized = parts[k + 1];
              let factor = pending.multi ?? pending.size ?? 1;
              if (!ingredient.ignore && sized?.t === 'size' && !sized.multi && pending.size === null && pending.multi === null) {
                factor = sized.factor;
                k++;
              }
              addIngredient(dish, ingredient, factor, kind, label);
            }
            items[dish.itemIndex] = dishItem(dish);
            while (parts[k + 1]?.t === 'cook') k++; // «cebolla frita»: la forma de cocinar no es del alimento que venga después
            pending = fresh();
            negate = false;
            break;
          }
          dish = null; // lo que sigue no es de este plato
        }
        if (negate) {
          pending = fresh();
          negate = false;
          break;
        }
        // Detrás del alimento pueden ir la forma de cocinar («pollo a la plancha»), la cantidad («arroz 200 g», «croquetas (6)») y el tamaño
        // («manzana pequeña»), en cualquier orden.
        for (let guard = 0; guard < 4; guard++) {
          const next = parts[k + 1];
          if (next === undefined) break;
          if (next.t === 'cook') {
            pending.cook = strongerCook(pending.cook, next.method);
            k++;
          } else if ((next.t === 'fill' || next.t === 'de') && (parts[k + 2]?.t === 'cook' || parts[k + 2]?.t === 'length')) {
            k++; // «a» o «de» antes de la forma de cocinar o de la longitud («un sub de pavo de 30 cm»)
          } else if (next.t === 'length' && pending.cm === null) {
            pending.cm = next.cm;
            k++;
          } else if (next.t === 'de' && pending.weight === null && (pending.unit === null || pending.unit.unit.kind === 'measure' || pending.unit.unit.kind === 'each') && weightAfterDe(parts, k) !== null) {
            // «una hamburguesa de 200 g», «un filete de 300 gramos», «dos filetes de 200 g»: el peso de cada uno va tras el «de».
            const weight = weightAfterDe(parts, k)!;
            pending.weight = { value: weight.value, unit: weight.unit };
            k += 3;
          } else if (next.t === 'de' && pending.num === null && pending.unit === null && part.entry.each !== null && countOf(parts, k) !== null) {
            // «mcnuggets de 9», «alitas de 12»: la cantidad va tras el «de».
            const count = countOf(parts, k)!;
            pending.num = count.value;
            k += count.used;
          } else if (next.t === 'paren' && pending.num === null && pending.unit === null) {
            pending.num = next.value;
            if (next.unit) pending.unit = { unit: next.unit, word: next.word };
            k++;
          } else if (next.t === 'num' && pending.num === null && pending.unit === null) {
            const unit = parts[k + 2];
            const after = parts[k + 3];
            if (unit?.t === 'unit' && (unit.unit.kind === 'mass' || unit.unit.kind === 'volume' || unit.unit.kind === 'measure') && (after === undefined || after.t === 'sep' || after.t === 'food' || after.t === 'cook')) {
              pending.num = next.value;
              pending.unit = { unit: unit.unit, word: unit.word };
              k += 2;
            } else break;
          } else if (next.t === 'size' && (next.multi ? pending.multi === null : pending.size === null)) {
            if (next.multi) pending.multi = next.factor;
            else pending.size = next.factor;
            k++;
          } else break;
        }
        pending.plural = isPlural(part.said);
        // «un pollo asado entero», «una tarta entera», «pollo entero»: lo que se compra entero se cuenta entero, no una ración.
        const next = parts[k + 1];
        if (part.entry.whole !== null && ((next?.t === 'fill' && next.whole) || /\benter[oa]\b/.test(foldAccents(part.said).toLowerCase()))) pending.entire = true;
        // Con comida rápida delante (aunque las patatas lleven cantidad: «una hamburguesa y una ración grande de patatas»), son fritas.
        const friedPotato = hostFast && part.entry.name === FAST_FOOD_POTATO.generic ? index.byName.get(FAST_FOOD_POTATO.fried) : undefined;
        const itemsBefore = items.length;
        emit(friedPotato ?? part.entry);
        if (pendingEnergy !== null && items.length > itemsBefore) {
          energyFor.set(items.length - 1, pendingEnergy); // «300 kcal de tarta»
          pendingEnergy = null;
        }
        pending = fresh();
        break;
      }
      case 'fill':
        if (part.some) segment.cue = true;
        break;
      default:
        break; // 'de' no cambia nada
    }
  }
  finish();

  for (const [at, flavor] of flavors) {
    let item = items[at];
    if (!item || flavor.said.length === 0) continue;
    // «yogur de fresa» no es el yogur natural: con un sabor, el alimento pasa a ser el de sabores.
    const target = flavor.entry.flavorTo !== null ? index.byName.get(flavor.entry.flavorTo) : undefined;
    const entry = target ?? flavor.entry;
    if (target && target.recipe === null) item = itemOf(target, flavor.pending, false);
    // «Yogur de sabores de fresa» → «Yogur de fresa»; «Yogur con frutas de fresa» → «Yogur de fresa».
    const base = entry.name.replace(/ (de sabores|con frutas)$/, '');
    if (item.name.startsWith(entry.name)) items[at] = { ...item, name: `${base} de ${listed(flavor.said)}${item.name.slice(entry.name.length)}` };
    else items[at] = item;
  }

  // Las calorías dichas de un alimento de la tabla: se ajusta su cantidad a ellas (o, si no se puede —el café no tiene calorías que ajustar—, se anota tal cual con su nombre).
  for (const [at, kcal] of energyFor) {
    const item = items[at];
    if (item !== undefined) items[at] = scaleToKcal(item, kcal) ?? energyItem(item.name, kcal);
  }
  const guessed = items.filter((item) => item.kcalOnly === true);
  const assumed = items.filter((item) => item.assumed);
  const sentences: string[] = [...notes, ...productNotes];
  if (guessed.length > 0) {
    sentences.push(`Usé las calorías que dijiste para ${listed(guessed.map((item) => `«${item.name}»`))} y repartí los nutrientes como en una comida media, porque no sé qué lleva.`);
  }
  if (assumed.length > 0) sentences.push(`Sin la cantidad, supuse una ración habitual de: ${assumed.map((item) => `${item.name} (${item.amount} ${item.unit})`).join(', ')}.`);
  if (skipped > 0) sentences.push(`Solo cuento los ${MAX_ITEMS} primeros alimentos.`);
  return { items, assumptions: sentences.join(' '), unknown: unknown.filter((phrase) => phrase.length > 2) };
}

/** Las cifras de lo calculado, sumadas, como borrador de una comida (el nombre junta los alimentos). */
export function draftOfAnalysis(analysis: TextAnalysis): MealDraft {
  const sum = (pick: (item: TextItem) => number): number => Math.round(analysis.items.reduce((total, item) => total + pick(item), 0) * 10) / 10;
  // La fibra, los azúcares y la sal suman lo que cada alimento sabe de ellos; si ninguno lo sabe (solo productos de etiqueta incompleta), «sin dato».
  const known = (pick: (item: TextItem) => number | undefined, decimals: number): number | null => {
    const values = analysis.items.map(pick).filter((value): value is number => value !== undefined);
    if (values.length === 0) return null;
    const factor = 10 ** decimals;
    return Math.round(values.reduce((total, value) => total + value, 0) * factor) / factor;
  };
  return {
    name: analysis.items
      .map((item) => item.name)
      .join(' + ')
      .slice(0, MAX_MEAL_NAME),
    kcal: Math.min(MAX_MEAL_KCAL, Math.round(sum((item) => item.kcal))),
    proteinG: sum((item) => item.proteinG),
    carbsG: sum((item) => item.carbsG),
    fatG: sum((item) => item.fatG),
    fiberG: known((item) => item.fiberG, 1),
    sugarsG: known((item) => item.sugarsG, 1),
    saltG: known((item) => item.saltG, 1),
  };
}
