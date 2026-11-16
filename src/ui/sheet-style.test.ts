import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySheetStyle, SHEET_STYLE } from './sheet-style';

describe('versión del aspecto de las hojas', () => {
  it('marca la versión en el elemento raíz', () => {
    const root = { dataset: {} as Record<string, string> };
    applySheetStyle(root as unknown as HTMLElement);
    expect(root.dataset.sheets).toBe(String(SHEET_STYLE));
  });

  it('toda regla de sheets-v2.css cuelga de «data-sheets=2»: el aspecto anterior (app.css) sigue intacto y se recupera poniendo SHEET_STYLE = 1', () => {
    const css = readFileSync(new URL('./styles/sheets-v2.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(?:^|})\s*([^{}@][^{}]*)\{/g)].map((m) => m[1]!.trim()).filter((s) => s !== '');
    expect(selectors.length).toBeGreaterThan(30);
    for (const list of selectors) for (const selector of list.split(',')) expect(selector.trim(), selector).toMatch(/^:root\[data-sheets='2'\]/);
  });

  it('el aspecto anterior de la valoración (app.css) sigue ahí', () => {
    const css = readFileSync(new URL('./styles/app.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.meal-fit \{/);
    expect(css).toMatch(/\.fit-row \{/);
    expect(css).toMatch(/\.menu-row__icon \{/);
  });
});
