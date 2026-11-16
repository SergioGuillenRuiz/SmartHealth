import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../ble/sim/dataset';
import { SimulatedTransport } from '../ble/sim/ring';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import { AVATAR_PREFIX, handleOf } from '../domain/social-profile';
import { reloadAll } from './actions';
import { saveSocial } from './social';
import { installServices } from './services';
import { socialProfile } from './state';

const NOW = new Date(2026, 10, 3, 9, 0, 0).getTime();
let counter = 0;
let store: IdbStore;

beforeEach(async () => {
  store = await openIdbStore(`social-${++counter}`);
  installServices({ store, transport: new SimulatedTransport(buildDemoDataset({ nowMs: NOW, days: 1, seed: 2 })), now: () => NOW, demo: false });
  socialProfile.value = null;
});

describe('perfil social en la app', () => {
  it('la primera vez se crea con su identificador y sin nombre; la siguiente se lee el mismo', async () => {
    await reloadAll();
    const first = socialProfile.value;
    expect(first?.username).toBe('');
    expect(first?.uid).toHaveLength(26);
    expect(handleOf(first!)).toBeNull();
    socialProfile.value = null;
    await reloadAll();
    expect(socialProfile.peek()?.uid).toBe(first?.uid);
  });

  it('editar guarda en el almacén y en la señal; la identidad no cambia', async () => {
    await reloadAll();
    const uid = socialProfile.value!.uid;
    const result = await saveSocial({ username: '@Ana María', status: 'a por el día' });
    expect(result.ok).toBe(true);
    expect(socialProfile.value).toMatchObject({ uid, username: 'ana_maria', status: 'a por el día', updatedMs: NOW });
    expect(await store.getSocial()).toMatchObject({ username: 'ana_maria' });
    expect(handleOf(socialProfile.value!)).toBe(`@ana_maria#${uid.slice(0, 4)}`);
  });

  it('un nombre que no vale se rechaza y no cambia nada', async () => {
    await reloadAll();
    const before = socialProfile.value;
    const result = await saveSocial({ username: 'x!' });
    expect(result.ok).toBe(false);
    expect(socialProfile.value).toBe(before);
    expect((await store.getSocial())?.username).toBe('');
  });

  it('la foto se guarda y se puede quitar', async () => {
    await reloadAll();
    const photo = `${AVATAR_PREFIX}${'A'.repeat(300)}`;
    expect((await saveSocial({ photo })).ok).toBe(true);
    expect(socialProfile.value?.photo).toBe(photo);
    await saveSocial({ photo: null });
    expect(socialProfile.value).not.toHaveProperty('photo');
    expect((await saveSocial({ photo: 'http://x/a.jpg' })).ok).toBe(false);
  });

  it('«Borrar todo» crea una identidad nueva', async () => {
    await reloadAll();
    const uid = socialProfile.value!.uid;
    await store.wipe();
    await reloadAll();
    expect(socialProfile.value?.uid).toHaveLength(26);
    expect(socialProfile.value?.uid).not.toBe(uid);
  });
});
