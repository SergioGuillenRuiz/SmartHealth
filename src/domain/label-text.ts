// Leer la tabla nutricional de un envase en texto: lo que se dicta o se escribe con palabras («480 calorías, 6 gramos de proteínas, 70 de hidratos…») y lo que sale de leer
// una foto de la etiqueta («Valor energético 1046 kJ / 250 kcal», «Grasas 12 g», «- de las cuales saturadas 3,1 g»…). Los dos llegan aquí como texto y salen como las cifras del
// formulario de «Enseñarle este producto». Solo lee: lo que no encuentra queda vacío (nunca se inventa una cifra) y quien lo usa enseña el formulario para revisarlo.

import { roundTo, SALT_PER_SODIUM } from './food-label';
import type { UserProductDraft } from './user-products';

export interface LabelReading {
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarsG: number | null;
  saltG: number | null;
  /** Gramos de una ración si la etiqueta la dice. */
  servingG: number | null;
  /** El nombre, si lo primero que se dijo no era una cifra ni un nutriente (solo en lo dictado: en una foto sería ruido). */
  name: string | null;
  /** A qué cantidad se refieren las cifras: por 100 g o 100 ml, por ración, o no se dice. */
  basis: 'per100' | 'serving' | 'unknown';
  /** Cuántas cifras de nutrientes (calorías, proteínas, hidratos, grasas, fibra, azúcares, sal) se han encontrado. */
  found: number;
}

type Field = 'kcal' | 'proteinG' | 'carbsG' | 'fatG' | 'fiberG' | 'sugarsG' | 'saltG' | 'sodium';
type Subject = Field | 'ignore' | 'serving';

// ───────────────────────────── números dichos con palabras ─────────────────────────────

const ONES: Readonly<Record<string, number>> = {
  cero: 0, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29,
};
const TENS: Readonly<Record<string, number>> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS: Readonly<Record<string, number>> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
// «un», «una» y «uno» sueltos son artículos o un «1» dicho: solo cuentan dentro de una cifra más larga («treinta y un», «ciento una»).
const ARTICLES = new Set(['un', 'una', 'uno']);
const isNumberWord = (word: string): boolean => word in ONES || word in TENS || word in HUNDREDS || word === 'mil';

function valueOfWords(words: readonly string[]): number {
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word === 'mil') {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
    } else if (word in HUNDREDS) current += HUNDREDS[word] as number;
    else if (word in TENS) current += TENS[word] as number;
    else if (word in ONES) current += ONES[word] as number;
    else if (ARTICLES.has(word)) current += 1;
  }
  return total + current;
}

/** «cero coma cinco» → 0.5, «seis» → 6, «cuarenta y cinco» → 45, «cuatrocientas ochenta» → 480: lo dicho con palabras pasa a cifras (lo que el teclado de dictado ya escribe con cifras no cambia). */
function digitsFromWords(text: string): string {
  const parts = text.match(/[a-z]+|\d+(?:\.\d+)?|[^a-z\d]+/g) ?? [];
  const blank = (part: string | undefined): boolean => part !== undefined && /^\s+$/.test(part);
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i] as string;
    if (!isNumberWord(part)) {
      out.push(part);
      i++;
      continue;
    }
    // Una racha de palabras de número: «cuatrocientas ochenta», «cuarenta y cinco», «mil cuarenta y seis».
    const run: string[] = [part];
    let j = i + 1;
    for (;;) {
      const next = parts[j + 1];
      if (blank(parts[j]) && next !== undefined && isNumberWord(next)) {
        run.push(next);
        j += 2;
      } else if (blank(parts[j]) && next === 'y' && blank(parts[j + 2]) && parts[j + 3] !== undefined && (parts[j + 3] as string) in ONES && (ONES[parts[j + 3] as string] as number) <= 9 && (run[run.length - 1] as string) in TENS) {
        run.push(parts[j + 3] as string);
        j += 4;
      } else if (blank(parts[j]) && next === 'y' && blank(parts[j + 2]) && ARTICLES.has(parts[j + 3] ?? '') && (run[run.length - 1] as string) in TENS) {
        run.push(parts[j + 3] as string);
        j += 4;
      } else break;
    }
    // «… coma cinco», «… coma cero cinco», «… coma veinticinco»: lo que sigue a «coma» son los decimales.
    let value = String(valueOfWords(run));
    if (blank(parts[j]) && parts[j + 1] === 'coma') {
      let k = j + 2;
      const decimals: string[] = [];
      while (blank(parts[k]) && parts[k + 1] !== undefined && isNumberWord(parts[k + 1] as string)) {
        decimals.push(parts[k + 1] as string);
        k += 2;
      }
      if (decimals.length > 0) {
        const digits = decimals.every((word) => word in ONES && (ONES[word] as number) <= 9);
        value += `.${digits ? decimals.map((word) => ONES[word]).join('') : valueOfWords(decimals)}`;
        j = k;
      }
    }
    out.push(value);
    i = j;
  }
  return out.join('');
}

// ───────────────────────────── trocear ─────────────────────────────

type Unit = 'g' | 'mg' | 'kcal' | 'kj' | 'ml' | '%';
type Token =
  | { kind: 'num'; value: number; unit: Unit | null; raw: string }
  | { kind: 'word'; word: string }
  // `hard`: corta la frase (coma, punto, punto y coma, salto de línea); lo demás (dos puntos, paréntesis, barra, guion) no.
  | { kind: 'sep'; hard: boolean };

const UNIT_OF: Readonly<Record<string, Unit>> = {
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  mg: 'mg', miligramo: 'mg', miligramos: 'mg',
  kcal: 'kcal', kcals: 'kcal', kilocaloria: 'kcal', kilocalorias: 'kcal', caloria: 'kcal', calorias: 'kcal', cal: 'kcal',
  // Cómo suele leer un OCR «kcal» cuando la foto está algo borrosa.
  heal: 'kcal', hcal: 'kcal', kcai: 'kcal', kcl: 'kcal', keal: 'kcal', kca: 'kcal', kal: 'kcal', kcol: 'kcal',
  kj: 'kj', kilojulio: 'kj', kilojulios: 'kj', kilojoule: 'kj', kilojoules: 'kj',
  ml: 'ml', mililitro: 'ml', mililitros: 'ml',
};

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\r/g, '\n')
    .replace(/(\d)\s*,\s*(\d)/g, '$1.$2')
    // Una «o» entre cifras es un cero mal leído (1o5 → 105), y una «o» suelta delante de los decimales también («o,5 g» → «0,5 g»).
    .replace(/(?<=\d)o(?=\d)/g, '0')
    .replace(/\bo(?=[.,]\d)/g, '0');
}

function tokenize(text: string): Token[] {
  const raw: Token[] = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)|([a-z]+)|(%)|(\n|[,;.])|([:()/|\-–—•*])/g)) {
    if (match[1] !== undefined) raw.push({ kind: 'num', value: Number(match[1]), unit: null, raw: match[1] });
    else if (match[2] !== undefined) raw.push({ kind: 'word', word: match[2] });
    else if (match[3] !== undefined) raw.push({ kind: 'word', word: '%' });
    else raw.push({ kind: 'sep', hard: match[4] !== undefined });
  }
  // Cada cifra con la unidad que la sigue («250 kcal», «6 g», «6g»); un «%» detrás la anula (es el % de lo recomendado).
  const out: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i] as Token;
    if (token.kind === 'num') {
      const next = raw[i + 1];
      if (next?.kind === 'word' && next.word === '%') {
        out.push({ ...token, unit: '%' });
        i++;
        continue;
      }
      if (next?.kind === 'word' && next.word in UNIT_OF) {
        out.push({ ...token, unit: UNIT_OF[next.word] as Unit });
        i++;
        continue;
      }
    }
    out.push(token);
  }
  return out;
}

// ───────────────────────────── palabras clave ─────────────────────────────

const KEYWORDS: ReadonlyArray<readonly [Subject, RegExp]> = [
  // Las grasas «de las cuales saturadas», monoinsaturadas, trans… son parte de las grasas: su cifra no vale como las grasas.
  ['ignore', /^(saturadas?|saturados?|monoinsaturadas?|monoinsaturados?|poliinsaturadas?|poliinsaturados?|trans|colesterol|polialcoholes|polioles|almidon|vitaminas?|calcio|hierro|potasio|magnesio|fosforo)$/],
  ['kcal', /^(energia|energetico|calorias?|kcal|kilocalorias?)$/],
  ['proteinG', /^(proteinas?)$/],
  ['carbsG', /^(hidratos?|carbohidratos?|glucidos?)$/],
  ['sugarsG', /^(azucar|azucares)$/],
  ['fatG', /^(grasas?|lipidos?)$/],
  ['fiberG', /^(fibra|fibras)$/],
  ['saltG', /^sal$/],
  ['sodium', /^sodio$/],
  ['serving', /^(racion|raciones|porcion|porciones)$/],
];
/** Las palabras largas que el OCR suele leer con una letra mal («hidratcs», «protelnas»): se reconocen con una sola diferencia. Las cortas («sal», «fibra») solo exactas. */
const FUZZY: ReadonlyArray<readonly [string, Subject]> = [
  ['proteinas', 'proteinG'],
  ['proteina', 'proteinG'],
  ['hidratos', 'carbsG'],
  ['carbohidratos', 'carbsG'],
  ['carbohidrato', 'carbsG'],
  ['glucidos', 'carbsG'],
  ['azucares', 'sugarsG'],
  ['grasas', 'fatG'],
  ['lipidos', 'fatG'],
  ['energia', 'kcal'],
  ['energetico', 'kcal'],
  ['calorias', 'kcal'],
  ['kilocalorias', 'kcal'],
  ['saturadas', 'ignore'],
  ['saturados', 'ignore'],
  ['monoinsaturadas', 'ignore'],
  ['poliinsaturadas', 'ignore'],
];

/** ¿Se diferencian dos palabras en una sola letra (cambiada, sobrante, que falta o dos seguidas cambiadas de sitio)? */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // una letra cambiada
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // dos seguidas al revés
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

const subjectOf = (word: string): Subject | null => {
  const exact = KEYWORDS.find(([, re]) => re.test(word))?.[0];
  if (exact !== undefined) return exact;
  if (word.length < 6) return null;
  return FUZZY.find(([canonical]) => oneEditApart(word, canonical))?.[1] ?? null;
};

/** Palabras que pueden ir entre una cifra y el nutriente al que se refiere («6 gramos DE proteínas», «70 de hidratos»). */
const BETWEEN = new Set(['de', 'del', 'en', 'la', 'las', 'los', 'el', 'unos', 'unas', 'aproximadamente']);

interface Claim {
  subject: Subject;
  /** `raw` es la cifra tal como salió escrita (con el punto decimal), para poder repararla si el OCR le pegó la «g» como un «9». */
  values: Array<{ value: number; unit: Unit | null; raw: string }>;
}

/**
 * Qué cifra es de qué nutriente. Una cifra va con el nutriente que la precede en su frase («proteínas 6 g», «proteínas: 6»); salvo que lo que venga justo
 * después, solo con unidades y un «de» por medio, sea un nutriente: «6 gramos de proteínas», «70 de hidratos». Las calorías con su unidad no necesitan palabra.
 */
function claimNumbers(tokens: readonly Token[]): Claim[] {
  const claims: Claim[] = [];
  const energy: Claim = { subject: 'kcal', values: [] };
  const keywords: Array<{ index: number; clause: number; claim: Claim }> = [];
  const clauseAt: number[] = [];
  let clause = 0;
  tokens.forEach((token, index) => {
    clauseAt[index] = clause;
    if (token.kind === 'sep' && token.hard) clause++;
  });

  tokens.forEach((token, index) => {
    if (token.kind !== 'word') return;
    const subject = subjectOf(token.word);
    if (subject === null) return;
    const last = keywords[keywords.length - 1];
    if (last !== undefined && last.claim.subject === subject && index - last.index <= 3 && clauseAt[index] === last.clause) return; // «valor energético»
    const claim = subject === 'kcal' ? energy : { subject, values: [] };
    keywords.push({ index, clause: clauseAt[index] as number, claim });
    if (!claims.includes(claim)) claims.push(claim);
  });

  tokens.forEach((token, index) => {
    if (token.kind !== 'num' || token.unit === '%') return;
    if (token.unit === 'kcal' || token.unit === 'kj') {
      energy.values.push({ value: token.value, unit: token.unit, raw: token.raw });
      if (!claims.includes(energy)) claims.push(energy);
      return;
    }
    // Hacia delante: «6 gramos de proteínas», «70 de hidratos».
    const ahead = keywords.find((k) => k.index > index && k.clause === clauseAt[index] && bindsForward(tokens, index, k.index));
    if (ahead !== undefined) {
      ahead.claim.values.push({ value: token.value, unit: token.unit, raw: token.raw });
      return;
    }
    // Hacia atrás: «proteínas 6 g», «azúcares: 30».
    let owner: (typeof keywords)[number] | undefined;
    for (const k of keywords) if (k.index < index && k.clause === clauseAt[index]) owner = k;
    owner?.claim.values.push({ value: token.value, unit: token.unit, raw: token.raw });
  });
  return claims;
}

/** ¿Está esta cifra, con solo unidades y un «de» por medio, justo antes de ese nutriente? */
function bindsForward(tokens: readonly Token[], from: number, keywordIndex: number): boolean {
  let sawDe = false;
  for (let i = from + 1; i < keywordIndex; i++) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' || !BETWEEN.has(token.word)) return false;
    if (token.word === 'de' || token.word === 'del') sawDe = true;
  }
  return sawDe;
}

// ───────────────────────────── lectura ─────────────────────────────

/** Un nombre solo si lo primero que se dijo no lleva cifras ni palabras de nutrientes («Galletas de la abuela: 480 kcal…», «Nombre: galletas, 480 calorías…»). */
function nameOf(original: string): string | null {
  const first = (original.replace(/^\s*nombre\s*[:=-]\s*/i, '').split(/[,;:\n.]/)[0] ?? '').trim();
  if (first.length < 2 || first.length > 80 || /\d/.test(first)) return null;
  const words = normalize(first).match(/[a-z]+/g) ?? [];
  if (words.length === 0 || words.length > 8) return null;
  if (words.some((w) => subjectOf(w) !== null || w in UNIT_OF || (isNumberWord(w) && !ARTICLES.has(w)))) return null;
  // «tiene 480 calorías», «es por cada 100 g»: no es un nombre.
  if (/^(tiene|tienen|lleva|llevan|son|es|por|cada|valor|informacion)$/.test(words[0] as string)) return null;
  return first.replace(/^./, (c) => c.toUpperCase());
}

// ───────────────────────────── reparar lo que el OCR lee mal ─────────────────────────────

type MacroKey = 'proteinG' | 'carbsG' | 'fatG' | 'fiberG' | 'sugarsG' | 'saltG';
const MACROS: readonly MacroKey[] = ['fatG', 'carbsG', 'sugarsG', 'fiberG', 'proteinG', 'saltG'];

interface Candidate {
  value: number;
  /** Cuántos decimales trae: las etiquetas dan un decimal (dos la sal), así que más es señal de una «g» pegada leída como «9». */
  decimals: number;
  /** Lo que cuesta darla por buena: 0 si es la cifra tal cual se leyó; algo más cuanto más hubo que repararle. */
  cost: number;
  /** Se le quitó la última cifra (la «g» leída como «9»): si esto pasa en varias cifras de la misma etiqueta, es cosa de la foto y lo normal es que pase en todas. */
  stripped?: boolean;
}

const decimalsOf = (raw: string): number => (raw.includes('.') ? raw.length - raw.indexOf('.') - 1 : 0);

/**
 * Lo que el OCR suele hacer con «13,2 g» es leerlo «13,29»: la «g» pegada a la cifra sale como un «9». Una cifra sin unidad que acaba en 9 puede ser, pues, la cifra de verdad
 * o esa cifra con un 9 de más; se dan las dos y `resolveOcr` elige la que cuadra con el resto de la etiqueta.
 */
function candidatesOf(chosen: { value: number; unit: Unit | null; raw: string } | null): Candidate[] {
  if (chosen === null) return [];
  const asRead: Candidate = { value: chosen.unit === 'mg' ? chosen.value / 1000 : chosen.value, decimals: decimalsOf(chosen.raw), cost: 0 };
  if (chosen.unit !== null) return [asRead];
  const out: Candidate[] = [asRead];
  const add = (raw: string, cost: number, stripped = false): void => {
    if (raw === '' || raw === '.') return;
    const value = Number(raw);
    if (Number.isFinite(value) && !out.some((c) => c.value === value)) out.push({ value, decimals: decimalsOf(raw), cost, ...(stripped ? { stripped } : {}) });
  };
  const digitsOf = (raw: string): number => raw.replace('.', '').length;
  const dropLast = (raw: string): string => raw.slice(0, -1).replace(/\.$/, '');
  /** Con la coma perdida («2,9 g» → «29»): se vuelve a poner antes de la última cifra. */
  const withComma = (raw: string): string | null => (!raw.includes('.') && raw.length >= 2 ? `${raw.slice(0, -1)}.${raw.slice(-1)}` : null);

  const raw = chosen.raw;
  // La «g» seguida del borde de la tabla (una raya vertical) sale como «91» o «9|»: «3,3 g|» → «3391». Es la cifra de verdad (con o sin la coma perdida) sin esas dos últimas.
  const edge = /^(\d{2,4})91$/.exec(raw);
  if (edge !== null) {
    const base = edge[1] as string;
    add(base, 0.9, true);
    const comma = withComma(base);
    if (comma !== null) add(comma, 0.95, true);
  }
  // La «g» pegada sale como un 9 (lo más corriente) o como otro dígito: si la cifra trae más decimales de los que da una etiqueta, o es un entero largo, la última cifra puede sobrar.
  const withoutLast = (raw.endsWith('9') && digitsOf(raw) >= 2) || decimalsOf(raw) >= 2 || (!raw.includes('.') && raw.length >= 3) ? dropLast(raw) : null;
  // Una coma perdida en una cifra de dos cifras («29» por «2,9») es lo más corriente; una «g» pegada a un entero («219» por «21 g») es más probable que la coma perdida en una de tres.
  const spaced = withComma(raw);
  if (spaced !== null) add(spaced, raw.length === 2 ? 0.55 : 0.9);
  /** La coma tras la primera cifra («252» → 2,52): así se escriben la sal y los valores pequeños con dos decimales, y es la que más se pierde. */
  const afterFirst = (digits: string): string | null => (!digits.includes('.') && digits.length >= 3 ? `${digits[0]}.${digits.slice(1)}` : null);
  const early = afterFirst(raw);
  if (early !== null) add(early, 1.25);
  if (withoutLast !== null) {
    const earlyStripped = afterFirst(withoutLast);
    if (earlyStripped !== null) add(earlyStripped, 1.4, raw.endsWith('9') && (decimalsOf(raw) >= 2 || !raw.includes('.')));
    // Solo cuenta como «9 de más» una cifra pegada a la «g» sin más pistas: con dos decimales (una etiqueta da uno) o entera. «1,9» seguido de un resto («1,9E8») es un 1,9 de verdad.
    const nineGlued = raw.endsWith('9') && (decimalsOf(raw) >= 2 || !raw.includes('.'));
    add(withoutLast, 0.6, nineGlued);
    const both = withComma(withoutLast);
    if (both !== null) add(both, 1.2, nineGlued);
  }
  return out;
}

/** Cuánto «desentona» una lectura de la tabla: 0 si todo cuadra (energía, límites y tamaños creíbles); más cuanto peor. */
function implausibility(values: Partial<Record<MacroKey, Candidate>>, kcal: number | null): number {
  let penalty = 0;
  for (const key of MACROS) {
    const c = values[key];
    if (c === undefined) continue;
    penalty += c.cost; // a igualdad, mejor lo leído tal cual
    if (c.value > 100) penalty += 6;
    if (key === 'saltG' ? c.decimals > 2 : c.decimals > 1) penalty += 2.5;
    // Lo muy raro en un alimento (más de 20 g de fibra o 12 g de sal por 100 g) pesa en contra.
    if ((key === 'fiberG' && c.value > 20) || (key === 'saltG' && c.value > 12)) penalty += 1.5;
    // La sal de un alimento corriente no pasa de 6 g por 100 g: «12» suele ser «1,2» sin la coma (la energía no vigila la sal, así que sin esto nada lo corregiría).
    if (key === 'saltG' && c.value > 6) penalty += 1;
    if (key === 'saltG' && c.value > 10) penalty += 3;
  }
  const v = (key: MacroKey): number | null => values[key]?.value ?? null;
  const fat = v('fatG');
  const carbs = v('carbsG');
  const protein = v('proteinG');
  const fiber = v('fiberG');
  const sugars = v('sugarsG');
  if (sugars !== null && carbs !== null && sugars > carbs + 0.05) penalty += 3;
  if ((fat ?? 0) + (carbs ?? 0) + (protein ?? 0) + (fiber ?? 0) > 100.5) penalty += 3;
  if (kcal !== null && kcal > 0) {
    if (fat !== null && carbs !== null && protein !== null) {
      const expected = 9 * fat + 4 * carbs + 4 * protein + 2 * (fiber ?? 0);
      penalty += Math.min(5, (Math.abs(kcal - expected) / Math.max(kcal, 40)) * 14);
    } else {
      for (const [grams, factor] of [[fat, 9], [carbs, 4], [protein, 4]] as const) if (grams !== null && grams * factor > kcal * 1.15 + 5) penalty += 3;
    }
  }
  return penalty;
}

/** Elige, entre las lecturas posibles de cada cifra, la combinación que más cuadra entre sí (con la energía como contraste). */
function resolveOcr(candidates: Partial<Record<MacroKey, Candidate[]>>, kcal: number | null): Partial<Record<MacroKey, number>> {
  return resolveOcrScored(candidates, kcal).picks;
}

/** Lo mismo, con lo que «desentona» la mejor combinación (para comparar dos energías posibles). */
function resolveOcrScored(candidates: Partial<Record<MacroKey, Candidate[]>>, kcal: number | null): { picks: Partial<Record<MacroKey, number>>; penalty: number } {
  const keys = MACROS.filter((key) => (candidates[key]?.length ?? 0) > 0);
  let lastPenalty = 0;
  const search = (pool: Partial<Record<MacroKey, Candidate[]>>): Partial<Record<MacroKey, Candidate>> => {
    let best: Partial<Record<MacroKey, Candidate>> = {};
    let bestPenalty = Infinity;
    const walk = (index: number, chosen: Partial<Record<MacroKey, Candidate>>): void => {
      if (index === keys.length) {
        const penalty = implausibility(chosen, kcal);
        if (penalty < bestPenalty - 1e-9) {
          bestPenalty = penalty;
          best = { ...chosen };
        }
        return;
      }
      const key = keys[index] as MacroKey;
      for (const candidate of pool[key] as Candidate[]) walk(index + 1, { ...chosen, [key]: candidate });
    };
    walk(0, {});
    lastPenalty = bestPenalty;
    return best;
  };
  let best = search(candidates);
  // Si la energía obligó a quitarle el «9» a dos o más cifras, la foto lee así todas las «g»: también las que la energía no vigila (la sal, los azúcares) llevan el 9 de más.
  if (keys.filter((key) => best[key]?.stripped === true).length >= 2) {
    const favoured: Partial<Record<MacroKey, Candidate[]>> = {};
    for (const key of keys) favoured[key] = (candidates[key] as Candidate[]).map((c) => (c.stripped === true ? { ...c, cost: c.cost - 0.7 } : c));
    best = search(favoured);
  }
  const out: Partial<Record<MacroKey, number>> = {};
  for (const key of keys) out[key] = (best[key] as Candidate).value;
  return { picks: out, penalty: lastPenalty };
}

const isNutrientWord = (word: string): boolean => subjectOf(word) !== null;

/** Una línea de cifras: lleva algún dígito, ninguna palabra de nutriente y casi todo lo que tiene son cifras, signos y unidades (con alguna letra suelta de la «g» mal leída). */
function isValueLine(line: string): boolean {
  if (!/\d/.test(line) || line.length > 48) return false;
  const words = line.match(/[a-z]+/g) ?? [];
  if (words.some((w) => w.length >= 3 && !(w in UNIT_OF) && w !== 'kj')) return false;
  const letters = words.join('').length;
  return letters <= line.replace(/\s/g, '').length * 0.5;
}

/**
 * Un OCR a veces lee la tabla por columnas: primero todos los nombres («Grasas», «Hidratos de carbono»…) y después, aparte, todas las cifras. Si los nombres van todos antes que las
 * cifras y hay tantas cifras como nombres (o un múltiplo, una por columna), se vuelven a juntar por orden: «Grasas 37.3 g 74.6 g».
 */
export function joinNameAndValueBlocks(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  const kind = lines.map((line): 'name' | 'value' | 'other' => {
    if (line === '') return 'other';
    const words = line.match(/[a-z]+/g) ?? [];
    if (!/\d/.test(line) && words.some(isNutrientWord)) return 'name';
    if (isValueLine(line)) return 'value';
    return 'other';
  });
  const names = kind.flatMap((k, i) => (k === 'name' ? [i] : []));
  let values = kind.flatMap((k, i) => (k === 'value' ? [i] : []));
  if (names.length < 3 || values.length < 3) return text;
  // Todos los nombres, antes que todas las cifras.
  if ((names[names.length - 1] as number) > (values[0] as number)) return text;
  // La energía en dos líneas («1276 kJ» y «305 kcal») es una sola cifra.
  const energyLine = (line: string): boolean => /\b(kj|kcal)\b/.test(line) && !/\bg\b/.test(line);
  const merged = new Map<number, string>();
  const kept: number[] = [];
  for (const index of values) {
    const prev = kept[kept.length - 1];
    if (prev !== undefined && energyLine(merged.get(prev) ?? (lines[prev] as string)) && energyLine(lines[index] as string) && index === prev + 1 && !/\bkj\b.*\bkcal\b/.test(merged.get(prev) ?? (lines[prev] as string))) {
      merged.set(prev, `${merged.get(prev) ?? (lines[prev] as string)} / ${lines[index] as string}`);
    } else kept.push(index);
  }
  values = kept;
  const valueText = (index: number): string => merged.get(index) ?? (lines[index] as string);
  if (values.length % names.length !== 0 || values.length / names.length > 3) return text;
  const columns = values.length / names.length;
  const out = lines.map((line, i) => (kind[i] === 'other' ? line : null));
  names.forEach((nameIndex, n) => {
    const row = [lines[nameIndex] as string];
    for (let c = 0; c < columns; c++) row.push(valueText(values[n + c * names.length] as number));
    out[nameIndex] = row.join(' ');
  });
  return out.filter((l): l is string => l !== null).join('\n');
}

// ───────────────────────────── nombres que el OCR no leyó ─────────────────────────────

/**
 * El orden de las filas de una etiqueta europea (Reglamento 1169/2011): energía, grasas, saturadas, hidratos, azúcares, fibra, proteínas y sal. El índice de cada una.
 */
const ORDER: Readonly<Partial<Record<Subject, number>>> = { kcal: 0, fatG: 1, carbsG: 3, sugarsG: 4, fiberG: 5, proteinG: 6, saltG: 7, sodium: 7 };
const SATURATED_POSITION = 2;
const NAME_AT: readonly string[] = ['energia', 'grasas', 'saturadas', 'hidratos de carbono', 'azucares', 'fibra', 'proteinas', 'sal'];

/** Palabras de una línea que no es una fila de nutriente aunque lleve cifras: la cabecera, las raciones, los porcentajes de lo recomendado. */
const HEADER_LINE = /\b(por|cada|racion|porcion|raciones|nutricional|informacion|valores|valor medio|medios|declaracion|cantidad|vrn|referencia|adulto|100|ingesta)\b/;

/**
 * Un OCR a veces lee las cifras de una fila y no su nombre («Gar», «Mdrasos de carbono», «e»). Como las filas van en un orden fijo, una fila sin nombre entre dos con nombre se sabe cuál
 * es si hay justo tantas filas sin nombre como huecos: «Valor energético… / (sin nombre) / de las cuales saturadas…» es la de las grasas. Solo se hace si lo que sí se leyó sigue el orden
 * normal y los huecos cuadran exactamente; ante la duda no se toca nada.
 */
export function fillMissingNames(text: string): string {
  const lines = text.split('\n');
  interface Entry {
    index: number;
    position: number | null;
  }
  const entries: Entry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.trim() === '') continue;
    const words = line.match(/[a-z]+/g) ?? [];
    const subjects = words.map((w) => subjectOf(w)).filter((subject): subject is Subject => subject !== null);
    if (subjects.length > 0) {
      const energyLine = subjects.includes('kcal');
      const subject = energyLine ? 'kcal' : subjects.find((x) => x !== 'ignore' && x !== 'serving') ?? null;
      if (subject !== null && ORDER[subject] !== undefined) entries.push({ index, position: ORDER[subject] as number });
      else if (words.some((w) => /^satur/.test(w))) entries.push({ index, position: SATURATED_POSITION });
      else if (subjects.includes('ignore')) return text; // «monoinsaturadas», «colesterol»…: otra clase de etiqueta, no se adivina
      continue;
    }
    if (!/\d/.test(line) || HEADER_LINE.test(line)) continue;
    // Una fila de datos: cifras (con su «g», «%»…), sin nombre de nutriente reconocible.
    entries.push({ index, position: null });
  }
  const named = entries.filter((e) => e.position !== null);
  if (named.length < 3) return text;
  for (let i = 1; i < named.length; i++) if ((named[i] as Entry).position! <= (named[i - 1] as Entry).position!) return text;

  const assigned = new Map<number, number>();
  let i = 0;
  while (i < entries.length) {
    if ((entries[i] as Entry).position !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < entries.length && (entries[j] as Entry).position === null) j++;
    const before = i > 0 ? ((entries[i - 1] as Entry).position as number) : -1;
    const after = j < entries.length ? ((entries[j] as Entry).position as number) : NAME_AT.length;
    const gap = after - before - 1;
    if (j - i === gap && gap > 0) for (let k = 0; k < gap; k++) assigned.set((entries[i + k] as Entry).index, before + 1 + k);
    i = j;
  }
  if (assigned.size === 0) return text;
  return lines.map((line, index) => (assigned.has(index) ? `${NAME_AT[assigned.get(index) as number] as string} ${line}` : line)).join('\n');
}

/**
 * Quita las rayas de relleno que un OCR lee como cifras sueltas entre el nombre y el valor («Grasas 7-6 — 2179»: el «7-6» son los puntos y rayas de la tabla). Solo si, en esa misma línea,
 * hay después una cifra de verdad (de dos o más dígitos), para no tocar una línea que solo trae eso.
 */
function dropLeaderNoise(text: string): string {
  return text
    .split('\n')
    .map((line) => (/\d{2,}/.test(line.replace(/\d[-–—_]+\d?/, '')) ? line.replace(/(^|\s)\d\s*[-–—_]+\s*\d?(?=\s)/, '$1') : line))
    .join('\n');
}

/** Quita las notas al pie («*Valor de referencia de un adulto medio (8400 kJ / 2000 kcal)»): sus cifras no son las del producto. */
function dropFootnotes(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/referencia|adulto|ingesta diaria/.test(line))
    .join('\n');
}

/**
 * Cuánto se puede fiar uno de una lectura: sube con las cifras encontradas y baja con lo que no cuadra entre ellas (la energía frente a los nutrientes, un azúcar mayor que los hidratos…).
 * Sirve para elegir entre varias pasadas del OCR sobre la misma foto y para saber si ya basta con una.
 */
export function readingScore(reading: LabelReading): number {
  const candidate = (value: number | null): Candidate | undefined => (value === null ? undefined : { value, decimals: decimalsOf(String(value)), cost: 0 });
  const values: Partial<Record<MacroKey, Candidate>> = {};
  for (const [key, value] of [['fatG', reading.fatG], ['carbsG', reading.carbsG], ['sugarsG', reading.sugarsG], ['fiberG', reading.fiberG], ['proteinG', reading.proteinG], ['saltG', reading.saltG]] as const) {
    const c = candidate(value);
    if (c !== undefined) values[key] = c;
  }
  return reading.found * 2 - implausibility(values, reading.kcal);
}

/** ¿Basta con esta lectura? Seis o más cifras y todas cuadrando entre sí (la energía con los nutrientes, sin azúcares mayores que los hidratos…): no hace falta otra pasada. */
export function isConfidentReading(reading: LabelReading): boolean {
  return reading.found >= 6 && readingScore(reading) >= reading.found * 2 - 0.7;
}

const FIELD_KEYS = ['kcal', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarsG', 'saltG'] as const;

/**
 * Junta varias lecturas de la misma etiqueta (una por pasada del OCR): parte de la más fiable y le añade las cifras que le faltan de las demás, siempre que con ellas no cuadre peor.
 */
export function mergeReadings(readings: readonly LabelReading[]): LabelReading {
  const ranked = [...readings].sort((a, b) => readingScore(b) - readingScore(a));
  const base: LabelReading = { ...(ranked[0] as LabelReading) };
  const count = (r: LabelReading): number => FIELD_KEYS.filter((key) => r[key] !== null).length;
  for (const other of ranked.slice(1)) {
    for (const key of FIELD_KEYS) {
      if (base[key] !== null || other[key] === null) continue;
      const trial: LabelReading = { ...base, [key]: other[key] };
      trial.found = count(trial);
      if (readingScore(trial) > readingScore(base)) Object.assign(base, trial);
    }
    if (base.servingG === null && other.servingG !== null) base.servingG = other.servingG;
    if (base.basis === 'unknown' && other.basis !== 'unknown') base.basis = other.basis;
  }
  base.found = count(base);
  return base;
}

/** Cuántas lecturas posibles de cada cifra se conservan al juntar varias pasadas (el reparto prueba todas las combinaciones: con más serían demasiadas). */
const MAX_CANDIDATES_PER_FIELD = 8;
/** Lo que baja el coste de una lectura por cada pasada MÁS que dio el mismo valor: dos pasadas distintas que coinciden casi nunca se equivocan igual. */
const VOTE_BONUS = 0.7;

/**
 * Junta lo que leyó el OCR en VARIAS pasadas (otro recorte, otro tamaño, otro realce) de la misma tabla. En vez de quedarse con la mejor lectura entera y rellenarle huecos
 * (`mergeReadings`), junta las lecturas posibles de CADA cifra de todas las pasadas —una cifra que sale igual en dos pasadas cuesta menos— y elige la combinación que más cuadra con
 * la energía. Así una pasada que leyó bien las grasas y mal la fibra se completa con otra que leyó bien la fibra y mal las grasas, que es lo corriente con un OCR sobre una foto.
 */
export function readLabelTexts(texts: readonly string[], options: { ocr?: boolean } = {}): LabelReading {
  const analyses = texts.map((text) => analyzeLabelText(text, options));
  const first = analyses[0];
  if (first === undefined) return readLabelText('', options);
  const base = mergeReadings(analyses.map((a) => a.reading));
  if (analyses.length === 1 || options.ocr !== true) return base;

  const merged: Partial<Record<MacroKey, Candidate[]>> = {};
  for (const key of MACROS) {
    const byValue = new Map<number, { candidate: Candidate; votes: number }>();
    for (const analysis of analyses) {
      const seen = new Set<number>();
      for (const candidate of analysis.candidates[key] ?? []) {
        if (seen.has(candidate.value)) continue;
        seen.add(candidate.value);
        const known = byValue.get(candidate.value);
        if (known === undefined) byValue.set(candidate.value, { candidate, votes: 1 });
        else {
          known.votes++;
          if (candidate.cost < known.candidate.cost) known.candidate = candidate;
        }
      }
    }
    const list = [...byValue.values()].map(({ candidate, votes }) => ({ ...candidate, cost: candidate.cost - VOTE_BONUS * (votes - 1) })).sort((a, b) => a.cost - b.cost);
    if (list.length > 0) merged[key] = list.slice(0, MAX_CANDIDATES_PER_FIELD);
  }

  // Las energías posibles de todas las pasadas, las que más se repiten primero.
  const energyVotes = new Map<number, number>();
  for (const analysis of analyses) for (const option of new Set(analysis.kcalOptions)) energyVotes.set(option, (energyVotes.get(option) ?? 0) + 1);
  const kcalOptions = [...energyVotes.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, 4);

  let best: { picks: Partial<Record<MacroKey, number>>; kcal: number | null; penalty: number } | null = null;
  for (const kcal of kcalOptions.length > 0 ? kcalOptions : [null]) {
    const scored = resolveOcrScored(merged, kcal);
    // Un empate se queda con la energía que más pasadas leyeron.
    if (best === null || scored.penalty < best.penalty - 0.35) best = { picks: scored.picks, kcal, penalty: scored.penalty };
  }
  const chosen = best as { picks: Partial<Record<MacroKey, number>>; kcal: number | null; penalty: number };
  const reading: LabelReading = {
    ...base,
    kcal: chosen.kcal ?? base.kcal,
    proteinG: chosen.picks.proteinG ?? base.proteinG,
    carbsG: chosen.picks.carbsG ?? base.carbsG,
    fatG: chosen.picks.fatG ?? base.fatG,
    fiberG: chosen.picks.fiberG ?? base.fiberG,
    sugarsG: chosen.picks.sugarsG ?? base.sugarsG,
    saltG: chosen.picks.saltG ?? base.saltG,
  };
  reading.found = [reading.kcal, reading.proteinG, reading.carbsG, reading.fatG, reading.fiberG, reading.sugarsG, reading.saltG].filter((v) => v !== null).length;
  return reading;
}

/** Arregla lo más típico del OCR en el texto antes de leerlo: la «g» suelta que quedó como un «9» tras la cifra o tras «por 100». */
function repairGlue(text: string): string {
  return text.replace(/(\d\.\d)\s+9(?![\d.])/g, '$1 g').replace(/\b(por|cada)\s*1009\b/g, '$1 100 g');
}

/** Lee la tabla nutricional de un texto (dictado, escrito o sacado de una foto). Con `ocr` se reparan además los fallos típicos de un OCR (la «g» leída como «9», erratas…). */
export function readLabelText(original: string, options: { withName?: boolean; ocr?: boolean } = {}): LabelReading {
  return analyzeLabelText(original, options).reading;
}

/** Una lectura con lo que hizo falta para sacarla: las lecturas posibles de cada cifra y las energías posibles (para juntar varias pasadas del OCR, ver `readLabelTexts`). */
interface Analysis {
  reading: LabelReading;
  candidates: Partial<Record<MacroKey, Candidate[]>>;
  kcalOptions: number[];
}

function analyzeLabelText(original: string, options: { withName?: boolean; ocr?: boolean } = {}): Analysis {
  const ocr = options.ocr === true;
  const text = digitsFromWords(normalize(original));
  const readable = ocr ? fillMissingNames(joinNameAndValueBlocks(repairGlue(dropLeaderNoise(dropFootnotes(text))))) : text;
  const claims = claimNumbers(tokenize(readable));

  // ¿Qué columna es la de 100 g? Las etiquetas con dos columnas («por 100 g» y «por ración») traen dos cifras por línea.
  const per100At = readable.search(ocr ? /100\s*(g|gr|ml|9)\b|cada\s*100/ : /100\s*(g|gr|ml)\b|cada\s*100/);
  const servingAt = readable.search(/por\s+(racion|porcion)|cada\s+(racion|porcion)|\b(racion|porcion)\s*\(?\s*\d/);
  const basis: LabelReading['basis'] = per100At >= 0 ? 'per100' : servingAt >= 0 ? 'serving' : 'unknown';
  const column = per100At >= 0 && servingAt >= 0 && servingAt < per100At ? 1 : 0;

  type Chosen = { value: number; unit: Unit | null; raw: string };
  const valuesOf = (subject: Subject): Chosen[] => {
    const claim = claims.find((c) => c.subject === subject && c.values.some((v) => v.unit === null || v.unit === 'g' || v.unit === 'mg' || v.unit === 'ml'));
    return claim === undefined ? [] : claim.values.filter((v) => v.unit === null || v.unit === 'g' || v.unit === 'mg' || v.unit === 'ml');
  };
  const chosenOf = (subject: Subject): Chosen | null => {
    const values = valuesOf(subject);
    return values[Math.min(column, values.length - 1)] ?? null;
  };
  /** La cifra de la columna de 100 g y, si la fila trae dos, la de la otra columna (la de la ración). */
  const chosenTwo = (subject: Subject): [Chosen | null, Chosen | null] => {
    const values = valuesOf(subject);
    const per = values[Math.min(column, values.length - 1)] ?? null;
    return [per, values.length > 1 ? (values[column === 0 ? 1 : 0] ?? null) : null];
  };
  /** Las kcal posibles de la fila de energía, la más probable primero (casi siempre una sola; si el OCR deja dudas entre la cifra de kcal y la de kJ, las dos y se decide con los nutrientes). */
  const energyOptions = (): number[] => {
    const claim = claims.find((c) => c.subject === 'kcal' && c.values.length > 0);
    if (claim === undefined) return [];
    // Una fila de energía trae «kJ / kcal» (a veces dos veces, por 100 g y por ración): 1 kcal son 4,184 kJ. Si hay dos cifras con esa razón, la segunda son las kcal aunque el OCR haya
    // leído mal las unidades («1)/ 499 heal») o pegado cifras sueltas entre ellas. Es la señal más fiable que hay en esa fila. (La ventana es estrecha a propósito: una ración de la
    // cuarta parte de 100 g da una razón de 4,0 entre las columnas, y eso no es kJ/kcal.) Un kJ explícito al que no se le lee la kcal da la suya (kJ / 4,184).
    const values = claim.values;
    // Lo más claro: «X kJ / Y kcal» con las dos unidades leídas, una detrás de otra (en cualquier orden): las kcal de ese par. La columna de 100 g es el primer par. Esto no mira la razón
    // entre las dos cifras, que el OCR estropea a menudo («1536 kJ» leído «136 kJ»): con eso la fila entera se saltaba y se tomaba la columna de la ración (kcal 110 en vez de 367).
    const explicit: Array<{ kcal: number; kj: number | null }> = [];
    for (let i = 0; i + 1 < values.length; i++) {
      const a = values[i] as (typeof values)[number];
      const b = values[i + 1] as (typeof values)[number];
      if ((a.unit === 'kj' && b.unit === 'kcal') || (a.unit === 'kcal' && b.unit === 'kj')) {
        const kcalValue = a.unit === 'kcal' ? a.value : b.value;
        const kjValue = a.unit === 'kj' ? a.value : b.value;
        if (kcalValue >= 1 && kcalValue <= 1000) explicit.push({ kcal: kcalValue, kj: kjValue });
        i++;
      }
    }
    if (explicit.length > 0) {
      const pair = explicit[Math.min(column, explicit.length - 1)] as { kcal: number; kj: number | null };
      const fromKj = pair.kj !== null && pair.kj >= 150 ? roundTo(pair.kj / 4.184, 0) : null;
      const ratio = pair.kj !== null ? pair.kj / pair.kcal : 0;
      // Las dos cifras casan (la razón de siempre) o la de kJ no se puede usar (la leyó mal el OCR: «136» por «1536»): las kcal leídas.
      if (fromKj === null || (ratio >= 4.08 && ratio <= 4.3)) return [pair.kcal];
      // No casan. Una kcal muy por debajo de lo que dice el kJ perdió una cifra («S17» por «517»): manda el kJ. Si no, se dudan las dos y deciden los nutrientes (con la kcal leída primero).
      return pair.kcal < fromKj * 0.4 ? [fromKj, pair.kcal] : [pair.kcal, fromKj];
    }
    const pairs: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const at = values[i] as (typeof values)[number];
      if (at.unit === 'kcal' || at.value < 150) continue;
      let matched = false;
      for (let j = i + 1; j <= Math.min(values.length - 1, i + 2); j++) {
        const other = (values[j] as (typeof values)[number]).value;
        const ratio = at.value / other;
        if (other >= 10 && ratio >= 4.08 && ratio <= 4.3) {
          pairs.push(other);
          i = j;
          matched = true;
          break;
        }
      }
      if (!matched && at.unit === 'kj') pairs.push(roundTo(at.value / 4.184, 0));
    }
    if (pairs.length > 0) return [pairs[Math.min(column, pairs.length - 1)] as number];
    // Sin unidad, una cifra de más de 900 solo puede ser kJ.
    const energies = claim.values.map(({ value, unit }) => ({ value, unit: unit ?? (value > 900 ? 'kj' : 'kcal') }));
    const kcals = energies.filter((e) => e.unit === 'kcal');
    const kcal = kcals[Math.min(column, kcals.length - 1)];
    if (kcal !== undefined) return [kcal.value];
    const kj = energies.find((e) => e.unit === 'kj');
    return kj === undefined ? [] : [roundTo(kj.value / 4.184, 0)];
  };
  const kcalOptions = energyOptions();
  let kcal: number | null = kcalOptions[0] ?? null;

  const sodiumChosen = chosenOf('sodium');
  const sodium = sodiumChosen === null ? null : sodiumChosen.unit === 'mg' ? sodiumChosen.value / 1000 : sodiumChosen.value;
  const saltChosen = chosenOf('saltG');

  // La ración: «ración de 30 g», «porción: 25 g», «una ración (30 g)». En una foto la «g» sale a veces como «9» y la unidad no se reconoce: se toma la cifra que sigue a «ración».
  const servingClaim = claims.find((c) => c.subject === 'serving')?.values.find((v) => (v.unit === 'g' || v.unit === 'ml') && v.value > 0 && v.value <= 5000);
  const servingGuess = ocr ? Number(/racion[^\d\n]{0,14}(\d{1,3}(?:\.\d+)?)/.exec(readable)?.[1] ?? NaN) : NaN;
  const serving = servingClaim ?? (servingGuess >= 5 && servingGuess <= 1000 ? { value: servingGuess } : undefined);

  // Cada cifra y, si es de un OCR, sus lecturas posibles; sin OCR, la cifra tal cual.
  const candidates: Partial<Record<MacroKey, Candidate[]>> = {};
  for (const key of MACROS) {
    const [per, other] = chosenTwo(key);
    let list = candidatesOf(key === 'saltG' ? saltChosen : per);
    // Con dos columnas y la ración conocida, la cifra por ración tiene que ser la de 100 g × ración / 100: eso decide entre «25» y «2,5» cuando el OCR perdió la coma.
    if (ocr && serving !== undefined && other !== null && per !== null) {
      const factor = serving.value / 100;
      const others = candidatesOf(other).map((c) => c.value);
      const matches = (a: number): boolean => others.some((b) => Math.abs(b - a * factor) <= Math.max(0.06, 0.1 * a * factor));
      const good = list.filter((c) => matches(c.value));
      if (good.length > 0 && good.length < list.length) list = good.map((c) => ({ ...c, cost: c.cost - 0.9 }));
    }
    candidates[key] = list;
  }
  // Con dos energías posibles, la que deja los nutrientes más cuadrados (la primera gana los empates).
  let resolved: Partial<Record<MacroKey, number>> | null = null;
  if (ocr && kcalOptions.length > 1) {
    let bestPenalty = Infinity;
    for (const option of kcalOptions) {
      const scored = resolveOcrScored(candidates, option);
      if (scored.penalty < bestPenalty - 0.35) {
        bestPenalty = scored.penalty;
        resolved = scored.picks;
        kcal = option;
      }
    }
  }
  const picked: Partial<Record<MacroKey, number>> = ocr ? (resolved ?? resolveOcr(candidates, kcal)) : Object.fromEntries(MACROS.flatMap((key) => (candidates[key]?.[0] ? [[key, (candidates[key] as Candidate[])[0]?.value]] : [])));
  const value = (key: MacroKey): number | null => picked[key] ?? null;
  const saltG = value('saltG') ?? (sodium !== null ? roundTo(sodium * SALT_PER_SODIUM, 2) : null);

  const reading: LabelReading = {
    kcal,
    proteinG: value('proteinG'),
    carbsG: value('carbsG'),
    fatG: value('fatG'),
    fiberG: value('fiberG'),
    sugarsG: value('sugarsG'),
    saltG,
    servingG: servingClaim?.value ?? null,
    name: options.withName === true ? nameOf(original) : null,
    basis,
    found: 0,
  };
  reading.found = [reading.kcal, reading.proteinG, reading.carbsG, reading.fatG, reading.fiberG, reading.sugarsG, reading.saltG].filter((v) => v !== null).length;
  return { reading, candidates, kcalOptions };
}

/**
 * El formulario de «Enseñarle este producto» con lo leído. Si las cifras son por ración y se sabe cuánto pesa, se pasan a 100 g (que es lo que pide el formulario).
 * `scaled` dice si hubo que convertir.
 */
export function draftFromReading(reading: LabelReading, barcode: string): { draft: UserProductDraft; scaled: boolean } {
  const scaled = reading.basis === 'serving' && reading.servingG !== null && reading.servingG > 0;
  const factor = scaled ? 100 / (reading.servingG as number) : 1;
  const convert = (value: number | null, decimals: number): number | null => (value === null ? null : roundTo(value * factor, decimals));
  return {
    scaled,
    draft: {
      barcode,
      name: reading.name ?? '',
      kcal: convert(reading.kcal, 0),
      proteinG: convert(reading.proteinG, 1),
      carbsG: convert(reading.carbsG, 1),
      fatG: convert(reading.fatG, 1),
      fiberG: convert(reading.fiberG, 1),
      sugarsG: convert(reading.sugarsG, 1),
      saltG: convert(reading.saltG, 2),
      servingG: reading.servingG,
    },
  };
}
