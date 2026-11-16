import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortWhenHidden } from './hidden-guard';

afterEach(() => vi.unstubAllGlobals());

/** Un `document` mínimo con visibilidad y oyentes. */
function fakeDocument(state: 'visible' | 'hidden') {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: state,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  return { doc, listeners, change: (next: 'visible' | 'hidden') => { doc.visibilityState = next; for (const fn of [...listeners]) fn(); } };
}

describe('abortWhenHidden: no hacer trabajo pesado con la app oculta', () => {
  it('con la app a la vista no está cortada; al ocultarse se corta; al volver a verse no se «descorta»', () => {
    const page = fakeDocument('visible');
    vi.stubGlobal('document', page.doc);
    const guard = abortWhenHidden();
    expect(guard.signal.aborted).toBe(false);
    page.change('hidden');
    expect(guard.signal.aborted).toBe(true);
    page.change('visible');
    expect(guard.signal.aborted).toBe(true);
    guard.dispose();
    expect(page.listeners.size).toBe(0);
  });

  it('si ya está oculta, viene cortada y no deja oyentes', () => {
    const page = fakeDocument('hidden');
    vi.stubGlobal('document', page.doc);
    const guard = abortWhenHidden();
    expect(guard.signal.aborted).toBe(true);
    expect(page.listeners.size).toBe(0);
  });

  it('al acabar el trabajo se deja de oír la visibilidad (ni una fuga de oyentes por cada bajada)', () => {
    const page = fakeDocument('visible');
    vi.stubGlobal('document', page.doc);
    const guards = [abortWhenHidden(), abortWhenHidden(), abortWhenHidden()];
    expect(page.listeners.size).toBe(3);
    for (const guard of guards) guard.dispose();
    expect(page.listeners.size).toBe(0);
  });

  it('sin `document` (pruebas, otros entornos) nunca se corta', () => {
    const guard = abortWhenHidden();
    expect(guard.signal.aborted).toBe(false);
    guard.dispose();
  });
});
