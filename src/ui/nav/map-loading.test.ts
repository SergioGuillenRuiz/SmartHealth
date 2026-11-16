import { afterEach, describe, expect, it } from 'vitest';
import { navState } from '../../app/nav/navigator';
import { mapLoadingText } from './NavSection';

const base = navState.value;
const set = (change: Partial<typeof base>): void => {
  navState.value = { ...base, ...change };
};
afterEach(() => {
  navState.value = base;
});

describe('lo que dice la carga del mapa de un entreno guiado', () => {
  it('no dice nada si no hay nada que esperar', () => {
    set({ phase: 'closed' });
    expect(mapLoadingText()).toBeNull();
    set({ phase: 'search' });
    expect(mapLoadingText()).toBeNull();
  });

  it('espera al GPS y lo dice con lo que lo ayuda (aire libre)', () => {
    set({ phase: 'locating' });
    expect(mapLoadingText()).toEqual({ line: expect.stringContaining('posición del GPS'), hint: expect.stringContaining('al aire libre') });
  });

  it('abrir el mapa guardado no necesita explicación', () => {
    set({ phase: 'loading' });
    expect(mapLoadingText()).toEqual({ line: 'Abriendo el mapa guardado de tu zona…', hint: '' });
  });

  it('bajar un mapa nuevo enseña los MB y dice POR QUÉ tarda', () => {
    set({ phase: 'downloading', download: { stage: 'download', bytes: 3_400_000 } });
    const text = mapLoadingText();
    expect(text?.line).toBe('Bajando el mapa de tu zona… 3,4 MB');
    expect(text?.hint).toContain('Por eso tarda');
    expect(text?.hint).toContain('una sola vez');
  });

  it('al empezar la bajada, sin MB todavía, la frase no deja un hueco', () => {
    set({ phase: 'downloading', download: { stage: 'download', bytes: 0 } });
    expect(mapLoadingText()?.line).toBe('Bajando el mapa de tu zona…');
  });

  it('montarlo, cuando ya bajó, también se dice', () => {
    set({ phase: 'downloading', download: { stage: 'build' } });
    expect(mapLoadingText()?.line).toBe('Preparando el mapa de tu zona…');
  });
});
