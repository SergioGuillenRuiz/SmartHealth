import type { ZoneMeta } from '../../domain/nav/zones';

// Dónde se guardan las zonas de mapa bajadas: una base de IndexedDB aparte de la de los datos de la persona (`smartring`), para que ni las copias de seguridad ni «Borrar todo» la toquen
// (son datos de OpenStreetMap, se pueden volver a bajar). Dos almacenes: `meta` (lo que se lista, pequeño) y `packs` (el paquete, grande), para decidir qué borrar sin leer los paquetes.

export interface AreaStore {
  list(): Promise<ZoneMeta[]>;
  /** El paquete de una zona, o `null` si no está. */
  get(id: string): Promise<ArrayBuffer | null>;
  put(meta: ZoneMeta, buffer: ArrayBuffer): Promise<void>;
  /** Anota que se ha usado ahora. */
  touch(id: string, nowMs: number): Promise<void>;
  /** Cambia algo de lo que se sabe de una zona (sin tocar su paquete): p. ej. cuándo se intentó bajar su detalle. Una zona que ya no está no se crea. */
  update(id: string, change: Partial<Omit<ZoneMeta, 'id'>>): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
}

export const AREA_DB = 'smartring-maps';

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB falló.'));
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB falló.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB canceló la operación.'));
  });

export function createIdbAreaStore(factory: IDBFactory = indexedDB, name: string = AREA_DB): AreaStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> =>
    (opened ??= new Promise((resolve, reject) => {
      const open = factory.open(name, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('meta', { keyPath: 'id' });
        open.result.createObjectStore('packs');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => {
        opened = null;
        reject(open.error ?? new Error('No se pudo abrir la base de los mapas.'));
      };
    }));

  return {
    async list() {
      const tx = (await db()).transaction('meta', 'readonly');
      return (await request(tx.objectStore('meta').getAll())) as ZoneMeta[];
    },
    async get(id) {
      const tx = (await db()).transaction('packs', 'readonly');
      const found = (await request(tx.objectStore('packs').get(id))) as ArrayBuffer | undefined;
      return found ?? null;
    },
    async put(meta, buffer) {
      const tx = (await db()).transaction(['meta', 'packs'], 'readwrite');
      tx.objectStore('packs').put(buffer, meta.id);
      tx.objectStore('meta').put(meta);
      await finished(tx);
    },
    async touch(id, nowMs) {
      const tx = (await db()).transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const current = (await request(store.get(id))) as ZoneMeta | undefined;
      if (current) store.put({ ...current, lastUsedMs: nowMs });
      await finished(tx);
    },
    async update(id, change) {
      const tx = (await db()).transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const current = (await request(store.get(id))) as ZoneMeta | undefined;
      if (current) store.put({ ...current, ...change });
      await finished(tx);
    },
    async remove(ids) {
      if (ids.length === 0) return;
      const tx = (await db()).transaction(['meta', 'packs'], 'readwrite');
      for (const id of ids) {
        tx.objectStore('meta').delete(id);
        tx.objectStore('packs').delete(id);
      }
      await finished(tx);
    },
  };
}
