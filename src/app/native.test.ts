import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = { keepScreenOn: vi.fn(async (_options: { enabled: boolean }) => undefined) };
const platform = { native: true };

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native },
  registerPlugin: () => plugin,
}));

const { releaseNativeScreenLock } = await import('./native');

beforeEach(() => {
  plugin.keepScreenOn.mockClear();
  platform.native = true;
});

describe('releaseNativeScreenLock', () => {
  it('en la app de Android suelta el indicador de pantalla encendida (sobrevive a una recarga de la página)', () => {
    releaseNativeScreenLock();
    expect(plugin.keepScreenOn).toHaveBeenCalledTimes(1);
    expect(plugin.keepScreenOn).toHaveBeenCalledWith({ enabled: false });
  });

  it('si el plugin falla no lanza nada ni deja la promesa sin atender (el arranque no depende de esto)', async () => {
    plugin.keepScreenOn.mockRejectedValueOnce(new Error('sin plugin'));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    expect(() => releaseNativeScreenLock()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('en el navegador no toca nada', () => {
    platform.native = false;
    releaseNativeScreenLock();
    expect(plugin.keepScreenOn).not.toHaveBeenCalled();
  });
});
