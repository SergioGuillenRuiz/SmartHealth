import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isNative: vi.fn(() => true), vibrate: vi.fn() }));
vi.mock('../app/native', () => ({ isNative: mocks.isNative }));
vi.mock('@capacitor/haptics', () => ({ Haptics: { vibrate: mocks.vibrate } }));

import { vibrateCue } from './cues';

beforeEach(() => {
  vi.useFakeTimers();
  mocks.isNative.mockReturnValue(true);
  mocks.vibrate.mockReset();
  mocks.vibrate.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('vibrateCue en Android', () => {
  it('«atención» y «ya» son una sola vibración (más larga la segunda)', async () => {
    vibrateCue('attention');
    await vi.runAllTimersAsync();
    expect(mocks.vibrate.mock.calls).toEqual([[{ duration: 250 }]]);

    mocks.vibrate.mockClear();
    vibrateCue('go');
    await vi.runAllTimersAsync();
    expect(mocks.vibrate.mock.calls).toEqual([[{ duration: 600 }]]);
  });

  it('«fin» son tres vibraciones cortas separadas por pausas, sin esperar a que acaben', async () => {
    vibrateCue('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.vibrate).toHaveBeenCalledTimes(1); // la primera sale al momento
    await vi.advanceTimersByTimeAsync(320); // 180 ms de vibración + 140 de pausa
    expect(mocks.vibrate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(320);
    expect(mocks.vibrate).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();
    expect(mocks.vibrate.mock.calls.map(([options]) => (options as { duration: number }).duration)).toEqual([180, 180, 180]);
  });

  it('si el móvil no puede vibrar no pasa nada (ni un error sin gestionar)', async () => {
    mocks.vibrate.mockRejectedValue(new Error('sin vibrador'));
    expect(() => vibrateCue('done')).not.toThrow();
    await vi.runAllTimersAsync(); // si el rechazo se escapara, vitest fallaría por «unhandled rejection»
  });
});

describe('vibrateCue en el navegador', () => {
  const nav = globalThis.navigator as unknown as { vibrate?: unknown };

  beforeEach(() => mocks.isNative.mockReturnValue(false));
  afterEach(() => {
    delete nav.vibrate;
  });

  it('usa navigator.vibrate con el patrón de la señal', () => {
    const vibrate = vi.fn();
    Object.defineProperty(nav, 'vibrate', { value: vibrate, configurable: true });
    vibrateCue('done');
    expect(vibrate).toHaveBeenCalledWith([180, 140, 180, 140, 180]);
    expect(mocks.vibrate).not.toHaveBeenCalled();
  });

  it('sin navigator.vibrate, o si lanza, no pasa nada', () => {
    expect(() => vibrateCue('go')).not.toThrow();
    Object.defineProperty(nav, 'vibrate', {
      value: () => {
        throw new Error('bloqueado');
      },
      configurable: true,
    });
    expect(() => vibrateCue('go')).not.toThrow();
  });
});
