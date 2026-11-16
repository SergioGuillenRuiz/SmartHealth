import { afterEach, describe, expect, it, vi } from 'vitest';
import { overpassCity, overpassCityDetail, overpassCityLight } from '../../domain/nav/overpass.test-support';
import { NO_NAME, nameOf, PACK_VERSION, PLACE, readPack, SHAPE } from '../../domain/nav/pack';
import { zoneCovers } from '../../domain/nav/zones';
import { downloadDetailFor, downloadZone, ZoneError, ZONE_MESSAGES, type DownloadProgress } from './area-download';

const ENDPOINTS = ['https://uno.test/api', 'https://dos.test/api'] as const;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const POS = { lat: 40.4168, lon: -3.7038 };

type Call = { url: string; body: string };
function server(handler: (call: Call, n: number) => Response | Promise<Response>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const call = { url, body: String((init?.body as URLSearchParams | undefined)?.get('data') ?? '') };
    calls.push(call);
    return handler(call, calls.length);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

afterEach(() => vi.unstubAllGlobals());

/** `count` parques (o edificios) pequeños y distintos alrededor del centro, para pasar de los 8000 objetos con los que la construcción cede el paso. */
function manyShapes(count: number, tags: Record<string, string>): NonNullable<ReturnType<typeof overpassCity>['elements']> {
  const out: NonNullable<ReturnType<typeof overpassCity>['elements']> = [];
  for (let i = 0; i < count; i++) {
    const lat = 40.4168 + (i % 90) * 0.00012;
    const lon = -3.7038 + Math.floor(i / 90) * 0.00012;
    const d = 0.00004;
    const ring = [
      { lat, lon },
      { lat: lat + d, lon },
      { lat: lat + d, lon: lon + d },
      { lat, lon: lon + d },
      { lat, lon },
    ];
    out.push({ type: 'way', id: 9_000_000 + i, nodes: ring.map((_, k) => 9_000_000_000 + i * 10 + (k % 4)), geometry: ring, tags });
  }
  return out;
}

describe('bajar el mapa de una zona', () => {
  it('pide a Overpass la zona de la posición y devuelve un paquete listo para guardar', async () => {
    const { fetchFn, calls } = server(() => json(overpassCity()));
    const progress: DownloadProgress[] = [];
    const zone = await downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 12345, onProgress: (p) => progress.push(p) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINTS[0]);
    expect(calls[0]!.body).toMatch(/^\[out:json\]/);
    expect(zone.meta).toMatchObject({ createdMs: 12345, lastUsedMs: 12345, packVersion: PACK_VERSION, name: 'Barrio Centro' });
    expect(zone.meta.bytes).toBe(zone.buffer.byteLength);
    expect(zone.meta.id).toMatch(/^z40\.417_-3\.704$/);
    expect(zoneCovers(zone.meta.box, POS.lat, POS.lon)).toBe(true);
    expect(readPack(zone.buffer).meta.name).toBe('Barrio Centro');
    expect(progress[0]).toEqual({ stage: 'download', bytes: 0 }); // en cuanto empieza, aunque el servidor tarde en contestar
    expect(progress.some((p) => p.stage === 'download' && p.bytes > 1000)).toBe(true);
    expect(progress.at(-1)).toEqual({ stage: 'build' });
  });

  it('con la app oculta (señal cortada) mientras baja, se para con su propio motivo y no prueba otro servidor', async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = server(() => {
      controller.abort();
      throw new DOMException('abortado', 'AbortError');
    });
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1, signal: controller.signal })).rejects.toMatchObject({ code: 'paused', message: ZONE_MESSAGES.paused });
    expect(calls).toHaveLength(1);
    expect(ZONE_MESSAGES.paused).toMatch(/segundo plano/);
  });

  it('si se corta justo al empezar a construir, no construye; y si se corta a mitad (cada 8000 objetos), tampoco acaba', async () => {
    const controller = new AbortController();
    const { fetchFn } = server(() => json(overpassCity()));
    await expect(
      downloadZone(POS.lat, POS.lon, {
        fetchFn,
        endpoints: ENDPOINTS,
        now: () => 1,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.stage === 'build') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'paused' });

    const mid = new AbortController();
    const big = { elements: [...(overpassCityLight().elements ?? []), ...manyShapes(9000, { leisure: 'park', name: 'Plaza' })] };
    const bigServer = server(() => json(big));
    await expect(
      downloadZone(POS.lat, POS.lon, {
        fetchFn: bigServer.fetchFn,
        endpoints: ENDPOINTS,
        now: () => 1,
        signal: mid.signal,
        onProgress: (p) => {
          if (p.stage === 'build') queueMicrotask(() => mid.abort()); // se oculta ya construyendo
        },
      }),
    ).rejects.toMatchObject({ code: 'paused' });
    // Sin cortarla, el mismo mapa grande se construye entero (la prueba de que el corte es lo que lo paró).
    const whole = await downloadZone(POS.lat, POS.lon, { fetchFn: bigServer.fetchFn, endpoints: ENDPOINTS, now: () => 1 });
    expect(whole.buffer.byteLength).toBeGreaterThan(0);
  });

  it('si el primer servidor está saturado prueba el segundo', async () => {
    const { fetchFn, calls } = server((_, n) => (n === 1 ? new Response('busy', { status: 429 }) : json(overpassCity())));
    const zone = await downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 });
    expect(calls.map((c) => c.url)).toEqual([...ENDPOINTS]);
    expect(zone.meta.name).toBe('Barrio Centro');
  });

  it('si el servidor se corta a medias (remark) prueba una zona más pequeña', async () => {
    const { fetchFn, calls } = server((call) => (call.body.includes('bbox:40.38') ? json({ elements: [], remark: 'runtime error: Query timed out' }) : json(overpassCity())));
    const zone = await downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 });
    const sizes = calls.map((c) => c.body.match(/bbox:([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)/)!.slice(1).map(Number));
    // La grande y, como no pudo, la reducida.
    expect(sizes).toHaveLength(2);
    expect(sizes[1]![2]! - sizes[1]![0]!).toBeLessThan(sizes[0]![2]! - sizes[0]![0]!);
    expect(zone.meta.box.maxLat - zone.meta.box.minLat).toBeCloseTo((2 * 2500) / 111_195, 3);
  });

  it('abrir el mapa NO espera a los edificios ni a los comercios: la consulta de la zona solo pide lo ligero y el paquete aún no lleva detalle (ronda 46)', async () => {
    const { fetchFn, calls } = server(() => json(overpassCityLight()));
    const zone = await downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 });
    const body = calls[0]!.body;
    expect(body).not.toContain('way["building"]');
    expect(body).not.toContain('node["shop"]');
    expect(body).not.toContain('"bus_stop"');
    expect(body).toContain('way["highway"');
    expect(readPack(zone.buffer).meta.detail).toBeUndefined();
    expect(zone.meta.detailMs).toBeUndefined();
    expect(zoneCovers(zone.meta.box, POS.lat, POS.lon)).toBe(true);
  });

  it('si nadie contesta dice que los servidores están saturados o que falló', async () => {
    const busy = server(() => new Response('x', { status: 504 }));
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn: busy.fetchFn, endpoints: ENDPOINTS, now: () => 1 })).rejects.toMatchObject({ code: 'busy', message: ZONE_MESSAGES.busy });
    const broken = server(() => new Response('x', { status: 400 }));
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn: broken.fetchFn, endpoints: ENDPOINTS, now: () => 1 })).rejects.toMatchObject({ code: 'failed' });
    const garbage = server(() => new Response('<html>no es json</html>', { status: 200 }));
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn: garbage.fetchFn, endpoints: ENDPOINTS, now: () => 1 })).rejects.toMatchObject({ code: 'failed' });
  });

  it('un servidor que rechaza por exceso de peticiones (429) o está caído (503) no se vuelve a probar con una zona más pequeña: serían peticiones inútiles', async () => {
    for (const status of [429, 503, 502]) {
      const { fetchFn, calls } = server(() => new Response('x', { status }));
      await expect(downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 }), String(status)).rejects.toMatchObject({ code: 'busy' });
      expect(calls.map((c) => c.url), String(status)).toEqual([...ENDPOINTS]); // uno por servidor, nada más
    }
  });

  it('un 504 (se le acabó el tiempo al servidor: la consulta era demasiado pesada) sí prueba una zona más pequeña', async () => {
    const { fetchFn, calls } = server((call) => (call.body.includes('bbox:40.38') ? new Response('x', { status: 504 }) : json(overpassCity())));
    const zone = await downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 });
    expect(calls).toHaveLength(3); // la grande en los dos servidores (los dos se cortan) y la pequeña en el primero
    expect(zone.meta.box.maxLat - zone.meta.box.minLat).toBeCloseTo((2 * 2500) / 111_195, 3);
  });

  it('sin conexión ni lo intenta', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { fetchFn, calls } = server(() => json(overpassCity()));
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 })).rejects.toMatchObject({ code: 'offline' });
    expect(calls).toHaveLength(0);
  });

  it('un fallo de red a mitad (el móvil pierde la señal) se dice sin conexión', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const fetchFn = (async () => {
      vi.stubGlobal('navigator', { onLine: false });
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 })).rejects.toMatchObject({ code: 'offline' });
  });

  it('una zona sin calles se dice vacía y no insiste con una más pequeña', async () => {
    const { fetchFn, calls } = server(() => json({ elements: [{ type: 'node', id: 1, lat: 40.4, lon: -3.7, tags: { place: 'village', name: 'Solo' } }] }));
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1 })).rejects.toMatchObject({ code: 'empty' });
    expect(calls).toHaveLength(1);
  });

  it('un servidor que no contesta se corta a tiempo y se pasa al siguiente', async () => {
    const { fetchFn, calls } = server((call) => (call.url === ENDPOINTS[0] ? (new Promise<Response>(() => undefined) as unknown as Response) : json(overpassCity())));
    const hung = (async (url: string, init?: RequestInit) => {
      if (url === ENDPOINTS[0]) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('abortado', 'AbortError'))));
      }
      return fetchFn(url, init);
    }) as unknown as typeof fetch;
    const zone = await downloadZone(POS.lat, POS.lon, { fetchFn: hung, endpoints: ENDPOINTS, now: () => 1, timeoutMs: 30 });
    expect(zone.meta.name).toBe('Barrio Centro');
    expect(calls.map((c) => c.url)).toEqual([ENDPOINTS[1]]);
  });

  it('una respuesta enorme se corta (algo va mal)', async () => {
    const big = new Response(new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array(100 * 1024 * 1024)); c.enqueue(new Uint8Array(100 * 1024 * 1024)); c.close(); } }), { status: 200 });
    const { fetchFn } = server(() => big);
    await expect(downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: [ENDPOINTS[0]], now: () => 1 })).rejects.toBeInstanceOf(ZoneError);
  });
});


describe('bajar el detalle de una zona ya guardada (ronda 46)', () => {
  const baseZone = async (): Promise<Awaited<ReturnType<typeof downloadZone>>> => {
    const { fetchFn } = server(() => json(overpassCityLight()));
    return downloadZone(POS.lat, POS.lon, { fetchFn, endpoints: ENDPOINTS, now: () => 1000 });
  };

  it('pide SOLO el detalle (sin calles) en una caja de ±1 km centrada en la zona y lo suma al paquete guardado', async () => {
    const zone = await baseZone();
    const before = readPack(zone.buffer);
    const { fetchFn, calls } = server(() => json(overpassCityDetail()));
    const upgraded = await downloadDetailFor(zone.meta, zone.buffer, { fetchFn, endpoints: ENDPOINTS, now: () => 5000 });
    expect(upgraded).not.toBeNull();
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body).toContain('way["building"]');
    expect(body).toContain('node["shop"]');
    expect(body).not.toContain('way["highway"~');
    const pack = readPack(upgraded!.buffer);
    // Las calles son las mismas; ahora hay edificios, la panadería, el café y la parada.
    expect(pack.nodeCount).toBe(before.nodeCount);
    expect(pack.edgeCount).toBe(before.edgeCount);
    expect(pack.shapeCount).toBe(before.shapeCount + 2);
    expect(Array.from(pack.shapeKind).filter((kind) => kind === SHAPE.BUILDING)).toHaveLength(2);
    expect(pack.placeCount).toBe(before.placeCount + 3);
    const names = Array.from({ length: pack.placeCount }, (_, i) => (pack.placeName[i] === NO_NAME ? '' : nameOf(pack, pack.placeName[i]!)));
    expect(names).toContain('Panadería Sol');
    expect(names).toContain('Café del Parque');
    expect(Array.from(pack.placeKind)).toContain(PLACE.SHOP);
    const detail = pack.meta.detail!;
    expect(detail.maxLat - detail.minLat).toBeCloseTo((2 * 1000) / 111_195, 3);
    expect(upgraded!.meta).toMatchObject({ id: zone.meta.id, detailMs: 5000, createdMs: 1000, bytes: upgraded!.buffer.byteLength });
  });

  it('no hace esperar ni molesta: sin conexión, con un servidor que falla o con basura devuelve null, sin avisar de nada', async () => {
    const zone = await baseZone();
    vi.stubGlobal('navigator', { onLine: false });
    const offline = server(() => json(overpassCityDetail()));
    expect(await downloadDetailFor(zone.meta, zone.buffer, { fetchFn: offline.fetchFn, endpoints: ENDPOINTS, now: () => 1 })).toBeNull();
    expect(offline.calls).toHaveLength(0);
    vi.unstubAllGlobals();
    for (const handler of [() => new Response('x', { status: 504 }), () => new Response('<html>', { status: 200 }), () => json({ elements: [], remark: 'runtime error: Query timed out' })]) {
      const broken = server(handler);
      expect(await downloadDetailFor(zone.meta, zone.buffer, { fetchFn: broken.fetchFn, endpoints: ENDPOINTS, now: () => 1 })).toBeNull();
    }
  });

  it('un servidor que no acaba esta consulta no se repite con el otro más de lo justo: cada uno una vez', async () => {
    const zone = await baseZone();
    const { fetchFn, calls } = server(() => new Response('x', { status: 504 }));
    expect(await downloadDetailFor(zone.meta, zone.buffer, { fetchFn, endpoints: ENDPOINTS, now: () => 1 })).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([...ENDPOINTS]);
  });

  it('si el centro no tiene nada que sumar (ni edificios ni comercios) no toca el mapa', async () => {
    const zone = await baseZone();
    const { fetchFn } = server(() => json({ elements: [] }));
    expect(await downloadDetailFor(zone.meta, zone.buffer, { fetchFn, endpoints: ENDPOINTS, now: () => 1 })).toBeNull();
  });

  it('lo que el servidor devuelve de más (una respuesta enorme) se corta y se deja', async () => {
    const zone = await baseZone();
    const huge = server(() => new Response(new Uint8Array(1)));
    // Una respuesta que no es JSON válido tampoco rompe nada.
    expect(await downloadDetailFor(zone.meta, zone.buffer, { fetchFn: huge.fetchFn, endpoints: ENDPOINTS, now: () => 1 })).toBeNull();
  });

  it('cancelada porque la app se ocultó, no sigue y lo dice (`paused`): quien lo pidió no cuenta el intento', async () => {
    const zone = await baseZone();
    const controller = new AbortController();
    controller.abort();
    const { fetchFn, calls } = server(() => json(overpassCityDetail()));
    await expect(downloadDetailFor(zone.meta, zone.buffer, { fetchFn, endpoints: ENDPOINTS, now: () => 1, signal: controller.signal })).rejects.toMatchObject({ code: 'paused' });
    expect(calls).toHaveLength(0);
  });

  it('si se oculta mientras baja o mientras construye, también se corta con `paused`', async () => {
    const zone = await baseZone();
    const duringFetch = new AbortController();
    const slow = server(() => {
      duringFetch.abort();
      throw new DOMException('abortado', 'AbortError');
    });
    await expect(downloadDetailFor(zone.meta, zone.buffer, { fetchFn: slow.fetchFn, endpoints: ENDPOINTS, now: () => 1, signal: duringFetch.signal })).rejects.toMatchObject({ code: 'paused' });
    expect(slow.calls).toHaveLength(1); // no prueba el otro servidor

    const duringBuild = new AbortController();
    const big = { elements: manyShapes(9000, { building: 'yes' }) };
    const bigServer = server(() => {
      queueMicrotask(() => duringBuild.abort());
      return json(big);
    });
    await expect(downloadDetailFor(zone.meta, zone.buffer, { fetchFn: bigServer.fetchFn, endpoints: ENDPOINTS, now: () => 1, signal: duringBuild.signal })).rejects.toMatchObject({ code: 'paused' });
  });
});
