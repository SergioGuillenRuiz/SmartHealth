import { describe, expect, it } from 'vitest';
import { checkDigit, expandUpcE, gtinFromScan, lookupCodes, neighbourCodes, typedBarcode, unlistedReason } from './barcode';
import { isBarcode } from './food-label';

describe('checkDigit', () => {
  it('calcula la cifra de control de cada longitud', () => {
    expect(checkDigit('841000000001')).toBe(6); // EAN-13
    expect(checkDigit('9638507')).toBe(4); // EAN-8
    expect(checkDigit('03600029145')).toBe(2); // UPC-A
    expect(checkDigit('1001234567890')).toBe(2); // GTIN-14
  });
});

describe('expandUpcE', () => {
  it('pasa un UPC-E a UPC-A según su última cifra', () => {
    expect(expandUpcE('04252614')).toBe('042100005264'); // termina en 4
    expect(expandUpcE('01234565')).toBe('012345000065'); // termina en 5
    expect(expandUpcE('01234505')).toBe('012000003455'); // termina en 0
  });
  it('rechaza lo que no lo es o no cuadra', () => {
    expect(expandUpcE('04252615')).toBeNull(); // cifra de control mala
    expect(expandUpcE('24252614')).toBeNull(); // un UPC-E empieza por 0 o 1
    expect(expandUpcE('1234')).toBeNull();
  });
});

describe('typedBarcode: el código que teclea la persona', () => {
  it('admite espacios y guiones, y los de 8, 12, 13 y 14 cifras con su control', () => {
    expect(typedBarcode('8410000000016')).toBe('8410000000016');
    expect(typedBarcode('841 0000 000016')).toBe('8410000000016');
    expect(typedBarcode('84-10000-000016')).toBe('8410000000016');
    expect(typedBarcode('96385074')).toBe('96385074');
    expect(typedBarcode('036000291452')).toBe('036000291452');
  });
  it('un UPC-E de 8 cifras que no es un EAN-8 válido se pasa a UPC-A', () => {
    expect(isBarcode('04252614')).toBe(false);
    expect(typedBarcode('04252614')).toBe('042100005264');
  });
  it('lo demás no es un código', () => {
    expect(typedBarcode('8410000000019')).toBeNull();
    expect(typedBarcode('hola')).toBeNull();
    expect(typedBarcode('')).toBeNull();
    expect(typedBarcode('12345')).toBeNull();
  });
});

describe('gtinFromScan: el producto que hay en lo que leyó la cámara', () => {
  it('las cifras tal cual', () => {
    expect(gtinFromScan('8410000000016')).toBe('8410000000016');
    expect(gtinFromScan(' 96385074 ')).toBe('96385074');
    expect(gtinFromScan('10012345678902')).toBe('10012345678902'); // ITF-14 de una caja
  });
  it('dentro de un código GS1 con o sin paréntesis, aunque siga con más datos', () => {
    expect(gtinFromScan('(01)08410000000016')).toBe('08410000000016');
    expect(gtinFromScan('(01)08410000000016(17)261231(10)LOTE1')).toBe('08410000000016');
    expect(gtinFromScan('0108410000000016')).toBe('08410000000016');
    expect(gtinFromScan('01084100000000161726123110LOTE1')).toBe('08410000000016');
  });
  it('dentro de un enlace GS1 (QR)', () => {
    expect(gtinFromScan('https://id.gs1.org/01/08410000000016')).toBe('08410000000016');
    expect(gtinFromScan('https://marca.es/01/08410000000016/10/ABC?x=1')).toBe('08410000000016');
  });
  it('lo que no es un producto no vale', () => {
    expect(gtinFromScan('https://marca.es/receta/123')).toBeNull();
    expect(gtinFromScan('HOLA')).toBeNull();
    expect(gtinFromScan('8410000000019')).toBeNull(); // cifra de control mala
    expect(gtinFromScan('(01)08410000000019')).toBeNull();
    expect(gtinFromScan('')).toBeNull();
  });
});

describe('lookupCodes: qué más probar para el mismo producto', () => {
  it('un código normal se prueba solo', () => {
    expect(lookupCodes('8410000000016')).toEqual(['8410000000016']);
    expect(lookupCodes('96385074')).toEqual(['96385074']);
    expect(lookupCodes('08410000000016')).toEqual(['08410000000016']); // GTIN-14 con 0 = el EAN-13
  });
  it('un GTIN-14 de caja lleva dentro el código de la unidad', () => {
    // 1 + 841000000001 + control del 14 → dentro: 841000000001 + su control (6) = 8410000000016
    const box = `1841000000001${checkDigit('1841000000001')}`;
    expect(isBarcode(box)).toBe(true);
    expect(lookupCodes(box)).toEqual([box, '8410000000016']);
  });
});

describe('unlistedReason: códigos que no pueden estar en una base', () => {
  it('las etiquetas de balanza y de la propia tienda', () => {
    expect(unlistedReason('2812345002345')).toMatch(/de la propia tienda/);
    expect(unlistedReason('0212345002347')).toMatch(/de la propia tienda/);
    expect(unlistedReason(`41234567890${checkDigit('41234567890')}`)).toMatch(/de la propia tienda/); // UPC-A de sistema 4: de uso restringido
    expect(unlistedReason(`21234567890${checkDigit('21234567890')}`)).toMatch(/de la propia tienda/); // UPC-A de sistema 2: de peso variable
  });
  it('libros, revistas y cupones', () => {
    expect(unlistedReason('9788437604947')).toMatch(/libro/);
    expect(unlistedReason('9771234567003')).toMatch(/libro o una revista/);
    expect(unlistedReason('9912345678900')).toMatch(/cupón/);
  });
  it('un producto normal no tiene motivo', () => {
    expect(unlistedReason('8410000000016')).toBeNull();
    expect(unlistedReason('96385074')).toBeNull();
    expect(unlistedReason('5449000000996')).toBeNull();
  });
});

describe('neighbourCodes: el código que se quiso teclear', () => {
  it('con la cifra de control mal, la primera propuesta es corregirla', () => {
    expect(neighbourCodes('8410000000019')[0]).toBe('8410000000016');
  });
  it('con una cifra cambiada hay candidatos válidos que difieren en una sola cifra', () => {
    const typed = '8410000000116'; // se tecleó un 1 de más en el medio del código bueno
    const found = neighbourCodes(typed);
    expect(found.every((code) => isBarcode(code))).toBe(true);
    expect(found).toContain('8410000000016');
    for (const code of found) expect([...code].filter((digit, i) => digit !== typed[i]).length).toBeGreaterThanOrEqual(1);
  });
  it('un código válido o de otra longitud no tiene vecinos', () => {
    expect(neighbourCodes('8410000000016')).toEqual([]);
    expect(neighbourCodes('12345')).toEqual([]);
    expect(neighbourCodes('abc')).toEqual([]);
  });
});
