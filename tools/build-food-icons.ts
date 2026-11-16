// Baja más ilustraciones 3D de comida de los «Fluent Emoji» de Microsoft (licencia MIT) y las deja como miniaturas WebP de 160 px en `src/ui/food-photos/`.
//
//   node tools/build-food-icons.ts [--dir <carpeta>] [--only a,b] [--all]
//
// Se ejecuta en el CI (el trabajo «iconos» de `.github/workflows/android.yml`), que sí tiene internet: el sandbox de trabajo, no. Para cada ilustración de `EXTRA_ICONS` pide el PNG
// 3D del repositorio público de Microsoft (https://github.com/microsoft/fluentui-emoji), lo reduce con ImageMagick y lo guarda como `<clave>.webp`. Las que ya están no se vuelven
// a bajar (`--only` repite las pedidas y `--all` todas), y una que no exista en el repositorio se salta y se cuenta (no rompe el trabajo). Los iconos se usan desde `ui/meal-icon.ts`.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets';
const SIZE = 160;

/** Los emojis que se bajan, con el nombre de su carpeta en el repositorio de Microsoft (el archivo es ese nombre en minúsculas y con «_»: `ear_of_corn`). */
export const EXTRA_ICONS: readonly string[] = [
  // masas, panes y bollería
  'Pancakes', 'Waffle', 'Bagel', 'Pretzel', 'Flatbread', 'Tamale', 'Falafel', 'Fondue', 'Dumpling', 'Pie', 'Dango', 'Moon cake', 'Fortune cookie', 'Rice cracker',
  // platos de otras cocinas
  'Sushi', 'Bento box', 'Takeout box', 'Rice ball', 'Curry rice', 'Fish cake with swirl', 'Oden',
  // pescado y marisco, y aves
  'Lobster', 'Crab', 'Squid', 'Oyster', 'Octopus', 'Fried shrimp', 'Turkey', 'Duck',
  // fruta y verdura
  'Green apple', 'Kiwi fruit', 'Peach', 'Pear', 'Melon', 'Mango', 'Blueberries', 'Eggplant', 'Garlic', 'Onion', 'Ginger root', 'Pea pod', 'Chestnut', 'Coconut', 'Cucumber', 'Ear of corn', 'Hot pepper', 'Roasted sweet potato',
  // despensa y bebidas
  'Butter', 'Mate', 'Beverage box', 'Tropical drink', 'Sake', 'Teacup without handle', 'Baby bottle', 'Ice',
];

export const keyOf = (folder: string): string => folder.toLowerCase().replace(/ /g, '_');
export const urlOf = (folder: string): string => `${BASE}/${encodeURIComponent(folder)}/3D/${keyOf(folder)}_3d.png`;

export interface Network {
  bytes(url: string): Promise<Uint8Array | null>;
}

function toWebp(input: string, output: string): void {
  const args = [input, '-background', 'none', '-resize', `${SIZE}x${SIZE}`, '-strip', '-quality', '72', '-define', 'webp:alpha-quality=85', '-define', 'webp:method=6', output];
  try {
    execFileSync('convert', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
}

export interface BuildResult {
  done: string[];
  kept: string[];
  missing: string[];
}

export async function buildFoodIcons(options: { dir: string; net: Network; only?: readonly string[]; all?: boolean; icons?: readonly string[]; log?: (message: string) => void }): Promise<BuildResult> {
  const { dir, net, icons = EXTRA_ICONS, log = () => undefined } = options;
  await mkdir(dir, { recursive: true });
  const result: BuildResult = { done: [], kept: [], missing: [] };
  const redo = new Set(options.only ?? []);
  for (const folder of icons) {
    const key = keyOf(folder);
    const output = join(dir, `${key}.webp`);
    if (existsSync(output) && !options.all && !redo.has(key)) {
      result.kept.push(key);
      continue;
    }
    let bytes: Uint8Array | null = null;
    try {
      bytes = await net.bytes(urlOf(folder));
    } catch (error) {
      log(`✗ ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!bytes) {
      result.missing.push(key);
      log(`✗ ${key}: no está en el repositorio`);
      continue;
    }
    const work = join(tmpdir(), `food-icon-${process.pid}-${key}.png`);
    try {
      await writeFile(work, bytes);
      toWebp(work, output);
      log(`✓ ${key} (${(await stat(output)).size} B)`);
      result.done.push(key);
    } catch (error) {
      result.missing.push(key);
      log(`✗ ${key}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(work, { force: true });
    }
  }
  return result;
}

const realNetwork: Network = {
  bytes: async (url) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, { headers: { 'User-Agent': 'SmartHealthFoodIcons/1.0' } });
      if (response.status === 404) return null;
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    throw new Error(`HTTP error en ${new URL(url).hostname}`);
  },
};

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const only = (argument('only') ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '');
  const result = await buildFoodIcons({ dir: argument('dir') ?? 'src/ui/food-photos', net: realNetwork, only, all: process.argv.includes('--all'), log: (message) => console.log(message) });
  console.log(`\nIconos: ${result.done.length} nuevos, ${result.kept.length} ya estaban, ${result.missing.length} sin conseguir de ${EXTRA_ICONS.length}.`);
  if (result.missing.length > 0) console.log(`Sin conseguir: ${result.missing.join(', ')}`);
  // Sin red lo normal es que no llegue ninguno: mejor que el trabajo falle y no confirme nada.
  if (result.done.length + result.kept.length < EXTRA_ICONS.length * 0.5) {
    console.error('::error::Demasiados iconos sin conseguir; no se confirma nada.');
    process.exit(1);
  }
}
