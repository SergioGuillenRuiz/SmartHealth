// Copia al proyecto los iconos de Tabler (MIT) que usa la app, en `src/ui/icon-set.ts`.
//
// Se hace con un script y no con la dependencia porque `@tabler/icons-preact` declara `preact@^10` como peer y el proyecto
// usa Preact 11 (npm se niega a instalarla sin forzar), y porque así solo viaja en la app lo que se usa.
//
// Uso (el paquete se instala fuera del proyecto, solo para copiar los iconos):
//   mkdir /tmp/tabler && cd /tmp/tabler && npm init -y && npm i --legacy-peer-deps @tabler/icons-preact@3.49.0
//   node scripts/vendor-icons.mjs /tmp/tabler/node_modules/@tabler/icons-preact
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Falta la ruta a @tabler/icons-preact (ver la cabecera del script)');

// nombre en la app → nombre del icono en Tabler (sin el prefijo «Icon»)
const ICONS = {
  walk: 'Walk',
  run: 'Run',
  bike: 'Bike',
  trekking: 'Trekking',
  swimming: 'Swimming',
  barbell: 'Barbell',
  yoga: 'Yoga',
  football: 'BallFootball',
  basketball: 'BallBasketball',
  tennis: 'BallTennis',
  bolt: 'Bolt',
  'ping-pong': 'PingPong',
  'jump-rope': 'JumpRope',
  sailboat: 'Sailboat',
  music: 'Music',
  mountain: 'Mountain',
  flame: 'Flame',
  flag: 'Flag',
  'map-pin': 'MapPin',
  route: 'Route',
  stopwatch: 'Stopwatch',
  clock: 'Clock',
  heartbeat: 'Heartbeat',
  droplet: 'Droplet',
  target: 'Target',
  trophy: 'Trophy',
  stairs: 'Stairs',
  'chart-bar': 'ChartBar',
  'chart-line': 'ChartLine',
  'player-play': 'PlayerPlay',
  'player-pause': 'PlayerPause',
  'player-stop': 'PlayerStop',
  plus: 'Plus',
  'chevron-right': 'ChevronRight',
  'chevron-left': 'ChevronLeft',
  'chevron-down': 'ChevronDown',
  share: 'Share',
  calendar: 'Calendar',
  settings: 'Settings',
  user: 'User',
  'user-circle': 'UserCircle',
  database: 'Database',
  // la comida (los iconos de lo que se anota en «Nutrición»; ver `src/ui/meal-icon.ts`)
  avocado: 'Avocado',
  baguette: 'Baguette',
  'bowl-chopsticks': 'BowlChopsticks',
  'bowl-spoon': 'BowlSpoon',
  bottle: 'Bottle',
  bread: 'Bread',
  cheese: 'Cheese',
  chocolate: 'Chocolate',
  'fish-bone': 'FishBone',
  'glass-champagne': 'GlassChampagne',
  'glass-gin': 'GlassGin',
  jar: 'Milk',
  lemon: 'Lemon2',
  meat: 'Meat',
  milkshake: 'Milkshake',
  mug: 'Mug',
  mushroom: 'Mushroom',
  pepper: 'Pepper',
  salt: 'Salt',
  sausage: 'Sausage',
  teapot: 'Teapot',
};

const nodes = {};
for (const [name, tabler] of Object.entries(ICONS)) {
  const source = readFileSync(join(root, 'dist/esm/icons', `Icon${tabler}.mjs`), 'utf8');
  const match = source.match(/createPreactComponent\("outline", "[^"]+", "[^"]+", (\[[\s\S]*\])\);/);
  if (!match) throw new Error(`No se encontró el dibujo de Icon${tabler}`);
  // El dibujo es un literal JS de tuplas [etiqueta, atributos]; se descarta `key`, que es de Preact.
  const drawing = new Function(`return ${match[1]}`)();
  nodes[name] = drawing.map(([tag, attrs]) => {
    const { key: _key, ...rest } = attrs;
    return [tag, rest];
  });
}

const lines = Object.entries(nodes).map(([name, drawing]) => `  ${JSON.stringify(name)}: ${JSON.stringify(drawing)},`);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
writeFileSync(
  new URL('../src/ui/icon-set.ts', import.meta.url),
  `// GENERADO por scripts/vendor-icons.mjs a partir de @tabler/icons-preact ${version} (licencia MIT, © codecalm).
// No se edita a mano: ver docs/atribuciones.md.

export type IconNode = ReadonlyArray<readonly [tag: string, attrs: Readonly<Record<string, string | number>>]>;

export const TABLER_ICONS: Readonly<Record<string, IconNode>> = {
${lines.join('\n')}
};
`,
);
console.log(`${Object.keys(nodes).length} iconos copiados (Tabler ${version})`);
