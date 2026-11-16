import { describe, expect, it } from 'vitest';
import { parseDecimal, parseHeightCm, parseVolumeMl, parseWhole, UNITS } from './parse';

describe('parseDecimal', () => {
  it('acepta coma y punto', () => {
    expect(parseDecimal('10,5')).toBe(10.5);
    expect(parseDecimal(' 10.5 ')).toBe(10.5);
    expect(parseDecimal('42')).toBe(42);
  });
  it('vacío o basura → null', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('1,2,3')).toBeNull();
  });
});

describe('parseWhole (calorías, minutos…): el punto separa miles', () => {
  it('«1.500» es mil quinientos, no 1,5 (que se guardaba como 2 kcal sin avisar)', () => {
    expect(parseWhole('1.500')).toBe(1500);
    expect(parseWhole('2.000')).toBe(2000);
    expect(parseWhole('12.500')).toBe(12_500);
    expect(parseWhole('1.234.567')).toBe(1_234_567);
    expect(parseWhole(' 1.500 ')).toBe(1500);
  });
  it('lo demás se lee como siempre: sin separador, con coma decimal o con un punto de menos de tres cifras', () => {
    expect(parseWhole('350')).toBe(350);
    expect(parseWhole('1500')).toBe(1500);
    expect(parseWhole('2,5')).toBe(2.5);
    expect(parseWhole('2.5')).toBe(2.5);
    expect(parseWhole('0.5')).toBe(0.5);
    expect(parseWhole('1.5000')).toBe(1.5); // cuatro cifras tras el punto: no es un separador de miles
    expect(parseWhole('')).toBeNull();
    expect(parseWhole('12 mil')).toBeNull();
    expect(parseWhole('abc')).toBeNull();
  });
});

describe('unidades escritas detrás del número (la gente escribe «118 kg», «2,5 km», «30 min»)', () => {
  it('se quitan solo si son de ese campo', () => {
    expect(parseDecimal('118 kg', UNITS.kg)).toBe(118);
    expect(parseDecimal('118,5kg', UNITS.kg)).toBe(118.5);
    expect(parseDecimal('118 Kilos', UNITS.kg)).toBe(118);
    expect(parseDecimal('2.5 km', UNITS.km)).toBe(2.5);
    expect(parseDecimal('2,5 KM.', UNITS.km)).toBe(2.5);
    expect(parseDecimal('75 cm', UNITS.cm)).toBe(75);
    expect(parseDecimal('50 m', UNITS.m)).toBe(50);
    expect(parseDecimal('200 g', UNITS.g)).toBe(200);
    expect(parseWhole('30 min', UNITS.min)).toBe(30);
    expect(parseWhole('45 minutos', UNITS.min)).toBe(45);
    expect(parseWhole('1.500 kcal', UNITS.kcal)).toBe(1500);
    expect(parseWhole('350 calorías', UNITS.kcal)).toBe(350);
  });
  it('una unidad de otro campo, o sin pedirla, sigue sin entenderse (no se adivina)', () => {
    expect(parseDecimal('118 km', UNITS.kg)).toBeNull();
    expect(parseDecimal('118 kg')).toBeNull();
    expect(parseDecimal('kg', UNITS.kg)).toBeNull();
    expect(parseDecimal('118 kg kg', UNITS.kg)).toBeNull();
    expect(parseWhole('2 h', UNITS.min)).toBeNull();
    expect(parseWhole('90 minutos y pico', UNITS.min)).toBeNull();
  });
});

describe('parseHeightCm: centímetros o metros', () => {
  it('los centímetros, con o sin unidad', () => {
    expect(parseHeightCm('162')).toBe(162);
    expect(parseHeightCm('162 cm')).toBe(162);
    expect(parseHeightCm('162,5')).toBe(162.5);
    expect(parseHeightCm('  182cm ')).toBe(182);
  });
  it('un número por debajo de 3 son metros: «1,82» y «1.82 m» son 182 cm', () => {
    expect(parseHeightCm('1,82')).toBe(182);
    expect(parseHeightCm('1.62')).toBe(162);
    expect(parseHeightCm('1,82 m')).toBe(182);
    expect(parseHeightCm('1.82 metros')).toBe(182);
    expect(parseHeightCm('2 m')).toBe(200);
    expect(parseHeightCm('2,05')).toBe(205);
  });
  it('con «m» detrás siempre son metros (y el rango ya avisará de lo absurdo); lo que no es un número, nada', () => {
    expect(parseHeightCm('162 m')).toBe(16_200);
    expect(parseHeightCm('')).toBeNull();
    expect(parseHeightCm('alto')).toBeNull();
    expect(parseHeightCm('0')).toBe(0);
  });
});

describe('parseVolumeMl', () => {
  it.each([
    ['300', 300],
    ['300 ml', 300],
    ['300ML', 300],
    ['33 cl', 330],
    ['50cl', 500],
    ['0,5 l', 500],
    ['0.5 L', 500],
    ['1,5 litros', 1500],
    ['1 litro', 1000],
    ['1.500 ml', 1500],
  ])('«%s» son %i ml', (text, ml) => {
    expect(parseVolumeMl(text)).toBe(ml);
  });

  it.each(['', 'agua', '-5', '0', '0 ml', '300 kg', '2 vasos', '1,5,5 l', 'ml'])('«%s» no se entiende', (text) => {
    expect(parseVolumeMl(text)).toBeNull();
  });
});
