import { describe, expect, it } from 'vitest';
import { topDialog } from './back-button';

const dialog = (name: string, opened?: number) => ({ name, dataset: { opened: opened === undefined ? undefined : String(opened) } });

describe('topDialog: la hoja a la que cierra «atrás»', () => {
  it('sin hojas abiertas no hay ninguna', () => {
    expect(topDialog([])).toBeUndefined();
  });

  it('la última que se abrió, aunque esté antes en el documento', () => {
    // Orden en el documento: anillo, menú, apartado. Orden de apertura: menú, apartado, anillo (desde «Diagnóstico del anillo»).
    const ring = dialog('anillo', 3);
    const menu = dialog('menú', 1);
    const section = dialog('apartado', 2);
    expect(topDialog([ring, menu, section])?.name).toBe('anillo');
  });

  it('sin orden anotado vale la última del documento, y una con orden gana a las que no lo tienen', () => {
    expect(topDialog([dialog('a'), dialog('b')])?.name).toBe('b');
    expect(topDialog([dialog('a', 5), dialog('b')])?.name).toBe('a');
  });

  it('si dos tienen el mismo orden gana la última del documento (una hoja dentro de otra)', () => {
    expect(topDialog([dialog('fuera', 4), dialog('dentro', 4)])?.name).toBe('dentro');
  });
});
