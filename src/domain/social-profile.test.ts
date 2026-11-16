import { describe, expect, it } from 'vitest';
import {
  AVATAR_PREFIX,
  cleanSocialProfile,
  editSocialProfile,
  encodeUid,
  handleOf,
  initialOf,
  isAvatar,
  isSocialProfile,
  isUid,
  isUntouched,
  MAX_AVATAR_CHARS,
  MAX_STATUS,
  newSocialProfile,
  normalizeStatus,
  normalizeUsername,
  publicCard,
  tagOf,
  usernameProblem,
} from './social-profile';

const bytesOf = (fill: number): Uint8Array => new Uint8Array(16).fill(fill);
const PHOTO = `${AVATAR_PREFIX}${'A'.repeat(400)}`;

describe('identificador único', () => {
  it('codifica 128 bits en 26 caracteres de Crockford', () => {
    expect(encodeUid(bytesOf(0))).toBe('0'.repeat(26));
    expect(encodeUid(bytesOf(255))).toBe(`${'Z'.repeat(25)}W`);
    expect(encodeUid(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))).toHaveLength(26);
    expect(() => encodeUid(new Uint8Array(15))).toThrow();
  });

  it('dos perfiles creados con bytes distintos no comparten identificador ni etiqueta (con probabilidad enorme)', () => {
    const seen = new Set<string>();
    const tags = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const uid = newSocialProfile(0, () => bytes).uid;
      expect(isUid(uid)).toBe(true);
      seen.add(uid);
      tags.add(tagOf(uid));
    }
    expect(seen.size).toBe(2000);
    // 2000 etiquetas de 20 bits: casi todas distintas (una colisión sería mala suerte, no un fallo).
    expect(tags.size).toBeGreaterThan(1990);
  });

  it('solo es un identificador lo que tiene la forma', () => {
    expect(isUid('0'.repeat(26))).toBe(true);
    expect(isUid('0'.repeat(25))).toBe(false);
    expect(isUid(`${'0'.repeat(25)}I`)).toBe(false); // la I no existe en Crockford
    expect(isUid(7)).toBe(false);
  });
});

describe('nombre de usuario', () => {
  it('se normaliza: sin @, sin tildes, en minúsculas y con guion bajo por los espacios', () => {
    expect(normalizeUsername('  @Ana María  ')).toBe('ana_maria');
    expect(normalizeUsername('JOSÉ.p')).toBe('jose.p');
    expect(normalizeUsername('@@x')).toBe('x');
  });

  it('acepta lo razonable y explica lo que no vale', () => {
    for (const ok of ['ana', 'ana_25', 'a.b.c', 'luis.g']) expect(usernameProblem(ok), ok).toBeNull();
    expect(usernameProblem('ab')).toMatch(/al menos 3/);
    expect(usernameProblem('a'.repeat(21))).toMatch(/Como mucho 20/);
    expect(usernameProblem('ana!')).toMatch(/Solo letras/);
    expect(usernameProblem('_ana')).toMatch(/empezar y acabar/);
    expect(usernameProblem('ana.')).toMatch(/empezar y acabar/);
    expect(usernameProblem('a..b')).toMatch(/dos signos/);
    expect(usernameProblem('a_.b')).toMatch(/dos signos/);
    expect(usernameProblem('admin')).toMatch(/reservado/);
    expect(usernameProblem('smartring')).toMatch(/reservado/);
  });

  it('el identificador completo lleva la etiqueta de su uid', () => {
    const p = { ...newSocialProfile(5, () => bytesOf(255)), username: 'ana' };
    expect(handleOf(p)).toBe('@ana#ZZZZ');
    expect(handleOf(newSocialProfile(5, () => bytesOf(0)))).toBeNull();
    expect(initialOf(p)).toBe('A');
    expect(initialOf({ username: '' })).toBeNull();
  });
});

describe('estado y foto', () => {
  it('el estado es de una línea y con los espacios recogidos', () => {
    expect(normalizeStatus('  hoy\n\n toca   correr \t')).toBe('hoy toca correr');
    expect(normalizeStatus('')).toBe('');
  });

  it('una foto vale si es un JPEG en texto que no pesa de más', () => {
    expect(isAvatar(PHOTO)).toBe(true);
    expect(isAvatar(`data:image/png;base64,${'A'.repeat(100)}`)).toBe(false);
    expect(isAvatar(AVATAR_PREFIX)).toBe(false);
    expect(isAvatar(`${AVATAR_PREFIX}${'A'.repeat(MAX_AVATAR_CHARS)}`)).toBe(false);
    expect(isAvatar(`${AVATAR_PREFIX}no es base64!`)).toBe(false);
    expect(isAvatar(null)).toBe(false);
  });
});

describe('editar el perfil', () => {
  const base = newSocialProfile(1_000, () => bytesOf(7));

  it('cambia lo que se pide, deja lo demás y anota la hora', () => {
    const result = editSocialProfile(base, { username: '@Ana', status: ' de camino ', photo: PHOTO }, 2_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({ uid: base.uid, username: 'ana', status: 'de camino', photo: PHOTO, createdMs: 1_000, updatedMs: 2_000 });
  });

  it('sin cambios devuelve el mismo perfil, con su hora', () => {
    const result = editSocialProfile(base, { username: '', status: '' }, 9_999);
    expect(result).toEqual({ ok: true, profile: base });
  });

  it('un nombre que no vale se rechaza y no cambia nada', () => {
    const result = editSocialProfile(base, { username: 'a' }, 2_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('username');
  });

  it('el estado demasiado largo y la foto inválida se rechazan', () => {
    const long = editSocialProfile(base, { status: 'x'.repeat(MAX_STATUS + 1) }, 2_000);
    expect(long.ok).toBe(false);
    const bad = editSocialProfile(base, { photo: 'http://example.com/a.jpg' }, 2_000);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe('photo');
  });

  it('quitar la foto la borra', () => {
    const withPhoto = { ...base, photo: PHOTO };
    const result = editSocialProfile(withPhoto, { photo: null }, 5_000);
    expect(result.ok && 'photo' in result.profile).toBe(false);
  });
});

describe('forma y limpieza', () => {
  const valid = { ...newSocialProfile(10, () => bytesOf(3)), username: 'ana', status: 'hola', photo: PHOTO };

  it('reconoce un perfil válido y rechaza lo que no lo es', () => {
    expect(isSocialProfile(valid)).toBe(true);
    expect(isSocialProfile({ ...valid, uid: 'corto' })).toBe(false);
    expect(isSocialProfile({ ...valid, username: 'a' })).toBe(false);
    expect(isSocialProfile({ ...valid, status: 'x'.repeat(MAX_STATUS + 1) })).toBe(false);
    expect(isSocialProfile({ ...valid, photo: 'http://x' })).toBe(false);
    expect(isSocialProfile({ ...valid, createdMs: -1 })).toBe(false);
    expect(isSocialProfile({ ...valid, updatedMs: Number.NaN })).toBe(false);
    expect(isSocialProfile(null)).toBe(false);
    expect(isSocialProfile([])).toBe(false);
    expect(isSocialProfile({ ...valid, username: '' })).toBe(true); // aún sin nombre
  });

  it('la copia limpia solo lleva los campos conocidos', () => {
    const dirty = { ...valid, secreto: 'x', status: '  hola\n' } as typeof valid;
    const clean = cleanSocialProfile(dirty);
    expect(clean).not.toHaveProperty('secreto');
    expect(clean.status).toBe('hola');
  });

  it('lo público no lleva nada de salud: solo identidad, nombre, estado y foto', () => {
    const card = publicCard(valid);
    expect(Object.keys(card).sort()).toEqual(['handle', 'photo', 'status', 'uid', 'updatedMs', 'username']);
    expect(card.handle).toBe(handleOf(valid));
  });

  it('un perfil recién creado está sin tocar; con nombre, estado o foto, ya no', () => {
    expect(isUntouched(newSocialProfile(1, () => bytesOf(1)))).toBe(true);
    expect(isUntouched(valid)).toBe(false);
  });
});
