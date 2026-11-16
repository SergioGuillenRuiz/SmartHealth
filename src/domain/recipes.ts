// Recetas para comer mejor: cuando una comida poco adecuada se repite, se le proponen recetas del mismo tipo (pasta, arroz, hamburguesa, bollería…) pero más sanas y rápidas (de 3 a 20 minutos,
// con cosas de cualquier despensa). No es una dieta ni una pauta médica: son alternativas habituales.
//
// Cada receta tiene sus ingredientes **con cantidad y con un papel** (proteína, hidrato, verdura, grasa o «fijo») para poder **ajustarla al objetivo de salud** de la persona (`scaleRecipe` en
// `recipe-suggest.ts`: más verdura y menos hidrato para perder peso, más proteína e hidrato para ganar músculo…) y los **pasos con la acción que se dibuja animada** (cortar, cocer, saltear,
// hornear…: `ui/recipes/step-icon.ts`). De los ingredientes sale un texto («150 g de pechuga de pollo, 60 g de pan integral») que se pasa por la misma tabla de alimentos que el resto de la
// app, así que las calorías y la valoración que se enseñan de una receta nunca se apartan de lo que saldría si se anotara. Una prueba comprueba que se entienden enteras con cada objetivo.

/** Qué función cumple un ingrediente en el plato; decide cuánto cambia al ajustar la receta a un objetivo (el «fijo» no se toca: un huevo, una pieza de pan). */
export type Role = 'protein' | 'carb' | 'veg' | 'fat' | 'fixed';

/** Lo que se dibuja animado en un paso. */
export type CookAction = 'cut' | 'boil' | 'saute' | 'bake' | 'mix' | 'toast' | 'blend' | 'plate' | 'drain' | 'wait' | 'season' | 'spread';

/** Lo que una comida puede necesitar mejorar (y lo que arregla una receta). */
export type Need = 'salt' | 'sugar' | 'protein' | 'fiber' | 'light' | 'filling';

export interface RecipeIngredient {
  /** La cantidad para una ración, en gramos, mililitros o unidades. */
  q: number;
  unit: 'g' | 'ml' | 'ud';
  /** Cómo se llama en la lista (en singular si va en unidades). */
  name: string;
  /** Cómo lo entiende la tabla de alimentos. */
  food: string;
  role: Role;
}

export interface RecipeStep {
  text: string;
  action: CookAction;
  /** El alimento que sale en la animación del paso (sin él, el ingrediente principal de la receta). */
  item?: string;
  /** Lo que dura el paso, si es de espera o de cocción. */
  minutes?: number;
}

export interface Recipe {
  id: string;
  /** El nombre de la receta: ojo, de él sale parte de la valoración («saludable» se mira por el nombre), así que sin palabras de comida rápida, fritura o dulce. */
  title: string;
  /** Qué cambia respecto a lo habitual, en una frase. */
  change: string;
  /** Lo que se tarda en total (minutos). */
  minutes: number;
  /** Lo que mejora respecto a una versión poco sana de este tipo de plato. */
  fixes: readonly Need[];
  ingredients: readonly RecipeIngredient[];
  /** Lo que hay en casa y no suma (sal, especias, ajo…), sin cantidades. */
  pantry: readonly string[];
  steps: readonly RecipeStep[];
  /** Palabras (sin tildes, separadas por «|») del nombre de lo que sustituye mejor: esa receta va antes si se parece a la comida. */
  closeTo?: string;
  /** `false` en las bebidas sin calorías o con alcohol: la valoración por nutrientes no dice nada de ellas (no tienen proteína ni saciedad), así que no se enseña. */
  rated?: boolean;
  /**
   * `'product'`: no es una preparación sino algo que se compra hecho (una gelatina sin azúcar, un skyr, un helado proteico…): no lleva pasos y se enseña con `shop`. No todo lo que mejora una
   * comida tiene que cocinarse, ni ser un alimento perfecto: un producto de súper que encaja con lo que la persona busca es una ayuda realista.
   */
  kind?: 'product';
  /** Para un producto: qué mirar en la etiqueta o dónde está en el súper, en una frase. */
  shop?: string;
  /** Una receta salada dentro de un tipo dulce (la tostada con tomate entre las de bollería): solo se propone si de verdad se parece a la comida (`closeTo`), no a quien busca un dulce. */
  savory?: boolean;
}

export interface RecipeFamily {
  id: string;
  /** Cómo se llama este tipo de plato, en minúsculas y en singular: «pasta», «hamburguesa»… */
  label: string;
  /** Las palabras que lo señalan en el nombre de una comida (ver `domain/name-match.ts`). */
  words: string;
  /** Una bebida solo gana a otra familia si la comida no nombra nada más. */
  drink?: boolean;
  /** El grupo de `classifyName` que cae aquí si el nombre no dice nada más (ver `familyOf`). */
  group?: string;
  recipes: readonly Recipe[];
}

import { EXTRA_FAMILIES, EXTRA_RECIPES } from './recipes-more';
import { RECIPES_RONDA53 } from './recipes-ronda53';

const g = (q: number, name: string, role: Role, food: string = name): RecipeIngredient => ({ q, unit: 'g', name, food, role });
const ml = (q: number, name: string, role: Role, food: string = name): RecipeIngredient => ({ q, unit: 'ml', name, food, role });
const ud = (q: number, name: string, role: Role, food: string = name): RecipeIngredient => ({ q, unit: 'ud', name, food, role });
const step = (action: CookAction, text: string, item?: string, minutes?: number): RecipeStep => ({ action, text, ...(item !== undefined ? { item } : {}), ...(minutes !== undefined ? { minutes } : {}) });

/** Los tipos de plato y recetas de siempre; los de la ronda 35 están en `recipes-more.ts` y se juntan abajo. */
const BASE_FAMILIES: readonly RecipeFamily[] = [
  {
    id: 'pasta',
    label: 'pasta',
    words: 'pasta|espagueti|macarron|fideo|tallarin|lasana|canelon|ravioli|raviol|tortellini|gnocchi|noqui|carbonara|bolonesa|penne|fusilli|tagliatelle|spaghetti',
    recipes: [
      {
        id: 'pasta-atun-tomate',
        title: 'Pasta integral con atún y tomate',
        change: 'Misma pasta de siempre, pero integral y con atún y tomate natural: más proteína y fibra y mucha menos sal que el sobre.',
        minutes: 12,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'pasta|espagueti|macarron|spaghetti|sobre|instantanea|fideo',
        ingredients: [g(200, 'pasta integral cocida', 'carb', 'pasta integral'), g(60, 'atún al natural', 'protein'), g(150, 'tomate triturado', 'veg', 'tomate'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['ajo', 'orégano', 'una pizca de sal'],
        steps: [
          step('boil', 'Cuece la pasta en agua con sal el tiempo del paquete (unos 9 minutos).', 'pasta', 9),
          step('saute', 'Mientras, sofríe el ajo laminado con el aceite y añade el tomate triturado.', 'tomate', 4),
          step('drain', 'Escurre la pasta.', 'pasta'),
          step('mix', 'Mezcla la pasta con la salsa y el atún escurrido.', 'atún'),
          step('plate', 'Sirve con orégano por encima.', 'pasta'),
        ],
      },
      {
        id: 'fideos-pollo-verduras',
        title: 'Fideos salteados con pollo y verduras',
        change: 'En vez de fideos de sobre, fideos cocidos con pollo y verdura troceada: el mismo plato de cuchara y tenedor, con proteína y sin el sabor artificial.',
        minutes: 15,
        fixes: ['salt', 'protein', 'fiber', 'light'],
        closeTo: 'fideo|noodle|ramen|sobre|instantanea|yakisoba',
        ingredients: [g(180, 'fideos cocidos', 'carb', 'fideos'), g(100, 'pechuga de pollo', 'protein'), g(60, 'zanahoria', 'veg'), g(100, 'calabacín', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['ajo', 'jengibre', 'pimienta', 'un chorrito de salsa de soja baja en sal'],
        steps: [
          step('cut', 'Corta el pollo en tiras y la zanahoria y el calabacín en bastones finos.', 'zanahoria'),
          step('boil', 'Cuece los fideos 4 minutos y escúrrelos.', 'fideos', 4),
          step('saute', 'Dora el pollo con el aceite y el ajo 4 minutos.', 'pollo', 4),
          step('saute', 'Añade la verdura 3 minutos y, al final, los fideos con la soja.', 'calabacín', 3),
          step('plate', 'Sirve caliente con jengibre rallado.', 'fideos'),
        ],
      },
      {
        id: 'pasta-gambas-calabacin',
        title: 'Pasta con gambas, calabacín y limón',
        change: 'Una pasta ligera: la gamba pone la proteína y el calabacín el volumen, con limón en vez de salsas pesadas.',
        minutes: 14,
        fixes: ['protein', 'light', 'fiber'],
        closeTo: 'carbonara|bolonesa|lasana|canelon|tortellini|ravioli',
        ingredients: [g(160, 'pasta integral cocida', 'carb', 'pasta integral'), g(100, 'gambas', 'protein'), g(150, 'calabacín', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['ajo', 'limón', 'perejil', 'una pizca de sal'],
        steps: [
          step('boil', 'Cuece la pasta según el paquete.', 'pasta', 9),
          step('cut', 'Corta el calabacín en medias lunas finas.', 'calabacín'),
          step('saute', 'Saltea el ajo con el aceite, añade el calabacín 3 minutos y luego las gambas 2 minutos.', 'gambas', 5),
          step('mix', 'Mezcla con la pasta escurrida, ralla la piel del limón y exprime un poco.', 'pasta'),
          step('plate', 'Sirve con perejil picado.', 'gambas'),
        ],
      },
    ],
  },
  {
    id: 'sopa',
    label: 'sopa',
    words: 'sopa|ramen|noodle|caldo|crema|fideos instantaneos|maruchan|yatekomo|sopa de sobre|cup noodles',
    recipes: [
      {
        id: 'sopa-fideos-pollo',
        title: 'Sopa de fideos con pollo, huevo y verduras',
        change: 'La sopa de sobre, hecha con caldo suave, pollo, huevo y verdura: reconforta igual y sacia mucho más.',
        minutes: 15,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'sopa|ramen|noodle|sobre|caldo',
        ingredients: [ml(250, 'caldo de pollo casero', 'fixed', 'caldo'), g(100, 'fideos cocidos', 'carb', 'fideos'), g(80, 'pechuga de pollo', 'protein'), ud(1, 'huevo', 'fixed'), g(50, 'zanahoria', 'veg'), g(40, 'espinacas', 'veg')],
        pantry: ['ajo', 'pimienta', 'perejil'],
        steps: [
          step('cut', 'Corta el pollo en dados y la zanahoria en rodajas finas.', 'pollo'),
          step('boil', 'Hierve el caldo con la zanahoria y el pollo 8 minutos.', 'caldo', 8),
          step('boil', 'Añade los fideos y el huevo roto con un tenedor, removiendo, y las espinacas al final.', 'huevo', 3),
          step('plate', 'Sirve muy caliente con perejil y pimienta.', 'sopa'),
        ],
      },
      {
        id: 'crema-verduras-huevo',
        title: 'Crema de calabacín y zanahoria con huevo duro y tostada',
        change: 'Una crema casera con huevo y pan integral: caliente, rápida y con la proteína que le falta a la de sobre.',
        minutes: 18,
        fixes: ['salt', 'protein', 'fiber', 'light'],
        closeTo: 'crema|sopa|sobre|caldo',
        ingredients: [g(200, 'calabacín', 'veg'), g(80, 'zanahoria', 'veg'), g(40, 'cebolla', 'veg'), g(80, 'patata cocida', 'carb', 'patata'), ud(1, 'huevo cocido', 'fixed', 'huevo'), g(30, 'pan integral', 'fixed'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['agua', 'una pizca de sal', 'pimienta'],
        steps: [
          step('cut', 'Trocea la verdura y la patata.', 'zanahoria'),
          step('boil', 'Cuécelo todo cubierto de agua 12 minutos.', 'calabacín', 12),
          step('blend', 'Tritúralo con el aceite hasta que quede fino.', 'calabacín'),
          step('toast', 'Tuesta el pan.', 'pan'),
          step('plate', 'Sirve la crema con el huevo duro troceado y la tostada.', 'huevo'),
        ],
      },
      {
        id: 'sopa-verduras-garbanzos',
        title: 'Sopa de verduras con garbanzos y huevo',
        change: 'Una sopa que cena sola: la legumbre y el huevo ponen la proteína y la verdura, el volumen.',
        minutes: 15,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'sopa|caldo|crema|sobre',
        ingredients: [ml(250, 'caldo de verduras casero', 'fixed', 'caldo'), g(100, 'garbanzos cocidos', 'carb', 'garbanzos'), g(60, 'zanahoria', 'veg'), g(50, 'espinacas', 'veg'), ud(1, 'huevo', 'fixed')],
        pantry: ['ajo', 'pimienta', 'perejil'],
        steps: [
          step('cut', 'Corta la zanahoria en rodajas finas.', 'zanahoria'),
          step('boil', 'Hierve el caldo con la zanahoria y los garbanzos 8 minutos.', 'garbanzos', 8),
          step('boil', 'Añade las espinacas y el huevo batido en hilo, removiendo.', 'huevo', 2),
          step('plate', 'Sirve caliente con perejil.', 'caldo'),
        ],
      },
    ],
  },
  {
    id: 'arroz',
    label: 'arroz',
    words: 'arroz|paella|risotto|chaufa|tres delicias|sushi',
    recipes: [
      {
        id: 'arroz-pollo-verduras',
        title: 'Arroz integral salteado con pollo y verduras',
        change: 'Arroz integral con pollo y verdura en sartén: un plato único con más fibra y proteína que el arroz precocinado.',
        minutes: 15,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'paella|risotto',
        ingredients: [g(150, 'arroz integral cocido', 'carb', 'arroz integral'), g(100, 'pechuga de pollo', 'protein'), g(80, 'pimiento', 'veg'), g(60, 'guisantes', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['ajo', 'pimentón', 'una pizca de sal'],
        steps: [
          step('cut', 'Corta el pollo en dados y el pimiento en tiras.', 'pimiento'),
          step('saute', 'Dora el pollo con el aceite y el ajo 4 minutos.', 'pollo', 4),
          step('saute', 'Añade el pimiento y los guisantes 3 minutos.', 'guisantes', 3),
          step('mix', 'Incorpora el arroz y el pimentón y remueve 2 minutos.', 'arroz', 2),
          step('plate', 'Sirve en un bol.', 'arroz'),
        ],
      },
      {
        id: 'arroz-huevo-verduras',
        title: 'Arroz salteado con huevo, zanahoria y guisantes',
        change: 'Tu arroz tres delicias, pero casero: poco aceite, huevo en vez de jamón graso y verdura de verdad.',
        minutes: 12,
        fixes: ['salt', 'protein', 'fiber'],
        closeTo: 'tres delicias|chaufa|frito',
        ingredients: [g(150, 'arroz cocido', 'carb'), ud(2, 'huevo', 'fixed'), g(60, 'zanahoria', 'veg'), g(60, 'guisantes', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['cebolleta', 'una pizca de sal'],
        steps: [
          step('cut', 'Corta la zanahoria en dados pequeños.', 'zanahoria'),
          step('saute', 'Saltea la zanahoria y los guisantes con el aceite 4 minutos.', 'guisantes', 4),
          step('mix', 'Aparta la verdura, bate los huevos y cuájalos removiendo en la misma sartén.', 'huevo', 2),
          step('saute', 'Añade el arroz y mezcla todo 2 minutos a fuego fuerte.', 'arroz', 2),
          step('plate', 'Sirve con cebolleta picada.', 'arroz'),
        ],
      },
      {
        id: 'bol-arroz-atun',
        title: 'Bol de arroz integral con atún, aguacate y tomate',
        change: 'Un bol frío que se monta en 10 minutos con arroz ya cocido: fibra, proteína y grasa buena, sin salsas.',
        minutes: 10,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'sushi|poke|arroz',
        ingredients: [g(130, 'arroz integral cocido', 'carb', 'arroz integral'), g(60, 'atún al natural', 'protein'), g(50, 'aguacate', 'fat'), g(100, 'tomate', 'veg')],
        pantry: ['limón', 'una pizca de sal', 'pimienta'],
        steps: [
          step('cut', 'Corta el tomate y el aguacate en dados.', 'aguacate'),
          step('mix', 'Escurre el atún y mézclalo con el arroz.', 'atún'),
          step('plate', 'Monta el bol con el tomate y el aguacate por encima.', 'aguacate'),
          step('season', 'Aliña con limón, sal y pimienta.', 'limón'),
        ],
      },
    ],
  },
  {
    id: 'pizza',
    label: 'pizza',
    words: 'pizza|calzone|focaccia',
    recipes: [
      {
        id: 'pizza-wrap',
        title: 'Wrap gratinado con tomate, mozzarella y verduras',
        change: 'La masa de pizza pasa a un wrap fino y la mitad del queso se cambia por verdura.',
        minutes: 12,
        fixes: ['salt', 'light', 'fiber'],
        closeTo: 'pizza|calzone|focaccia',
        ingredients: [ud(1, 'wrap integral', 'fixed', 'wrap'), g(60, 'tomate triturado', 'veg', 'tomate'), g(40, 'mozzarella', 'protein'), g(60, 'champiñones', 'veg'), g(40, 'pimiento', 'veg')],
        pantry: ['orégano'],
        steps: [
          step('cut', 'Lamina los champiñones y corta el pimiento en tiras finas.', 'champiñones'),
          step('spread', 'Pon el wrap en una bandeja y extiende el tomate.', 'tomate'),
          step('plate', 'Reparte la verdura y la mozzarella por encima.', 'mozzarella'),
          step('bake', 'Hornea 8 minutos a 200 °C.', 'pizza', 8),
          step('season', 'Espolvorea orégano.', 'orégano'),
        ],
      },
      {
        id: 'pizza-pan-pavo',
        title: 'Tostada gratinada con tomate, pavo y mozzarella',
        change: 'Una «pizza» sobre pan integral con pavo en vez de embutido: se hace en 10 minutos y se parece mucho.',
        minutes: 10,
        fixes: ['salt', 'protein', 'fiber'],
        closeTo: 'pizza|calzone',
        ingredients: [g(70, 'pan integral', 'carb'), g(80, 'tomate triturado', 'veg', 'tomate'), g(50, 'fiambre de pavo', 'protein'), g(40, 'mozzarella', 'protein')],
        pantry: ['orégano', 'albahaca'],
        steps: [
          step('toast', 'Tuesta el pan 1 minuto por cada lado.', 'pan', 2),
          step('spread', 'Unta el tomate.', 'tomate'),
          step('plate', 'Añade el pavo y la mozzarella.', 'mozzarella'),
          step('bake', 'Gratina 5 minutos en el horno a 200 °C.', 'pizza', 5),
          step('season', 'Termina con orégano y albahaca.', 'albahaca'),
        ],
      },
      {
        id: 'pizza-berenjena',
        title: 'Berenjena al horno con tomate, pavo y mozzarella',
        change: 'La pizza sin masa: rodajas de berenjena con los mismos sabores, mucha menos harina y el doble de verdura.',
        minutes: 18,
        fixes: ['salt', 'light', 'fiber', 'protein'],
        closeTo: 'pizza|calzone|focaccia',
        ingredients: [g(200, 'berenjena', 'veg'), g(80, 'tomate triturado', 'veg', 'tomate'), g(40, 'fiambre de pavo', 'protein'), g(40, 'mozzarella', 'protein'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['orégano', 'una pizca de sal'],
        steps: [
          step('cut', 'Corta la berenjena en rodajas gruesas.', 'berenjena'),
          step('bake', 'Hornéalas 10 minutos a 200 °C con un hilo de aceite.', 'berenjena', 10),
          step('spread', 'Cúbrelas con el tomate, el pavo en trozos y la mozzarella.', 'tomate'),
          step('bake', 'Gratina 5 minutos más.', 'mozzarella', 5),
          step('season', 'Espolvorea orégano.', 'orégano'),
        ],
      },
    ],
  },
  {
    id: 'hamburguesa',
    label: 'hamburguesa',
    words: 'hamburguesa|burger|whopper|big mac|cuarto de libra|mcdonald|burger king|mcmenu|cheeseburger|mcpollo|mcchicken|taco bell|kfc',
    group: 'comida rápida',
    recipes: [
      {
        id: 'hamburguesa-pavo',
        title: 'Pan integral con carne picada de pavo y ensalada',
        change: 'La carne la haces tú a la plancha, con pan integral y mucha verdura, en vez de la de cadena con salsas y patatas.',
        minutes: 15,
        fixes: ['salt', 'light', 'protein', 'fiber'],
        closeTo: 'hamburguesa|burger|whopper|big mac|mcdonald|cuarto de libra',
        ingredients: [g(150, 'carne picada de pavo', 'protein'), g(60, 'pan integral', 'carb'), ud(1, 'tomate', 'veg'), g(40, 'lechuga', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['sal', 'pimienta'],
        steps: [
          step('mix', 'Mezcla la carne con sal y pimienta y forma una hamburguesa.', 'pavo'),
          step('saute', 'Dórala 4 minutos por lado en una sartén con el aceite.', 'pavo', 8),
          step('toast', 'Tuesta el pan 1 minuto.', 'pan', 1),
          step('plate', 'Monta con tomate en rodajas y lechuga.', 'lechuga'),
        ],
      },
      {
        id: 'hamburguesa-pollo-aguacate',
        title: 'Hamburguesa de pollo con aguacate y ensalada',
        change: 'Pollo picado en casa y aguacate en vez de queso fundido y salsa: grasa buena y mucha menos sal.',
        minutes: 15,
        fixes: ['salt', 'light', 'protein'],
        closeTo: 'pollo|mcpollo|mcchicken|kfc|burger king',
        ingredients: [g(150, 'pechuga de pollo picada', 'protein', 'pechuga de pollo'), g(60, 'pan integral', 'carb'), g(40, 'aguacate', 'fat'), g(40, 'lechuga', 'veg'), ud(1, 'tomate', 'veg')],
        pantry: ['ajo en polvo', 'sal', 'pimienta'],
        steps: [
          step('cut', 'Pica la pechuga con un cuchillo o en la picadora.', 'pollo'),
          step('mix', 'Mézclala con ajo en polvo, sal y pimienta y dale forma de hamburguesa.', 'pollo'),
          step('saute', 'Dórala 5 minutos por lado en la sartén, sin aceite.', 'pollo', 10),
          step('plate', 'Monta con el pan tostado, el aguacate aplastado, la lechuga y el tomate.', 'aguacate'),
        ],
      },
      {
        id: 'bol-hamburguesa',
        title: 'Hamburguesa de ternera con huevo, ensalada y patata al horno',
        change: 'La hamburguesa «sin pan»: el hidrato lo pone una patata asada, y el huevo y la ensalada completan el plato.',
        minutes: 20,
        fixes: ['salt', 'fiber', 'filling'],
        closeTo: 'burger king|whopper|cuarto de libra',
        ingredients: [g(130, 'carne picada de ternera', 'protein', 'carne picada'), ud(1, 'huevo', 'fixed'), g(150, 'patata asada', 'carb'), g(60, 'lechuga', 'veg'), ud(1, 'tomate', 'veg')],
        pantry: ['sal', 'pimienta', 'pimentón'],
        steps: [
          step('bake', 'Hornea la patata en gajos con pimentón 20 minutos a 200 °C.', 'patata', 20),
          step('saute', 'Dora la hamburguesa de ternera 4 minutos por lado.', 'ternera', 8),
          step('saute', 'Haz el huevo a la plancha.', 'huevo', 2),
          step('plate', 'Sirve todo con la ensalada.', 'lechuga'),
        ],
      },
    ],
  },
  {
    id: 'kebab',
    label: 'kebab',
    words: 'kebab|durum|shawarma|doner|gyros|falafel',
    recipes: [
      {
        id: 'wrap-pollo-yogur',
        title: 'Wrap de pollo a la plancha con yogur y verduras',
        change: 'La carne de kebab pasa a pechuga a la plancha y la salsa, a yogur natural con limón.',
        minutes: 15,
        fixes: ['salt', 'light', 'protein'],
        closeTo: 'kebab|durum|shawarma|doner',
        ingredients: [g(120, 'pechuga de pollo', 'protein'), ud(1, 'wrap integral', 'fixed', 'wrap'), g(50, 'yogur natural', 'fixed'), g(40, 'lechuga', 'veg'), ud(1, 'tomate', 'veg')],
        pantry: ['limón', 'comino', 'sal'],
        steps: [
          step('season', 'Sazona el pollo en tiras con comino y sal.', 'pollo'),
          step('saute', 'Dóralo 5 minutos en la plancha.', 'pollo', 5),
          step('mix', 'Mezcla el yogur con unas gotas de limón.', 'yogur'),
          step('plate', 'Rellena el wrap con el pollo, la verdura y la salsa y enróllalo.', 'wrap'),
        ],
      },
      {
        id: 'bol-pollo-yogur',
        title: 'Bol de pollo especiado con arroz, pepino y yogur',
        change: 'Los sabores del kebab en un bol ligero: pollo, arroz, pepino fresco y una salsa de yogur.',
        minutes: 15,
        fixes: ['salt', 'light', 'protein', 'fiber'],
        closeTo: 'falafel|gyros|shawarma',
        ingredients: [g(130, 'pechuga de pollo', 'protein'), g(100, 'arroz cocido', 'carb'), g(80, 'yogur natural', 'fixed'), g(80, 'pepino', 'veg'), g(60, 'tomate', 'veg')],
        pantry: ['pimentón', 'comino', 'limón', 'una pizca de sal'],
        steps: [
          step('season', 'Sazona el pollo troceado con pimentón, comino y sal.', 'pollo'),
          step('saute', 'Dóralo 6 minutos en la sartén.', 'pollo', 6),
          step('cut', 'Corta el pepino y el tomate.', 'pepino'),
          step('mix', 'Mezcla el yogur con limón.', 'yogur'),
          step('plate', 'Monta el bol: arroz, pollo, verdura y la salsa por encima.', 'arroz'),
        ],
      },
      {
        id: 'plato-pollo-especiado',
        title: 'Pollo especiado con ensalada, yogur y pan integral',
        change: 'El kebab desmontado en el plato: pollo a la plancha, ensalada fresca, salsa de yogur y un poco de pan.',
        minutes: 15,
        fixes: ['salt', 'light', 'protein', 'fiber'],
        closeTo: 'kebab|durum|doner|gyros',
        ingredients: [g(130, 'pechuga de pollo', 'protein'), g(50, 'pan integral', 'carb'), g(60, 'yogur natural', 'fixed'), g(100, 'tomate', 'veg'), g(60, 'pepino', 'veg')],
        pantry: ['comino', 'pimentón', 'limón', 'una pizca de sal'],
        steps: [
          step('season', 'Sazona el pollo en tiras con comino, pimentón y sal.', 'pollo'),
          step('saute', 'Dóralo 6 minutos en la plancha.', 'pollo', 6),
          step('cut', 'Corta el tomate y el pepino.', 'tomate'),
          step('mix', 'Mezcla el yogur con limón.', 'yogur'),
          step('plate', 'Sirve todo junto con el pan tostado.', 'pollo'),
        ],
      },
    ],
  },
  {
    id: 'bocadillo',
    label: 'bocadillo',
    words: 'bocadillo|bocata|sandwich|hot dog|perrito caliente|chorizo|salchichon|fuet|sobrasada|bacon|panceta|mortadela|salchicha|embutido|jamon york|montadito|serranito',
    group: 'embutido',
    recipes: [
      {
        id: 'bocadillo-pavo',
        title: 'Pan integral con pavo en lonchas y tomate',
        change: 'El embutido graso pasa a pavo bajo en grasa, con tomate.',
        minutes: 5,
        fixes: ['salt', 'light', 'fiber'],
        closeTo: 'chorizo|salchichon|bocadillo|fuet|sobrasada|mortadela|bacon|panceta|salchicha|embutido',
        ingredients: [g(60, 'pan integral', 'carb'), g(60, 'fiambre de pavo', 'protein'), ud(1, 'tomate', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['una pizca de sal'],
        steps: [
          step('toast', 'Tuesta el pan.', 'pan'),
          step('spread', 'Ralla el tomate sobre el pan con un hilo de aceite.', 'tomate'),
          step('plate', 'Añade el pavo.', 'pavo'),
        ],
      },
      {
        id: 'sandwich-atun-huevo',
        title: 'Sándwich integral de atún, huevo y lechuga',
        change: 'Un sándwich que sacia más y lleva la mitad de sal: atún y huevo en vez de embutido, con yogur en lugar de mayonesa.',
        minutes: 12,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'sandwich|hot dog|perrito|montadito',
        ingredients: [g(70, 'pan integral', 'carb'), g(60, 'atún al natural', 'protein'), ud(1, 'huevo cocido', 'fixed', 'huevo'), g(30, 'lechuga', 'veg'), g(20, 'yogur natural', 'fixed')],
        pantry: ['pimienta', 'limón'],
        steps: [
          step('boil', 'Cuece el huevo 10 minutos (puedes hacerlo de antemano).', 'huevo', 10),
          step('mix', 'Machaca el huevo con el atún escurrido y el yogur.', 'atún'),
          step('toast', 'Tuesta el pan.', 'pan'),
          step('plate', 'Monta con la lechuga y la mezcla.', 'lechuga'),
        ],
      },
      {
        id: 'tortilla-pavo-espinacas',
        title: 'Tortilla francesa de 2 huevos con pavo, espinacas y pan integral',
        change: 'La proteína viene del huevo y el pavo, las espinacas sacian y el pan integral pone el hidrato.',
        minutes: 8,
        fixes: ['salt', 'protein', 'filling'],
        closeTo: 'bacon|panceta|jamon york|salchicha|embutido|fuet',
        ingredients: [ud(2, 'huevo', 'fixed'), g(40, 'fiambre de pavo', 'protein'), g(40, 'espinacas', 'veg'), g(30, 'pan integral', 'carb'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['una pizca de sal'],
        steps: [
          step('mix', 'Bate los huevos con sal.', 'huevo'),
          step('saute', 'Saltea las espinacas 1 minuto y añade el pavo en trozos.', 'espinacas', 1),
          step('saute', 'Echa el huevo y cuaja la tortilla por los dos lados.', 'huevo', 3),
          step('plate', 'Sirve con el pan.', 'pan'),
        ],
      },
    ],
  },
  {
    id: 'dulce',
    label: 'dulce',
    words:
      'bolleria|croissant|napolitana|donut|dona|magdalena|palmera|bizcocho|galleta|cereales|bollo|ensaimada|barrita|pastel|muffin|gofre|tarta|helado|chocolate|chocolatina|chuche|golosina|caramelo|gominola|flan|natilla|nutella|nocilla|mermelada|churro|postre|brownie|cookie|turron|polvoron|dulce|bunuelo|torrija|rosquilla|roscon|pestino|mantecado|mazapan|sobao|berlina|cruasan|tiramisu|profiterol|eclair|mousse|arroz con leche|cuajada|sorbete|polo|crepe dulce|crema catalana|panna cotta|trufa|bombon|lacasitos|conguito|kitkat|bounty|twix|snickers|mars',
    group: 'bollería y dulce',
    recipes: [
      {
        id: 'tostada-tomate',
        savory: true,
        title: 'Tostada integral con tomate y aceite de oliva',
        change: 'Del bollo o la galleta a una tostada salada: más saciante y casi sin azúcar.',
        minutes: 5,
        fixes: ['sugar', 'fiber', 'filling'],
        closeTo: 'croissant|napolitana|bolleria|donut|magdalena|palmera|bizcocho|galleta|bollo|ensaimada',
        ingredients: [g(60, 'pan integral', 'carb'), ud(1, 'tomate', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['una pizca de sal'],
        steps: [step('toast', 'Tuesta el pan.', 'pan', 2), step('cut', 'Ralla el tomate.', 'tomate'), step('spread', 'Repártelo por el pan.', 'tomate'), step('season', 'Añade el aceite y una pizca de sal.', 'aceite')],
      },
      {
        id: 'yogur-avena-platano',
        title: 'Yogur natural con copos de avena y plátano',
        change: 'Sigue siendo dulce, pero el azúcar viene de la fruta y la avena da saciedad.',
        minutes: 3,
        fixes: ['sugar', 'fiber', 'filling'],
        closeTo: 'flan|natilla|postre|tarta|pastel|dulce|chuche|cereales',
        ingredients: [g(125, 'yogur natural', 'protein'), g(30, 'copos de avena', 'carb', 'avena'), ud(1, 'plátano', 'fixed')],
        pantry: ['canela'],
        steps: [step('plate', 'Pon el yogur en un bol.', 'yogur'), step('cut', 'Corta el plátano en rodajas.', 'plátano'), step('mix', 'Añade la avena y el plátano.', 'avena'), step('season', 'Espolvorea canela.', 'canela')],
      },
      {
        id: 'tostada-cacahuete-fresas',
        title: 'Tostada integral con crema de cacahuete y fresas',
        change: 'Mantienes el capricho dulce con grasa buena y fruta, en vez de bollería industrial.',
        minutes: 5,
        fixes: ['sugar', 'protein', 'fiber'],
        closeTo: 'nutella|nocilla|crema de cacao|mermelada|churro|croissant',
        ingredients: [g(30, 'pan integral', 'carb'), g(15, 'crema de cacahuete', 'fat', 'crema de cacahuete'), g(80, 'fresas', 'veg')],
        pantry: [],
        steps: [step('toast', 'Tuesta el pan.', 'pan', 2), step('spread', 'Unta la crema de cacahuete.', 'cacahuete'), step('cut', 'Lamina las fresas.', 'fresas'), step('plate', 'Corona con las fresas.', 'fresas')],
      },
      {
        id: 'tortitas-avena-platano',
        title: 'Tortitas de avena y plátano',
        change: 'Un desayuno de bollería sin azúcar añadido: tres ingredientes, una sartén y diez minutos.',
        minutes: 10,
        fixes: ['sugar', 'protein', 'fiber', 'filling'],
        closeTo: 'bunuelo|torrija|rosquilla|pestino|churro|crepe|gofre|pancake|tortita|bizcocho|magdalena|muffin|croissant|cereales',
        ingredients: [g(40, 'copos de avena', 'carb', 'avena'), ud(1, 'plátano', 'fixed'), ud(1, 'huevo', 'fixed'), g(60, 'fresas', 'veg')],
        pantry: ['canela'],
        steps: [
          step('mix', 'Aplasta el plátano con un tenedor y mézclalo con el huevo y la avena.', 'plátano'),
          step('saute', 'Cuece cucharadas de masa en una sartén antiadherente 2 minutos por lado.', 'avena', 4),
          step('plate', 'Sirve con las fresas y canela.', 'fresas'),
        ],
      },
      {
        id: 'queso-batido-cacao',
        title: 'Queso batido con cacao puro y fresas',
        change: 'El postre de chocolate hecho con proteína: cacao puro y fruta en lugar de crema de cacao.',
        minutes: 3,
        fixes: ['sugar', 'protein', 'filling'],
        closeTo: 'helado|chocolate|chocolatina|nocilla|nutella|flan|natilla|postre|brownie|tarta|pastel|bombon',
        ingredients: [g(125, 'queso fresco batido', 'protein'), g(8, 'cacao en polvo', 'fixed', 'cacao puro'), g(100, 'fresas', 'veg')],
        pantry: ['canela'],
        steps: [step('mix', 'Mezcla el queso batido con el cacao.', 'queso'), step('cut', 'Corta las fresas.', 'fresas'), step('plate', 'Sirve con las fresas por encima.', 'fresas')],
      },
      {
        id: 'platano-chocolate-nueces',
        title: 'Plátano con chocolate negro y nueces',
        change: 'Un capricho de chocolate pequeño y con sentido: negro, con fruta y frutos secos.',
        minutes: 3,
        fixes: ['sugar', 'fiber', 'filling'],
        closeTo: 'chocolate|chocolatina|bombon|caramelo|chuche|golosina|gominola|turron|polvoron',
        ingredients: [ud(1, 'plátano', 'fixed'), g(20, 'chocolate negro', 'fat'), g(15, 'nueces', 'fat')],
        pantry: [],
        steps: [step('cut', 'Corta el plátano en rodajas.', 'plátano'), step('cut', 'Trocea el chocolate y las nueces.', 'nueces'), step('plate', 'Mézclalo todo en un bol.', 'plátano')],
      },
      {
        id: 'manzana-asada-yogur',
        title: 'Manzana asada con canela y yogur',
        change: 'Caliente, dulce y con su toque de canela, como un postre de sartén, pero con el azúcar de la fruta y la proteína del yogur.',
        minutes: 8,
        fixes: ['sugar', 'fiber', 'filling'],
        closeTo: 'bunuelo|torrija|rosquilla|pestino|crepe|tarta|pastel|arroz con leche|tiramisu|profiterol|eclair|mazapan|sobao',
        ingredients: [ud(1, 'manzana', 'fixed'), g(125, 'yogur natural', 'protein'), g(10, 'nueces', 'fat')],
        pantry: ['canela'],
        steps: [
          step('cut', 'Lava la manzana, quítale el corazón y córtala en gajos.', 'manzana'),
          step('bake', 'Ponla en un plato con canela y caliéntala en el microondas 3 minutos (o en el horno, 12).', 'manzana', 3),
          step('plate', 'Sírvela con el yogur y las nueces troceadas por encima.', 'yogur'),
        ],
      },
      {
        id: 'gelatina-sin-azucar',
        kind: 'product',
        title: 'Gelatina sin azúcar',
        change: 'No es un alimento perfecto, pero sí un capricho realista: llena el hueco del dulce con casi cero calorías, sin azúcar ni grasa, y la tienes siempre lista en la nevera.',
        shop: 'Busca «sin azúcar» o «light» en la etiqueta: cada vasito trae unas 10 kcal.',
        minutes: 0,
        fixes: ['sugar', 'light'],
        // Con 16 kcal la valoración por nutrientes no dice nada (ni proteína ni saciedad que medir): se enseñan las calorías y no el nivel.
        rated: false,
        closeTo: 'bunuelo|flan|natilla|postre|chuche|golosina|gominola|caramelo|mousse|dulce|torrija|pestino|rosquilla',
        ingredients: [ud(2, 'vasito de gelatina sin azúcar', 'fixed', 'gelatina sin azúcar')],
        pantry: [],
        steps: [],
      },
      {
        id: 'skyr-natural',
        kind: 'product',
        title: 'Skyr natural (yogur alto en proteínas)',
        change: 'Cremoso como un postre, con el doble de proteína que un yogur normal y casi sin azúcar: sacia mucho más que un bollo y no hay que preparar nada.',
        shop: 'Mejor el natural o el «sin azúcares añadidos»: cada tarrina trae unos 15 g de proteína.',
        minutes: 0,
        fixes: ['sugar', 'protein', 'filling'],
        closeTo: 'yogur|natilla|flan|cuajada|postre|cheesecake|tarta de queso|mousse|crema|nata',
        ingredients: [g(150, 'skyr', 'fixed')],
        pantry: [],
        steps: [],
      },
      {
        id: 'helado-proteico',
        kind: 'product',
        title: 'Tarrina congelada proteica',
        change: 'Un helado de verdad, pero con la mitad de calorías y de azúcar y con proteína: lo tienes en la sección de congelados del súper.',
        shop: 'Busca los «proteicos» o «sin azúcar añadido»: unas 100 kcal por ración.',
        minutes: 0,
        fixes: ['sugar', 'light', 'protein'],
        closeTo: 'helado|magnum|cornetto|gelato|sorbete|cucurucho|tarrina|polo',
        ingredients: [g(100, 'helado proteico', 'fixed')],
        pantry: [],
        steps: [],
      },
      {
        id: 'cuajada-natural',
        kind: 'product',
        title: 'Cuajada natural con canela',
        change: 'La textura de una natilla pero sin el azúcar: es leche cuajada, con proteína y poco más. Un postre de toda la vida que se compra hecho.',
        shop: 'Natural y sin azúcar añadido (también la hay desnatada); la canela es opcional.',
        minutes: 0,
        fixes: ['sugar', 'protein'],
        closeTo: 'natilla|flan|arroz con leche|postre|tarta de queso|cheesecake|crema catalana|mousse|panna cotta',
        ingredients: [ud(1, 'cuajada', 'fixed')],
        pantry: ['canela'],
        steps: [],
      },
    ],
  },
  {
    id: 'snack',
    label: 'snack',
    words: 'patatas fritas de bolsa|patatas de bolsa|bolsa de patatas|patatas chips|chips|lays|ruffles|ganchitos|doritos|cheetos|pringles|nachos|snack|aperitivo|palomitas|cortezas|tortilla de maiz',
    group: 'snack o fritura',
    recipes: [
      {
        id: 'garbanzos-crujientes',
        title: 'Garbanzos tostados en sartén con pimentón',
        change: 'Siguen siendo algo crujiente para picar, pero con fibra y proteína en vez de grasa y sal.',
        minutes: 10,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'patatas fritas|patatas de bolsa|chips|doritos|cheetos|pringles|nachos|snack|ganchitos|aperitivo',
        ingredients: [g(150, 'garbanzos cocidos', 'carb', 'garbanzos'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['pimentón', 'una pizca de sal'],
        steps: [
          step('drain', 'Escurre y seca bien los garbanzos con papel de cocina.', 'garbanzos'),
          step('saute', 'Tuéstalos en la sartén con el aceite a fuego medio-alto 8 minutos, moviéndolos, hasta que estén crujientes.', 'garbanzos', 8),
          step('season', 'Échales el pimentón y la sal al final.', 'pimentón'),
        ],
      },
      {
        id: 'zanahoria-hummus',
        title: 'Bastones de zanahoria con hummus',
        change: 'Se moja y se come con las manos igual que el snack, pero con fibra y proteína.',
        minutes: 5,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        closeTo: 'snack|patatas|chips|aperitivo|tortilla de maiz|nachos',
        ingredients: [g(150, 'zanahoria', 'veg'), g(50, 'hummus', 'protein')],
        pantry: ['pimentón'],
        steps: [step('cut', 'Pela la zanahoria y córtala en bastones.', 'zanahoria'), step('plate', 'Pon el hummus en un cuenco con un poco de pimentón.', 'hummus')],
      },
      {
        id: 'frutos-secos-fruta',
        title: 'Un puñado de frutos secos al natural con una pieza de fruta',
        change: 'Más saciante y con grasas buenas, midiendo el puñado.',
        minutes: 2,
        fixes: ['salt', 'fiber', 'filling'],
        ingredients: [g(25, 'almendras', 'fat'), ud(1, 'manzana', 'fixed')],
        pantry: [],
        steps: [step('plate', 'Cuenta un puñado pequeño (25 g).', 'almendras'), step('cut', 'Acompáñalo con la manzana en gajos.', 'manzana')],
      },
      {
        id: 'palomitas-al-natural',
        kind: 'product',
        title: 'Palomitas al natural, sin aceite',
        change: 'Crujen y se pican igual que las patatas de bolsa, pero un puñado grande son 100 kcal, con fibra y sin grasa ni sal de más.',
        shop: 'Busca «al natural», «sin aceite» o «al aire»: sin mantequilla ni caramelo.',
        minutes: 0,
        fixes: ['salt', 'light', 'fiber'],
        closeTo: 'palomitas|patatas|chips|snack|ganchitos|doritos|cheetos|pringles|nachos|aperitivo|cortezas',
        ingredients: [g(30, 'palomitas al natural', 'fixed', 'palomitas naturales')],
        pantry: [],
        steps: [],
      },
      {
        id: 'edamame-bolsa',
        kind: 'product',
        title: 'Edamame al vapor (bolsa lista)',
        change: 'Un picoteo salado para hacer con las manos, con proteína y fibra de verdad, que se calienta en el microondas en un minuto.',
        shop: 'En la zona de verdura envasada o de congelados; mejor sin sal añadida.',
        minutes: 0,
        fixes: ['protein', 'fiber', 'filling', 'light'],
        closeTo: 'patatas|chips|snack|ganchitos|doritos|cheetos|pringles|nachos|aperitivo|cortezas|palomitas',
        ingredients: [g(100, 'edamame', 'fixed')],
        pantry: [],
        steps: [],
      },
    ],
  },
  {
    id: 'fritura',
    label: 'fritura',
    words: 'frito|empanado|rebozado|croqueta|nugget|tempura|alitas|bravas|calamares|romana|san jacobo|milanesa|escalope|patatas fritas|papas fritas|bunuelos de bacalao|bunuelos salados|bunuelos de queso|bolitas de queso',
    group: 'fritura',
    recipes: [
      {
        id: 'pollo-avena-horno',
        title: 'Pollo con copos de avena al horno',
        change: 'El rebozado se hace con avena y se hornea en vez de freírse.',
        minutes: 20,
        fixes: ['light', 'fiber', 'protein'],
        closeTo: 'empanado|rebozado|nugget|escalope|milanesa|san jacobo|pollo frito|crujiente|alitas',
        ingredients: [g(150, 'pechuga de pollo', 'protein'), ud(1, 'huevo', 'fixed'), g(30, 'copos de avena', 'carb', 'avena'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['ajo en polvo', 'pimentón', 'sal'],
        steps: [
          step('cut', 'Corta la pechuga en filetes finos.', 'pollo'),
          step('mix', 'Pasa los filetes por el huevo batido y luego por la avena con las especias.', 'huevo'),
          step('bake', 'Hornea 15 minutos a 200 °C en una bandeja con el aceite, dándoles la vuelta a la mitad.', 'pollo', 15),
        ],
      },
      {
        id: 'patatas-horno-huevo',
        title: 'Patatas doradas con pimentón y huevo cocido',
        change: 'Se cuecen y se doran con un hilo de aceite en vez de freírse, y el huevo les da la proteína que no tienen.',
        minutes: 20,
        fixes: ['light', 'protein', 'filling'],
        closeTo: 'patatas|bravas|papas|churros',
        ingredients: [g(250, 'patatas', 'carb', 'patata cocida'), ud(1, 'huevo cocido', 'fixed', 'huevo'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['pimentón', 'sal'],
        steps: [
          step('cut', 'Corta las patatas en dados pequeños, con piel.', 'patata'),
          step('boil', 'Cuécelas con el huevo 10 minutos y escúrrelas.', 'patata', 10),
          step('saute', 'Dóralas 6 minutos en la sartén con el aceite, el pimentón y la sal.', 'patata', 6),
          step('plate', 'Sirve con el huevo cocido troceado.', 'huevo'),
        ],
      },
      {
        id: 'calamares-plancha',
        title: 'Calamares a la plancha con limón y perejil',
        change: 'A la plancha en vez de a la romana: la misma comida de bar sin freír.',
        minutes: 10,
        fixes: ['light', 'protein'],
        closeTo: 'calamares|rabas|croquetas|frito|romana|tempura',
        ingredients: [g(200, 'calamares', 'protein'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['ajo', 'perejil', 'limón'],
        steps: [step('saute', 'Calienta la plancha con el aceite y dora los calamares 3 minutos por lado.', 'calamares', 6), step('season', 'Sirve con ajo y perejil picados y limón.', 'limón')],
      },
    ],
  },
  {
    id: 'bebida',
    label: 'bebida azucarada',
    words: 'refresco|cola|coca-cola|coca cola|fanta|sprite|pepsi|tonica|gaseosa|energetica|isotonico|nestea|aquarius|monster|redbull|red bull',
    drink: true,
    group: 'bebida azucarada',
    recipes: [
      {
        id: 'agua-gas-limon',
        title: 'Agua con gas, limón y hielo',
        change: 'Mismo burbujeo, sin azúcar.',
        minutes: 1,
        fixes: ['sugar'],
        rated: false,
        ingredients: [ml(300, 'agua con gas', 'fixed', 'agua'), g(10, 'limón', 'fixed')],
        pantry: ['hielo'],
        steps: [step('plate', 'Llena un vaso con hielo y agua con gas.', 'agua'), step('season', 'Exprime un poco de limón y deja la rodaja dentro.', 'limón')],
      },
      {
        id: 'te-frio-menta',
        title: 'Té frío casero con limón y menta',
        change: 'Sabor y frescor, sin azúcar añadido.',
        minutes: 5,
        fixes: ['sugar'],
        rated: false,
        ingredients: [ml(300, 'té', 'fixed'), g(10, 'limón', 'fixed')],
        pantry: ['menta', 'hielo'],
        steps: [step('boil', 'Infusiona la bolsita de té 4 minutos y retírala.', 'té', 4), step('wait', 'Deja enfriar.', 'té', 5), step('plate', 'Añade limón, menta y hielo.', 'limón')],
      },
      {
        id: 'refresco-zero',
        kind: 'product',
        title: 'Refresco sin azúcar (zero)',
        change: 'El mismo sabor y las mismas burbujas, sin azúcar. No es agua, pero para quien no quiere dejar el refresco es el cambio más fácil y realista.',
        shop: 'Busca «zero», «sin azúcar» o «light»: sin calorías.',
        minutes: 0,
        fixes: ['sugar'],
        rated: false,
        closeTo: 'cola|coca|fanta|sprite|pepsi|refresco|nestea|aquarius|tonica|gaseosa',
        ingredients: [ml(330, 'refresco zero', 'fixed', 'refresco light')],
        pantry: ['hielo'],
        steps: [],
      },
    ],
  },
  {
    id: 'zumo',
    label: 'zumo o batido',
    words: 'zumo|jugo|batido|smoothie',
    drink: true,
    group: 'zumo o batido',
    recipes: [
      {
        id: 'fruta-entera',
        title: 'La fruta entera con un vaso de agua',
        change: 'Con la fruta entera se conserva la fibra y se come más despacio.',
        minutes: 2,
        fixes: ['sugar', 'fiber', 'filling'],
        closeTo: 'zumo|jugo|naranja',
        ingredients: [ud(2, 'naranja', 'fixed')],
        pantry: ['un vaso de agua'],
        steps: [step('cut', 'Pela la fruta y sepárala en gajos.', 'naranja')],
      },
      {
        id: 'batido-yogur-fresas',
        title: 'Batido de yogur griego y frutos rojos sin azúcar añadido',
        change: 'La fruta y el yogur dan el dulzor y la proteína que le faltan al batido.',
        minutes: 5,
        fixes: ['sugar', 'protein', 'filling'],
        closeTo: 'batido|smoothie|zumo',
        ingredients: [g(170, 'yogur griego desnatado', 'protein'), g(100, 'fresas', 'fixed'), ml(100, 'leche desnatada', 'fixed')],
        pantry: ['hielo'],
        steps: [step('blend', 'Pon todo en el vaso de la batidora y tritura 30 segundos.', 'fresas', 1), step('plate', 'Sirve frío.', 'yogur')],
      },
    ],
  },
  {
    id: 'alcohol',
    label: 'bebida con alcohol',
    words: 'cerveza|vino|sangria|licor|cubata|whisky|ginebra|vodka|ron|champan|cava|vermut|alcohol|tinto de verano',
    drink: true,
    group: 'alcohol',
    recipes: [
      {
        id: 'cerveza-sin',
        title: 'Cerveza sin alcohol con unas aceitunas',
        change: 'Misma ocasión y mismo vaso, sin el alcohol.',
        minutes: 2,
        fixes: [],
        rated: false,
        closeTo: 'cerveza|cana|tercio|birra',
        ingredients: [ml(330, 'cerveza sin alcohol', 'fixed'), g(30, 'aceitunas', 'fixed')],
        pantry: [],
        steps: [step('plate', 'Sírvela bien fría y acompaña con las aceitunas.', 'cerveza')],
      },
      {
        id: 'soda-limon-vino',
        title: 'Vaso largo de soda con limón y un chorrito de vino',
        change: 'Menos vino y más soda: un vaso largo que dura más con mucho menos alcohol.',
        minutes: 2,
        fixes: [],
        rated: false,
        closeTo: 'vino|tinto|sangria|vermut|cava',
        ingredients: [ml(50, 'vino tinto', 'fixed'), ml(200, 'agua con gas', 'fixed', 'agua')],
        pantry: ['hielo', 'limón'],
        steps: [step('plate', 'Pon hielo en un vaso largo, añade el vino y completa con la soda.', 'vino'), step('season', 'Exprime limón.', 'limón')],
      },
    ],
  },
  {
    id: 'general',
    label: 'plato',
    words: '',
    recipes: [
      {
        id: 'pollo-plancha-ensalada',
        title: 'Pechuga de pollo a la plancha con ensalada y patata cocida',
        change: 'Un plato de proteína, verdura y un hidrato sencillo, sin salsas ni fritos.',
        minutes: 20,
        fixes: ['salt', 'protein', 'light', 'filling'],
        ingredients: [g(150, 'pechuga de pollo', 'protein'), g(150, 'patata cocida', 'carb', 'patata cocida'), g(100, 'lechuga', 'veg'), ud(1, 'tomate', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['limón', 'una pizca de sal'],
        steps: [
          step('boil', 'Cuece la patata 15 minutos.', 'patata', 15),
          step('saute', 'Dora la pechuga en la plancha 4 minutos por lado.', 'pollo', 8),
          step('cut', 'Prepara la ensalada y aliña con aceite, limón y sal.', 'lechuga'),
          step('plate', 'Sirve todo junto.', 'pollo'),
        ],
      },
      {
        id: 'revuelto-verduras',
        title: 'Revuelto de verduras con huevos y pan integral',
        change: 'Se cocina en 10 minutos con lo que haya en la nevera y llena más con menos calorías.',
        minutes: 10,
        fixes: ['salt', 'protein', 'fiber', 'light'],
        ingredients: [ud(2, 'huevo', 'fixed'), g(100, 'calabacín', 'veg'), g(60, 'champiñones', 'veg'), g(30, 'pan integral', 'carb'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['una pizca de sal'],
        steps: [
          step('cut', 'Trocea el calabacín y los champiñones.', 'calabacín'),
          step('saute', 'Saltea la verdura 4 minutos.', 'champiñones', 4),
          step('mix', 'Añade los huevos batidos y remueve hasta que cuajen.', 'huevo', 2),
          step('plate', 'Sirve con el pan.', 'pan'),
        ],
      },
      {
        id: 'ensalada-garbanzos-atun',
        title: 'Ensalada templada de garbanzos con atún y tomate',
        change: 'Legumbre y proteína en un plato frío que se hace en 5 minutos con conservas.',
        minutes: 5,
        fixes: ['salt', 'protein', 'fiber', 'filling'],
        ingredients: [g(150, 'garbanzos cocidos', 'carb', 'garbanzos'), g(60, 'atún al natural', 'protein'), ud(1, 'tomate', 'veg'), g(5, 'aceite de oliva', 'fat')],
        pantry: ['cebolla', 'perejil', 'limón'],
        steps: [
          step('drain', 'Escurre los garbanzos y el atún.', 'garbanzos'),
          step('cut', 'Pica el tomate y la cebolla.', 'tomate'),
          step('mix', 'Mezcla todo y aliña con aceite y limón.', 'garbanzos'),
        ],
      },
    ],
  },
];

/**
 * Todos los tipos de plato, con sus recetas: las de siempre y, DESPUÉS de ellas (para que lo que ya salía primero siga saliendo primero), las de `recipes-more.ts`. Los tipos nuevos van antes del
 * general, que es el que se usa cuando ninguno encaja.
 */
const withExtras = (family: RecipeFamily): RecipeFamily => ({ ...family, recipes: [...family.recipes, ...(EXTRA_RECIPES[family.id] ?? [])] });
/** Lo de la ronda 53 (más productos de súper y alguna receta más) va al final de cada tipo, tras lo de siempre. */
const withMore = (family: RecipeFamily): RecipeFamily => ({ ...family, recipes: [...family.recipes, ...(RECIPES_RONDA53[family.id] ?? [])] });
export const RECIPE_FAMILIES: readonly RecipeFamily[] = [
  ...BASE_FAMILIES.filter((family) => family.id !== 'general').map(withExtras),
  ...EXTRA_FAMILIES,
  ...BASE_FAMILIES.filter((family) => family.id === 'general').map(withExtras),
].map(withMore);
