// El perfil de la persona de cara a los demás: la base de una futura mini-red social. Hoy vive solo en el móvil (y en la copia de seguridad); lo único pensado para salir algún día
// es lo que sale en `publicCard` (identificador, nombre de usuario, estado y foto): nada de salud, peso ni comidas. Detalle del diseño y de lo que falta (un servidor): `docs/social.md`.
//
// Quién es: `uid`, 128 bits aleatorios que se crean una sola vez al abrir la app y no cambian nunca (es la identidad). El nombre de usuario sí se puede cambiar; para que dos personas
// con el mismo nombre no se confundan, el identificador completo lleva una etiqueta sacada del `uid` (`@ana#7K3Q`). Reservar un nombre EN EXCLUSIVA entre todas las personas necesita un
// servidor que lo vigile: sin él, lo único que se puede asegurar es que el identificador completo no se repite.

export interface SocialProfile {
  /** Identidad única e inmutable (26 caracteres, base 32 de Crockford). */
  uid: string;
  /** Nombre de usuario sin la `@` (`''` hasta que la persona lo elige). */
  username: string;
  /** Un estado corto, de una línea (`''` si no hay). */
  status: string;
  /** Foto de perfil: un JPEG cuadrado pequeño en texto (`data:`). */
  photo?: string;
  createdMs: number;
  updatedMs: number;
}

export const MIN_USERNAME = 3;
export const MAX_USERNAME = 20;
export const MAX_STATUS = 80;
export const AVATAR_PREFIX = 'data:image/jpeg;base64,';
/** Una foto de perfil reducida (256 × 256) pesa unos 15–30 KB: con esto cabe de sobra y una copia hostil no mete megas. */
export const MAX_AVATAR_CHARS = 60_000;
/** El lado de la foto de perfil guardada (px). */
export const AVATAR_SIDE = 256;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const UID_LENGTH = 26;
const UID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TAG_LENGTH = 4;

/** Reservados: nombres con los que alguien podría hacerse pasar por la app o por quien la gestiona. */
const RESERVED = new Set(['admin', 'administrador', 'soporte', 'ayuda', 'smartring', 'smarthealth', 'sistema', 'system', 'root', 'moderador', 'oficial', 'anonimo', 'usuario', 'null', 'undefined']);

/** Codifica 16 bytes (128 bits) como 26 caracteres en base 32 de Crockford (sin I, L, O, U: no se confunden al leerlos). */
export function encodeUid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RangeError('Un identificador son 16 bytes.');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

export const isUid = (value: unknown): value is string => typeof value === 'string' && value.length === UID_LENGTH && UID_PATTERN.test(value);

/** La etiqueta corta del identificador completo: los 4 primeros caracteres del `uid` (20 bits: un millón de combinaciones entre personas con el mismo nombre). */
export const tagOf = (uid: string): string => uid.slice(0, TAG_LENGTH);

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw new Error('Este dispositivo no puede generar un identificador seguro.');
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Un perfil nuevo, sin nombre de usuario todavía. `random` solo se cambia en las pruebas. */
export function newSocialProfile(nowMs: number, random: () => Uint8Array = randomBytes): SocialProfile {
  return { uid: encodeUid(random()), username: '', status: '', createdMs: nowMs, updatedMs: nowMs };
}

/** Lo que alguien teclea como nombre de usuario, llevado a la forma en que se guarda: sin `@`, sin tildes, en minúsculas y con guion bajo en vez de espacios. */
export function normalizeUsername(input: string): string {
  return input
    .trim()
    .replace(/^@+/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/** Por qué un nombre de usuario (ya normalizado) no vale, o `null` si vale. */
export function usernameProblem(username: string): string | null {
  if (username.length < MIN_USERNAME) return `Pon al menos ${MIN_USERNAME} caracteres.`;
  if (username.length > MAX_USERNAME) return `Como mucho ${MAX_USERNAME} caracteres.`;
  if (!/^[a-z0-9_.]+$/.test(username)) return 'Solo letras sin tilde, números, punto y guion bajo.';
  if (!/^[a-z0-9]/.test(username) || !/[a-z0-9]$/.test(username)) return 'Tiene que empezar y acabar con una letra o un número.';
  if (/[_.]{2}/.test(username)) return 'No pongas dos signos seguidos.';
  if (RESERVED.has(username)) return 'Ese nombre está reservado: elige otro.';
  return null;
}

/** El estado tal como se guarda: una sola línea, con los espacios recogidos. */
export const normalizeStatus = (input: string): string => input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

export const isAvatar = (value: unknown): value is string =>
  typeof value === 'string' && value.length > AVATAR_PREFIX.length && value.length <= MAX_AVATAR_CHARS && value.startsWith(AVATAR_PREFIX) && /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(AVATAR_PREFIX.length));

/** ¿Es un perfil con la forma y los valores que guarda la app? (también para lo que llega en una copia). */
export function isSocialProfile(value: unknown): value is SocialProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const finiteMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!isUid(p.uid) || !finiteMs(p.createdMs) || !finiteMs(p.updatedMs)) return false;
  if (typeof p.username !== 'string' || (p.username !== '' && usernameProblem(p.username) !== null)) return false;
  if (typeof p.status !== 'string' || p.status.length > MAX_STATUS) return false;
  return p.photo === undefined || isAvatar(p.photo);
}

/** Una copia reconstruida solo con los campos conocidos. */
export const cleanSocialProfile = (p: SocialProfile): SocialProfile => ({
  uid: p.uid,
  username: p.username,
  status: normalizeStatus(p.status),
  ...(p.photo !== undefined ? { photo: p.photo } : {}),
  createdMs: p.createdMs,
  updatedMs: p.updatedMs,
});

/** Lo que se cambia al editar el perfil (lo que no viene, no se toca). `photo: null` quita la foto. */
export interface SocialEdit {
  username?: string;
  status?: string;
  photo?: string | null;
}

export type SocialEditResult = { ok: true; profile: SocialProfile } | { ok: false; error: string; field: 'username' | 'status' | 'photo' };

/** Aplica una edición comprobándola. Con todo igual que antes, devuelve el mismo perfil (sin cambiar la fecha). */
export function editSocialProfile(current: SocialProfile, edit: SocialEdit, nowMs: number): SocialEditResult {
  let next: SocialProfile = current;
  if (edit.username !== undefined) {
    const username = normalizeUsername(edit.username);
    // Dejarlo vacío (volver a no tener nombre) se admite; lo escrito tiene que valer.
    if (username !== '') {
      const problem = usernameProblem(username);
      if (problem !== null) return { ok: false, field: 'username', error: problem };
    }
    next = { ...next, username };
  }
  if (edit.status !== undefined) {
    const status = normalizeStatus(edit.status);
    if (status.length > MAX_STATUS) return { ok: false, field: 'status', error: `El estado admite ${MAX_STATUS} caracteres como mucho.` };
    next = { ...next, status };
  }
  if (edit.photo !== undefined) {
    if (edit.photo === null) {
      const { photo: _removed, ...rest } = next;
      next = rest;
    } else if (isAvatar(edit.photo)) {
      next = { ...next, photo: edit.photo };
    } else {
      return { ok: false, field: 'photo', error: 'La foto no es una imagen válida o pesa demasiado.' };
    }
  }
  const changed = next.username !== current.username || next.status !== current.status || next.photo !== current.photo;
  return { ok: true, profile: changed ? { ...next, updatedMs: nowMs } : current };
}

/** El identificador completo, con el que dos personas con el mismo nombre no se confunden (`@ana#7K3Q`), o `null` si aún no hay nombre de usuario. */
export const handleOf = (p: Pick<SocialProfile, 'uid' | 'username'>): string | null => (p.username === '' ? null : `@${p.username}#${tagOf(p.uid)}`);

/** Lo único del perfil que se pensó para compartir con otras personas algún día: nada de salud, de peso ni de comidas. */
export interface PublicCard {
  uid: string;
  handle: string | null;
  username: string;
  status: string;
  photo?: string;
  updatedMs: number;
}

export const publicCard = (p: SocialProfile): PublicCard => ({
  uid: p.uid,
  handle: handleOf(p),
  username: p.username,
  status: p.status,
  ...(p.photo !== undefined ? { photo: p.photo } : {}),
  updatedMs: p.updatedMs,
});

/** Un perfil sin tocar (recién creado por la app): sirve para saber si al restaurar una copia puede cambiarse por el de la copia sin perder nada. */
export const isUntouched = (p: SocialProfile): boolean => p.username === '' && p.status === '' && p.photo === undefined;

/** Las iniciales para el círculo cuando no hay foto: la primera letra del nombre de usuario, o `null` si no lo hay. */
export const initialOf = (p: Pick<SocialProfile, 'username'>): string | null => (p.username === '' ? null : p.username.charAt(0).toUpperCase());
