import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables } from './food-table';
import { analyzeMealText, draftOfAnalysis, MAX_TEXT_CHARS, wordForms, type TextAnalysis } from './food-text';

const table = parseFoodTables(FOOD_SOURCES);
const run = (text: string): TextAnalysis => analyzeMealText(text, table);

/** Lo calculado como «nombre cantidad unidad» (una línea por alimento): fácil de leer cuando falla. */
const shape = (analysis: TextAnalysis): string[] => analysis.items.map((item) => `${item.name} ${item.amount}${item.unit}`);
const kcalOf = (analysis: TextAnalysis): number => analysis.items.reduce((sum, item) => sum + item.kcal, 0);

describe('wordForms', () => {
  it('singular y plural comparten forma', () => {
    const same = (a: string, b: string): boolean => wordForms(a).some((form) => wordForms(b).includes(form));
    expect(same('huevos', 'huevo')).toBe(true);
    expect(same('tomates', 'tomate')).toBe(true);
    expect(same('panes', 'pan')).toBe(true);
    expect(same('carnes', 'carne')).toBe(true);
    expect(same('yogures', 'yogur')).toBe(true);
    expect(same('nueces', 'nuez')).toBe(true);
    expect(same('melones', 'melon')).toBe(true);
    expect(same('arroz', 'arroces')).toBe(true);
    expect(same('pan', 'pasta')).toBe(false);
    expect(same('mas', 'ma')).toBe(false);
  });
});

describe('cantidades', () => {
  it('cuenta unidades: «dos huevos»', () => {
    const a = run('dos huevos');
    expect(shape(a)).toEqual(['Huevo ×2 110g']);
    expect(kcalOf(a)).toBe(171); // 155 kcal por 100 g × 110 g
    expect(a.assumptions).toBe('');
  });

  it('lee cifras, palabras y fracciones', () => {
    expect(shape(run('3 huevos'))).toEqual(['Huevo ×3 165g']);
    expect(shape(run('tres huevos'))).toEqual(['Huevo ×3 165g']);
    expect(shape(run('un huevo'))).toEqual(['Huevo 55g']);
    expect(shape(run('1,5 huevos'))).toEqual(['Huevo ×1,5 83g']);
    expect(shape(run('medio aguacate'))).toEqual(['Aguacate ×0,5 75g']);
    expect(shape(run('1/2 aguacate'))).toEqual(['Aguacate ×0,5 75g']);
    expect(shape(run('un par de huevos'))).toEqual(['Huevo ×2 110g']);
    expect(shape(run('media docena de huevos'))).toEqual(['Huevo ×6 330g']);
    expect(shape(run('una docena de huevos'))).toEqual(['Huevo ×12 660g']);
    expect(shape(run('dos o tres huevos'))).toEqual(['Huevo ×2,5 138g']);
    expect(shape(run('dos y medio huevos'))).toEqual(['Huevo ×2,5 138g']);
  });

  it('gramos, kilos y litros se respetan tal cual', () => {
    const rice = run('200 g de arroz');
    expect(shape(rice)).toEqual(['Arroz cocido 200g']);
    expect(kcalOf(rice)).toBe(260);
    expect(shape(run('200g de arroz'))).toEqual(['Arroz cocido 200g']);
    expect(shape(run('doscientos gramos de arroz'))).toEqual(['Arroz cocido 200g']);
    expect(shape(run('1 kg de patatas'))).toEqual(['Patata cocida 1000g']);
    expect(shape(run('un cuarto de kilo de patatas'))).toEqual(['Patata cocida 250g']);
    expect(shape(run('1,5 kg de arroz'))).toEqual(['Arroz cocido 1500g']);
    expect(run('200 g de arroz').assumptions).toBe('');
  });

  it('los líquidos van en mililitros y pesan lo que pesan', () => {
    const milk = run('medio litro de leche');
    expect(shape(milk)).toEqual(['Leche semidesnatada 500ml']);
    expect(kcalOf(milk)).toBeCloseTo(46 * 5.15, 0); // 500 ml de leche pesan 515 g
    expect(shape(run('250 ml de zumo de naranja'))).toEqual(['Zumo de naranja 250ml']);
    expect(shape(run('un vaso de leche entera'))).toEqual(['Leche entera 200ml']);
    expect(shape(run('dos vasos de leche'))).toEqual(['Leche semidesnatada 400ml']);
    expect(shape(run('2 dl de leche'))).toEqual(['Leche semidesnatada 200ml']);
    // Gramos de un líquido: se pasan a mililitros.
    expect(shape(run('100 g de aceite'))).toEqual(['Aceite 109ml']);
  });

  it('medidas caseras: cucharadas, puñados, lonchas, trozos', () => {
    const oil = run('dos cucharadas de aceite');
    expect(shape(oil)).toEqual(['Aceite 30ml']);
    expect(kcalOf(oil)).toBeCloseTo(900 * 0.3 * 0.92, 0);
    expect(shape(run('una cucharadita de azúcar'))).toEqual(['Azúcar 5g']);
    expect(kcalOf(run('una cucharadita de azúcar'))).toBe(20);
    expect(shape(run('un puñado de almendras'))).toEqual(['Almendras 30g']);
    expect(shape(run('tres lonchas de jamón serrano'))).toEqual(['Jamón serrano 45g']);
    expect(shape(run('una porción de pizza'))).toEqual(['Pizza 120g']);
    expect(shape(run('un trozo de tarta'))).toEqual(['Tarta 100g']);
    expect(shape(run('una taza de café con leche'))).toEqual(['Café con leche 200ml']);
    expect(shape(run('una lata de coca-cola'))).toEqual(['Refresco de cola 330ml']);
  });

  it('un plato, una ración: lo habitual de ese alimento', () => {
    expect(shape(run('un plato de lentejas'))).toEqual(['Lentejas guisadas 300g']);
    expect(shape(run('una ración de jamón ibérico'))).toEqual(['Jamón serrano 50g']);
    expect(shape(run('dos raciones de patatas bravas'))).toEqual(['Patatas bravas 400g']);
  });

  it('el tamaño cambia las unidades y los platos, no los gramos dichos', () => {
    expect(shape(run('un plato grande de lentejas'))).toEqual(['Lentejas guisadas 390g']);
    expect(shape(run('una manzana pequeña'))).toEqual(['Manzana 126g']);
    expect(shape(run('200 g de arroz grande'))).toEqual(['Arroz cocido 200g']);
  });

  it('«un poco de» es media ración', () => {
    const a = run('un poco de arroz');
    expect(shape(a)).toEqual(['Arroz cocido 100g']);
    expect(a.assumptions).toContain('Arroz cocido');
  });

  it('la cantidad puede ir detrás: «arroz 200 g»', () => {
    expect(shape(run('arroz 200g, pollo 150g'))).toEqual(['Arroz cocido 200g', 'Pollo 150g']);
    expect(shape(run('arroz 200 g pollo 150 g'))).toEqual(['Arroz cocido 200g', 'Pollo 150g']);
  });
});

describe('sin cantidad', () => {
  it('supone una ración y lo dice', () => {
    const a = run('arroz');
    expect(shape(a)).toEqual(['Arroz cocido 200g']);
    expect(a.items[0]?.assumed).toBe(true);
    expect(a.assumptions).toBe('Sin la cantidad, supuse una ración habitual de: Arroz cocido (200 g).');
  });

  it('«un café» es una unidad; «huevos fritos», en plural y sin número, una ración', () => {
    expect(shape(run('un café'))).toEqual(['Café solo 60ml']);
    expect(shape(run('un café con leche'))).toEqual(['Café con leche 200ml']);
    expect(shape(run('huevos fritos'))).toEqual(['Huevo frito 100g']);
    expect(shape(run('croquetas'))).toEqual(['Croquetas 120g']);
    expect(shape(run('una croqueta'))).toEqual(['Croquetas 30g']);
  });

  it('una medida sin alimento: el de siempre', () => {
    expect(shape(run('una caña'))).toEqual(['Cerveza 200ml']);
    expect(shape(run('dos cañas'))).toEqual(['Cerveza 400ml']);
    expect(shape(run('un botellín'))).toEqual(['Cerveza 330ml']);
    expect(shape(run('una copa de vino'))).toEqual(['Vino 100ml']);
    expect(shape(run('un vaso de agua'))).toEqual(['Agua 200ml']);
  });
});

describe('frases completas', () => {
  it('un desayuno', () => {
    const a = run('dos huevos revueltos con una tostada y un café con leche');
    expect(shape(a)).toEqual(['Huevos revueltos ×2 120g', 'Tostada 45g', 'Café con leche 200ml']);
    expect(kcalOf(a)).toBe(216 + 131 + 68);
    expect(a.unknown).toEqual([]);
  });

  it('«con» une o separa según el alimento', () => {
    expect(shape(run('pan con tomate'))).toEqual(['Tostada con tomate 70g']);
    expect(shape(run('café con leche'))).toEqual(['Café con leche 200ml']);
    expect(shape(run('arroz con pollo'))).toEqual(['Arroz con pollo 350g']);
    expect(shape(run('arroz con tomate y huevo frito'))).toEqual(['Arroz con tomate 250g', 'Huevo frito 50g']);
    expect(shape(run('tostada con aceite y tomate'))).toEqual(['Tostada 45g', 'Aceite 10ml', 'Tomate 40g']);
    // El café con leche es un plato compuesto: lo que se le echa va dentro y se ve en el nombre.
    expect(shape(run('café con leche con azúcar'))).toEqual(['Café con leche con azúcar 208ml']);
  });

  it('«sin» quita lo que viene detrás', () => {
    expect(shape(run('café con leche sin azúcar'))).toEqual(['Café con leche sin azúcar 200ml']);
    expect(shape(run('ensalada sin aceite'))).toEqual(['Ensalada 200g']);
  });

  it('lista con comas, «y» y puntos', () => {
    expect(shape(run('una manzana, un yogur natural y un puñado de almendras'))).toEqual(['Manzana 180g', 'Yogur natural 125g', 'Almendras 30g']);
    expect(shape(run('Comí paella. Y una cerveza.'))).toEqual(['Paella 350g', 'Cerveza 330ml']);
    expect(shape(run('lentejas; fruta'))).toEqual(['Lentejas guisadas 300g', 'Fruta 150g']);
  });

  it('palabras de relleno, la hora y los porcentajes no cuentan', () => {
    expect(shape(run('hoy a las 3 me he comido una hamburguesa con queso'))).toEqual(['Hamburguesa con queso 260g']);
    expect(shape(run('a las 14:30 comí arroz con pollo'))).toEqual(['Arroz con pollo 350g']);
    expect(shape(run('para desayunar tomé unas tostadas'))).toEqual(['Tostada 45g']);
    expect(shape(run('un yogur 0% con cereales'))).toEqual(['Yogur desnatado 125g', 'Cereales de desayuno 40g']);
    expect(shape(run('chocolate 70% 20 g'))).toEqual(['Chocolate negro 20g']);
  });

  it('ignora mayúsculas, acentos y la eñe', () => {
    expect(shape(run('CAFÉ CON LECHE'))).toEqual(['Café con leche 200ml']);
    expect(shape(run('cafe con leche'))).toEqual(['Café con leche 200ml']);
    expect(shape(run('Dos Cañas'))).toEqual(['Cerveza 400ml']);
    expect(shape(run('dos canas'))).toEqual(['Cerveza 400ml']);
    expect(shape(run('platano'))).toEqual(['Plátano 120g']);
    expect(shape(run('gin-tonic'))).toEqual(['Combinado 250ml']);
    expect(shape(run('coca-cola zero'))).toEqual(['Refresco light 330ml']);
  });

  it('condimentos: se reconocen y no suman', () => {
    expect(shape(run('pollo a la plancha con sal, limón y ajo'))).toEqual(['Pollo (a la plancha) 150g']);
    expect(shape(run('dos cucharadas de sal'))).toEqual([]);
    expect(run('dos cucharadas de sal').unknown).toEqual([]);
  });

  it('plurales y variantes del mismo alimento', () => {
    expect(shape(run('dos tomates'))).toEqual(['Tomate ×2 240g']);
    expect(shape(run('2 yogures'))).toEqual(['Yogur natural ×2 250g']);
    expect(shape(run('unas lentejas'))).toEqual(['Lentejas guisadas 300g']);
    expect(shape(run('pimientos de padrón'))).toEqual(['Pimientos de Padrón 100g']);
  });

  it('las erratas de una letra se entienden y se dice', () => {
    const a = run('tomatee y lechuga');
    expect(shape(a)).toEqual(['Tomate 120g', 'Lechuga 60g']);
    expect(a.assumptions).toContain('Entendí «tomatee» como tomate.');
    expect(shape(run('una manzanna'))).toEqual(['Manzana 180g']);
    expect(shape(run('ensalda'))).toEqual(['Ensalada 200g']);
    expect(shape(run('una banana de canarias'))).toEqual(['Plátano 120g']);
  });
});

describe('lo que no entiende', () => {
  it('lo dice en vez de sumarlo', () => {
    const a = run('pollo con zorongo');
    expect(shape(a)).toEqual(['Pollo 150g']);
    expect(a.unknown).toEqual(['zorongo']);
  });

  it('un texto sin ningún alimento no da nada', () => {
    const a = run('xyz abc');
    expect(a.items).toEqual([]);
    expect(a.unknown).toEqual(['xyz abc']);
    expect(run('').items).toEqual([]);
    expect(run('   ').items).toEqual([]);
    expect(run('hola, qué tal').items).toEqual([]);
    expect(run('dos').items).toEqual([]);
    expect(run('dos').unknown).toEqual([]);
  });

  it('el tipo de cocinado que no sabe no se convierte en otro plato', () => {
    const a = run('pescado al pil pil');
    expect(shape(a)).toEqual(['Pescado blanco 180g']);
    expect(a.unknown).toEqual(['pil pil']);
  });

  it('no se deja engañar por palabras del lenguaje de objetos de JavaScript', () => {
    expect(run('constructor').items).toEqual([]);
    expect(run('toString y __proto__').items).toEqual([]);
  });

  it('un texto enorme se recorta y nunca se cuelga', () => {
    const a = run('huevo y '.repeat(5_000));
    expect(a.items.length).toBeLessThanOrEqual(20);
    expect(a.assumptions).toContain('primeros');
    expect(MAX_TEXT_CHARS).toBe(1000);
    const long = run('x'.repeat(100_000));
    expect(long.items).toEqual([]);
  });

  it('una cantidad enorme no pasa de lo que admite una comida', () => {
    const a = run('99999 g de arroz');
    expect(a.items[0]?.amount).toBe(5000);
  });
});

describe('draftOfAnalysis', () => {
  it('suma las cifras y junta los nombres', () => {
    const a = run('dos huevos revueltos con una tostada y un café con leche');
    expect(draftOfAnalysis(a)).toEqual({
      name: 'Huevos revueltos ×2 + Tostada + Café con leche',
      kcal: 415,
      proteinG: expect.any(Number),
      carbsG: expect.any(Number),
      fatG: expect.any(Number),
      fiberG: expect.any(Number),
      sugarsG: expect.any(Number),
      saltG: expect.any(Number),
    });
    const draft = draftOfAnalysis(a);
    expect(draft.proteinG).toBeCloseTo(a.items.reduce((t, i) => t + i.proteinG, 0), 1);
  });

  it('el nombre no pasa del máximo', () => {
    const a = run('huevo, '.repeat(30));
    expect(draftOfAnalysis(a).name!.length).toBeLessThanOrEqual(120);
  });
});

describe('formas de cocinar', () => {
  const kcal = (text: string): number => kcalOf(run(text));

  it('a la plancha o hervido casi no cambia las cifras de la tabla; frito y empanado, sí', () => {
    expect(shape(run('150 g de cerdo'))).toEqual(['Cerdo 150g']);
    const plain = kcal('150 g de cerdo');
    const grilled = kcal('150 g de cerdo a la plancha');
    const fried = kcal('150 g de cerdo frito');
    const breaded = kcal('150 g de cerdo empanado');
    expect(grilled).toBeGreaterThan(plain);
    expect(grilled - plain).toBeLessThan(20);
    expect(fried - plain).toBeGreaterThan(80);
    expect(breaded).toBeGreaterThan(fried);
    expect(kcal('150 g de cerdo cocido')).toBe(plain);
  });

  it('la forma de cocinar va en el nombre y vale antes o después del alimento', () => {
    expect(shape(run('cerdo frito'))).toEqual(['Cerdo (frito) 150g']);
    expect(shape(run('merluza a la romana'))).toEqual(['Merluza (empanado) 150g']);
    expect(shape(run('berenjenas fritas'))).toEqual(['Berenjena (frito) 150g']);
    expect(shape(run('patata frita'))).toEqual(['Patatas fritas 150g']); // esa ya es un plato con nombre propio en la tabla
    expect(shape(run('200 g de salmón al horno'))).toEqual(['Salmón (al horno) 200g']);
    expect(shape(run('pechuga de pollo 200 g a la plancha'))).toEqual(['Pechuga de pollo (a la plancha) 200g']);
  });

  it('si se dicen dos, manda la que más grasa añade', () => {
    expect(shape(run('pescado rebozado y frito'))).toEqual(['Pescado blanco (empanado) 180g']);
  });

  it('en lo que no cambia con ella se ignora, sin avisar', () => {
    const a = run('arroz frito');
    expect(shape(a)).toEqual(['Arroz frito 250g']);
    expect(shape(run('pan asado'))).toEqual(['Pan 60g']);
    expect(run('pan asado').unknown).toEqual([]);
  });

  it('«crudo» usa las cifras del alimento crudo (lleva más agua)', () => {
    const raw = kcal('150 g de pechuga de pollo cruda');
    const cooked = kcal('150 g de pechuga de pollo');
    expect(raw).toBeLessThan(cooked * 0.8);
    expect(raw).toBeGreaterThan(cooked * 0.6);
    expect(shape(run('150 g de pechuga de pollo cruda'))).toEqual(['Pechuga de pollo (crudo) 150g']);
  });
});

describe('cantidades más complicadas', () => {
  it('números en palabras de varias palabras', () => {
    expect(shape(run('ciento cincuenta gramos de arroz'))).toEqual(['Arroz cocido 150g']);
    expect(shape(run('doscientos cincuenta gramos de arroz'))).toEqual(['Arroz cocido 250g']);
    expect(shape(run('trescientos gramos de pollo'))).toEqual(['Pollo 300g']);
    expect(shape(run('treinta y cinco gramos de almendras'))).toEqual(['Almendras 35g']);
    expect(shape(run('mil doscientos gramos de patatas'))).toEqual(['Patata cocida 1200g']);
    expect(shape(run('veintiséis gramos de miel'))).toEqual(['Miel 26g']);
  });

  it('separador de miles, fracciones de teclado y «y media»', () => {
    expect(shape(run('1.500 g de patatas'))).toEqual(['Patata cocida 1500g']);
    expect(shape(run('0.250 kg de arroz'))).toEqual(['Arroz cocido 250g']);
    expect(shape(run('½ litro de leche'))).toEqual(['Leche semidesnatada 500ml']);
    expect(shape(run('1½ litros de leche'))).toEqual(['Leche semidesnatada 1500ml']);
    expect(shape(run('una taza y media de leche'))).toEqual(['Leche semidesnatada 375ml']);
    expect(shape(run('dos raciones y media de pasta'))).toEqual(['Pasta cocida 500g']);
  });

  it('la cantidad entre paréntesis o dicha después', () => {
    expect(shape(run('croquetas de jamón (6)'))).toEqual(['Croquetas de jamón ×6 180g']);
    expect(shape(run('arroz (200 g)'))).toEqual(['Arroz cocido 200g']);
    expect(shape(run('helado de chocolate, dos bolas'))).toEqual(['Helado de chocolate 120g']);
    expect(shape(run('pizza margarita, una porción'))).toEqual(['Pizza 120g']);
  });

  it('doble, triple y un título con dos puntos', () => {
    expect(shape(run('una ración doble de patatas bravas'))).toEqual(['Patatas bravas 400g']);
    expect(shape(run('sushi: 8 piezas de nigiri y 6 de maki'))).toEqual(['Nigiri ×8 240g', 'Maki ×6 150g']);
  });
});

describe('bocadillos, sándwiches y wraps', () => {
  it('lo que va dentro cuenta como relleno, no como un plato', () => {
    const a = run('un bocadillo de pavo y queso');
    expect(shape(a)).toEqual(['Bocadillo (pan) 100g', 'Pavo 60g', 'Queso 25g']);
    expect(shape(run('sándwich de atún y tomate'))).toEqual(['Sándwich (pan) 56g', 'Atún al natural 50g', 'Tomate 40g']);
    expect(shape(run('un wrap de pollo con verduras'))).toEqual(['Wrap 60g', 'Pollo 60g', 'Verduras 100g']);
  });

  it('una cantidad dicha acaba el relleno', () => {
    expect(shape(run('un bocadillo de jamón y un yogur'))).toEqual(['Bocadillo de jamón 180g', 'Yogur natural 125g']);
    expect(shape(run('bocadillo de queso y una manzana'))).toEqual(['Bocadillo de queso 170g', 'Manzana 180g']);
    expect(shape(run('un bocadillo de pavo. Una manzana'))).toEqual(['Bocadillo (pan) 100g', 'Pavo 60g', 'Manzana 180g']);
  });

  it('los bocadillos con nombre propio siguen siendo un plato entero', () => {
    expect(shape(run('bocadillo de tortilla'))).toEqual(['Bocadillo de tortilla 250g']);
  });
});

describe('marcas y platos habituales', () => {
  const names = (text: string): string[] => run(text).items.map((item) => item.name);

  it('reconoce marcas y productos de cadena', () => {
    expect(names('un big mac')).toEqual(['Big Mac']);
    expect(names('una coca cola zero')).toEqual(['Refresco light']);
    expect(names('un kinder bueno')).toEqual(['Kinder Bueno']);
    expect(names('unas pringles')).toEqual(['Pringles']);
    expect(names('un magnum')).toEqual(['Helado envasado']);
    expect(names('un tinto de verano y un vermut')).toEqual(['Tinto de verano', 'Vermut']);
  });

  it('platos de la cocina de aquí', () => {
    expect(names('pulpo a la gallega')).toEqual(['Pulpo a la gallega']);
    expect(names('huevos rotos con jamón')).toEqual(['Huevos rotos']);
    expect(names('salmorejo y croquetas de jamón')).toEqual(['Salmorejo', 'Croquetas de jamón']);
    expect(names('pimientos rellenos')).toEqual(['Pimientos rellenos']);
  });
});

describe('fibra, azúcares y sal de lo escrito', () => {
  it('cada alimento de la tabla trae los tres, a la cantidad dicha', () => {
    const [ham] = run('50 g de jamón serrano').items;
    expect(ham).toMatchObject({ fiberG: 0, sugarsG: 0, saltG: 2.25 }); // 4,5 g de sal por 100 g
    const [apple] = run('200 g de manzana').items;
    expect(apple?.fiberG).toBeGreaterThan(3);
    expect(apple?.sugarsG).toBeGreaterThan(15);
    expect(apple?.saltG).toBeLessThan(0.1);
  });

  it('sumar los alimentos suma también los tres', () => {
    const a = run('dos rebanadas de pan con 40 g de jamón serrano');
    const draft = draftOfAnalysis(a);
    expect(draft.saltG).toBeCloseTo(a.items.reduce((total, item) => total + (item.saltG ?? 0), 0), 1);
    expect(draft.saltG!).toBeGreaterThan(2); // el pan (≈1,2 g por 100 g) y el jamón (1,8 g en 40 g)
    expect(draft.fiberG!).toBeGreaterThan(0.5);
  });

  it('un plato compuesto lleva los tres, pieza a pieza, y las piezas suman el plato', () => {
    const [dish] = run('un kebab de ternera').items;
    expect(dish?.parts?.length).toBeGreaterThan(2);
    expect(dish?.saltG).toBeCloseTo(dish!.parts!.reduce((total, part) => total + (part.saltG ?? 0), 0), 1);
    expect(dish?.saltG).toBeGreaterThan(2); // un kebab es de lo más salado que se come en una comida
  });

  it('freír, empanar o guisar añade la sal con que se cocina; la plancha, un poco; crudo no cambia el reparto', () => {
    const salt = (text: string): number => run(text).items[0]?.saltG ?? 0;
    expect(salt('200 g de pechuga de pollo a la plancha')).toBeGreaterThan(salt('200 g de pechuga de pollo cocida'));
    expect(salt('200 g de pechuga de pollo empanada')).toBeGreaterThan(salt('200 g de pechuga de pollo frita'));
    expect(salt('200 g de pechuga de pollo frita')).toBeGreaterThan(salt('200 g de pechuga de pollo a la plancha'));
  });

  it('draftOfAnalysis deja «sin dato» (null) lo que ningún alimento sabe', () => {
    const a = run('una manzana');
    const bare = { ...a, items: a.items.map(({ fiberG: _f, sugarsG: _s, saltG: _t, ...rest }) => rest) };
    expect(draftOfAnalysis(bare)).toMatchObject({ fiberG: null, sugarsG: null, saltG: null });
  });

  it('un producto envasado trae lo de su etiqueta, y si no lo trae no se inventa', async () => {
    const withLabel = (words: readonly string[]) =>
      words.includes('flurbo')
        ? [{ name: 'Galletas Flurbo', brand: 'Marca', kcal: 450, proteinG: 7, carbsG: 70, fatG: 15, servingG: 30, fiberG: 3, sugarsG: 24, saltG: 0.9 }]
        : words.includes('glorp')
          ? [{ name: 'Galletas Glorp', brand: 'Marca', kcal: 450, proteinG: 7, carbsG: 70, fatG: 15, servingG: 30 }]
          : [];
    const [a] = analyzeMealText('unas galletas flurbo', table, withLabel).items;
    expect(a).toMatchObject({ amount: 30, fiberG: 0.9, sugarsG: 7.2, saltG: 0.27 });
    const [b] = analyzeMealText('unas galletas glorp', table, withLabel).items;
    expect(b?.fiberG).toBeUndefined();
    expect(b?.saltG).toBeUndefined();
  });
});
