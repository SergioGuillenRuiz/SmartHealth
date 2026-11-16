import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { FOOD_ROLES, MEASURES, parseFoodTable, parseFoodTables, type FoodEntry } from './food-table';
import { aliasProblems } from './food-text';

const table = parseFoodTables(FOOD_SOURCES);

describe('parseFoodTable', () => {
  it('lee una línea con todos sus extras', () => {
    const [entry] = parseFoodTable('# comentario\n\nCerveza | birra, cañas | 43 0.4 3.6 0 0 0 0 | liquido densidad=1.01 alcohol=3.9 cana=200 racion=330 ud=330\n');
    expect(entry).toMatchObject({ name: 'Cerveza', kcal: 43, proteinG: 0.4, carbsG: 3.6, fatG: 0, liquid: true, density: 1.01, alcoholG: 3.9, serving: 330, each: 330, measures: { cana: 200 }, ignore: false });
    expect(entry?.aliases).toEqual(['Cerveza', 'birra', 'cañas']);
  });

  it('lee la fibra, los azúcares y la sal (por 100 g, después de los cuatro primeros números)', () => {
    const [entry] = parseFoodTable('Pan integral | pan integral | 247 9.4 41 3.4 6.8 3.1 1.3 | racion=60');
    expect(entry).toMatchObject({ fiberG: 6.8, sugarsG: 3.1, saltG: 1.3 });
  });

  it('exige los siete números y que los azúcares no pasen de los hidratos', () => {
    expect(() => parseFoodTable('Pan | pan | 265 9 49 3.2 | racion=60')).toThrow(/7 números/);
    expect(() => parseFoodTable('Pan | pan | 265 9 49 3.2 2.7 3 | racion=60')).toThrow(/7 números/);
    expect(() => parseFoodTable('Pan | pan | 265 9 49 3.2 2.7 3 1.2 9 | racion=60')).toThrow(/7 números/);
    expect(() => parseFoodTable('Dulce | dulce | 400 2 60 10 1 70 0.1 | racion=30')).toThrow(/azúcares.*no pueden ser más que los hidratos/);
    expect(() => parseFoodTable('Roto | roto | 100 2 20 1 90 1 0.1 | racion=30')).toThrow(/imposibles/);
    expect(() => parseFoodTable('Roto | roto | 100 2 20 1 1 1 120 | racion=30')).toThrow(/imposibles/);
  });

  it('un alimento que se ignora no necesita ración', () => {
    expect(parseFoodTable('Sal | sal, pimienta | 0 0 0 0 0 0 0 | ignorar')[0]).toMatchObject({ ignore: true, serving: 0 });
  });

  it('dice la línea de lo que está mal escrito', () => {
    const line = (text: string): string => `Pan | pan | 265 9 49 3.2 2.7 3 1.2 | racion=60\n${text}`;
    expect(() => parseFoodTable(line('Roto | a | 1 2 3 4'))).toThrow(/línea 2.*4 columnas.*hay 3/);
    expect(() => parseFoodTable(line('Roto | a | 1 2 3 | racion=1'))).toThrow(/línea 2.*cifras/);
    expect(() => parseFoodTable(line('Roto | a | 1 2 3 | racion=1 | x'))).toThrow(/línea 2.*5/);
    expect(() => parseFoodTable(line('Roto | a | 1 2 tres 4 | racion=1'))).toThrow(/línea 2.*cifras/);
    expect(() => parseFoodTable(line('Roto | a | 1000 2 3 4 0 0 0 | racion=1'))).toThrow(/imposibles/);
    expect(() => parseFoodTable(line('Roto | a | 1 2 3 4 0 0 0 |'))).toThrow(/falta racion/);
    expect(() => parseFoodTable(line('Roto | a | 1 2 3 4 0 0 0 | racion=0'))).toThrow(/mayor que 0/);
    expect(() => parseFoodTable(line('Roto | a | 1 2 3 4 0 0 0 | racion=1 vasoo=3'))).toThrow(/desconocid/);
    expect(() => parseFoodTable(line('Roto | a | 1 2 3 4 0 0 0 | racion=1 liquid'))).toThrow(/desconocido/);
    expect(() => parseFoodTable(line('Pan | otro | 1 2 3 4 0 0 0 | racion=1'))).toThrow(/repetido/);
    expect(() => parseFoodTable(line(' | a | 1 2 3 4 0 0 0 | racion=1'))).toThrow(/nombre/);
    expect(() => parseFoodTable('# solo comentarios\n')).toThrow(/vacío/);
  });
});

describe('platos compuestos', () => {
  const base = 'Pan | pan | 265 9 49 3.2 2.7 3 1.2 | racion=60\nQueso | queso | 400 25 1.3 33 0 0.5 1.8 | racion=30\nTomate | tomate | 18 0.9 3.9 0.2 1.2 2.6 0.01 | racion=100\n';
  const parse = (lines: string): FoodEntry[] => parseFoodTables({ 'alimentos.txt': base + lines });
  const dish = (lines: string): FoodEntry => parse(lines).find((entry) => entry.recipe !== null)!;

  it('sus cifras salen de las piezas, por 100 g del plato', () => {
    const entry = dish('Tostada mixta | tostada mixta | = Pan 60 + Queso 30 | ud=90');
    expect(entry).toMatchObject({ kcal: 310, proteinG: 14.3, carbsG: 33.1, fatG: 13.1, fiberG: 1.8, sugarsG: 2.2, saltG: 1.4, serving: 90, each: 90 });
    expect(entry.recipe!.map((part) => [part.entry.name, part.amount, part.slot])).toEqual([['Pan', 60, null], ['Queso', 30, null]]);
  });

  it('sin ración ni unidad, valen lo que pesan sus piezas; con ellas, las suyas', () => {
    expect(dish('Tostada | tostada | = Pan 60 + Tomate 40 |')).toMatchObject({ serving: 100, each: 100 });
    expect(dish('Tostada | tostada | = Pan 60 + Tomate 40 | racion=200 ud=100')).toMatchObject({ serving: 200, each: 100 });
  });

  it('un «rol:» delante hace sustituible la pieza', () => {
    const entry = dish('Tostada | tostada | = Pan 60 + queso:Queso 30 + verdura:Tomate 40 |');
    expect(entry.recipe!.map((part) => part.slot)).toEqual([null, 'queso', 'verdura']);
  });

  it('una pieza de un líquido pesa lo que ocupa por su densidad', () => {
    const entries = parseFoodTables({ 'alimentos.txt': 'Leche | leche | 46 3.1 4.8 1.6 0 0 0 | liquido densidad=1.03 racion=200\nCafé | café | 1 0.1 0 0 0 0 0 | liquido racion=60\nCafé con leche | cafe con leche | = Café 60 + Leche 140 | liquido' });
    const entry = entries.find((candidate) => candidate.recipe !== null)!;
    // 60 ml de café (1 g/ml) + 140 ml de leche (144,2 g) = 204,2 g
    expect(entry.kcal).toBeCloseTo((1 * 0.6 + 46 * 1.442) / 2.042, 0);
  });

  it('«como=» dice qué se pone cuando se nombra otra cosa', () => {
    const entry = dish('Tostada | tostada | = Pan 60 + queso:Queso 30 | como=Tomate:Queso');
    const [tomato, cheese] = [parse('').find((candidate) => candidate.name === 'Tomate')!, parse('').find((candidate) => candidate.name === 'Queso')!];
    expect([...entry.like!].map(([from, to]) => [from.name, to.name])).toEqual([[tomato.name, cheese.name]]);
  });

  it('los extras de los platos y de la tabla', () => {
    const [entry] = parseFoodTable('Menú | menú | 200 10 20 8 0 0 0 | menu rapida sabores=Otro_sabor sabor cm=15 peso=proteina contenedor rell=25 racion=100');
    expect(entry).toMatchObject({ menu: true, fast: true, flavored: true, flavorTo: 'Otro sabor', flavor: true, lengthCm: 15, weightOf: 'proteina', container: true, filling: 25 });
    expect(parseFoodTable('Yogur | yogur | 60 4 5 3 0 0 0 | sabores racion=125')[0]).toMatchObject({ flavored: true, flavorTo: null });
  });

  it('dice la línea de lo que está mal escrito en un plato', () => {
    expect(() => parseFoodTable('Plato | plato | = Pan 60 + Queso 30 | ud=90')).toThrow(/solo se lee con parseFoodTables/);
    expect(() => parse('Plato | plato | = Pan 60 | ud=60')).toThrow(/al menos dos piezas/);
    expect(() => parse('Plato | plato | = Pan + Queso 30 | ud=60')).toThrow(/cada pieza es «nombre gramos»/);
    expect(() => parse('Plato | plato | = Pan 0 + Queso 30 | ud=60')).toThrow(/mayor que 0/);
    expect(() => parse('Plato | plato | = postre:Pan 60 + Queso 30 | ud=60')).toThrow(/rol desconocido/);
    expect(() => parse('Plato | plato | = Pan 60 + Jamonete 30 | ud=60')).toThrow(/Jamonete.*no es un alimento de la tabla/);
    expect(() => parse('Otro | otro | = Pan 60 + Queso 30 | ud=60\nPlato | plato | = Otro 100 + Queso 30 | ud=60')).toThrow(/ya es un plato compuesto/);
    expect(() => parse('Plato | plato | = Pan 60 + Queso 30 | como=Tomate')).toThrow(/pares/);
    expect(() => parse('Plato | plato | = Pan 60 + Queso 30 | como=Tomate:Jamonete')).toThrow(/no está en la tabla/);
    expect(() => parse('Plato | plato | 1 2 3 4 0 0 0 | como=Tomate:Queso racion=1')).toThrow(/solo se usa en un plato compuesto/);
    expect(() => parse('Plato | plato | = Pan 60 + Queso 30 | rol=postre')).toThrow(/rol= debe ser/);
    expect(() => parse('Plato | plato | = Pan 60 + Queso 30 | peso=gramos')).toThrow(/peso= debe ser un rol/);
    expect(() => parse('Plato | plato | = Pan 60 + Queso 30 | cm=0')).toThrow(/cm debe ser un número mayor que 0/);
    expect(() => parse('Plato | plato | = Pan 60 + Queso 30 | menu=1')).toThrow(/desconocid/);
  });

  it('el papel de un alimento sin «rol=» lo da su archivo (y la familia vale para sus variantes)', () => {
    const drink = 'Agua | agua | 0 0 0 0 0 0 0 | liquido racion=200';
    expect(parseFoodTable(drink, 'alimentos-bebidas.txt')[0]!.role).toBe('bebida');
    expect(parseFoodTable(drink, 'alimentos-bebidas-marcas.txt')[0]!.role).toBe('bebida');
    expect(parseFoodTable(drink, 'alimentos.txt')[0]!.role).toBeNull();
    expect(parseFoodTable(`${drink} rol=queso`, 'alimentos-bebidas.txt')[0]!.role).toBe('queso');
    expect(parseFoodTable(`${drink} rol=ninguno`, 'alimentos-bebidas.txt')[0]!.role).toBeNull();
  });
});

describe('la tabla de alimentos de la app', () => {
  const recipes = table.filter((entry) => entry.recipe !== null);

  it('tiene platos compuestos, y cada uno suma lo que dice', () => {
    expect(recipes.length).toBeGreaterThan(50);
    for (const entry of recipes) {
      const mass = entry.recipe!.reduce((sum, part) => sum + (part.entry.liquid ? part.amount * part.entry.density : part.amount), 0);
      expect(mass, entry.name).toBeGreaterThan(30);
      expect(mass, entry.name).toBeLessThan(1500);
      // Las cifras del plato son las de sus piezas: por 100 g, y con las calorías que dan sus nutrientes.
      const expected = 4 * entry.proteinG + 4 * entry.carbsG + 9 * entry.fatG + 7 * entry.alcoholG;
      expect(Math.abs(entry.kcal - expected), entry.name).toBeLessThanOrEqual(Math.max(25, 0.18 * expected));
    }
  });

  it('cada pieza sustituible lleva un papel que existe, y un plato no se sustituye entero', () => {
    for (const entry of recipes) {
      for (const part of entry.recipe!) {
        if (part.slot !== null) expect(FOOD_ROLES, `${entry.name}: ${part.entry.name}`).toContain(part.slot);
        expect(part.entry.recipe, `${entry.name} lleva ${part.entry.name}, que es un plato`).toBeNull();
        expect(part.entry.ignore, `${entry.name} lleva ${part.entry.name}, que no suma`).toBe(false);
      }
    }
  });

  it('los menús crecen en patatas y bebida, y por eso las llevan; «peso=» nombra una pieza que existe', () => {
    for (const entry of recipes.filter((candidate) => candidate.menu)) {
      expect(entry.recipe!.some((part) => part.slot === 'guarnicion' || part.slot === 'bebida'), entry.name).toBe(true);
    }
    for (const entry of recipes.filter((candidate) => candidate.weightOf !== null)) {
      expect(entry.recipe!.some((part) => part.slot === entry.weightOf), entry.name).toBe(true);
    }
  });

  it('un alimento de sabores que pasa a otro nombra uno que existe y no es un plato', () => {
    const byName = new Map(table.map((entry) => [entry.name, entry]));
    for (const entry of table.filter((candidate) => candidate.flavorTo !== null)) {
      const target = byName.get(entry.flavorTo!);
      expect(target, `${entry.name} → ${entry.flavorTo}`).toBeDefined();
      expect(target!.recipe, `${entry.name} → ${entry.flavorTo}`).toBeNull();
    }
  });

  it('lo que se pide por longitud tiene unidad, y la comida rápida y los contenedores son alimentos con ración', () => {
    for (const entry of table.filter((candidate) => candidate.lengthCm !== null)) expect(entry.each, entry.name).not.toBeNull();
    for (const entry of table.filter((candidate) => candidate.fast || candidate.container)) expect(entry.ignore, entry.name).toBe(false);
  });

  it('tiene cientos de alimentos', () => {
    expect(table.length).toBeGreaterThan(250);
  });

  it('las calorías cuadran con los nutrientes (4 kcal por g de proteína o hidrato, 9 por g de grasa, 7 por g de alcohol)', () => {
    const off = table
      .filter((entry) => !entry.ignore)
      .map((entry) => ({ entry, expected: 4 * entry.proteinG + 4 * entry.carbsG + 9 * entry.fatG + 7 * entry.alcoholG }))
      // La fibra y los polifenoles explican hasta un 18 % de diferencia; por debajo de 25 kcal no se mira.
      .filter(({ entry, expected }) => Math.abs(entry.kcal - expected) > Math.max(25, 0.18 * expected))
      .map(({ entry, expected }) => `${entry.name}: ${entry.kcal} kcal, pero sus nutrientes dan ${expected.toFixed(0)}`);
    expect(off).toEqual([]);
  });

  it('cada alimento trae fibra, azúcares y sal razonables (solo lo que no lleva nada de eso va a cero)', () => {
    const entries = table.filter((entry) => !entry.ignore && entry.recipe === null);
    const allZero = entries.filter((e) => e.fiberG === 0 && e.sugarsG === 0 && e.saltG === 0).map((e) => e.name);
    expect(allZero.sort()).toEqual(['Agua', 'Aceite', 'Aceite de oliva', 'Café solo', 'Licor', 'Té'].sort());
    // Los azúcares son una parte de los hidratos; la sal alta es de lo que de verdad es salado (curados, salazones, conservantes y salsas).
    const salty = entries.filter((e) => e.saltG > 3).map((e) => e.name).sort();
    expect(salty).toEqual(
      ['Anchoas', 'Bacon', 'Caldo en cubo', 'Cecina', 'Chorizo', 'Fuet', 'Jamón serrano', 'Lomo embuchado', 'Mojama', 'Mostaza', 'Pepperoni', 'Queso azul', 'Salchichón', 'Salsa de soja', 'Salsa picante'].sort(),
    );
    expect(entries.filter((e) => e.fiberG > 12).map((e) => e.name).sort()).toEqual(['Alubias crudas', 'Cacao en polvo', 'Garbanzos crudos', 'Palomitas naturales', 'Semillas']);
    for (const e of entries) expect(e.sugarsG, e.name).toBeLessThanOrEqual(e.carbsG * 1.02 + 0.3);
    const by = (name: string): FoodEntry => entries.find((e) => e.name === name)!;
    // Algunos valores de referencia (BEDCA/AESAN): el pan lleva sal (1–1,5 g/100 g) y algo de fibra; el jamón serrano es de lo más salado; la manzana, fibra y azúcares sin sal.
    expect(by('Pan').saltG).toBeGreaterThan(0.9);
    expect(by('Pan').saltG).toBeLessThan(1.8);
    expect(by('Pan').fiberG).toBeGreaterThan(2);
    expect(by('Jamón serrano').saltG).toBeGreaterThan(4);
    expect(by('Manzana').fiberG).toBeGreaterThan(1.5);
    expect(by('Manzana').sugarsG).toBeGreaterThan(8);
    expect(by('Manzana').saltG).toBeLessThan(0.05);
  });

  it('un plato compuesto suma la fibra, los azúcares y la sal de sus piezas', () => {
    const dishes = table.filter((entry) => entry.recipe !== null);
    expect(dishes.length).toBeGreaterThan(40);
    for (const dish of dishes) {
      const mass = dish.recipe!.reduce((sum, part) => sum + (part.entry.liquid ? part.amount * part.entry.density : part.amount), 0);
      const salt = dish.recipe!.reduce((sum, part) => sum + (part.entry.saltG * (part.entry.liquid ? part.amount * part.entry.density : part.amount)) / 100, 0);
      expect(dish.saltG, dish.name).toBeCloseTo(salt / (mass / 100), 1);
      expect(dish.sugarsG, dish.name).toBeLessThanOrEqual(dish.carbsG * 1.02 + 0.3);
    }
  });

  it('las formas de decir cada alimento no se pisan entre sí ni con las cantidades y los rellenos', () => {
    expect(aliasProblems(table)).toEqual([]);
  });

  it('las raciones, unidades y medidas son razonables', () => {
    const odd: string[] = [];
    for (const entry of table) {
      if (entry.ignore) continue;
      if (entry.serving > 1500) odd.push(`${entry.name}: ración de ${entry.serving}`);
      if (entry.each !== null && entry.each > 1000) odd.push(`${entry.name}: unidad de ${entry.each}`);
      for (const [measure, value] of Object.entries(entry.measures)) if (value > 1000) odd.push(`${entry.name}: ${measure} de ${value}`);
      // Una ración mucho menor que una unidad suelta suele ser un error de escritura (una bola de mozzarella sí se parte).
      if (entry.each !== null && entry.serving < entry.each * 0.3) odd.push(`${entry.name}: la ración (${entry.serving}) es mucho menor que una unidad (${entry.each})`);
      if (entry.serving > 0 && entry.serving < 1) odd.push(`${entry.name}: ración de ${entry.serving}`);
    }
    expect(odd).toEqual([]);
  });

  it('las bebidas se miden en líquido y los sólidos no', () => {
    const solidsWithDensity = table.filter((e) => !e.liquid && e.density !== 1).map((e) => e.name);
    expect(solidsWithDensity).toEqual([]);
    const alcoholWithoutLiquid = table.filter((e) => e.alcoholG > 0 && !e.liquid).map((e) => e.name);
    expect(alcoholWithoutLiquid).toEqual([]);
  });

  it('cada medida de la tabla existe', () => {
    const known = new Set<string>(MEASURES);
    for (const entry of table) for (const measure of Object.keys(entry.measures)) expect(known.has(measure)).toBe(true);
  });
});
