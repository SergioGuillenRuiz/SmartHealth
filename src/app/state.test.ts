import { afterEach, describe, expect, it } from 'vitest';
import type { SyncRecord } from '../data/types';
import { autoHoldsRing, claimRing, lastSync, ringCapabilities, ringUsedByOther, ringUse, setAutoYield, syncUi, toast, tryClaimRing, yieldRingToUser } from './state';

afterEach(() => {
  ringUse.value = null;
  toast.value = null;
  syncUi.value = { status: 'idle' };
  setAutoYield(null);
});

describe('claimRing: el anillo solo se usa para una cosa a la vez', () => {
  it('reserva, bloquea a los demás con un aviso que explica por qué, y libera', () => {
    const releaseSync = claimRing('sync');
    expect(releaseSync).not.toBeNull();
    expect(ringUse.value).toBe('sync');

    expect(claimRing('measure')).toBeNull();
    expect(toast.value).toMatchObject({ tone: 'error', message: 'Se está sincronizando: espera a que termine antes de medir el pulso.' });
    expect(claimRing('workout')).toBeNull();
    expect(toast.value?.message).toBe('Se está sincronizando: espera a que termine antes de empezar un entrenamiento.');
    expect(ringUse.value).toBe('sync'); // los rechazos no cambian al dueño

    releaseSync?.();
    expect(ringUse.value).toBeNull();
    expect(claimRing('workout')).not.toBeNull();
  });

  it('liberar dos veces, o liberar lo que ya es de otro, no quita la reserva ajena', () => {
    const first = claimRing('sync');
    first?.();
    const second = claimRing('workout');
    first?.(); // un liberador viejo no debe soltar la reserva nueva
    expect(ringUse.value).toBe('workout');
    second?.();
    expect(ringUse.value).toBeNull();
  });

  it('un entrenamiento en curso se explica a quien intenta sincronizar', () => {
    claimRing('workout');
    expect(claimRing('sync')).toBeNull();
    expect(toast.value?.message).toBe('Hay un entrenamiento en curso: espera a que termine antes de sincronizar.');
  });
});

describe('claimRing: reservas del mismo uso', () => {
  it('un entrenamiento o una medida que se cancelan siguen reservando el anillo: no se dice que «hay un entrenamiento en curso»', () => {
    claimRing('workout');
    expect(claimRing('workout')).toBeNull();
    expect(toast.value?.message).toBe('El anillo aún se está soltando del intento anterior: espera unos segundos y vuelve a intentarlo.');
    ringUse.value = null;
    claimRing('measure');
    expect(claimRing('measure')).toBeNull();
    expect(toast.value?.message).toMatch(/aún se está soltando/);
  });

  it('dos sincronizaciones seguidas siguen avisando de que ya se está sincronizando', () => {
    claimRing('sync');
    expect(claimRing('sync')).toBeNull();
    expect(toast.value?.message).toBe('Se está sincronizando: espera a que termine antes de sincronizar.');
  });
});

describe('ringCapabilities: se lee al arrancar y no se fía de lo guardado', () => {
  const sync = (capabilities: unknown): SyncRecord =>
    ({ tsMs: 1, ringName: 'R99', firmware: null, batteryPercent: null, durationMs: 0, interrupted: false, outcomes: [], added: { buckets: 0, counters: 0, heart: 0, spo2: 0, sleep: 0 }, dropped: {}, liveSteps: null, capabilities }) as SyncRecord;
  afterEach(() => {
    lastSync.value = null;
  });

  it('una lista da el conjunto; sin sincronización o sin la lista, «aún no se sabe»', () => {
    expect(ringCapabilities.value).toBeNull();
    lastSync.value = sync(['steps', 'sleep']);
    expect([...(ringCapabilities.value ?? [])]).toEqual(['steps', 'sleep']);
    lastSync.value = sync(undefined);
    expect(ringCapabilities.value).toBeNull();
    lastSync.value = sync(null);
    expect(ringCapabilities.value).toBeNull();
  });

  it('un valor que no es una lista (de una copia rara ya guardada) no lanza: tumbaría el arranque', () => {
    lastSync.value = sync(5);
    expect(() => ringCapabilities.value).not.toThrow();
    expect(ringCapabilities.value).toBeNull();
    lastSync.value = sync('steps');
    expect(ringCapabilities.value).toBeNull();
    lastSync.value = sync(['steps', 7, { a: 1 }]);
    expect([...(ringCapabilities.value ?? [])]).toEqual(['steps']);
  });
});

describe('tryClaimRing y la cesión a la actualización automática', () => {
  it('reserva sin avisar a nadie: si el anillo está ocupado, devuelve null y no saca ningún aviso', () => {
    const release = tryClaimRing('sync');
    expect(release).not.toBeNull();
    expect(ringUse.value).toBe('sync');
    expect(tryClaimRing('sync')).toBeNull();
    expect(tryClaimRing('workout')).toBeNull();
    expect(toast.value).toBeNull();
    release?.();
    expect(ringUse.value).toBeNull();
  });

  it('autoHoldsRing: solo cuando lo tiene una sincronización que nadie ha pedido (una pedida enseña su progreso)', () => {
    expect(autoHoldsRing()).toBe(false); // libre
    const release = tryClaimRing('sync');
    expect(autoHoldsRing()).toBe(true); // sincronizando y sin progreso en pantalla: la automática
    syncUi.value = { status: 'running', progress: { stage: 'connecting', message: 'Buscando el anillo…', fraction: 0.02 } };
    expect(autoHoldsRing()).toBe(false); // la pidió la persona
    release?.();
    const measuring = tryClaimRing('measure');
    syncUi.value = { status: 'idle' };
    expect(autoHoldsRing()).toBe(false); // una medida o un entreno nunca se ceden
    measuring?.();
  });

  it('ringUsedByOther: lo que bloquea a un botón es otro uso del anillo, no la actualización automática (esa se aparta)', () => {
    expect(ringUsedByOther('measure')).toBeNull(); // libre
    const auto = tryClaimRing('sync');
    expect(ringUsedByOther('measure')).toBeNull(); // la automática no bloquea
    expect(ringUsedByOther('test')).toBeNull();
    syncUi.value = { status: 'running', progress: { stage: 'connecting', message: 'Buscando el anillo…', fraction: 0.02 } };
    expect(ringUsedByOther('measure')).toBe('sync'); // una sincronización pedida por la persona, sí
    expect(ringUsedByOther('sync')).toBeNull(); // el propio uso nunca se bloquea a sí mismo
    auto?.();
    const workout = tryClaimRing('workout');
    syncUi.value = { status: 'idle' };
    expect(ringUsedByOther('measure')).toBe('workout');
    workout?.();
  });

  it('yieldRingToUser no hace nada sin automática, y espera a la que haya registrada', async () => {
    await expect(yieldRingToUser()).resolves.toBeUndefined();
    let yielded = false;
    setAutoYield(async () => {
      await Promise.resolve();
      yielded = true;
    });
    await yieldRingToUser();
    expect(yielded).toBe(true);
  });
});
