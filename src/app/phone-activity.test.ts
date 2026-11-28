import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// La parte nativa (Android) se sustituye por una de mentira: aquí solo se prueba lo que hace la web con lo que ella le cuenta.
const native = vi.hoisted(() => ({
  isNative: true,
  status: { supported: true, granted: true, screenEvents: true },
  read: vi.fn(),
  open: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('./native', () => ({
  isNative: () => native.isNative,
  NativeTools: {
    phoneActivityStatus: () => Promise.resolve(native.status),
    readPhoneActivity: (options: { sinceMs: number }) => native.read(options),
    openPhoneActivitySettings: () => native.open(),
    schedulePhoneActivity: () => native.schedule(),
  },
}));

import { openIdbStore, type IdbStore } from '../data/idb-store';
import { openPhoneAccessSettings, phoneAccess, refreshPhoneAccess, syncPhoneActivity } from './phone-activity';
import { installServices } from './services';
import { dataVersion } from './state';

const MIN = 60_000;
const NOW = new Date(2026, 9, 12, 9, 0, 0).getTime();
let clock = NOW;
let store: IdbStore;
let n = 0;

beforeEach(async () => {
  native.isNative = true;
  native.status = { supported: true, granted: true, screenEvents: true };
  native.read = vi.fn();
  native.open = vi.fn(() => Promise.resolve());
  native.schedule = vi.fn(() => Promise.resolve());
  clock = NOW;
  store = await openIdbStore(`phone-activity-${n++}`);
  installServices({ store, transport: {} as never, now: () => clock, demo: false, hrTiming: { hrWarmupMs: 0, hrStreamAfterMs: 0 } });
});

const reading = (extra: Partial<{ granted: boolean; fromMs: number; toMs: number; firstMs: number; uses: string; offs: string }> = {}) => ({
  granted: true,
  fromMs: NOW - 3 * 60 * MIN,
  toMs: NOW,
  firstMs: NOW - 3 * 60 * MIN + 20 * MIN,
  uses: `${NOW - 120 * MIN}:${NOW - 110 * MIN}`,
  offs: '',
  ...extra,
});

describe('syncPhoneActivity', () => {
  it('guarda los tramos de uso y la cobertura desde el primer evento que el sistema conserva, y avisa a las pantallas', async () => {
    native.read.mockResolvedValue(reading());
    const before = dataVersion.value;
    await syncPhoneActivity(true);
    const stored = await store.loadPhoneActivity(NOW - DAYS(1), NOW + 1);
    expect(stored.uses).toEqual([{ startMs: NOW - 120 * MIN, endMs: NOW - 110 * MIN }]);
    expect(stored.coverage).toEqual([{ startMs: NOW - 160 * MIN, endMs: NOW }]);
    expect(await store.lastPhoneRead()).toBe(NOW);
    expect(dataVersion.value).toBeGreaterThan(before);
  });

  it('los ratos con el móvil apagado no cuentan como leídos', async () => {
    native.read.mockResolvedValue(reading({ offs: `${NOW - 100 * MIN}:${NOW - 60 * MIN}` }));
    await syncPhoneActivity(true);
    const stored = await store.loadPhoneActivity(NOW - DAYS(1), NOW + 1);
    expect(stored.coverage).toEqual([
      { startMs: NOW - 160 * MIN, endMs: NOW - 100 * MIN },
      { startMs: NOW - 60 * MIN, endMs: NOW },
    ]);
  });

  it('sin ningún evento (firstMs 0) no hay cobertura: no se sabe nada de ese rato', async () => {
    native.read.mockResolvedValue(reading({ firstMs: 0, uses: '' }));
    await syncPhoneActivity(true);
    expect((await store.loadPhoneActivity(NOW - DAYS(1), NOW + 1)).coverage).toEqual([]);
    expect(await store.lastPhoneRead()).toBeNull();
  });

  it('la primera vez pide hasta diez días y, después, desde un poco antes de la última lectura', async () => {
    native.read.mockResolvedValue(reading());
    await syncPhoneActivity(true);
    expect(native.read).toHaveBeenLastCalledWith({ sinceMs: NOW - DAYS(10) });
    clock = NOW + 3 * 60 * MIN;
    native.read.mockResolvedValue(reading({ fromMs: clock - 3 * 60 * MIN, toMs: clock, firstMs: NOW, uses: '' }));
    await syncPhoneActivity(true);
    expect(native.read).toHaveBeenLastCalledWith({ sinceMs: NOW - 15 * MIN });
  });

  it('no relee si hace menos de dos minutos de la última lectura (salvo que se fuerce)', async () => {
    native.read.mockResolvedValue(reading());
    await syncPhoneActivity(true);
    clock = NOW + MIN;
    await syncPhoneActivity();
    expect(native.read).toHaveBeenCalledTimes(1);
    await syncPhoneActivity(true);
    expect(native.read).toHaveBeenCalledTimes(2);
  });

  it('sin el acceso (o en la web) no lee ni guarda nada', async () => {
    native.status = { supported: true, granted: false, screenEvents: true };
    await syncPhoneActivity(true);
    expect(native.read).not.toHaveBeenCalled();
    expect(phoneAccess.value).toEqual({ checked: true, supported: true, granted: false });
    native.isNative = false;
    native.status = { supported: true, granted: true, screenEvents: true };
    await syncPhoneActivity(true);
    expect(native.read).not.toHaveBeenCalled();
    expect(phoneAccess.value).toEqual({ checked: true, supported: false, granted: false });
  });

  it('si el acceso se retira entre la comprobación y la lectura, lo anota y no guarda nada', async () => {
    native.read.mockResolvedValue({ granted: false, fromMs: NOW, toMs: NOW, firstMs: 0, uses: '', offs: '' });
    await syncPhoneActivity(true);
    expect(phoneAccess.value.granted).toBe(false);
    expect(await store.lastPhoneRead()).toBeNull();
  });

  it('un fallo del sistema no sale hacia fuera', async () => {
    native.read.mockRejectedValue(new Error('boom'));
    await expect(syncPhoneActivity(true)).resolves.toBeUndefined();
  });
});

describe('acceso', () => {
  it('refreshPhoneAccess dice lo que hay y openPhoneAccessSettings abre los ajustes de Android', async () => {
    expect(await refreshPhoneAccess()).toEqual({ checked: true, supported: true, granted: true });
    await openPhoneAccessSettings();
    expect(native.open).toHaveBeenCalledTimes(1);
    native.isNative = false;
    await openPhoneAccessSettings();
    expect(native.open).toHaveBeenCalledTimes(1);
  });
});

function DAYS(count: number): number {
  return count * 24 * 60 * MIN;
}
