import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SimulatedTransport } from '../ble/sim/ring';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { DEFAULT_SETTINGS } from '../data/types';
import { startSync } from './actions';
import { hasRing, hasScale, setHasRing, setHasScale } from './devices';
import { installServices } from './services';
import { ringUse, settings, syncUi, toast } from './state';

const NOW = new Date(2026, 6, 10, 18, 0, 0).getTime();
let counter = 0;
let store: IdbStore;

beforeEach(async () => {
  store = await openIdbStore(`dev-${++counter}`);
  installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: NOW, days: 1, seed: 2 })), now: () => NOW, demo: false });
  settings.value = { ...DEFAULT_SETTINGS };
  ringUse.value = null;
  syncUi.value = { status: 'idle' };
  toast.value = null;
});

describe('dispositivos: qué tiene la persona', () => {
  it('de serie tiene los dos', () => {
    expect(hasRing.value).toBe(true);
    expect(hasScale.value).toBe(true);
  });

  it('apagar y encender el anillo cambia el ajuste, se guarda y NO borra ningún dato', async () => {
    await store.putProfileEntry({ date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15' });
    await setHasRing(false);
    expect(hasRing.value).toBe(false);
    expect((await store.getSettings()).hasRing).toBe(false);
    expect(await store.getProfileHistory()).toHaveLength(1); // lo guardado sigue ahí
    await setHasRing(true);
    expect(hasRing.value).toBe(true);
    expect((await store.getSettings()).hasRing).toBe(true);
  });

  it('con el anillo en uso (sincronizando, midiendo o entrenando) no se puede apagar, y lo avisa', async () => {
    ringUse.value = 'workout';
    await setHasRing(false);
    expect(hasRing.value).toBe(true);
    expect(toast.value?.message).toMatch(/en uso/);
    ringUse.value = null;
    await setHasRing(false);
    expect(hasRing.value).toBe(false);
  });

  it('sin anillo no se sincroniza: pedirlo a mano no hace nada', async () => {
    await setHasRing(false);
    await startSync();
    expect(syncUi.value).toEqual({ status: 'idle' });
    expect(ringUse.value).toBeNull();
  });

  it('el interruptor de la báscula se guarda y se puede volver a encender', async () => {
    await setHasScale(false);
    expect(hasScale.value).toBe(false);
    expect((await store.getSettings()).hasScale).toBe(false);
    await setHasScale(true);
    expect(hasScale.value).toBe(true);
    expect((await store.getSettings()).hasScale).toBe(true);
  });
});

describe('ajustes de dispositivos al leer y en la copia', () => {
  it('un valor guardado que no es un sí o un no vuelve a «lo tiene»', async () => {
    await store.setSettings({ hasRing: 'no' as never, hasScale: null as never });
    expect(await store.getSettings()).toMatchObject({ hasRing: true, hasScale: true });
    await store.setSettings({ hasRing: false });
    expect(await store.getSettings()).toMatchObject({ hasRing: false, hasScale: true });
  });
});
