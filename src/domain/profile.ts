import { daysBetween, isValidDayKey, parseDayKey, type DayKey } from './dates';

export type Sex = 'male' | 'female';

/**
 * Datos personales VIGENTES DESDE `date`. Una persona cambia con el tiempo (peso, a veces la altura o la
 * zancada) y las estimaciones de cada día deben usar los valores que regían ese día, no los actuales:
 * por eso el perfil es un historial de entradas y no un único registro.
 */
export interface ProfileEntry {
  /** Primer día en que rigen estos valores. */
  date: DayKey;
  heightCm: number;
  weightKg: number;
  sex: Sex;
  birthDate: DayKey;
  /** Longitud de zancada (paso) medida o fijada a mano. Si falta, se deriva de la altura. */
  strideCm?: number;
  /**
   * La zancada no la fijó la persona: la dedujo la app de sus paseos con GPS (ver `autoStrideEntry`). Se vuelve a ajustar con paseos
   * nuevos; la que fija la persona (sin esta marca) manda siempre.
   */
  strideAuto?: boolean;
  /**
   * La entrada solo existe para fijar la zancada (una calibración): arrastra el peso anterior sin ser una pesada. No
   * sale como punto en la evolución del peso ni hace pasar por «al día» un peso que no se ha vuelto a medir.
   */
  strideOnly?: boolean;
}

export interface ResolvedProfile extends ProfileEntry {
  /** `true` si el día consultado es anterior a la primera entrada y se usan los primeros datos conocidos. */
  extrapolated: boolean;
}

/**
 * Valores genéricos para cuando aún no se ha introducido nada. Son solo un punto de partida para que la
 * app funcione; la interfaz avisa de que las estimaciones usan datos genéricos hasta completar el perfil.
 */
export const GENERIC_PROFILE: Omit<ProfileEntry, 'date'> = {
  heightCm: 170,
  weightKg: 70,
  sex: 'male',
  birthDate: '1990-01-01',
};

export function sortProfile(history: readonly ProfileEntry[]): ProfileEntry[] {
  return [...history].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Una calibración de zancada (`strideOnly`) no trae datos propios, solo la zancada: peso, altura, sexo y nacimiento los
 * toma de la última entrada anterior que SÍ es una pesada, tal como está ahora. Así un peso corregido, o apuntado después
 * con una fecha pasada, llega también a los días posteriores a la calibración (la copia que guardó al crearse se ignora).
 * Sin ninguna entrada anterior que lo sea, se queda con lo que traía.
 */
export function withInheritedData(history: readonly ProfileEntry[], entry: ProfileEntry): ProfileEntry {
  if (!entry.strideOnly) return entry;
  const before = sortProfile(history).filter((e) => !e.strideOnly && e.date < entry.date);
  const source = before[before.length - 1];
  return source ? { ...entry, heightCm: source.heightCm, weightKg: source.weightKg, sex: source.sex, birthDate: source.birthDate } : entry;
}

/** Entrada vigente el día `day` (la última con `date ≤ day`), con los datos que le corresponden (ver `withInheritedData`). */
export function profileAt(history: readonly ProfileEntry[], day: DayKey): ResolvedProfile | null {
  if (history.length === 0) return null;
  const sorted = sortProfile(history);
  let current: ProfileEntry | undefined;
  for (const entry of sorted) {
    if (entry.date <= day) current = entry;
    else break;
  }
  if (current) return { ...withInheritedData(sorted, current), extrapolated: false };
  const first = sorted[0];
  return first ? { ...withInheritedData(sorted, first), extrapolated: true } : null;
}

/** El peso que rige el día `day`; `null` si es anterior a la primera pesada (no se inventa un peso). */
export function weightOn(history: readonly ProfileEntry[], day: DayKey): number | null {
  const found = profileAt(history, day);
  return found && !found.extrapolated ? found.weightKg : null;
}

/** Edad cumplida en años el día `day`. */
export function ageAt(birthDate: DayKey, day: DayKey): number {
  const b = parseDayKey(birthDate);
  const d = parseDayKey(day);
  let age = d.year - b.year;
  if (d.month < b.month || (d.month === b.month && d.day < b.day)) age--;
  return Math.max(0, age);
}

/** Reemplaza la entrada de la misma fecha o la inserta; devuelve el historial ordenado. */
export function upsertProfileEntry(history: readonly ProfileEntry[], entry: ProfileEntry): ProfileEntry[] {
  return sortProfile([...history.filter((e) => e.date !== entry.date), entry]);
}

/** Serie de peso por fecha (evolución del peso). */
export function weightSeries(history: readonly ProfileEntry[]): Array<{ date: DayKey; weightKg: number }> {
  return sortProfile(history)
    .filter((e) => !e.strideOnly)
    .map((e) => ({ date: e.date, weightKg: e.weightKg }));
}

/** Errores de validación en castellano; lista vacía = válido. `today` permite probarlo de forma determinista. */
export function validateProfileEntry(entry: Partial<ProfileEntry>, today: DayKey): string[] {
  const errors: string[] = [];
  const { date, heightCm, weightKg, sex, birthDate, strideCm } = entry;
  if (!date || !isValidDayKey(date)) errors.push('La fecha de vigencia no es válida.');
  else if (date > today) errors.push('La fecha de vigencia no puede estar en el futuro.');
  if (heightCm === undefined || !Number.isFinite(heightCm) || heightCm < 100 || heightCm > 230) {
    errors.push('La altura debe estar entre 100 y 230 cm.');
  }
  if (weightKg === undefined || !Number.isFinite(weightKg) || weightKg < 25 || weightKg > 300) {
    errors.push('El peso debe estar entre 25 y 300 kg.');
  }
  if (sex !== 'male' && sex !== 'female') errors.push('Indica el sexo (se usa en las fórmulas de estimación).');
  if (!birthDate || !isValidDayKey(birthDate)) {
    errors.push('La fecha de nacimiento no es válida.');
  } else if (birthDate >= today) {
    errors.push('La fecha de nacimiento debe ser anterior a hoy.');
  } else {
    const age = ageAt(birthDate, today);
    if (age < 5 || age > 110) errors.push('La edad debe estar entre 5 y 110 años.');
  }
  if (strideCm !== undefined && (!Number.isFinite(strideCm) || strideCm < 30 || strideCm > 150)) {
    errors.push('La longitud de zancada debe estar entre 30 y 150 cm.');
  }
  return errors;
}

/**
 * Días desde el último dato de PESO (para sugerir "actualiza tu peso" sin ser pesado). Una calibración de zancada no
 * cuenta: no vuelve a medir el peso.
 */
export function daysSinceLastEntry(history: readonly ProfileEntry[], today: DayKey): number | null {
  const last = sortProfile(history).filter((e) => !e.strideOnly).at(-1);
  return last ? Math.max(0, daysBetween(last.date, today)) : null;
}

