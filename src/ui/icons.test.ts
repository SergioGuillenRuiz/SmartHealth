import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPORTS } from '../domain/sports';
import { hasIcon } from './icons';

// Un nombre de icono que no existe se dibuja como un icono genérico, sin error: así se coló un «MapPin» que dejó de
// existir al cambiar de familia de iconos. Este test lo caza.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'icon-set.ts' ? [path] : [];
  });
}

describe('iconos', () => {
  it('todos los deportes (también los retirados) tienen un icono que existe', () => {
    for (const sport of SPORTS) expect(hasIcon(sport.icon), `${sport.id}: ${sport.icon}`).toBe(true);
  });

  it('todos los nombres escritos en la interfaz existen', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(__dirname, '..'))) {
      const source = readFileSync(file, 'utf8');
      const names = new Set<string>();
      // <Icon name="X" />, icon="X" (cabeceras y estados vacíos) y las dos ramas de <Icon name={a === b ? 'X' : 'Y'} />
      for (const m of source.matchAll(/<Icon[^>]*?\bname="([A-Za-z][\w-]*)"/g)) names.add(m[1] ?? '');
      for (const m of source.matchAll(/\bicon="([A-Za-z][\w-]*)"/g)) names.add(m[1] ?? '');
      for (const m of source.matchAll(/<Icon[^>]*?\bname=\{([^}]*)\}/g)) for (const n of (m[1] ?? '').matchAll(/[?:]\s*'([A-Za-z][\w-]*)'/g)) names.add(n[1] ?? '');
      for (const name of names) if (name && !hasIcon(name)) missing.push(`${file.replace(`${join(__dirname, '..')}/`, '')}: ${name}`);
    }
    expect(missing).toEqual([]);
  });
});
