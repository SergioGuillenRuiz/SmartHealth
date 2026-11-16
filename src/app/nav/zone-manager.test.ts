import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { overpassCity, overpassCityDetail, overpassCityLight } from '../../domain/nav/overpass.test-support';
import { PACK_VERSION, readPack } from '../../domain/nav/pack';
import { boxAround, DETAIL_RETRY_MS, MAX_ZONES } from '../../domain/nav/zones';
import { downloadDetailFor, downloadZone, ZoneError, type DownloadProgress } from './area-download';
import { createIdbAreaStore, type AreaStore } from './area-store';
import { forgetRememberedZoneForTests, loadMostRecentStoredZone, loadStoredZoneCovering, loadZoneFor, type ZoneDeps } from './zone-manager';

const DAY = 86_400_000;
const HOME = { lat: 40.4168, lon: -3.7038 };
// A 30 km de casa: otra zona.
const FAR = { lat: 40.4168, lon: -3.7038 + 30_000 / (111_195 * Math.cos((40.4168 * Math.PI) / 180)) };

function setup(options: { fail?: () => ZoneError | null } = {}): { deps: ZoneDeps; store: AreaStore; downloads: Array<{ lat: number; lon: number }>; clock: { now: number } } {
  forgetRememberedZoneForTests(); // cada prueba empieza sin el mapa recordado de la anterior
  const store = createIdbAreaStore(new IDBFactory(), 'zonas-prueba');
  const clock = { now: Date.UTC(2026, 10, 4) };
  const downloads: Array<{ lat: number; lon: number }> = [];
  const deps: ZoneDeps = {
    store,
    now: () => clock.now,
    download: async (lat, lon, onProgress) => {
      downloads.push({ lat, lon });
      const failure = options.fail?.();
      if (failure) throw failure;
      const fetchFn = (async () => new Response(JSON.stringify(overpassCity({ center: { lat, lon } })), { status: 200 })) as unknown as typeof fetch;
      return downloadZone(lat, lon, { fetchFn, endpoints: ['https://x.test'], now: () => clock.now, onProgress });
    },
  };
  return { deps, store, downloads, clock };
}

describe('el mapa de donde estás', () => {
  it('la primera vez lo baja, lo guarda y lo abre', async () => {
    const { deps, store, downloads } = setup();
    const progress: DownloadProgress[] = [];
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps, (p) => progress.push(p));
    expect(loaded.ok).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(progress.some((p) => p.stage === 'download')).toBe(true);
    const saved = await store.list();
    expect(saved).toHaveLength(1);
    if (loaded.ok) {
      expect(loaded.data.zoneId).toBe(saved[0]!.id);
      expect(loaded.data.title).toBe('Barrio Centro');
    }
  });

  it('la próxima vez, sin pedir nada a internet, lo abre de lo guardado y anota el uso', async () => {
    const { deps, store, downloads, clock } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    clock.now += 3 * DAY;
    const again = await loadZoneFor(HOME.lat + 0.005, HOME.lon + 0.005, deps);
    expect(again.ok).toBe(true);
    expect(downloads).toHaveLength(1);
    expect((await store.list())[0]!.lastUsedMs).toBe(clock.now);
  });

  it('si cambias de zona baja la nueva y se queda con las dos', async () => {
    const { deps, store, downloads } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    const there = await loadZoneFor(FAR.lat, FAR.lon, deps);
    expect(there.ok).toBe(true);
    expect(downloads).toHaveLength(2);
    expect(await store.list()).toHaveLength(2);
    // Y al volver a casa no baja nada.
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(downloads).toHaveLength(2);
  });

  it('borra lo que lleva más de 60 días sin usarse al abrir otra zona', async () => {
    const { deps, store, clock } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    clock.now += 61 * DAY;
    await loadZoneFor(FAR.lat, FAR.lon, deps);
    const left = await store.list();
    expect(left).toHaveLength(1);
    expect(left[0]!.lastUsedMs).toBe(clock.now);
  });

  it('con demasiadas zonas se van las menos usadas', async () => {
    const { deps, store, clock } = setup();
    const lonStep = 30_000 / (111_195 * Math.cos((40.4168 * Math.PI) / 180));
    for (let i = 0; i < MAX_ZONES + 2; i++) {
      clock.now += DAY;
      await loadZoneFor(HOME.lat, HOME.lon + i * lonStep, deps);
    }
    const kept = await store.list();
    expect(kept).toHaveLength(MAX_ZONES);
    expect(kept.some((z) => z.createdMs === Date.UTC(2026, 10, 4) + DAY)).toBe(false); // la primera se fue
  });

  it('un paquete guardado que no se puede leer se borra y se vuelve a bajar', async () => {
    const { deps, store, downloads } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    const [meta] = await store.list();
    await store.put(meta!, new ArrayBuffer(64));
    forgetRememberedZoneForTests(); // se estropeó por debajo, sin pasar por la app: el mapa recordado ya no vale
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(loaded.ok).toBe(true);
    expect(downloads).toHaveLength(2);
    expect(await store.list()).toHaveLength(1);
  });

  it('una ficha sin paquete se limpia', async () => {
    const { deps, store, downloads } = setup();
    await store.put({ id: 'huerfana', name: 'x', box: boxAround(HOME.lat, HOME.lon, 4000), bytes: 1, createdMs: 0, lastUsedMs: Date.UTC(2026, 10, 4), packVersion: PACK_VERSION }, new ArrayBuffer(0));
    await store.remove([]);
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(loaded.ok).toBe(true);
    expect(downloads).toHaveLength(1);
    expect((await store.list()).map((z) => z.id)).not.toContain('huerfana');
  });

  it('sin internet y sin nada guardado dice qué hace falta', async () => {
    const { deps, store } = setup({ fail: () => new ZoneError('offline', 'Sin conexión') });
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(loaded).toMatchObject({ ok: false, reason: 'offline' });
    if (!loaded.ok) expect(loaded.message).toMatch(/hace falta internet una vez/);
    expect(await store.list()).toEqual([]);
  });

  it('sin internet pero cerca del borde de una zona guardada, esa sirve', async () => {
    let failing = false;
    const { deps } = setup({ fail: () => (failing ? new ZoneError('offline', 'x') : null) });
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    failing = true;
    // A 3,5 km al norte del centro: dentro de la zona (4 km) pero a menos de 1 km del borde.
    const edge = { lat: HOME.lat + 3500 / 111_195, lon: HOME.lon };
    const loaded = await loadZoneFor(edge.lat, edge.lon, deps);
    expect(loaded.ok).toBe(true);
    // Fuera del todo, no.
    const out = await loadZoneFor(HOME.lat + 5000 / 111_195, HOME.lon, deps);
    expect(out.ok).toBe(false);
  });

  it('si no hay sitio para guardar, el mapa se usa igual esta vez', async () => {
    const { deps } = setup();
    deps.store = { ...deps.store, put: async () => { throw new Error('quota'); } };
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.data.zoneId).toBeNull();
  });

  it('si ni la lista de lo guardado se puede leer, baja el mapa como si no hubiera nada', async () => {
    const { deps, downloads } = setup();
    deps.store = { ...deps.store, list: async () => { throw new Error('idb'); } };
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(downloads).toHaveLength(1);
    expect(loaded.ok).toBe(true);
  });
});

describe('abrir rápido', () => {
  /** Cuenta cuántas veces se lee un paquete de la base (lo caro de abrir un mapa guardado). */
  function counting(store: AreaStore): { store: AreaStore; reads: () => number } {
    let reads = 0;
    return {
      store: {
        ...store,
        get: async (id) => {
          reads++;
          return store.get(id);
        },
      },
      reads: () => reads,
    };
  }

  it('el mapa que se acaba de usar se reabre al instante desde la memoria, sin leer la base (el siguiente entreno o el mapa del recorrido)', async () => {
    const { deps, store } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    const spy = counting(store);
    const fast: ZoneDeps = { ...deps, store: spy.store };
    const again = await loadZoneFor(HOME.lat + 0.004, HOME.lon, fast);
    expect(again.ok).toBe(true);
    expect(spy.reads()).toBe(0);
    // Para dibujar el recorrido de ese entreno tampoco se vuelve a leer.
    const points = [{ lat: HOME.lat, lon: HOME.lon }, { lat: HOME.lat + 0.01, lon: HOME.lon + 0.01 }];
    expect(await loadStoredZoneCovering(points, fast)).not.toBeNull();
    expect(spy.reads()).toBe(0);
  });

  it('abrir desde la memoria sigue anotando el uso y es el mismo mapa', async () => {
    const { deps, store, clock } = setup();
    const first = await loadZoneFor(HOME.lat, HOME.lon, deps);
    clock.now += 60_000;
    const second = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(first.ok && second.ok && first.data === second.data).toBe(true);
    expect((await store.list())[0]!.lastUsedMs).toBe(clock.now);
  });

  it('pasados 20 minutos se vuelve a leer de la base (no se guarda en memoria para siempre)', async () => {
    const { deps, store, clock } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    clock.now += 21 * 60_000;
    const spy = counting(store);
    await loadZoneFor(HOME.lat, HOME.lon, { ...deps, store: spy.store });
    expect(spy.reads()).toBe(1);
  });

  it('si la zona se vuelve a bajar o se borra, lo recordado deja de valer', async () => {
    const { deps, store, clock } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    clock.now += 62 * DAY;
    await loadZoneFor(FAR.lat, FAR.lon, deps); // baja otra zona y la vieja (62 días sin usar) se borra
    await vi.waitFor(async () => expect(await store.list()).toHaveLength(1));
    const spy = counting(store);
    // La de casa ya no está: ni la memoria ni la base la sirven.
    expect(await loadStoredZoneCovering([{ lat: HOME.lat, lon: HOME.lon }], { store: spy.store, now: deps.now })).toBeNull();
  });

  it('limpiar lo viejo ocurre igualmente, pero sin hacer esperar al mapa', async () => {
    const { deps, store, clock } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    clock.now += 61 * DAY;
    await store.put({ ...(await store.list())[0]!, id: 'vieja', lastUsedMs: clock.now - 70 * DAY }, new ArrayBuffer(8));
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps); // abre la guardada y programa la limpieza
    expect(loaded.ok).toBe(true);
    await vi.waitFor(async () => expect((await store.list()).map((z) => z.id)).not.toContain('vieja'));
  });

  it('antes de saber dónde estás, abre la zona usada más recientemente (sin bajar nada)', async () => {
    const { deps, clock, downloads } = setup();
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    clock.now += DAY;
    await loadZoneFor(FAR.lat, FAR.lon, deps);
    forgetRememberedZoneForTests();
    const recent = await loadMostRecentStoredZone(deps);
    expect(recent).not.toBeNull();
    expect(recent!.box.minLat).toBeCloseTo(boxAround(FAR.lat, FAR.lon, 4000).minLat, 3);
    expect(downloads).toHaveLength(2);
  });

  it('sin ninguna zona guardada no hay mapa provisional', async () => {
    const { deps } = setup();
    expect(await loadMostRecentStoredZone(deps)).toBeNull();
  });
});


describe('el detalle (edificios y comercios) llega después de abrir el mapa (ronda 46)', () => {
  /** Como `setup`, pero la bajada de la zona solo trae lo ligero y el detalle se pide aparte con su propio servidor de mentira. */
  function setupDetail(options: { detail?: () => Response | Promise<Response> } = {}) {
    forgetRememberedZoneForTests();
    const store = createIdbAreaStore(new IDBFactory(), 'zonas-detalle');
    const clock = { now: Date.UTC(2026, 10, 9) };
    const detailRequests: string[] = [];
    const upgrades: Array<{ shapes: number; zoneId: string | null }> = [];
    const deps: ZoneDeps = {
      store,
      now: () => clock.now,
      download: async (lat, lon, onProgress) => {
        const fetchFn = (async () => new Response(JSON.stringify(overpassCityLight({ center: { lat, lon } })), { status: 200 })) as unknown as typeof fetch;
        return downloadZone(lat, lon, { fetchFn, endpoints: ['https://x.test'], now: () => clock.now, onProgress });
      },
      downloadDetail: (zone, base) => {
        const fetchFn = (async (_url: string, init?: RequestInit) => {
          detailRequests.push(String((init?.body as URLSearchParams).get('data')));
          return options.detail ? options.detail() : new Response(JSON.stringify(overpassCityDetail({ center: { lat: HOME.lat, lon: HOME.lon } })), { status: 200 });
        }) as unknown as typeof fetch;
        return downloadDetailFor(zone, base, { fetchFn, endpoints: ['https://x.test'], now: () => clock.now });
      },
      onUpgrade: (data) => upgrades.push({ shapes: data.pack.shapeCount, zoneId: data.zoneId }),
    };
    return { deps, store, clock, detailRequests, upgrades };
  }

  /** Deja que acabe el trabajo en segundo plano. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  };

  it('el mapa se abre SIN detalle y, después, se baja y se suma al guardado, avisando a quien lo tenga abierto', async () => {
    const { deps, store, detailRequests, upgrades } = setupDetail();
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const before = loaded.data.pack.shapeCount;
    expect(loaded.data.pack.meta.detail).toBeUndefined();
    await settle();
    expect(detailRequests).toHaveLength(1);
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]!.shapes).toBe(before + 2); // dos edificios
    expect(upgrades[0]!.zoneId).toBe(loaded.data.zoneId);
    const [saved] = await store.list();
    expect(saved!.detailMs).toBeDefined();
    expect(readPack((await store.get(saved!.id))!).meta.detail).toBeDefined();
    // La próxima vez se abre ya con detalle y no se vuelve a pedir.
    const again = await loadZoneFor(HOME.lat, HOME.lon, deps);
    await settle();
    expect(again.ok && again.data.pack.meta.detail).toBeTruthy();
    expect(detailRequests).toHaveLength(1);
  });

  it('si el detalle falla, el mapa sigue como estaba, no se avisa de nada y no se insiste hasta pasado un rato', async () => {
    const { deps, store, clock, detailRequests, upgrades } = setupDetail({ detail: () => new Response('x', { status: 504 }) });
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(loaded.ok).toBe(true);
    await settle();
    expect(upgrades).toHaveLength(0);
    expect(detailRequests).toHaveLength(1);
    const [tried] = await store.list();
    expect(tried!.detailMs).toBeUndefined();
    expect(tried!.detailTriedMs).toBe(clock.now);
    // Otra apertura enseguida: no vuelve a pedirlo.
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    await settle();
    expect(detailRequests).toHaveLength(1);
    // Pasado el plazo, sí lo reintenta.
    clock.now += DETAIL_RETRY_MS + 1000;
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    await settle();
    expect(detailRequests).toHaveLength(2);
  });

  it('si el detalle se corta porque la app pasó a segundo plano, no cuenta como intento: la próxima vez que se abra la zona se vuelve a pedir', async () => {
    const { deps, store, clock, detailRequests } = setupDetail();
    let paused = true;
    const realDetail = deps.downloadDetail!;
    deps.downloadDetail = (zone, base) => {
      if (paused) return Promise.reject(new ZoneError('paused', 'La app pasó a segundo plano.'));
      return realDetail(zone, base);
    };
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    await settle();
    const [cut] = await store.list();
    expect(cut!.detailMs).toBeUndefined();
    expect(cut!.detailTriedMs).toBe(0); // como si nunca se hubiera intentado
    expect(detailRequests).toHaveLength(0);
    // Con la app a la vista otra vez, y SIN esperar el plazo de los fallos, se vuelve a pedir y se completa.
    paused = false;
    clock.now += 60_000;
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    await settle();
    expect(detailRequests).toHaveLength(1);
    expect((await store.list())[0]!.detailMs).toBeDefined();
  });

  it('sin la función de detalle (o sin conexión) abrir el mapa funciona igual', async () => {
    const { deps } = setupDetail();
    delete deps.downloadDetail;
    const loaded = await loadZoneFor(HOME.lat, HOME.lon, deps);
    expect(loaded.ok).toBe(true);
    await settle();
  });

  it('una zona vieja guardada sin detalle lo recibe la próxima vez que se abre', async () => {
    const { deps, store, detailRequests } = setupDetail({ detail: () => new Response('x', { status: 504 }) });
    await loadZoneFor(HOME.lat, HOME.lon, deps);
    await settle();
    expect(detailRequests).toHaveLength(1);
    // Se borra la anotación del intento fallido (como si hubiera pasado el plazo) y el servidor ya contesta bien.
    const [zone] = await store.list();
    await store.update(zone!.id, { detailTriedMs: 0 });
    const good = setupDetail();
    good.deps.store = store;
    forgetRememberedZoneForTests();
    await loadZoneFor(HOME.lat, HOME.lon, good.deps);
    await settle();
    expect(good.detailRequests).toHaveLength(1);
    expect((await store.list())[0]!.detailMs).toBeDefined();
  });
});
