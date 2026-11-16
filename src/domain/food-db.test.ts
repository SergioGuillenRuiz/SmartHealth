import { describe, expect, it } from 'vitest';
import { cleanText, dateOfDay, dayOfDate, encodeFoodDb, FoodDb, MAX_NAME_CHARS, type ProductRecord } from './food-db';

const product = (code: string, over: Partial<ProductRecord> = {}): ProductRecord => ({
  code,
  name: `Producto ${code}`,
  brand: 'Marca',
  kcal: 250.4,
  proteinG: 8.1,
  carbsG: 40,
  fatG: 6.25,
  servingG: 30,
  ...over,
});

const open = (records: ProductRecord[], dumpDay = 20_000): FoodDb => new FoodDb(encodeFoodDb(records, { dumpDay }));

describe('encodeFoodDb / FoodDb', () => {
  it('guarda y recupera un producto, con las cifras a una décima', () => {
    const db = open([product('8410000000016')]);
    expect(db.count).toBe(1);
    expect(db.find('8410000000016')).toEqual({ code: '8410000000016', name: 'Producto 8410000000016', brand: 'Marca', kcal: 250.4, proteinG: 8.1, carbsG: 40, fatG: 6.3, servingG: 30, fiberG: null, sugarsG: null, saltG: null });
  });

  it('guarda la fibra, los azúcares (décimas) y la sal (centésimas) y distingue «sin dato» de cero', () => {
    const db = open([
      product('8410000000016', { fiberG: 3.46, sugarsG: 12.04, saltG: 1.234 }),
      product('8410000000023', { fiberG: 0, sugarsG: 0, saltG: 0 }),
      product('8410000000030', { fiberG: 2, sugarsG: null }),
    ]);
    expect(db.version).toBe(2);
    expect(db.find('8410000000016')).toMatchObject({ fiberG: 3.5, sugarsG: 12, saltG: 1.23 });
    expect(db.find('8410000000023')).toMatchObject({ fiberG: 0, sugarsG: 0, saltG: 0 });
    expect(db.find('8410000000030')).toMatchObject({ fiberG: 2, sugarsG: null, saltG: null });
  });

  it('lee una base antigua (versión 1, sin fibra, azúcares ni sal) con sus productos sin ese dato', () => {
    // La versión 1: cifras de 10 bytes por producto (kcal, proteínas, hidratos, grasas y ración).
    const text = new TextEncoder().encode('Pan\u0000Marca');
    const bytes = new Uint8Array(32 + 8 + 10 + 8 + text.length);
    const view = new DataView(bytes.buffer);
    bytes.set([0x53, 0x52, 0x46, 0x44], 0);
    view.setUint8(4, 1);
    view.setUint32(8, 1, true);
    view.setUint32(12, 20_000, true);
    view.setUint32(16, text.length, true);
    view.setFloat64(32, 8410000000016, true);
    [2650, 90, 490, 32, 60].forEach((value, i) => view.setUint16(40 + i * 2, value, true));
    view.setUint32(50, 0, true);
    view.setUint32(54, text.length, true);
    bytes.set(text, 58);
    const db = new FoodDb(bytes);
    expect(db.version).toBe(1);
    expect(db.find('8410000000016')).toEqual({ code: '8410000000016', name: 'Pan', brand: 'Marca', kcal: 265, proteinG: 9, carbsG: 49, fatG: 3.2, servingG: 60, fiberG: null, sugarsG: null, saltG: null });
  });

  it('rechaza una fibra, unos azúcares o una sal imposibles al escribir', () => {
    expect(() => encodeFoodDb([product('8410000000016', { saltG: -1 })], { dumpDay: 1 })).toThrow(/sal fuera de rango/);
    expect(() => encodeFoodDb([product('8410000000016', { fiberG: 70_000 })], { dumpDay: 1 })).toThrow(/fibra fuera de rango/);
  });

  it('busca en cualquier posición, sea cual sea el orden en que se le dieron', () => {
    const codes = ['8410000000016', '3017620422003', '5449000000996', '0012345678905', '40170725', '4006381333931'];
    const db = open(codes.map((code) => product(code)));
    for (const code of codes) expect(db.find(code)?.name).toBe(`Producto ${code}`);
    // Por orden de código: el primero y el último.
    expect(db.at(0).code).toBe('40170725'); // el EAN-8 es el menor
    expect(db.at(db.count - 1).code).toBe('8410000000016');
    expect(db.find('8410000000017')).toBeNull();
    expect(db.find('1')).toBeNull();
    expect(db.find('abc')).toBeNull();
    expect(db.find('')).toBeNull();
  });

  it('un UPC-A de 12 cifras y su EAN-13 con un cero delante son el mismo producto', () => {
    const db = open([product('012345678905')]);
    expect(db.find('012345678905')?.code).toBe('0012345678905');
    expect(db.find('0012345678905')?.name).toBe('Producto 012345678905');
  });

  it('una base vacía es válida y no encuentra nada', () => {
    const db = open([]);
    expect(db.count).toBe(0);
    expect(db.find('8410000000016')).toBeNull();
  });

  it('la ración que falta se queda como null y los textos aguantan acentos, eñes y emojis', () => {
    const db = open([product('8410000000016', { name: 'Jamón serrano · niño 🐷', brand: 'Ñam', servingG: null })]);
    expect(db.find('8410000000016')).toMatchObject({ name: 'Jamón serrano · niño 🐷', brand: 'Ñam', servingG: null });
  });

  it('un nombre o una marca vacíos salen vacíos', () => {
    const db = open([product('8410000000016', { name: '', brand: '' })]);
    expect(db.find('8410000000016')).toMatchObject({ name: '', brand: '' });
  });

  it('guarda el día de los datos', () => {
    expect(open([product('8410000000016')], 20_377).dumpDay).toBe(20_377);
  });

  it('encuentra todos los productos de una base grande', () => {
    const records: ProductRecord[] = [];
    let seed = 12345;
    const used = new Set<number>();
    while (records.length < 20_000) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const n = 8_400_000_000_000 + (seed % 100_000_000);
      if (used.has(n)) continue;
      used.add(n);
      records.push(product(String(n), { kcal: records.length % 900 }));
    }
    const db = open(records);
    expect(db.count).toBe(20_000);
    for (const record of records) {
      const found = db.find(record.code);
      expect(found?.code).toBe(record.code);
      expect(found?.kcal).toBe(record.kcal);
    }
    expect(db.find('8499999999990')).toBeNull();
  });

  it('rechaza un código repetido, un código que no es de cifras y cifras imposibles', () => {
    expect(() => encodeFoodDb([product('8410000000016'), product('8410000000016')], { dumpDay: 1 })).toThrow(/repetido/);
    expect(() => encodeFoodDb([product('84100')], { dumpDay: 1 })).toThrow(/no válido/);
    expect(() => encodeFoodDb([product('84100000000AB')], { dumpDay: 1 })).toThrow(/no válido/);
    expect(() => encodeFoodDb([product('8410000000016', { kcal: -1 })], { dumpDay: 1 })).toThrow(RangeError);
    expect(() => encodeFoodDb([product('8410000000016', { fatG: 70_000 })], { dumpDay: 1 })).toThrow(RangeError);
    expect(() => encodeFoodDb([product('8410000000016', { servingG: 70_000 })], { dumpDay: 1 })).toThrow(RangeError);
    expect(() => encodeFoodDb([product('8410000000016', { kcal: Number.NaN })], { dumpDay: 1 })).toThrow(RangeError);
  });

  it('no abre algo que no es una base de productos o que está cortado', () => {
    const good = encodeFoodDb([product('8410000000016'), product('3017620422003')], { dumpDay: 1 });
    expect(() => new FoodDb(new Uint8Array(0))).toThrow(/No es una base/);
    expect(() => new FoodDb(new TextEncoder().encode('esto no es una base de productos, ni de lejos, de verdad'))).toThrow(/No es una base/);
    expect(() => new FoodDb(good.slice(0, good.length - 3))).toThrow(/incompleta/);
    expect(() => new FoodDb(good.slice(0, 20))).toThrow(/No es una base/);
    const wrongVersion = good.slice();
    wrongVersion[4] = 9;
    expect(() => new FoodDb(wrongVersion)).toThrow(/Versión/);
    const longer = new Uint8Array(good.length + 1);
    longer.set(good);
    expect(() => new FoodDb(longer)).toThrow(/incompleta/);
  });

  it('abre también un ArrayBuffer (lo que devuelve fetch) y una vista con desfase', () => {
    const good = encodeFoodDb([product('8410000000016')], { dumpDay: 1 });
    expect(new FoodDb(good.buffer as ArrayBuffer).find('8410000000016')?.brand).toBe('Marca');
    const padded = new Uint8Array(good.length + 7);
    padded.set(good, 7);
    expect(new FoodDb(padded.subarray(7)).find('8410000000016')?.brand).toBe('Marca');
  });

  it('at() no sale de la base', () => {
    const db = open([product('8410000000016')]);
    expect(() => db.at(-1)).toThrow(RangeError);
    expect(() => db.at(1)).toThrow(RangeError);
    expect(() => db.at(0.5)).toThrow(RangeError);
  });
});

describe('cleanText', () => {
  it('quita caracteres de control y espacios repetidos', () => {
    expect(cleanText('  Leche \t entera\n\u0000 1 L  ', 80)).toBe('Leche entera 1 L');
  });

  it('recorta por letras, sin partir un emoji por la mitad', () => {
    const text = '🐷'.repeat(100);
    const cut = cleanText(text, MAX_NAME_CHARS);
    expect([...cut]).toHaveLength(MAX_NAME_CHARS);
    expect(cut).not.toMatch(/�/);
  });

  it('un texto corto se queda como está', () => {
    expect(cleanText('Yogur natural', 80)).toBe('Yogur natural');
  });
});

describe('días', () => {
  it('pasa de fecha a día y vuelta', () => {
    expect(dayOfDate('1970-01-02')).toBe(1);
    expect(dateOfDay(dayOfDate('2026-10-17'))).toBe('2026-10-17');
    expect(() => dayOfDate('ayer')).toThrow(RangeError);
  });
});
