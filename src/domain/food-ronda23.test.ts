import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables } from './food-table';
import { analyzeMealText, type TextAnalysis } from './food-text';
import PHRASES_TEXT from './food-frases-ronda23.txt?raw';

// Ronda 23 («que reconozca cualquier cosa»): una batería de más de mil frases raras que la tabla debe entender entera, y los casos concretos que se arreglaron
// (calorías dichas, erratas con cabeza, horas, palabras de orden, nombres con & y apóstrofos, medidas nuevas).

const table = parseFoodTables(FOOD_SOURCES);
const run = (text: string): TextAnalysis => analyzeMealText(text, table);
const total = (analysis: TextAnalysis): number => analysis.items.reduce((sum, item) => sum + item.kcal, 0);
const names = (analysis: TextAnalysis): string[] => analysis.items.map((item) => item.name);

const PHRASES: readonly string[] = PHRASES_TEXT.split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

describe('la batería de frases de la ronda 23', () => {
  it('hay más de mil, sin repetidas', () => {
    expect(PHRASES.length).toBeGreaterThan(1000);
    expect(new Set(PHRASES).size).toBe(PHRASES.length);
  });

  it('todas se entienden enteras, con calorías de comida de verdad', () => {
    const problems: string[] = [];
    for (const phrase of PHRASES) {
      const analysis = run(phrase);
      if (analysis.items.length === 0) problems.push(`«${phrase}»: ningún alimento reconocido`);
      else if (analysis.unknown.length > 0) problems.push(`«${phrase}»: sin entender ${analysis.unknown.map((word) => `«${word}»`).join(', ')}`);
      else if (total(analysis) >= 3_500) problems.push(`«${phrase}»: ${Math.round(total(analysis))} kcal`);
      for (const item of analysis.items) {
        if (item.parts !== undefined && Math.abs(item.parts.reduce((sum, part) => sum + part.kcal, 0) - item.kcal) > item.parts.length) problems.push(`«${phrase}»: las piezas de «${item.name}» no suman el plato`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('la tabla creció', () => {
  it('tiene más de mil alimentos y los que se comen por raciones lo dicen', () => {
    expect(table.length).toBeGreaterThan(1000);
    for (const name of ['Maki', 'Nigiri', 'Takoyaki']) expect(table.find((entry) => entry.name === name)?.bareServing, name).toBe(true);
    expect(table.find((entry) => entry.name === 'Huevo')?.bareServing).toBe(false);
  });

  it('platos de otras cocinas se entienden con su nombre', () => {
    for (const [phrase, expected] of [
      ['tonkatsu con arroz', ['Tonkatsu', 'Arroz cocido']],
      ['shawarma de pollo', ['Kebab de pollo']],
      ['un cuenco de ramen', ['Ramen']],
      ['bubble tea', ['Bubble tea']],
      ['tres makis', ['Maki ×3']],
      ['un bol de açaí', ['Bol de açaí']],
    ] as const) {
      expect(names(run(phrase)), phrase).toEqual(expected);
    }
  });
});

describe('calorías dichas', () => {
  it.each([
    ['croissant 300 kcal', 300],
    ['400 kcal de tteokbokki', 400],
    ['tarta de la abuela (350 kcal)', 350],
    ['paella 700 kcal', 700],
    ['arroz con pollo 600 calorías', 600],
  ])('«%s» suma justo %i kcal (el alimento que la tabla conoce se ajusta a ellas)', (phrase, kcal) => {
    const analysis = run(phrase);
    expect(analysis.unknown).toEqual([]);
    expect(analysis.items).toHaveLength(1);
    expect(total(analysis)).toBe(kcal);
    expect(analysis.items[0]?.kcalOnly).toBeUndefined();
  });

  it('lo que la tabla no conoce se anota solo con esas calorías, sin perderlo ni avisar de que no se entiende', () => {
    const analysis = run('frumbulón 350 kcal');
    expect(analysis.unknown).toEqual([]);
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]).toMatchObject({ name: 'Frumbulón', kcal: 350, kcalOnly: true });
    // Con un reparto medio de nutrientes, que cuadra con las calorías.
    const [item] = analysis.items;
    expect(4 * item!.proteinG + 4 * item!.carbsG + 9 * item!.fatG).toBeCloseTo(350, -1);
  });

  it('sin decir de qué, son calorías de «comida»', () => {
    const analysis = run('he comido 500 kcal');
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]).toMatchObject({ name: 'Comida', kcal: 500, kcalOnly: true });
  });

  it('«dos X de N kcal» son N cada uno', () => {
    expect(total(run('dos pastelitos de 250 kcal'))).toBe(500);
    expect(total(run('2 galletas de 150 kcal'))).toBe(300);
  });

  it('se mezcla con lo que sí se sabe, cada cosa por separado', () => {
    const pizza = run('una pizza 800 kcal y una coca-cola');
    expect(pizza.items).toHaveLength(2);
    expect(pizza.items[0]?.kcal).toBe(800);
    expect(pizza.items[1]?.name).toBe('Refresco de cola');
    expect(total(run('un croissant de 300 kcal y un café'))).toBeCloseTo(301, 0);
  });
});

describe('erratas: se corrigen las creíbles y no se inventa un alimento', () => {
  it.each([
    ['vurrito de pollo', 'Burrito de pollo'],
    ['hamburgesa con patatas', 'Hamburguesa con patatas'],
    ['tortila de patatas', 'Tortilla de patatas'],
    ['jamon serrno', 'Jamón serrano'],
    ['cerbeza', 'Cerveza'],
  ])('«%s» es %s', (phrase, name) => {
    const analysis = run(phrase);
    expect(names(analysis)).toEqual([name]);
    expect(analysis.unknown).toEqual([]);
  });

  it('una pizca no es una pizza, una tercera no es una ternera ni «dough» es «doogh» (el ayran)', () => {
    expect(names(run('una pizca de pimienta y un huevo'))).toEqual(['Huevo']);
    expect(names(run('mi tercera cerveza'))).toEqual(['Cerveza']);
    expect(names(run('cookie dough')).join()).not.toMatch(/Ayran/);
    expect(names(run('ben and jerry\'s de cookie dough')).join()).not.toMatch(/Ayran/);
  });
});

describe('lo que rodea a la comida no estorba', () => {
  it('horas, palabras de orden y «repetí» no son alimentos ni palabras sin entender', () => {
    for (const [phrase, items] of [
      ['a las 14:30 comí arroz con pollo', ['Arroz con pollo']],
      ['sobre las 9 un café con leche', ['Café con leche']],
      ['la segunda hamburguesa', ['Hamburguesa']],
      ['mi tercera tostada', ['Tostada']],
      ['la cuarta cerveza', ['Cerveza']],
      ['repetí paella', ['Paella']],
      ['de primero lentejas y de segundo merluza con patatas', ['Lentejas guisadas', 'Merluza', 'Patata cocida']],
    ] as const) {
      const analysis = run(phrase);
      expect(analysis.unknown, phrase).toEqual([]);
      expect(names(analysis), phrase).toEqual(items);
    }
  });

  it('pero una parte sigue siendo una parte: una tercera parte, un cuarto de kilo', () => {
    expect(run('una tercera parte de la pizza').items[0]?.amount).toBeCloseTo(105, 0);
    expect(run('un cuarto de kilo de pollo').items[0]?.amount).toBe(250);
    expect(names(run('cuarto de libra con queso'))).toEqual(['Cuarto de libra']);
  });
});

describe('medidas y piezas', () => {
  it('una cucharada sopera es una cucharada, y de las piezas pequeñas se cuentan muchas', () => {
    expect(run('una cucharada sopera de aceite').items[0]).toMatchObject({ name: 'Aceite', amount: 15 });
    expect(run('unas 12 aceitunas').items[0]?.name).toBe('Aceitunas ×12');
    expect(run('quince almendras').items[0]?.name).toBe('Almendras ×15');
  });

  it('una pizca de sal no suma nada', () => {
    expect(run('una pizca de sal').items).toEqual([]);
    expect(total(run('una pizca de azúcar'))).toBeLessThan(5);
  });
});

describe('nombres con & y apóstrofos', () => {
  it('«m&m\'s» es el caramelo de chocolate, no tres palabras sueltas', () => {
    for (const phrase of ['m&m\'s', 'm&ms', 'unos m&m\'s de cacahuete']) {
      const analysis = run(phrase);
      expect(analysis.unknown, phrase).toEqual([]);
      expect(names(analysis), phrase).toEqual(['Lacasitos']);
    }
  });

  it('«ben & jerry\'s» y «fish & chips» casan con su alimento; «arroz & pollo» es «arroz y pollo»', () => {
    expect(names(run('ben & jerry\'s'))).toEqual(['Helado envasado']);
    expect(names(run('fish & chips'))).toEqual(['Fish and chips']);
    expect(names(run('arroz & pollo'))).toEqual(['Arroz cocido', 'Pollo']);
    expect(names(run('McDonald\'s big mac'))).toEqual(['Big Mac']);
  });
});

describe('lo que se deja fuera a propósito', () => {
  it('un suplemento sin calorías o una marca sola no se inventan un alimento', () => {
    for (const phrase of ['5 g de creatina', 'BCAA', 'nestlé', 'hacendado proteico']) {
      expect(run(phrase).items, phrase).toEqual([]);
    }
  });
});
