import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables } from './food-table';
import { analyzeMealText, type TextAnalysis, type TextItem } from './food-text';

// Platos compuestos («un kebab de ternera con cebolla y salsa blanca»), menús, cadenas, relleno de bocadillos y sabores: lo que se dice sustituye,
// suma o quita piezas del plato, y las piezas siempre suman el total.

const table = parseFoodTables(FOOD_SOURCES);
const run = (text: string): TextAnalysis => analyzeMealText(text, table);
const first = (text: string): TextItem => {
  const item = run(text).items[0];
  if (item === undefined) throw new Error(`«${text}» no dio nada`);
  return item;
};
const partNames = (text: string): string[] => first(text).parts?.map((part) => part.name) ?? [];
const partAmount = (text: string, name: string): number | undefined => first(text).parts?.find((part) => part.name === name)?.amount;
const names = (text: string): string[] => run(text).items.map((item) => item.name);
const kcalOf = (text: string): number => run(text).items.reduce((sum, item) => sum + item.kcal, 0);

describe('el kebab del ejemplo', () => {
  it('«un kebab de ternera con cebolla y salsa blanca»: lo que se dice, y solo eso', () => {
    const analysis = run('un kebab de ternera con cebolla y salsa blanca');
    expect(analysis.unknown).toEqual([]);
    expect(analysis.items).toHaveLength(1);
    const kebab = analysis.items[0]!;
    expect(kebab.name).toBe('Kebab de ternera con cebolla y salsa blanca');
    expect(kebab.parts!.map((part) => part.name)).toEqual(['Pan de kebab', 'Carne de kebab', 'Cebolla', 'Salsa blanca']);
    expect(kebab.kcal).toBeGreaterThan(600);
    expect(kebab.kcal).toBeLessThan(700);
    expect(kebab.assumed).toBe(false);
  });

  it('las piezas suman el total del plato (cifras y gramos)', () => {
    for (const text of [
      'un kebab de ternera con cebolla y salsa blanca',
      'hamburguesa doble con queso y bacon',
      'pizza pepperoni con extra de queso',
      'burrito de pollo sin queso',
      'café con leche de avena',
      'menú Big Mac con fanta',
      'dos kebabs de pollo',
      'hamburguesa sin tomate ni lechuga',
      'una hamburguesa de 200 g',
    ]) {
      const item = first(text);
      const parts = item.parts!;
      const sum = (pick: (part: TextItem) => number): number => parts.reduce((total, part) => total + pick(part), 0);
      // Cada pieza se redondea por su lado: la suma puede diferir en una unidad por pieza.
      expect(Math.abs(sum((part) => part.kcal) - item.kcal), `${text}: kcal`).toBeLessThanOrEqual(parts.length);
      expect(Math.abs(sum((part) => part.carbsG) - item.carbsG), `${text}: hidratos`).toBeLessThanOrEqual(parts.length * 0.1 + 0.1);
      // (los gramos solo cuadran si no hay líquidos entre las piezas: esos van en ml.)
      if (parts.every((part) => part.unit === 'g')) expect(Math.abs(sum((part) => part.amount) - item.amount), `${text}: gramos`).toBeLessThanOrEqual(parts.length);
    }
  });
});

describe('qué sustituye, qué suma y qué quita', () => {
  it('sin decir nada, el plato lleva sus piezas de serie', () => {
    expect(partNames('un kebab')).toEqual(['Pan de kebab', 'Carne de kebab', 'Lechuga', 'Tomate', 'Cebolla', 'Salsa blanca']);
    expect(partNames('una hamburguesa')).toContain('Pan de hamburguesa');
    expect(partNames('una hamburguesa')).toContain('Torta de hamburguesa');
    expect(first('un kebab').name).toBe('Kebab');
  });

  it('lo que se nombra sustituye a la pieza de su mismo tipo: «con cebolla» quita la lechuga y el tomate de serie', () => {
    expect(partNames('un kebab con cebolla')).toEqual(['Pan de kebab', 'Carne de kebab', 'Salsa blanca', 'Cebolla']);
    expect(partNames('kebab de ternera con lechuga y tomate')).toEqual(['Pan de kebab', 'Salsa blanca', 'Carne de kebab', 'Lechuga', 'Tomate']);
  });

  it('«de pollo» cambia la carne; en una hamburguesa, la torta', () => {
    expect(partNames('kebab de pollo')).toContain('Carne de kebab de pollo');
    expect(partNames('kebab de pollo')).not.toContain('Carne de kebab');
    expect(partNames('hamburguesa de pollo')).toContain('Pollo');
    expect(partNames('hamburguesa de pollo')).not.toContain('Torta de hamburguesa');
    // «hamburguesa de ternera» es la torta de ternera, no un filete.
    expect(partNames('hamburguesa de ternera')).toContain('Torta de hamburguesa');
    expect(partNames('hamburguesa de ternera')).not.toContain('Ternera');
  });

  it('dos carnes se reparten lo que pesaba una', () => {
    const item = first('kebab de pollo y ternera');
    expect(item.parts!.filter((part) => part.name.startsWith('Carne de kebab')).map((part) => part.amount)).toEqual([60, 60]);
    expect(item.name).toBe('Kebab de pollo con ternera');
  });

  it('lo que el plato no llevaba de serie se suma: «hamburguesa con queso, bacon y huevo»', () => {
    const base = partNames('una hamburguesa');
    const parts = partNames('hamburguesa con queso, bacon y huevo');
    for (const piece of base) expect(parts).toContain(piece);
    expect(parts).toEqual(expect.arrayContaining(['Queso', 'Bacon', 'Huevo']));
    expect(first('hamburguesa con queso, bacon y huevo').name).toBe('Hamburguesa con queso, bacon y huevo');
    expect(kcalOf('hamburguesa con queso, bacon y huevo')).toBeGreaterThan(kcalOf('una hamburguesa') + 250);
  });

  it('«sin»: quita la pieza justa o todo su grupo', () => {
    expect(partNames('kebab sin cebolla')).not.toContain('Cebolla');
    expect(partNames('kebab sin cebolla')).toContain('Lechuga');
    expect(first('kebab sin cebolla').name).toBe('Kebab sin cebolla');
    // «sin salsa»: se va la salsa blanca.
    expect(partNames('kebab sin salsa')).not.toContain('Salsa blanca');
    expect(partNames('pizza sin queso')).not.toContain('Mozzarella');
    expect(kcalOf('pizza sin queso')).toBeLessThan(kcalOf('pizza'));
    // Quitar algo que el plato no lleva no quita lo demás.
    expect(partNames('kebab sin queso')).toEqual(partNames('kebab'));
  });

  it('«sin tomate ni lechuga» y «sin tomate y lechuga» quitan las dos cosas', () => {
    for (const text of ['hamburguesa sin tomate ni lechuga', 'hamburguesa sin tomate y lechuga', 'hamburguesa sin tomate, lechuga']) {
      const parts = partNames(text);
      expect(parts, text).not.toContain('Tomate');
      expect(parts, text).not.toContain('Lechuga');
      expect(parts, text).toContain('Pan de hamburguesa');
      expect(first(text).name, text).toBe('Hamburguesa sin tomate y lechuga');
    }
  });

  it('«sin tomate y con lechuga» quita una y pone la otra; y «sin cebolla y patatas» pone las patatas', () => {
    const parts = partNames('hamburguesa sin tomate y con lechuga');
    expect(parts).not.toContain('Tomate');
    expect(parts).toContain('Lechuga');
    const kebab = partNames('kebab sin cebolla y patatas fritas');
    expect(kebab).not.toContain('Cebolla');
    expect(kebab).toContain('Patatas fritas');
    expect(first('kebab sin cebolla y patatas fritas').name).toBe('Kebab con patatas fritas sin cebolla');
  });

  it('un «sin» no se come lo que viene con cantidad: «kebab sin cebolla y una coca cola»', () => {
    const analysis = run('kebab sin cebolla y una coca cola');
    expect(analysis.items.map((item) => item.name)).toEqual(['Kebab sin cebolla', 'Refresco de cola']);
    expect(analysis.items[1]!.amount).toBe(330);
  });

  it('«doble» pone más carne, no más pan; «extra de queso» más queso, no más plato', () => {
    expect(partAmount('hamburguesa doble con queso', 'Torta de hamburguesa')).toBe(220);
    expect(partAmount('hamburguesa doble con queso', 'Pan de hamburguesa')).toBe(partAmount('una hamburguesa', 'Pan de hamburguesa'));
    expect(first('hamburguesa doble con queso').name).toBe('Hamburguesa doble con queso');
    expect(partAmount('kebab doble de carne', 'Carne de kebab')).toBe(240);
    expect(first('kebab doble de carne').name).toBe('Kebab doble de carne');
    const plain = partAmount('hamburguesa con queso', 'Queso')!;
    expect(partAmount('hamburguesa con extra de queso', 'Queso')).toBeGreaterThan(plain);
    expect(partAmount('hamburguesa con extra de queso', 'Pan de hamburguesa')).toBe(partAmount('una hamburguesa', 'Pan de hamburguesa'));
    expect(first('hamburguesa con extra de queso').name).toBe('Hamburguesa con extra de queso');
  });

  it('«triple» y los plurales («dos hamburguesas dobles») valen igual', () => {
    expect(partAmount('hamburguesa triple', 'Torta de hamburguesa')).toBe(330);
    const two = first('dos hamburguesas dobles');
    expect(two.name).toBe('Hamburguesa doble ×2');
    expect(two.parts!.find((part) => part.name === 'Torta de hamburguesa')!.amount).toBe(440);
    expect(two.parts!.find((part) => part.name === 'Pan de hamburguesa')!.amount).toBe(130);
  });

  it('las bebidas compuestas cambian de base: leche de avena, de soja, desnatada', () => {
    expect(partNames('café con leche de avena')).toEqual(['Café solo', 'Bebida de avena']);
    expect(first('café con leche de avena').name).toBe('Café con leche de avena');
    expect(partNames('cortado de soja')).toContain('Bebida de soja');
    expect(partNames('cortado de soja')).not.toContain('Salsa de soja');
    expect(first('café con leche desnatada').name).toBe('Café con leche desnatada');
    expect(partNames('cola cao con leche de soja')).toEqual(['Cola Cao en polvo', 'Bebida de soja']);
    expect(first('cola cao con leche de soja').name).toBe('Cola Cao de soja');
  });
});

describe('cantidades de un plato', () => {
  it('«dos kebabs de pollo»: el doble de todo', () => {
    const one = first('un kebab de pollo');
    const two = first('dos kebabs de pollo');
    expect(two.name).toBe('Kebab de pollo ×2');
    expect(two.kcal).toBeGreaterThanOrEqual(one.kcal * 2 - 2);
    expect(two.kcal).toBeLessThanOrEqual(one.kcal * 2 + 2);
    expect(two.assumed).toBe(false);
  });

  it('«media pizza», «tres cuartos de pizza», «dos porciones»: una parte de la pizza entera', () => {
    const whole = kcalOf('una pizza');
    expect(kcalOf('media pizza')).toBeCloseTo(whole / 2, -1);
    expect(kcalOf('tres cuartos de pizza')).toBeCloseTo((whole * 3) / 4, -1);
    // Una porción de pizza son 120 g (la medida de la tabla), con las proporciones de la pizza.
    expect(first('dos porciones de pizza margarita').amount).toBe(240);
    expect(kcalOf('dos porciones de pizza margarita')).toBeCloseTo((whole * 240) / first('una pizza').amount, -1);
  });

  it('«grande», «familiar»: el plato entero más grande; dicho al final de la marca también', () => {
    const normal = first('pizza');
    const big = first('pizza grande');
    expect(big.amount / normal.amount).toBeCloseTo(1.3, 1);
    expect(first('pizza de telepizza familiar').amount / normal.amount).toBeCloseTo(1.5, 1);
    expect(run('pizza de telepizza familiar').unknown).toEqual([]);
  });

  it('«una hamburguesa de 200 g»: los 200 g son los de la carne', () => {
    expect(partAmount('una hamburguesa de 200 g', 'Torta de hamburguesa')).toBe(200);
    expect(partAmount('una hamburguesa de 200 g', 'Pan de hamburguesa')).toBe(partAmount('una hamburguesa', 'Pan de hamburguesa'));
    expect(partAmount('dos hamburguesas de 150 g', 'Torta de hamburguesa')).toBe(300);
  });

  it('la cantidad dicha después: «hamburguesa x2», «hamburguesa con queso, 2», «una pizza, media»', () => {
    expect(first('hamburguesa x2').name).toBe('Hamburguesa ×2');
    expect(first('hamburguesa con queso x2').name).toBe('Hamburguesa con queso ×2');
    expect(first('hamburguesa con queso, 2').name).toBe('Hamburguesa con queso ×2');
    expect(kcalOf('hamburguesa x2')).toBeGreaterThan(2 * kcalOf('una hamburguesa') - 3);
  });

  it('«tacos» sin número son dos; «un taco», uno', () => {
    expect(first('tacos de pollo').amount).toBe(2 * first('un taco de pollo').amount);
    expect(first('tres tacos de pollo con guacamole').name).toBe('Taco de pollo con guacamole ×3');
  });
});

describe('«otro» y «otra»', () => {
  it('«un kebab de pollo y otro de ternera» son dos kebabs distintos', () => {
    expect(names('un kebab de pollo y otro de ternera')).toEqual(['Kebab de pollo', 'Kebab de ternera']);
    expect(kcalOf('un kebab de pollo y otro de ternera')).toBeGreaterThan(kcalOf('un kebab de pollo') * 2 - 100);
  });

  it('«una caña y otra», «dos cañas y otra»: otra unidad de lo mismo, con la misma medida', () => {
    const one = run('una caña y otra');
    expect(one.items.map((item) => `${item.name} ${item.amount}${item.unit}`)).toEqual(['Cerveza 200ml', 'Cerveza 200ml']);
    const two = run('dos cañas y otra');
    expect(two.items.map((item) => item.amount)).toEqual([400, 200]);
    expect(names('una hamburguesa doble y otra normal')).toEqual(['Hamburguesa doble', 'Hamburguesa']);
  });

  it('el «sin» del primero no pasa al segundo: «un kebab sin cebolla y otro de ternera con todo menos tomate»', () => {
    const analysis = run('un kebab de pollo sin cebolla y otro de ternera con todo menos tomate');
    expect(analysis.items.map((item) => item.name)).toEqual(['Kebab de pollo sin cebolla', 'Kebab de ternera sin tomate']);
    expect(analysis.items[1]!.parts!.map((part) => part.name)).toContain('Carne de kebab');
    expect(analysis.items[1]!.parts!.map((part) => part.name)).toContain('Cebolla');
  });

  it('«y otra» delante de un alimento no repite nada', () => {
    expect(names('un café y otra tostada')).toEqual(['Café solo', 'Tostada']);
    expect(names('otra tostada')).toEqual(['Tostada']);
  });
});

describe('menús y cadenas', () => {
  it('«menú Big Mac»: hamburguesa, patatas y refresco, como en la cadena', () => {
    const menu = first('menú Big Mac');
    expect(menu.parts!.map((part) => part.name)).toEqual(['Big Mac', 'Patatas de cadena', 'Refresco de cola']);
    expect(menu.kcal).toBeGreaterThan(900);
    expect(menu.kcal).toBeLessThan(1100);
    expect(menu.name).toBe('Menú Big Mac');
  });

  it('el menú cambia de bebida, quita la bebida o crece solo en patatas y bebida', () => {
    expect(partNames('menú Big Mac con fanta')).toContain('Refresco de naranja o limón');
    expect(partNames('menú Big Mac con fanta')).not.toContain('Refresco de cola');
    expect(partNames('menú Big Mac sin bebida')).toEqual(['Big Mac', 'Patatas de cadena']);
    expect(partAmount('menú Big Mac grande', 'Big Mac')).toBe(215);
    expect(partAmount('menú Big Mac grande', 'Patatas de cadena')!).toBeGreaterThan(partAmount('menú Big Mac', 'Patatas de cadena')!);
    expect(partAmount('menú Big Mac grande', 'Refresco de cola')!).toBeGreaterThan(partAmount('menú Big Mac', 'Refresco de cola')!);
    expect(first('menú Big Mac con fanta').name).toBe('Menú Big Mac con fanta');
  });

  it('«con patatas grandes y coca cola pequeña» tamaña cada cosa por separado', () => {
    expect(partAmount('menú Big Mac con patatas grandes y coca cola pequeña', 'Patatas de cadena')).toBe(partAmount('menú Big Mac grande', 'Patatas de cadena'));
    expect(partAmount('menú Big Mac con patatas grandes y coca cola pequeña', 'Refresco de cola')!).toBeLessThan(partAmount('menú Big Mac', 'Refresco de cola')!);
  });

  it('productos de cadena sueltos: Whopper, McNuggets «de 9», Sub de 30 cm, Frappuccino', () => {
    expect(names('un Whopper')).toEqual(['Whopper']);
    expect(names('9 nuggets de McDonald\'s')).toEqual(['McNuggets ×9']);
    expect(names('nuggets de 9')).toEqual(['Nuggets de pollo ×9']);
    expect(first('un whopper doble').name).toBe('Doble Whopper');
    expect(first('un whopper pequeño').name).toBe('Whopper Jr');
    expect(first('un whopper pequeño').amount).toBe(150);
    expect(names('frappuccino venti')).toEqual(['Frappuccino']);
  });

  it('los subs se piden por longitud, en cualquier orden', () => {
    const small = first('sub de pavo');
    const long = first('sub de pavo de 30 cm');
    expect(long.amount).toBe(small.amount * 2);
    for (const text of ['sub de 30 cm de pavo', '30 cm de sub de pavo', 'footlong de pavo', 'sub de pavo footlong', 'un sub de pavo de 30 centímetros']) {
      expect(first(text).kcal, text).toBe(long.kcal);
    }
    expect(first('sub de pavo de 15 cm').kcal).toBe(small.kcal);
    expect(first('subway de pollo teriyaki 30 cm').amount).toBe(first('subway de pollo teriyaki').amount * 2);
    expect(run('subway de pollo teriyaki 30 cm').unknown).toEqual([]);
  });

  it('el nombre de una cadena no suma nada ni se queda sin entender', () => {
    for (const text of ['un big mac de mcdonalds', 'una pizza de telepizza', 'un café de starbucks', 'una hamburguesa del burger king', 'un whopper de burger king']) {
      expect(run(text).unknown, text).toEqual([]);
      expect(run(text).items, text).toHaveLength(1);
    }
    expect(run('comida de mcdonalds').items).toHaveLength(0);
  });

  it('«aceite de oliva virgen extra», «cerveza extra» no son un tamaño', () => {
    expect(first('una cucharada de aceite de oliva virgen extra').amount).toBe(15);
    expect(first('una cerveza extra').amount).toBe(330);
    expect(first('un café doble').amount).toBe(120);
  });
});

describe('relleno de bocadillos y platos', () => {
  it('lo que se nombra sin cantidad detrás de un bocadillo es relleno: poco, no una ración', () => {
    const analysis = run('un bocadillo de jamón y queso con tomate');
    expect(analysis.items.map((item) => item.name)).toEqual(['Bocadillo de jamón y queso', 'Tomate']);
    expect(analysis.items[1]!.amount).toBeLessThanOrEqual(50);
    expect(run('tostada con aguacate, huevo y tomate').items.map((item) => item.name)).toEqual(['Tostada', 'Aguacate', 'Huevo', 'Tomate']);
    expect(run('tostada con aguacate, huevo y tomate').items[1]!.amount).toBeLessThan(80);
  });

  it('con cantidad, es otra cosa y se cuenta entera', () => {
    const analysis = run('un bocadillo de jamón con 100 g de queso');
    expect(analysis.items.map((item) => `${item.name} ${item.amount}`)).toEqual(['Bocadillo de jamón 180', 'Queso 100']);
  });

  it('otro plato dicho después no es relleno: «lentejas, merluza y flan»', () => {
    const analysis = run('lentejas, merluza y flan');
    expect(analysis.items.map((item) => item.name)).toEqual(['Lentejas guisadas', 'Merluza', 'Flan']);
    expect(analysis.items.every((item) => item.amount >= 100)).toBe(true);
  });

  it('el relleno de un plato: tomate y lechuga con un filete; salsa con patatas', () => {
    const analysis = run('filete de pollo con tomate y lechuga');
    expect(analysis.items.map((item) => item.name)).toEqual(['Pollo', 'Tomate', 'Lechuga']);
    expect(analysis.items[0]!.amount).toBe(150);
    expect(analysis.items[1]!.amount).toBeLessThan(80);
    expect(run('patatas fritas con kétchup').items[1]!.amount).toBeLessThan(30);
  });

  it('en una comida rápida, «con patatas» son patatas fritas', () => {
    const analysis = run('hamburguesa con patatas fritas y coca cola');
    expect(analysis.items.map((item) => item.name)).toEqual(['Hamburguesa con patatas fritas', 'Refresco de cola']);
    expect(partNames('kebab con patatas')).toContain('Patatas fritas');
    expect(partNames('kebab con patatas')).not.toContain('Patata cocida');
  });
});

describe('sabores', () => {
  it('el sabor no suma nada: solo cambia el nombre', () => {
    const yogurt = run('yogur de fresa y vainilla');
    expect(yogurt.items.map((item) => item.name)).toEqual(['Yogur de fresa y vainilla']);
    expect(yogurt.unknown).toEqual([]);
    expect(names('helado de chocolate y vainilla')).toEqual(['Helado de chocolate y vainilla']);
    expect(names('batido de fresa')).toHaveLength(1);
  });

  it('un yogur de sabores no es el natural', () => {
    expect(first('yogur de fresa').kcal).toBeGreaterThan(first('yogur natural').kcal);
  });
});

describe('«todo menos», «con ensalada» y otros giros', () => {
  it('«con todo menos cebolla» y «con todo excepto salsa» quitan lo que sigue; «más o menos» no quita nada', () => {
    expect(partNames('durum de ternera con todo menos cebolla')).not.toContain('Cebolla');
    expect(partNames('durum de ternera con todo menos cebolla')).toContain('Lechuga');
    expect(first('durum de ternera con todo menos cebolla').name).toBe('Kebab de ternera sin cebolla');
    expect(partNames('kebab con todo excepto salsa')).not.toContain('Salsa blanca');
    expect(names('más o menos 200 g de arroz')).toEqual(['Arroz cocido']);
    expect(run('más o menos medio plato de lentejas').items).toHaveLength(1);
  });

  it('«con ensalada» en un kebab o una hamburguesa es su verdura de siempre, no una ensalada más', () => {
    expect(partNames('shawarma de pollo con ensalada y salsa de ajo')).not.toContain('Ensalada');
    expect(first('hamburguesa con ensalada').kcal).toBe(first('una hamburguesa').kcal);
    // En un plato que no lleva verdura suelta, la ensalada es una pieza más.
    expect(partNames('plato de kebab con ensalada')).toContain('Ensalada');
  });

  it('«sin patatas» quita las patatas, no el resto del acompañamiento', () => {
    expect(partNames('plato de kebab')).toEqual(expect.arrayContaining(['Patatas fritas', 'Ensalada']));
    expect(partNames('plato de kebab sin patatas')).toContain('Ensalada');
    expect(partNames('plato de kebab sin patatas')).not.toContain('Patatas fritas');
    expect(partNames('menú Big Mac sin patatas')).toEqual(['Big Mac', 'Refresco de cola']);
  });

  it('una medida seguida de lo que pesa o mide: «dos filetes de 200 g», «una lata de 330 ml»', () => {
    expect(run('dos filetes de 200 g').items.map((item) => `${item.name} ${item.amount}${item.unit}`)).toEqual(['Ternera ×2 400g']);
    expect(run('un filete de 300 g').items[0]).toMatchObject({ name: 'Ternera', amount: 300, assumed: false });
    expect(run('una lata de 330 ml').items[0]).toMatchObject({ name: 'Refresco de cola', amount: 330, unit: 'ml' });
    expect(run('dos vasos de 200 ml de leche').items[0]).toMatchObject({ amount: 400, unit: 'ml' });
    expect(run('un vaso de 200 ml de leche').items[0]).toMatchObject({ amount: 200, unit: 'ml' });
  });

  it('una tableta de chocolate son 100 g; una onza, un trozo', () => {
    expect(run('una tableta de chocolate').items[0]).toMatchObject({ name: 'Chocolate con leche', amount: 100 });
    expect(run('media tableta de chocolate negro').items[0]).toMatchObject({ name: 'Chocolate negro', amount: 50 });
    expect(run('una tableta de lindt').items[0]!.amount).toBe(100);
    expect(run('una onza de milka').items[0]!.amount).toBeLessThan(10);
  });

  it('un churro con chocolate es poco; unos churros con chocolate, una ración', () => {
    expect(first('unos churros con chocolate').name).toBe('Churros con chocolate');
    expect(first('unos churros con chocolate').parts!.map((part) => part.name)).toEqual(['Churros', 'Chocolate a la taza']);
    expect(first('dos churros con chocolate').kcal).toBeLessThan(first('unos churros con chocolate').kcal / 2);
  });

  it('las patatas que acompañan a un plato frito son fritas', () => {
    for (const text of ['huevos fritos con patatas', 'croquetas con patatas', 'filete empanado con patatas']) {
      expect(names(text)[1], text).toBe('Patatas fritas');
    }
    expect(names('pollo asado con patatas')[1]).toBe('Patata cocida');
  });
});

describe('cantidades dichas detrás', () => {
  it('«croquetas 6», «croquetas x6», «croquetas ×6», «croquetas, 6»: unidades', () => {
    for (const text of ['croquetas 6', 'croquetas x6', 'croquetas ×6', 'croquetas, 6', '6 croquetas']) expect(names(text), text).toEqual(['Croquetas ×6']);
    expect(names('huevos x 3')).toEqual(['Huevo ×3']);
    expect(names('plátano 2')).toEqual(['Plátano ×2']);
  });

  it('una cifra grande son gramos: «arroz 200», «pollo 150»', () => {
    expect(run('arroz 200').items.map((item) => `${item.name} ${item.amount}${item.unit}`)).toEqual(['Arroz cocido 200g']);
    expect(run('pollo 150').items[0]!.amount).toBe(150);
    expect(run('arroz 200').assumptions).toBe('');
  });

  it('una cifra suelta con otra cosa detrás sigue siendo de lo de después: «2 huevos»', () => {
    expect(names('arroz y 2 huevos')).toEqual(['Arroz cocido', 'Huevo ×2']);
  });
});
