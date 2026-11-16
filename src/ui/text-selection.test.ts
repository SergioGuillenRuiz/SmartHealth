import { describe, expect, it } from 'vitest';
import { allowsSelection, blockTextSelection } from './text-selection';

interface Fake {
  closest: (selector: string) => unknown;
  parentElement: Fake | null;
}

/** Un elemento de mentira que sabe a qué selectores pertenece. */
const el = (tags: string[], parent: Fake | null = null): Fake => ({
  closest: (selector: string) => (tags.some((t) => selector.split(',').map((p) => p.trim()).includes(t)) ? {} : (parent?.closest(selector) ?? null)),
  parentElement: parent,
});

describe('allowsSelection', () => {
  it('solo los campos donde se escribe (y lo marcado) dejan seleccionar', () => {
    expect(allowsSelection(el(['input']))).toBe(true);
    expect(allowsSelection(el(['textarea']))).toBe(true);
    expect(allowsSelection(el(['[contenteditable="true"]']))).toBe(true);
    expect(allowsSelection(el(['[data-selectable]']))).toBe(true);
    expect(allowsSelection(el(['button']))).toBe(false);
    expect(allowsSelection(el(['svg']))).toBe(false);
    expect(allowsSelection(null)).toBe(false);
    expect(allowsSelection(undefined)).toBe(false);
  });

  it('un nodo de texto se mira por su elemento', () => {
    const input = el(['input']);
    expect(allowsSelection({ parentElement: input })).toBe(true);
    expect(allowsSelection({ parentElement: el(['button']) })).toBe(false);
    expect(allowsSelection({ parentElement: null })).toBe(false);
  });
});

describe('blockTextSelection', () => {
  it('cancela el menú contextual y la selección fuera de los campos, y los deja en ellos', () => {
    const handlers = new Map<string, (event: Event) => void>();
    blockTextSelection({ addEventListener: (type: string, handler: unknown) => void handlers.set(type, handler as (event: Event) => void) } as never);
    expect([...handlers.keys()].sort()).toEqual(['contextmenu', 'selectstart']);
    for (const type of ['contextmenu', 'selectstart']) {
      let prevented = false;
      handlers.get(type)?.({ target: el(['button']), preventDefault: () => (prevented = true) } as unknown as Event);
      expect(prevented, `${type} sobre un botón`).toBe(true);
      prevented = false;
      handlers.get(type)?.({ target: el(['input']), preventDefault: () => (prevented = true) } as unknown as Event);
      expect(prevented, `${type} sobre un campo`).toBe(false);
    }
  });
});
