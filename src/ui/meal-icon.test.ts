import { describe, expect, it } from 'vitest';
import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables } from '../domain/food-table';
import { hasIcon } from './icons';
import { MEAL_ICON_NAMES, mealIconName } from './meal-icon';

describe('mealIconName', () => {
  it.each([
    // desayuno
    ['Café con leche', 'mug'],
    ['Café solo', 'Coffee'],
    ['Tostadas con tomate y café con leche', 'bread'],
    ['Tostada con aguacate', 'bread'],
    ['Croissant', 'Croissant'],
    ['Napolitana de chocolate', 'Croissant'],
    ['Magdalena', 'Cupcake'],
    ['Donut', 'Donut'],
    ['Churros con chocolate', 'Donut'],
    ['Yogur natural y fruta', 'bowl-spoon'],
    ['Cereales con leche', 'Wheat'],
    ['Zumo de naranja', 'Citrus'],
    ['Té verde', 'teapot'],
    ['Colacao', 'mug'],
    // comidas
    ['Arroz con pollo y ensalada', 'rice'],
    ['Pollo con arroz', 'Drumstick'],
    ['Merluza con verduras y patata', 'Fish'],
    ['Pechuga de pollo a la plancha', 'Drumstick'],
    ['Ternera guisada', 'Beef'],
    ['Costillas de cerdo', 'meat'],
    ['Jamón serrano', 'Ham'],
    ['Chorizo', 'sausage'],
    ['Sardinas en lata', 'fish-bone'],
    ['Gambas al ajillo', 'Shrimp'],
    ['Tortilla de patatas', 'EggFried'],
    ['2 huevos revueltos', 'EggFried'],
    ['Huevo cocido', 'Egg'],
    ['Lentejas', 'CookingPot'],
    ['Cocido madrileño', 'CookingPot'],
    ['Garbanzos', 'Bean'],
    ['Sopa de fideos', 'Soup'],
    ['Gazpacho', 'Soup'],
    ['Espaguetis con tomate', 'pasta'],
    ['Macarrones con queso', 'pasta'],
    ['Ensalada mixta', 'Salad'],
    ['Lechuga', 'LeafyGreen'],
    ['Brócoli al vapor', 'broccoli'],
    ['Patatas cocidas', 'potato'],
    ['Patatas fritas', 'fries'],
    ['Tomate', 'tomato'],
    ['Zanahoria', 'Carrot'],
    ['Champiñones al ajillo', 'mushroom'],
    ['Aguacate', 'avocado'],
    // comida rápida y de cadena
    ['Pizza margarita', 'Pizza'],
    ['Big Mac', 'Hamburger'],
    ['Kebab de ternera con cebolla y salsa blanca', 'kebab'],
    ['Durum de pollo', 'kebab'],
    ['Burrito de pollo', 'wrap'],
    ['Bocadillo de jamón', 'baguette'],
    ['Sándwich mixto', 'Sandwich'],
    ['Sushi variado', 'bowl-chopsticks'],
    ['McNuggets', 'Drumstick'],
    // fruta y dulces
    ['Plátano', 'Banana'],
    ['Manzana', 'Apple'],
    ['Fresas', 'strawberry'],
    ['Sandía', 'watermelon'],
    ['Piña', 'pineapple'],
    ['Uvas', 'Grape'],
    ['Fruta y frutos secos', 'Apple'],
    ['Almendras', 'Nut'],
    ['Helado de chocolate', 'IceCreamCone'],
    ['Tarta de queso', 'CakeSlice'],
    ['Galletas', 'Cookie'],
    ['Chocolate negro', 'chocolate'],
    ['Flan', 'Dessert'],
    ['Nutella', 'jar'],
    // bebidas
    ['Una caña', 'Beer'],
    ['Vino tinto', 'Wine'],
    ['Gin tonic', 'glass-gin'],
    ['Mojito', 'Martini'],
    ['Coca-Cola', 'CupSoda'],
    ['Red Bull', 'CanSoda'],
    ['Agua', 'GlassWater'],
    ['Leche entera', 'Milk'],
    ['Batido de chocolate', 'milkshake'],
    ['Cava', 'glass-champagne'],
  ])('%s → %s', (name, icon) => {
    expect(mealIconName(name)).toBe(icon);
  });

  it('una bebida solo gana si no hay comida, y un condimento si no hay nada más', () => {
    expect(mealIconName('Café con leche + tostada')).toBe('bread');
    expect(mealIconName('Cerveza + patatas fritas')).toBe('fries');
    expect(mealIconName('Salsa de tomate')).toBe('tomato');
    expect(mealIconName('Mayonesa')).toBe('bottle');
  });

  it('no confunde una palabra con otra que la contiene', () => {
    expect(mealIconName('Panadería')).toBe('Utensils'); // «pan» no es «panadería»
    expect(mealIconName('Ensalada')).not.toBe('salt'); // «sal» no es «ensalada»
    expect(mealIconName('Masa de pizza')).toBe('Pizza');
  });

  it('con las tildes y las mayúsculas da igual', () => {
    expect(mealIconName('JAMÓN IBÉRICO')).toBe(mealIconName('jamon iberico'));
    expect(mealIconName('Plátano')).toBe(mealIconName('platano'));
  });

  it('lo que no se reconoce lleva el cubierto, y todos los iconos que puede dar existen', () => {
    expect(mealIconName('Cosa rara')).toBe('Utensils');
    expect(mealIconName('')).toBe('Utensils');
    for (const name of MEAL_ICON_NAMES) expect(hasIcon(name), name).toBe(true);
  });

  it('hay variedad: la gran mayoría de los iconos se usan con alguna comida de la tabla', () => {
    const table = parseFoodTables(FOOD_SOURCES);
    const used = new Set(table.map((entry) => mealIconName(entry.name)));
    // Cada icono nuevo que se dibuja o se copia tiene que servir para algo de lo que se puede anotar.
    const unused = MEAL_ICON_NAMES.filter((icon) => icon !== 'Utensils' && !used.has(icon));
    expect(unused, `iconos que ningún alimento de la tabla usa: ${unused.join(', ')}`).toEqual([]);
  });

  it('todos los alimentos de la tabla tienen un icono propio, no el cubierto', () => {
    const table = parseFoodTables(FOOD_SOURCES);
    const generic = table.filter((entry) => !entry.ignore && mealIconName(entry.name) === 'Utensils').map((entry) => entry.name);
    expect(generic).toEqual([]);
  });
});
