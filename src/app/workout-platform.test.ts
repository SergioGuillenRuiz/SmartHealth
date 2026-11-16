import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeTracker, TrackerTick } from './tracker';
import { nativeTracker } from './tracker';
import { browserPlatform, type WakeInfo } from './workout-controller';

vi.mock('./tracker', async (importOriginal) => ({ ...(await importOriginal<typeof import('./tracker')>()), nativeTracker: vi.fn() }));

/** Un `document` mínimo (las pruebas corren en Node): quien se apunta a `visibilitychange` recibe lo que se dispara con `fire`. */
function stubDocument(): { fire: () => void } {
  const listeners = new Set<() => void>();
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: (type: string, listener: () => void) => type === 'visibilitychange' && listeners.add(listener),
    removeEventListener: (type: string, listener: () => void) => type === 'visibilitychange' && listeners.delete(listener),
  });
  return { fire: () => [...listeners].forEach((listener) => listener()) };
}

function stubTracker(): { tick: (tick?: TrackerTick) => void; ack: ReturnType<typeof vi.fn> } {
  let listener: ((tick: TrackerTick) => void) | null = null;
  const ack = vi.fn();
  vi.mocked(nativeTracker).mockReturnValue({ onTick: (l: (tick: TrackerTick) => void) => ((listener = l), () => (listener = null)), ack } as unknown as NativeTracker);
  return { tick: (tick = { now: Date.now() }) => listener?.(tick), ack };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(nativeTracker).mockReset();
});

describe('browserPlatform().onWake: qué despierta al entreno', () => {
  it('sin servicio nativo (el navegador), volver a ver la página es la señal', () => {
    const doc = stubDocument();
    vi.mocked(nativeTracker).mockReturnValue(null);
    const wakes: WakeInfo[] = [];
    const off = browserPlatform().onWake?.((wake) => wakes.push(wake as WakeInfo));
    doc.fire();
    expect(wakes).toEqual([{ source: 'visible', lagMs: 0 }]);
    off?.();
    doc.fire();
    expect(wakes, 'al parar ya no oye nada').toHaveLength(1);
  });

  it('con el servicio nativo, «visible» sigue valiendo hasta que llega el primer aviso nativo, y después ya no: el aviso nativo va en la misma cola que lo que mandó el anillo y «visible» puede adelantarse a lo atrasado', () => {
    const doc = stubDocument();
    const native = stubTracker();
    const wakes: WakeInfo[] = [];
    browserPlatform().onWake?.((wake) => wakes.push(wake as WakeInfo));

    doc.fire(); // aún sin avisos nativos (el servicio puede no haber arrancado): sigue siendo la señal
    expect(wakes.map((w) => w.source)).toEqual(['visible']);

    native.tick({ now: Date.now() - 1500 });
    expect(native.ack).toHaveBeenCalledTimes(1); // lo primero, contestar al lado nativo
    expect(wakes.map((w) => w.source)).toEqual(['visible', 'tick']);
    expect(wakes[1]?.lagMs).toBeGreaterThanOrEqual(1500);

    doc.fire(); // ya hay avisos: encender la pantalla no despierta por sí mismo, lo hará el siguiente aviso (≤ 2 s)
    doc.fire();
    expect(wakes.map((w) => w.source)).toEqual(['visible', 'tick']);

    native.tick();
    expect(wakes.map((w) => w.source)).toEqual(['visible', 'tick', 'tick']);
  });
});
