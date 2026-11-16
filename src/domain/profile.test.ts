import { describe, expect, it } from 'vitest';
import { ageAt, daysSinceLastEntry, profileAt, upsertProfileEntry, validateProfileEntry, weightOn, weightSeries, withInheritedData, type ProfileEntry } from './profile';

const base: ProfileEntry = { date: '2026-01-01', heightCm: 178, weightKg: 82, sex: 'male', birthDate: '1985-06-15' };
const history: ProfileEntry[] = [
  base,
  { ...base, date: '2026-04-01', weightKg: 79 },
  { ...base, date: '2026-06-10', weightKg: 77, strideCm: 76 },
];

describe('weightOn: el peso que rige un día, sin inventarlo', () => {
  it('el de la última pesada hasta ese día', () => {
    expect(weightOn(history, '2026-03-31')).toBe(82);
    expect(weightOn(history, '2026-04-01')).toBe(79);
    expect(weightOn(history, '2030-01-01')).toBe(77);
  });

  it('antes de la primera pesada no hay peso (no se extrapola el primero)', () => {
    expect(weightOn(history, '2025-12-31')).toBeNull();
    expect(weightOn([], '2026-03-31')).toBeNull();
  });

  it('una calibración de zancada hereda el peso de la pesada anterior, sin ser una pesada nueva', () => {
    const withStride: ProfileEntry[] = [...history, { ...base, date: '2026-07-01', weightKg: 82, strideCm: 80, strideOnly: true }];
    expect(weightOn(withStride, '2026-07-02')).toBe(77);
  });
});

describe('profileAt: valores vigentes en cada periodo', () => {
  it('devuelve la última entrada con fecha ≤ día', () => {
    expect(profileAt(history, '2026-03-31')?.weightKg).toBe(82);
    expect(profileAt(history, '2026-04-01')?.weightKg).toBe(79);
    expect(profileAt(history, '2026-06-09')?.weightKg).toBe(79);
    expect(profileAt(history, '2026-06-10')?.weightKg).toBe(77);
    expect(profileAt(history, '2030-01-01')?.weightKg).toBe(77);
  });

  it('una zancada fijada más tarde no se aplica a días anteriores', () => {
    expect(profileAt(history, '2026-05-01')?.strideCm).toBeUndefined();
    expect(profileAt(history, '2026-06-20')?.strideCm).toBe(76);
  });

  it('antes de la primera entrada usa la primera, marcándola como extrapolada', () => {
    const p = profileAt(history, '2025-06-01');
    expect(p).toMatchObject({ weightKg: 82, extrapolated: true });
    expect(profileAt(history, '2026-02-01')?.extrapolated).toBe(false);
  });

  it('sin historial devuelve null', () => {
    expect(profileAt([], '2026-01-01')).toBeNull();
  });

  it('no depende del orden en que se guardaron las entradas', () => {
    expect(profileAt([...history].reverse(), '2026-05-01')?.weightKg).toBe(79);
  });
});

describe('edición del historial', () => {
  it('upsert reemplaza la misma fecha y mantiene el orden', () => {
    const next = upsertProfileEntry(history, { ...base, date: '2026-04-01', weightKg: 80 });
    expect(next.map((e) => [e.date, e.weightKg])).toEqual([
      ['2026-01-01', 82],
      ['2026-04-01', 80],
      ['2026-06-10', 77],
    ]);
  });

  it('upsert inserta una fecha intermedia (corrección retroactiva)', () => {
    const next = upsertProfileEntry(history, { ...base, date: '2026-02-15', weightKg: 81 });
    expect(next.map((e) => e.date)).toEqual(['2026-01-01', '2026-02-15', '2026-04-01', '2026-06-10']);
  });

  it('weightSeries da la evolución del peso en orden', () => {
    expect(weightSeries(history)).toEqual([
      { date: '2026-01-01', weightKg: 82 },
      { date: '2026-04-01', weightKg: 79 },
      { date: '2026-06-10', weightKg: 77 },
    ]);
  });
});

describe('calibrar la zancada no es pesarse', () => {
  const history = [
    { ...base, date: '2026-01-01', weightKg: 82 },
    { ...base, date: '2026-06-10', weightKg: 77 },
    { ...base, date: '2026-07-05', weightKg: 77, strideCm: 76.5, strideOnly: true },
  ];

  it('la entrada de calibración rige desde su fecha (zancada nueva, peso arrastrado)', () => {
    expect(profileAt(history, '2026-07-06')).toMatchObject({ weightKg: 77, strideCm: 76.5 });
    expect(profileAt(history, '2026-07-04')?.strideCm).toBeUndefined();
  });

  it('no sale en la evolución del peso', () => {
    expect(weightSeries(history).map((p) => p.date)).toEqual(['2026-01-01', '2026-06-10']);
  });

  it('no hace pasar por «al día» un peso que no se ha vuelto a medir', () => {
    // El último peso es del 10 de junio: a 10 de julio son 30 días, no 5.
    expect(daysSinceLastEntry(history, '2026-07-10')).toBe(30);
    expect(daysSinceLastEntry([{ ...base, date: '2026-07-05', strideOnly: true }], '2026-07-10')).toBeNull();
  });
});

describe('una calibración de zancada hereda los datos de la última pesada', () => {
  const entries = (janKg: number): ProfileEntry[] => [
    { ...base, date: '2026-01-01', weightKg: janKg },
    // La copia del peso que guardó la calibración al crearse (80 kg) no es la que cuenta.
    { ...base, date: '2026-03-01', weightKg: 80, strideCm: 76, strideOnly: true },
  ];

  it('un peso corregido después llega a los días posteriores a la calibración', () => {
    // La calibración del 1-mar copió 80 kg; luego se corrige la pesada del 1-ene a 78.
    const history: ProfileEntry[] = [
      { ...base, date: '2026-01-01', weightKg: 78 },
      { ...base, date: '2026-03-01', weightKg: 80, strideCm: 76, strideOnly: true },
    ];
    expect(profileAt(history, '2026-03-15')).toMatchObject({ weightKg: 78, strideCm: 76, extrapolated: false });
    expect(profileAt(history, '2026-02-10')?.weightKg).toBe(78);
  });

  it('una pesada apuntada con fecha pasada, anterior a la calibración, también llega', () => {
    const history: ProfileEntry[] = [
      { ...base, date: '2026-01-01', weightKg: 80 },
      { ...base, date: '2026-02-10', weightKg: 78 },
      { ...base, date: '2026-03-01', weightKg: 80, strideCm: 76, strideOnly: true },
    ];
    expect(profileAt(history, '2026-03-15')?.weightKg).toBe(78);
  });

  it('una pesada posterior a la calibración manda desde su fecha (y la zancada no se arrastra si no la trae)', () => {
    const history: ProfileEntry[] = [...entries(80), { ...base, date: '2026-04-01', weightKg: 75 }];
    expect(profileAt(history, '2026-03-20')).toMatchObject({ weightKg: 80, strideCm: 76 });
    expect(profileAt(history, '2026-04-02')).toMatchObject({ weightKg: 75 });
    expect(profileAt(history, '2026-04-02')?.strideCm).toBeUndefined();
  });

  it('sin ninguna pesada anterior se queda con lo que traía (no hay de dónde heredar)', () => {
    const only: ProfileEntry[] = [{ ...base, date: '2026-03-01', weightKg: 80, strideCm: 76, strideOnly: true }];
    expect(profileAt(only, '2026-03-15')?.weightKg).toBe(80);
    expect(profileAt(only, '2026-02-01')).toMatchObject({ weightKg: 80, extrapolated: true });
  });

  it('withInheritedData deja intactas las pesadas normales', () => {
    const history = entries(80);
    const normal = history[0] as ProfileEntry;
    expect(withInheritedData(history, normal)).toBe(normal);
  });
});

describe('ageAt', () => {
  it('cuenta años cumplidos', () => {
    expect(ageAt('1985-06-15', '2026-06-14')).toBe(40);
    expect(ageAt('1985-06-15', '2026-06-15')).toBe(41);
    expect(ageAt('2000-02-29', '2026-02-28')).toBe(25);
  });
});

describe('validateProfileEntry', () => {
  const today = '2026-07-10';
  it('acepta una entrada correcta', () => {
    expect(validateProfileEntry(base, today)).toEqual([]);
  });
  it('detecta cada campo fuera de rango', () => {
    expect(validateProfileEntry({ ...base, heightCm: 50 }, today)).toHaveLength(1);
    expect(validateProfileEntry({ ...base, weightKg: 10 }, today)).toHaveLength(1);
    expect(validateProfileEntry({ ...base, birthDate: '2030-01-01' }, today)).toHaveLength(1);
    expect(validateProfileEntry({ ...base, birthDate: '1800-01-01' }, today)).toHaveLength(1);
    expect(validateProfileEntry({ ...base, strideCm: 10 }, today)).toHaveLength(1);
    expect(validateProfileEntry({ ...base, date: '2026-12-01' }, today)).toHaveLength(1);
    expect(validateProfileEntry({ ...base, sex: undefined as never }, today)).toHaveLength(1);
  });
});
