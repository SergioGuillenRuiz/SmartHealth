import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { deleteLocalData, storeNameFor } from './FatalScreen';

describe('storeNameFor', () => {
  it('la demostración tiene su propia base de datos; el uso normal, la suya', () => {
    expect(storeNameFor('')).toBe('smartring');
    expect(storeNameFor('?x=1')).toBe('smartring');
    expect(storeNameFor('?demo=1')).toBe('smartring-demo');
    expect(storeNameFor('?demo=keep&ring=sin-pulso')).toBe('smartring-demo');
  });
});

describe('deleteLocalData: empezar de cero cuando lo guardado rompe la app', () => {
  it('borra la base de datos entera y solo esa', async () => {
    for (const name of ['smartring-rec', 'otra-rec']) {
      const db = await openDB(name, 1, { upgrade: (d) => void d.createObjectStore('kv') });
      await db.put('kv', 'dato', 'clave');
      db.close();
    }
    await deleteLocalData('smartring-rec');
    const empty = await openDB('smartring-rec', 1, { upgrade: (d) => void d.createObjectStore('kv') });
    expect(await empty.get('kv', 'clave')).toBeUndefined(); // ya no está: se ha creado de nuevo, vacía
    empty.close();
    const other = await openDB('otra-rec', 1);
    expect(await other.get('kv', 'clave')).toBe('dato'); // la demás no se toca
    other.close();
  });

  it('con otra conexión abierta no se queda esperando: el borrado queda pendiente y la llamada vuelve', async () => {
    const open = await openDB('bloqueada-rec', 1, { upgrade: (d) => void d.createObjectStore('kv') });
    await expect(deleteLocalData('bloqueada-rec')).resolves.toBeUndefined();
    open.close();
  });

  it('borrar una base que no existe tampoco falla', async () => {
    await expect(deleteLocalData('no-existe-rec')).resolves.toBeUndefined();
  });
});
