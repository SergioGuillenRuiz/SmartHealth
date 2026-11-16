// La imagen de cada tipo de comida: una ilustración en 3D (de los «Fluent Emoji» de Microsoft, licencia MIT: ver `LICENSE.txt` y `docs/atribuciones.md`) en lugar del icono de línea. Van dentro de
// la app (la app no usa internet). El tipo sale de `meal-icon.ts` (qué alimento principal lleva el nombre); el archivo, de esta tabla. Una prueba comprueba que todos los tipos tienen imagen.

const IMAGES = import.meta.glob<string>('./food-photos/*.webp', { eager: true, query: '?url', import: 'default' });

/** Para cada nombre de icono de `meal-icon.ts`, el archivo (sin extensión) de `food-photos/`. */
export const PHOTO_FILE: Readonly<Record<string, string>> = {
  Croissant: 'croissant',
  Donut: 'doughnut',
  Cupcake: 'cupcake',
  Cake: 'birthday_cake',
  CakeSlice: 'shortcake',
  Cookie: 'cookie',
  chocolate: 'chocolate_bar',
  Candy: 'candy',
  Lollipop: 'lollipop',
  IceCreamBowl: 'ice_cream',
  IceCreamCone: 'soft_ice_cream',
  Popsicle: 'shaved_ice',
  Dessert: 'custard',
  Popcorn: 'popcorn',
  Nut: 'peanuts',
  jar: 'honey_pot',
  bread: 'bread',
  baguette: 'baguette_bread',
  Sandwich: 'sandwich',
  wrap: 'burrito',
  kebab: 'stuffed_flatbread',
  Pizza: 'pizza',
  Hamburger: 'hamburger',
  fries: 'french_fries',
  sausage: 'hot_dog',
  Drumstick: 'poultry_leg',
  Beef: 'cut_of_meat',
  meat: 'meat_on_bone',
  Ham: 'bacon',
  Fish: 'fish',
  'fish-bone': 'tropical_fish',
  Shrimp: 'shrimp',
  Egg: 'egg',
  EggFried: 'cooking',
  Soup: 'pot_of_food',
  CookingPot: 'pot_of_food',
  'bowl-chopsticks': 'steaming_bowl',
  pasta: 'spaghetti',
  rice: 'cooked_rice',
  Wheat: 'sheaf_of_rice',
  'bowl-spoon': 'bowl_with_spoon',
  cheese: 'cheese_wedge',
  Salad: 'green_salad',
  LeafyGreen: 'leafy_green',
  tomato: 'tomato',
  potato: 'potato',
  broccoli: 'broccoli',
  Carrot: 'carrot',
  pepper: 'bell_pepper',
  mushroom: 'mushroom',
  avocado: 'avocado',
  Bean: 'beans',
  Apple: 'red_apple',
  Banana: 'banana',
  Citrus: 'tangerine',
  lemon: 'lemon',
  Cherry: 'cherries',
  Grape: 'grapes',
  strawberry: 'strawberry',
  watermelon: 'watermelon',
  pineapple: 'pineapple',
  Amphora: 'olive',
  milkshake: 'bubble_tea',
  mug: 'hot_beverage',
  Coffee: 'hot_beverage',
  teapot: 'teapot',
  Milk: 'glass_of_milk',
  Beer: 'beer_mug',
  'glass-champagne': 'bottle_with_popping_cork',
  Wine: 'wine_glass',
  'glass-gin': 'tumbler_glass',
  Martini: 'cocktail_glass',
  CanSoda: 'cup_with_straw',
  CupSoda: 'cup_with_straw',
  GlassWater: 'droplet',
  bottle: 'canned_food',
  salt: 'salt',
  Utensils: 'fork_and_knife_with_plate',
};

/** La URL de la imagen de un tipo de comida (el nombre de su icono), o `null` si no hay. */
export function mealPhotoUrl(iconName: string): string | null {
  const file = PHOTO_FILE[iconName];
  return file === undefined ? null : (IMAGES[`./food-photos/${file}.webp`] ?? null);
}

/** La imagen de una ilustración (la clave de `mealArt`): la de un tipo general se busca en la tabla; las finas son archivos sueltos de `food-photos/`. `null` si no está empaquetada. */
export function artUrl(art: string): string | null {
  return IMAGES[`./food-photos/${PHOTO_FILE[art] ?? art}.webp`] ?? null;
}

/** Las claves de las ilustraciones empaquetadas (para las pruebas). */
export const PACKED_ART_KEYS: readonly string[] = Object.keys(IMAGES).map((path) => path.replace(/^.*\//, '').replace(/\.webp$/, ''));
