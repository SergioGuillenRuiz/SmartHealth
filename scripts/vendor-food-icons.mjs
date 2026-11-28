// Copia al proyecto las ilustraciones de comida de Noto Emoji (Google, licencia Apache-2.0) que usa la app, como `src/ui/food-photos/<clave>.svg`.
//
// Se hace con un script y no con la dependencia por lo mismo que `vendor-icons.mjs`: así solo viaja en la app lo que se usa, y sin internet en tiempo de ejecución.
// La licencia y la procedencia están en `src/ui/food-photos/LICENSE.txt` y en `docs/atribuciones.md`.
//
// Uso (el paquete se instala fuera del proyecto, solo para copiar los dibujos):
//   mkdir /tmp/noto && cd /tmp/noto && npm init -y && npm i @iconify-json/noto@1.2.10
//   node scripts/vendor-food-icons.mjs /tmp/noto/node_modules/@iconify-json/noto
//
// Para una ilustración nueva: añadir su clave a `KEYS` (el nombre del emoji en minúsculas, con «_»: `ear_of_corn`; en Noto es el mismo con «-»), volver a ejecutar el script y decir qué
// palabras la señalan en `src/ui/meal-icon.ts`. Una prueba (`meal-photo.test.ts`) comprueba que cada archivo lo usa algo y que no falta ninguno.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Falta la ruta a @iconify-json/noto (ver la cabecera del script)');
const out = process.argv[3] ?? 'src/ui/food-photos';

const KEYS = [
  'avocado', 'baby_bottle', 'bacon', 'bagel', 'baguette_bread', 'banana', 'beans', 'beer_mug', 'bell_pepper', 'bento_box', 'beverage_box', 'birthday_cake',
  'blueberries', 'bottle_with_popping_cork', 'bowl_with_spoon', 'bread', 'broccoli', 'bubble_tea', 'burrito', 'butter', 'candy', 'canned_food', 'carrot', 'cheese_wedge',
  'cherries', 'chestnut', 'chocolate_bar', 'cocktail_glass', 'coconut', 'cooked_rice', 'cookie', 'cooking', 'crab', 'croissant', 'cucumber', 'cup_with_straw',
  'cupcake', 'curry_rice', 'custard', 'cut_of_meat', 'dango', 'doughnut', 'droplet', 'duck', 'dumpling', 'ear_of_corn', 'egg', 'eggplant', 'falafel', 'fish',
  'fish_cake_with_swirl', 'flatbread', 'fondue', 'fork_and_knife_with_plate', 'fortune_cookie', 'french_fries', 'fried_shrimp', 'garlic', 'ginger_root', 'glass_of_milk',
  'grapes', 'green_apple', 'green_salad', 'hamburger', 'honey_pot', 'hot_beverage', 'hot_dog', 'hot_pepper', 'ice', 'ice_cream', 'kiwi_fruit', 'leafy_green',
  'lemon', 'lobster', 'lollipop', 'mango', 'mate', 'meat_on_bone', 'melon', 'moon_cake', 'mushroom', 'octopus', 'oden', 'olive', 'onion', 'oyster', 'pancakes',
  'pea_pod', 'peach', 'peanuts', 'pear', 'pie', 'pineapple', 'pizza', 'popcorn', 'pot_of_food', 'potato', 'poultry_leg', 'pretzel', 'red_apple', 'rice_ball',
  'rice_cracker', 'roasted_sweet_potato', 'sake', 'salt', 'sandwich', 'shaved_ice', 'sheaf_of_rice', 'shortcake', 'shrimp', 'soft_ice_cream', 'spaghetti',
  'squid', 'steaming_bowl', 'strawberry', 'stuffed_flatbread', 'sushi', 'takeout_box', 'tamale', 'tangerine', 'teacup_without_handle', 'teapot', 'tomato',
  'tropical_drink', 'tropical_fish', 'tumbler_glass', 'turkey', 'waffle', 'watermelon', 'wine_glass',
];

const set = JSON.parse(readFileSync(join(root, 'icons.json'), 'utf8'));
const size = set.width ?? 128;
mkdirSync(out, { recursive: true });
const missing = [];
for (const key of KEYS) {
  const icon = set.icons[key.replace(/_/g, '-')];
  if (!icon) {
    missing.push(key);
    continue;
  }
  // Con ancho y alto propios: sin ellos, una imagen SVG que solo trae `viewBox` no tiene tamaño natural y algunos sitios (carga, medidas) la ven vacía.
  const xlink = icon.body.includes('xlink:') ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '';
  writeFileSync(join(out, `${key}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"${xlink} width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${icon.body}</svg>\n`);
}
console.log(`${KEYS.length - missing.length} ilustraciones copiadas a ${out}${missing.length > 0 ? `; sin equivalente en Noto: ${missing.join(', ')}` : ''}.`);
if (missing.length > 0) process.exit(1);
