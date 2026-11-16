import { describe, expect, it } from 'vitest';
import { asNumber, isBarcode, per100gFromLabel } from './food-label';

describe('per100gFromLabel', () => {
  it('lee las cifras por 100 g', () => {
    expect(per100gFromLabel({ kcal: 61, protein: 3.5, carbs: 4.7, fat: 3.2 })).toEqual({ kcal: 61, proteinG: 3.5, carbsG: 4.7, fatG: 3.2 });
    expect(per100gFromLabel({ kcal: '61,5', protein: '3,5', carbs: '4.7', fat: '3.2' })).toEqual({ kcal: 61.5, proteinG: 3.5, carbsG: 4.7, fatG: 3.2 });
  });

  it('si solo trae kilojulios, los pasa a kcal', () => {
    expect(per100gFromLabel({ kj: 1883 })?.kcal).toBeCloseTo(450, 0);
    // Con las calorías vacías y los kJ presentes, salen de los kJ.
    expect(per100gFromLabel({ kcal: '', kj: 836 })?.kcal).toBeCloseTo(199.8, 0);
  });

  it('sin energía o con cifras imposibles, no hay nada que anotar', () => {
    expect(per100gFromLabel({})).toBeNull();
    expect(per100gFromLabel({ kcal: '' })).toBeNull();
    expect(per100gFromLabel({ kcal: 'mucho' })).toBeNull();
    expect(per100gFromLabel({ kcal: -5 })).toBeNull();
    expect(per100gFromLabel({ kcal: 2500 })).toBeNull();
    expect(per100gFromLabel({ kcal: 100, protein: 400 })).toBeNull();
    expect(per100gFromLabel({ kcal: 100, carbs: 101 })).toBeNull();
    expect(per100gFromLabel({ kcal: 100, fat: 150 })).toBeNull();
  });

  it('unas calorías que no cuadran con los nutrientes no sirven; el agua (0 kcal) sí', () => {
    // 0 kcal con 70 g de hidratos es un dato mal subido.
    expect(per100gFromLabel({ kcal: 0, carbs: 70 })).toBeNull();
    expect(per100gFromLabel({ kcal: 0 })).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  });

  it('un nutriente que falta cuenta como 0', () => {
    expect(per100gFromLabel({ kcal: 100, carbs: 20 })).toEqual({ kcal: 100, proteinG: 0, carbsG: 20, fatG: 0 });
  });
});

describe('asNumber', () => {
  it('una cadena vacía no es un cero', () => {
    expect(asNumber('')).toBeNull();
    expect(asNumber('  ')).toBeNull();
    expect(asNumber('0')).toBe(0);
    expect(asNumber(undefined)).toBeNull();
    expect(asNumber(NaN)).toBeNull();
    expect(asNumber('1,5')).toBe(1.5);
  });
});

describe('isBarcode', () => {
  it('acepta EAN-13, EAN-8 y UPC-A con su dígito de control', () => {
    expect(isBarcode('8410000000016')).toBe(true); // EAN-13
    expect(isBarcode('96385074')).toBe(true); // EAN-8
    expect(isBarcode('036000291452')).toBe(true); // UPC-A
  });

  it('rechaza dígito de control erróneo, letras y longitudes raras', () => {
    expect(isBarcode('8410000000019')).toBe(false);
    expect(isBarcode('84100000000AB')).toBe(false);
    expect(isBarcode('12345')).toBe(false);
    expect(isBarcode('')).toBe(false);
  });
});
