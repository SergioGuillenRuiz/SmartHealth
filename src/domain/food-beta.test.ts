import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables } from './food-table';
import { analyzeMealText } from './food-text';

// Lo que destapó una prueba con personas de verdad (alguien con obesidad que anota atracones y comida rápida, alguien muy en forma que anota
// suplementos y platos de gimnasio): las frases que salían mal, fijadas con lo que debe salir.

const table = parseFoodTables(FOOD_SOURCES);
const run = (text: string) => analyzeMealText(text, table);
const names = (text: string): string[] => run(text).items.map((item) => item.name);
const grams = (text: string): number[] => run(text).items.map((item) => item.amount);
const kcal = (text: string): number => run(text).items.reduce((sum, item) => sum + item.kcal, 0);

describe('un paquete o una bolsa entera de galletas y chuches', () => {
  it('es el paquete (no una ración de 30 g): se anotaba una décima parte de un atracón', () => {
    expect(grams('un paquete de galletas')).toEqual([200]);
    expect(grams('una bolsa de galletas')).toEqual([200]);
    expect(grams('un paquete de galletas oreo')).toEqual([150]);
    expect(grams('un paquete de galletas digestive')).toEqual([200]);
    expect(grams('una bolsa de gominolas')).toEqual([100]);
    expect(grams('un paquete de galletas príncipe')).toEqual([150]);
    expect(kcal('un paquete de galletas')).toBeGreaterThan(800);
  });
  it('las galletas sueltas siguen como estaban', () => {
    expect(grams('5 galletas')).toEqual([30]);
    expect(grams('dos galletas maría')).toEqual([12]);
  });
});

describe('«de kfc» detrás de lo mismo no es otro plato', () => {
  it('un cubo de pollo frito de kfc cuenta una vez', () => {
    expect(names('un cubo de pollo frito de kfc')).toEqual(['Pollo frito de cadena']);
    expect(grams('un cubo de pollo frito de kfc')).toEqual(grams('un cubo de pollo frito'));
    for (const text of ['pollo frito de kfc', 'pollo de kfc', 'un pollo frito de kfc']) expect(names(text), text).toEqual(['Pollo frito de cadena']);
  });
  it('pero dos cosas iguales dichas con cantidad o separadas por «y» siguen siendo dos', () => {
    expect(run('dos tostadas y una tostada').items.length).toBeGreaterThan(0);
    expect(names('una cerveza y una cerveza')).toHaveLength(2);
    expect(names('pollo frito de kfc y pollo frito de kfc')).toHaveLength(2);
  });
});

describe('«patatas» con comida rápida delante son fritas, también con cantidad', () => {
  it.each([
    'una hamburguesa con una ración de patatas',
    'una hamburguesa y una ración de patatas',
    'una hamburguesa con 200 g de patatas',
    'dos hamburguesas y una ración grande de patatas',
    'hamburguesas y una ración grande de patatas con salsa',
    'un big mac con una ración de patatas',
  ])('%s', (text) => {
    const potatoes = names(text).filter((name) => /patata/i.test(name));
    expect(potatoes).toEqual(['Patatas fritas']);
  });
  it('sin comida rápida delante, o con un punto por medio, son las de siempre (cocidas)', () => {
    expect(names('un filete con una ración de patatas')).toContain('Patata cocida');
    expect(names('una ración de patatas')).toEqual(['Patata cocida']);
    expect(names('una hamburguesa. Después una patata')).toContain('Patata cocida');
    expect(names('una hamburguesa y luego 200 g de patatas')).toContain('Patata cocida');
  });
  it('una hamburguesa con una ración de patatas suma lo mismo que «con patatas»', () => {
    expect(Math.abs(kcal('una hamburguesa con una ración de patatas') - kcal('una hamburguesa con patatas'))).toBeLessThan(30);
  });
});

describe('«entero»: lo que se compra entero pesa lo que pesa entero', () => {
  it('un pollo asado entero son ~700 g de carne, no una ración de 200', () => {
    for (const text of ['pollo asado entero', 'un pollo asado entero', 'un pollo entero', 'me comí un pollo entero']) expect(grams(text), text).toEqual([700]);
    expect(grams('dos pollos asados enteros')).toEqual([1400]);
    expect(kcal('un pollo asado entero')).toBeGreaterThan(1400);
  });
  it('la mitad y un cuarto salen de ahí', () => {
    expect(grams('medio pollo asado')).toEqual([350]);
    expect(grams('medio pollo')).toEqual([350]);
    expect(grams('un cuarto de pollo asado')).toEqual([175]);
  });
  it('también una tarta, un melón o una tortilla', () => {
    expect(grams('una tarta entera')).toEqual([800]);
    expect(grams('la tarta entera')).toEqual([800]);
    expect(grams('un melón entero')).toEqual([1500]);
    expect(grams('una tortilla de patatas entera')).toEqual([700]);
  });
  it('lo que no se compra entero, o donde «entera» es otra cosa, no cambia', () => {
    expect(grams('pollo asado')).toEqual([200]);
    expect(grams('un pollo asado')).toEqual([200]);
    expect(names('leche entera')).toEqual(['Leche entera']);
    expect(grams('leche entera')).toEqual([200]);
    expect(grams('huevos enteros')).toEqual([110]);
  });
});

describe('suplementos y platos de gimnasio', () => {
  it('un gel energético es un gel (40 g, ~100 kcal), no una lata de bebida energética', () => {
    expect(names('un gel energético')).toEqual(['Gel energético']);
    expect(kcal('un gel energético')).toBe(100);
    expect(names('dos geles energéticos y un plátano')[0]).toBe('Gel energético ×2');
    expect(names('una lata de red bull')).toEqual(['Bebida energética']);
  });
  it('un huevo poché es un huevo escalfado (72 kcal), no unos huevos benedictinos', () => {
    expect(names('un huevo poché')).toEqual(['Huevo escalfado']);
    expect(kcal('un huevo poché')).toBe(72);
    expect(names('dos huevos escalfados')).toEqual(['Huevo escalfado ×2']);
    expect(names('huevos benedictinos')).toEqual(['Huevos benedictinos']);
  });
  it('un bol de açaí es un plato con su base y sus toppings (~400 kcal), no 200 g de frambuesas', () => {
    for (const text of ['un bol de açaí', 'un bol de acai', 'un acai bowl', 'un bowl de açaí']) {
      expect(names(text)[0], text).toBe('Bol de açaí');
      expect(kcal(text), text).toBeGreaterThan(350);
      expect(kcal(text), text).toBeLessThan(500);
    }
    expect(names('frambuesas')).toEqual(['Frambuesas']);
  });
});

describe('«sobre» es una preposición salvo que sea la medida (un sobre de azúcar)', () => {
  it('huevos sobre tostada: la tostada entera, no un sobre de 8 g', () => {
    expect(grams('dos huevos escalfados sobre tostada')).toEqual([100, 45]);
    expect(names('salmón sobre pan')).toHaveLength(2);
    expect(grams('salmón sobre pan')[1]).toBeGreaterThan(30);
  });
  it('un sobre de azúcar sigue siendo 8 g', () => {
    expect(grams('un sobre de azúcar')).toEqual([8]);
    expect(grams('dos sobres de azúcar')).toEqual([16]);
    expect(grams('café con un sobre de azúcar')[1]).toBe(8);
  });
});
