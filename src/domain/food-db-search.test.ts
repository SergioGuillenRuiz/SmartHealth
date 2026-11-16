import { describe, expect, it } from 'vitest';
import { encodeFoodDb, FoodDb, type ProductRecord } from './food-db';
import { ProductSearch } from './food-db-search';

let next = 8_410_000_000_000;
const product = (name: string, brand: string, over: Partial<ProductRecord> = {}): ProductRecord => ({
  code: String(next++),
  name,
  brand,
  kcal: 400,
  proteinG: 6,
  carbsG: 60,
  fatG: 15,
  servingG: null,
  ...over,
});

const searchOf = (records: ProductRecord[]): ProductSearch => new ProductSearch(new FoodDb(encodeFoodDb(records, { dumpDay: 20_000 })));
const names = (hits: readonly { name: string }[]): string[] => hits.map((hit) => hit.name);

describe('ProductSearch', () => {
  it('encuentra un producto por las palabras de su nombre y de su marca, sin tildes ni mayúsculas', () => {
    const search = searchOf([
      product('Galletas María', 'Fontaneda'),
      product('Bollycao', 'Bimbo'),
      product('Jamón cocido extra', 'El Pozo'),
    ]);
    expect(names(search.find(['maria']))).toEqual(['Galletas María']);
    expect(names(search.find(['MARÍA', 'fontaneda']))).toEqual(['Galletas María']);
    expect(names(search.find(['jamon', 'pozo']))).toEqual(['Jamón cocido extra']);
    expect(search.find(['bimbo'])[0]?.name).toBe('Bollycao');
  });

  it('pide TODAS las palabras: si falta alguna, no hay producto', () => {
    const search = searchOf([product('Tarta de la abuela', 'Marca'), product('Tarta de queso', 'Otra')]);
    expect(names(search.find(['tarta', 'abuela']))).toEqual(['Tarta de la abuela']);
    expect(search.find(['tarta', 'abuela', 'chocolate'])).toEqual([]);
    expect(search.find(['pizza'])).toEqual([]);
    expect(search.find([])).toEqual([]);
    expect(search.find(['a'])).toEqual([]); // una letra no es una palabra
  });

  it('una palabra es entera y empieza donde empieza la palabra: «pan» no es «panecillo» ni «sultana»', () => {
    const search = searchOf([product('Panecillos de leche', 'X'), product('Pan de molde', 'Y'), product('Lampan', 'Z')]);
    expect(names(search.find(['pan']))).toEqual(['Pan de molde']);
  });

  it('el singular y el plural valen lo mismo', () => {
    const search = searchOf([product('Galleta de avena', 'A'), product('Yogures de fresa', 'B')]);
    expect(names(search.find(['galletas']))).toEqual(['Galleta de avena']);
    expect(names(search.find(['yogur']))).toEqual(['Yogures de fresa']);
  });

  it('gana el producto de nombre más parecido a lo pedido (menos palabras de sobra)', () => {
    const search = searchOf([
      product('Chocolate con leche y avellanas enteras extra', 'Marca', { kcal: 560 }),
      product('Chocolate con leche', 'Marca', { kcal: 530 }),
    ]);
    expect(names(search.find(['chocolate', 'leche']))).toEqual(['Chocolate con leche', 'Chocolate con leche y avellanas enteras extra']);
  });

  it('los productos con las mismas cifras cuentan como uno, y el repetido pesa más', () => {
    const records = [
      product('Nocilla original', 'Nocilla', { kcal: 546, proteinG: 5, carbsG: 58, fatG: 32, servingG: 15 }),
      product('Nocilla Original', 'Nocilla', { kcal: 546, proteinG: 5, carbsG: 58, fatG: 32 }),
      product('Nocilla', 'Nocilla', { kcal: 546, proteinG: 5, carbsG: 58, fatG: 32 }),
      product('Nocilla blanca', 'Nocilla', { kcal: 544, proteinG: 4, carbsG: 62, fatG: 31 }),
    ];
    const hits = searchOf(records).find(['nocilla'], 5);
    // Tres productos iguales y uno distinto: dos resultados, y manda el repetido.
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ kcal: 546, fatG: 32 });
    expect(hits[1]).toMatchObject({ kcal: 544 });
  });

  it('devuelve las cifras de la etiqueta y la ración, y respeta el límite', () => {
    const search = searchOf([
      product('Barrita de cereales', 'Special K', { kcal: 395.3, proteinG: 5.1, carbsG: 69, fatG: 9.6, servingG: 22 }),
      product('Barrita de cereales chocolate', 'Otra', { kcal: 410 }),
      product('Barrita de cereales miel', 'Tercera', { kcal: 380 }),
    ]);
    const [first] = search.find(['barrita', 'special', 'k']);
    expect(first).toEqual({ name: 'Barrita de cereales', brand: 'Special K', kcal: 395.3, proteinG: 5.1, carbsG: 69, fatG: 9.6, servingG: 22 });
    expect(search.find(['barrita'], 2)).toHaveLength(2);
  });

  it('aguanta textos con eñes, emojis y caracteres raros sin descuadrar los productos que van detrás', () => {
    const search = searchOf([
      product('Ñoquis de patata 🥔', 'Gnocchi'),
      product('Crème brûlée ça va', 'Française'),
      product('日本 ラーメン', 'Japan'),
      product('Turrón blando', 'El Almendro'),
    ]);
    expect(names(search.find(['noquis']))).toEqual(['Ñoquis de patata 🥔']);
    expect(names(search.find(['creme', 'brulee']))).toEqual(['Crème brûlée ça va']);
    expect(names(search.find(['turron', 'almendro']))).toEqual(['Turrón blando']);
    expect(names(search.find(['ramen']))).toEqual([]);
  });

  it('una base vacía no encuentra nada', () => {
    expect(searchOf([]).find(['cola', 'cao'])).toEqual([]);
  });

  it('se puede preparar de antemano sin cambiar lo que encuentra (también con la base vacía)', () => {
    const search = searchOf([product('Galletas María', 'Fontaneda')]);
    search.warm();
    search.warm();
    expect(names(search.find(['maria']))).toEqual(['Galletas María']);
    expect(() => searchOf([]).warm()).not.toThrow();
  });

  it('el final de un producto no se pega al principio del siguiente', () => {
    const search = searchOf([product('Queso', 'Fresco'), product('Mantequilla', 'Sal')]);
    // «fresco» y «mantequilla» están en productos distintos aunque sus textos estén uno detrás de otro.
    expect(search.find(['fresco', 'mantequilla'])).toEqual([]);
    expect(search.find(['queso', 'fresco'])).toHaveLength(1);
  });
});
