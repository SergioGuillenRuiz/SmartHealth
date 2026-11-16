import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { PACK_VERSION } from '../../domain/nav/pack';
import { boxAround, type ZoneMeta } from '../../domain/nav/zones';
import { createIdbAreaStore } from './area-store';

const meta = (id: string, extra: Partial<ZoneMeta> = {}): ZoneMeta => ({ id, name: `Zona ${id}`, box: boxAround(40.4, -3.7, 4000), bytes: 16, createdMs: 1000, lastUsedMs: 1000, packVersion: PACK_VERSION, ...extra });
const bytes = (...values: number[]): ArrayBuffer => Uint8Array.from(values).buffer;
const fresh = () => createIdbAreaStore(new IDBFactory(), 'mapas-prueba');

describe('el almacén de zonas', () => {
  it('guarda una zona y la devuelve igual, con su lista aparte del paquete', async () => {
    const store = fresh();
    expect(await store.list()).toEqual([]);
    await store.put(meta('a'), bytes(1, 2, 3));
    expect(await store.list()).toEqual([meta('a')]);
    expect(new Uint8Array((await store.get('a'))!)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await store.get('no-existe')).toBeNull();
  });

  it('volver a guardar la misma zona la sustituye', async () => {
    const store = fresh();
    await store.put(meta('a'), bytes(1));
    await store.put(meta('a', { bytes: 99 }), bytes(9, 9));
    expect(await store.list()).toEqual([meta('a', { bytes: 99 })]);
    expect(new Uint8Array((await store.get('a'))!)).toEqual(Uint8Array.from([9, 9]));
  });

  it('anota el uso sin tocar el resto, y una zona que no existe no se inventa', async () => {
    const store = fresh();
    await store.put(meta('a'), bytes(1));
    await store.touch('a', 5000);
    await store.touch('fantasma', 5000);
    expect(await store.list()).toEqual([meta('a', { lastUsedMs: 5000 })]);
  });

  it('update cambia datos de la ficha sin tocar el paquete, y una zona que no existe no se inventa', async () => {
    const store = fresh();
    await store.put(meta('a'), bytes(1, 2));
    await store.update('a', { detailTriedMs: 5000 });
    expect(await store.list()).toEqual([meta('a', { detailTriedMs: 5000 })]);
    expect(new Uint8Array((await store.get('a'))!)).toEqual(Uint8Array.from([1, 2]));
    await store.update('nada', { detailTriedMs: 1 });
    expect(await store.list()).toHaveLength(1);
  });

  it('borra la ficha y el paquete juntos', async () => {
    const store = fresh();
    await store.put(meta('a'), bytes(1));
    await store.put(meta('b'), bytes(2));
    await store.remove(['a', 'zzz']);
    expect((await store.list()).map((z) => z.id)).toEqual(['b']);
    expect(await store.get('a')).toBeNull();
    await store.remove([]);
  });

  it('la base es aparte de la de los datos de la persona', async () => {
    const factory = new IDBFactory();
    const store = createIdbAreaStore(factory, 'smartring-maps');
    await store.put(meta('a'), bytes(1));
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).toEqual(['smartring-maps']);
  });
});
