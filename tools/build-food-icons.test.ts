import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFoodIcons, EXTRA_ICONS, keyOf, urlOf, type Network } from './build-food-icons';

const hasConvert = ((): boolean => {
  try {
    execFileSync('convert', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('claves y direcciones', () => {
  it('la clave es el nombre en minúsculas con «_» y la dirección apunta al PNG 3D del repositorio de Microsoft', () => {
    expect(keyOf('Ear of corn')).toBe('ear_of_corn');
    expect(urlOf('Ear of corn')).toBe('https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Ear%20of%20corn/3D/ear_of_corn_3d.png');
    expect(urlOf('Pancakes')).toContain('/Pancakes/3D/pancakes_3d.png');
  });

  it('no hay claves repetidas', () => {
    const keys = EXTRA_ICONS.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildFoodIcons', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasConvert)('baja y reduce las que existen, se salta las que no y no repite las que ya están', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'food-icons-test-'));
    dirs.push(dir);
    execFileSync('convert', ['-size', '256x256', 'xc:red', join(dir, 'in.png')]);
    const png = new Uint8Array(readFileSync(join(dir, 'in.png')));
    const asked: string[] = [];
    const net: Network = {
      bytes: async (url) => {
        asked.push(url);
        return url.includes('Mango') ? png : null; // solo el mango existe
      },
    };
    const out = join(dir, 'out');
    const first = await buildFoodIcons({ dir: out, net, icons: ['Mango', 'Cosa inventada'] });
    expect(first).toEqual({ done: ['mango'], kept: [], missing: ['cosa_inventada'] });
    expect(existsSync(join(out, 'mango.webp'))).toBe(true);
    expect(execFileSync('identify', ['-format', '%wx%h', join(out, 'mango.webp')]).toString()).toBe('160x160');

    asked.length = 0;
    const second = await buildFoodIcons({ dir: out, net, icons: ['Mango', 'Cosa inventada'] });
    expect(second.kept).toEqual(['mango']);
    expect(asked).toHaveLength(1); // solo vuelve a probar la que faltaba
    const third = await buildFoodIcons({ dir: out, net, icons: ['Mango'], only: ['mango'] });
    expect(third.done).toEqual(['mango']);
  });

  it('un fallo de red en una no detiene a las demás', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'food-icons-test-'));
    dirs.push(dir);
    const net: Network = {
      bytes: async () => {
        throw new Error('sin red');
      },
    };
    const result = await buildFoodIcons({ dir, net, icons: ['A', 'B'] });
    expect(result.missing).toEqual(['a', 'b']);
  });
});
