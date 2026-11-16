import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regla del proyecto: los datos nunca se representan con tablas. Ni la etiqueta `<table>` y sus partes, ni roles de tabla,
 * ni estilos que conviertan otra cosa en una (`display: table`). Un gráfico se nombra con un resumen y se lee con el cursor;
 * lo demás, con listas, recuadros de cifras o texto.
 */
const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'una etiqueta de tabla', pattern: /<\/?(table|thead|tbody|tfoot|tr|td|th|caption|colgroup)\b/i },
  { name: 'un rol de tabla', pattern: /role=["'{ ]*(table|grid|treegrid|row|rowgroup|cell|gridcell|columnheader|rowheader)\b/i },
  { name: 'un estilo de tabla', pattern: /display:\s*(table|inline-table|table-row|table-cell|table-header-group|table-row-group)\b|border-collapse/i },
  { name: 'el botón «Ver como tabla»', pattern: /como tabla/i },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('sin tablas para representar datos', () => {
  const files = sourceFiles(join(__dirname, '..'));

  it('hay código que revisar', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('las reglas detectan lo que prohíben (que la prueba no sea vacía)', () => {
    const samples: Record<string, string> = {
      'una etiqueta de tabla': '<table class="x"><tr><td>1</td></tr></table>',
      'un rol de tabla': '<div role="table">',
      'un estilo de tabla': '.a { display: table-cell; }',
      'el botón «Ver como tabla»': "label: 'Ver como tabla'",
    };
    for (const { name, pattern } of FORBIDDEN) expect(pattern.test(samples[name] ?? ''), name).toBe(true);
    expect(FORBIDDEN[0]?.pattern.test('<track src="a">')).toBe(false); // <track> no es <tr>
  });

  for (const { name, pattern } of FORBIDDEN) {
    it(`ningún fichero de la app usa ${name}`, () => {
      const found = files.filter((file) => pattern.test(readFileSync(file, 'utf8'))).map((file) => file.replace(/^.*\/src\//, 'src/'));
      expect(found, `los datos no van en tablas: ${found.join(', ')}`).toEqual([]);
    });
  }
});
