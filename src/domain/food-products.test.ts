import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { encodeFoodDb, FoodDb, type ProductRecord } from './food-db';
import { ProductSearch, type ProductHit } from './food-db-search';
import { parseFoodTables } from './food-table';
import { analyzeMealText, type ProductLookup } from './food-text';

// Lo que la tabla de alimentos no entiende («yogur flurbo», «pizza de trufa», «kinder bueno white») se busca entre los productos envasados de la
// base de la app. Aquí, con un buscador de mentira que apunta lo que le piden, y con una base pequeña de verdad. Las marcas y los productos de los
// ejemplos están inventados («flurbo»): así ninguna palabra de la tabla de alimentos los puede entender algún día.

const table = parseFoodTables(FOOD_SOURCES);

const hit = (over: Partial<ProductHit> = {}): ProductHit => ({ name: 'Yogur Flurbo', brand: 'Marca', kcal: 90, proteinG: 4, carbsG: 14, fatG: 2, servingG: 125, ...over });

/** Un buscador que solo conoce lo que se le dice (por una palabra que va entre las pedidas) y apunta cada pregunta. */
function fakeLookup(known: Record<string, readonly ProductHit[]>): { lookup: ProductLookup; asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    lookup: (words) => {
      asked.push([...words]);
      const key = Object.keys(known).find((word) => words.includes(word));
      return key === undefined ? [] : known[key]!;
    },
  };
}

describe('productos envasados en el lenguaje natural', () => {
  it('lo que la tabla no entiende se busca con TODAS las palabras de esa parte, y el producto sustituye a lo entendido', () => {
    const { lookup, asked } = fakeLookup({ flurbo: [hit()] });
    const analysis = analyzeMealText('un yogur flurbo', table, lookup);
    expect(asked).toEqual([['yogur', 'flurbo']]);
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]).toMatchObject({ name: 'Yogur Flurbo (Marca)', amount: 125, unit: 'g', kcal: 113, assumed: true });
    expect(analysis.unknown).toEqual([]);
    expect(analysis.assumptions).toContain('«yogur flurbo» lo busqué en la base de productos de la app: Yogur Flurbo (Marca), 90 kcal por 100 g.');
  });

  it('el producto lleva la cantidad dicha: unidades de su ración, o gramos exactos', () => {
    const { lookup } = fakeLookup({ flurbo: [hit()] });
    expect(analyzeMealText('dos yogures flurbo', table, lookup).items[0]).toMatchObject({ amount: 250, kcal: 225 });
    const grams = analyzeMealText('200 g de yogur flurbo', table, lookup);
    expect(grams.items[0]).toMatchObject({ name: 'Yogur Flurbo (Marca)', amount: 200, kcal: 180, assumed: false });
  });

  it('si el producto no trae ración, se queda con los gramos que la tabla había supuesto para eso mismo', () => {
    const { lookup } = fakeLookup({ flurbo: [hit({ name: 'Pizza flurbo', brand: 'Lidl', kcal: 305, servingG: null })] });
    const analysis = analyzeMealText('pizza flurbo', table, lookup);
    expect(analysis.items).toHaveLength(1);
    // Una pizza de la tabla son 315 g.
    expect(analysis.items[0]).toMatchObject({ name: 'Pizza flurbo (Lidl)', amount: 315, kcal: 961, assumed: true });
  });

  it('sin ración ni nada que sustituir, se supone según lo calórico que sea: poco de un dulce, más de una bebida', () => {
    const { lookup } = fakeLookup({ flurbo: [hit({ name: 'Flurbo', brand: '', kcal: 520, servingG: null })], blorgo: [hit({ name: 'Blorgo', brand: '', kcal: 60, servingG: null })] });
    expect(analyzeMealText('un flurbo', table, lookup).items[0]).toMatchObject({ name: 'Flurbo', amount: 30, kcal: 156 });
    expect(analyzeMealText('un blorgo', table, lookup).items[0]).toMatchObject({ name: 'Blorgo', amount: 200, kcal: 120 });
  });

  it('cada parte del texto se busca por separado: «un flurbo y un blorgo»', () => {
    const { lookup, asked } = fakeLookup({ flurbo: [hit({ name: 'Flurbo', brand: '', kcal: 500 })], blorgo: [hit({ name: 'Blorgo', brand: '', kcal: 100 })] });
    const analysis = analyzeMealText('un flurbo y un blorgo', table, lookup);
    expect(asked).toEqual([['flurbo'], ['blorgo']]);
    expect(analysis.items.map((item) => item.name)).toEqual(['Flurbo', 'Blorgo']);
  });

  it('lo que la tabla entiende por completo no se busca', () => {
    const { lookup, asked } = fakeLookup({});
    const analysis = analyzeMealText('dos huevos y un café con leche', table, lookup);
    expect(asked).toEqual([]);
    expect(analysis.items.map((item) => item.name)).toEqual(['Huevo ×2', 'Café con leche']);
  });

  it('si la base no tiene nada, todo queda como estaba: lo entendido, sumado, y lo demás, avisado', () => {
    const { lookup, asked } = fakeLookup({});
    const analysis = analyzeMealText('un yogur flurbo', table, lookup);
    expect(asked).toHaveLength(1);
    expect(analysis.unknown).toEqual(['flurbo']);
    expect(analysis.items).toHaveLength(1);
    expect(analysis.assumptions).not.toContain('base de productos');
    // Exactamente lo mismo que sin base.
    expect(analyzeMealText('un yogur flurbo', table)).toEqual(analysis);
  });

  it('con una sola palabra, solo vale un producto que se llame así o sea de esa marca (no «Bizcocho Flurbo»)', () => {
    const inside: ProductLookup = () => [hit({ name: 'Bizcocho Flurbo', brand: 'Dulcesol', kcal: 370, servingG: 50 })];
    const analysis = analyzeMealText('un flurbo', table, inside);
    expect(analysis.items).toEqual([]);
    expect(analysis.unknown).toEqual(['flurbo']);
    const brand: ProductLookup = () => [hit({ name: 'Cookies', brand: 'Flurbo', kcal: 500, servingG: 30 })];
    expect(analyzeMealText('un flurbo', table, brand).items[0]!.name).toBe('Cookies (Flurbo)');
    const named: ProductLookup = () => [hit({ name: 'Flurbos crujientes', brand: '', kcal: 500, servingG: 30 })];
    expect(analyzeMealText('un flurbo', table, named).items[0]!.name).toBe('Flurbos crujientes');
  });

  it('una palabra suelta sin decir cuánto no se busca (es más probable que sea una palabra de la frase): «cena estupenda», «hoy he comido fuera»', () => {
    const { lookup, asked } = fakeLookup({ estupenda: [hit({ name: 'Estupendas', brand: '', kcal: 450 })], fuera: [hit({ name: 'Fuera Ahumado', brand: '', kcal: 296 })] });
    expect(analyzeMealText('cena estupenda: ensalada y pescado', table, lookup).items.map((item) => item.name)).toEqual(['Ensalada', 'Pescado blanco']);
    expect(analyzeMealText('hoy he comido fuera con mis amigos', table, lookup).items).toEqual([]);
    expect(asked).toEqual([]);
    // Con una cantidad o una medida («una», «una bolsa de») sí.
    expect(analyzeMealText('una estupenda', table, lookup).items.map((item) => item.name)).toEqual(['Estupendas']);
    expect(analyzeMealText('una bolsa de estupenda', table, lookup).items.map((item) => item.name)).toEqual(['Estupendas']);
    expect(asked).toHaveLength(2);
  });

  it('con varias palabras vale el mejor producto que las lleve todas', () => {
    const lookup: ProductLookup = () => [hit({ name: 'Bizcocho Flurbo', brand: 'Dulcesol', kcal: 370, servingG: 50 }), hit({ name: 'Otro', kcal: 100 })];
    expect(analyzeMealText('un bizcocho flurbo', table, lookup).items[0]!.name).toBe('Bizcocho Flurbo (Dulcesol)');
  });

  it('palabras demasiado cortas o demasiadas no se buscan', () => {
    const { lookup, asked } = fakeLookup({});
    analyzeMealText('ab', table, lookup);
    analyzeMealText('aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii', table, lookup);
    expect(asked).toEqual([]);
    analyzeMealText('un abcd', table, lookup);
    expect(asked).toEqual([['abcd']]);
  });

  it('el nombre de un producto lleva su marca solo si no la dice ya', () => {
    const { lookup } = fakeLookup({ zorro: [hit({ name: 'Galletas Zorro', brand: 'Zorro', servingG: 20 })], lobo: [hit({ name: 'Galletas lobo', brand: 'Bosque', servingG: 20 })] });
    expect(analyzeMealText('un zorro', table, lookup).items[0]!.name).toBe('Galletas Zorro');
    expect(analyzeMealText('galletas lobo', table, lookup).items[0]!.name).toBe('Galletas lobo (Bosque)');
  });

  it('un número no cuenta como palabra para la búsqueda', () => {
    const { lookup, asked } = fakeLookup({ flurbo: [hit()] });
    analyzeMealText('3 yogures flurbo', table, lookup);
    expect(asked).toEqual([['yogures', 'flurbo']]);
  });
});

describe('con una base de productos de verdad (pequeña)', () => {
  const records: ProductRecord[] = [
    { code: '8410000000016', name: 'Yogur Flurbó', brand: 'Marca', kcal: 90, proteinG: 4, carbsG: 14, fatG: 2, servingG: 125 },
    { code: '8410000000023', name: 'Pizza trufada Zorro', brand: 'Lidl', kcal: 305, proteinG: 12, carbsG: 35, fatG: 12, servingG: null },
    { code: '8410000000030', name: 'Pastel Ñamñam', brand: 'Pastelitos', kcal: 430, proteinG: 7, carbsG: 74, fatG: 11, servingG: 60 },
    { code: '8410000000047', name: 'Jamón cocido extra', brand: 'El Pozo', kcal: 100, proteinG: 18, carbsG: 1, fatG: 2.5, servingG: null },
  ];
  const search = new ProductSearch(new FoodDb(encodeFoodDb(records, { dumpDay: 20_742 })));
  const lookup: ProductLookup = (words) => search.find(words);

  it('encuentra lo que la tabla no sabe y lo cuenta con las cifras de su etiqueta', () => {
    const analysis = analyzeMealText('un yogur flurbo', table, lookup);
    expect(analysis.unknown).toEqual([]);
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]).toMatchObject({ name: 'Yogur Flurbó (Marca)', amount: 125, kcal: 113 });
    expect(analysis.assumptions).toContain('base de productos');
  });

  it('las palabras con tilde o eñe de un producto se encuentran escritas con o sin ella', () => {
    for (const text of ['pastel namnam', 'pastel ñamñam', 'un pastel Ñamñam de pastelitos']) {
      expect(analyzeMealText(text, table, lookup).items.map((item) => item.name), text).toEqual(['Pastel Ñamñam (Pastelitos)']);
    }
    expect(analyzeMealText('yogur flurbó', table, lookup).items[0]!.name).toBe('Yogur Flurbó (Marca)');
  });

  it('lo mezclado con alimentos de la tabla se cuenta aparte', () => {
    const analysis = analyzeMealText('un café con leche y pizza trufada zorro', table, lookup);
    expect(analysis.items.map((item) => item.name)).toEqual(['Café con leche', 'Pizza trufada Zorro (Lidl)']);
    // La pizza no trae ración: los 315 g de una pizza de la tabla.
    expect(analysis.items[1]).toMatchObject({ amount: 315 });
  });

  it('lo que no está en la base se avisa como siempre', () => {
    const analysis = analyzeMealText('arroz con zarandajo', table, lookup);
    expect(analysis.items).toHaveLength(1);
    expect(analysis.unknown).toEqual(['zarandajo']);
  });
});
