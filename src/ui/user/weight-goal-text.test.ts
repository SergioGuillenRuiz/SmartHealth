import { describe, expect, it } from 'vitest';
import { weightGoalPlan, type WeightGoalInput } from '../../domain/weight-goal';
import { weightGoalMessage } from './weight-goal-text';

const TODAY = '2026-10-31';

const plan = (over: Partial<WeightGoalInput> = {}) =>
  weightGoalPlan({ currentKg: 80, targetKg: 74, goal: 'lose', maintenanceKcal: 2400, plannedKcal: 1920, trendKgPerWeek: null, heightCm: 178, ...over });

const HINT = 'Anota lo que comes unos días más';

/**
 * Los textos llevan un espacio que no se parte entre la cifra y «kg»; aquí se comparan con espacios normales. Sin días de comida anotados sale un aviso (`HINT`) que
 * estas pruebas no miran (las del final sí): se quita para que cada una hable de lo suyo.
 */
const texts = (over: Partial<WeightGoalInput> = {}, keepHint = false) => {
  const goal = over.goal ?? 'lose';
  const message = weightGoalMessage(plan(over), goal, TODAY);
  return {
    ...message,
    notes: message.notes.filter((note) => keepHint || !note.text.startsWith(HINT)).map((note) => ({ ...note, text: note.text.replace(/\u00a0/g, ' ') })),
  };
};

describe('weightGoalMessage: lo que se le dice a la persona sobre su peso objetivo', () => {
  it('perder con un objetivo que baja: cuánto falta y cuánto tardaría con lo que se propone, con la fecha por mes', () => {
    const { notes, suggestion } = texts();
    expect(suggestion).toBeNull();
    expect(notes.map((n) => n.text)).toEqual([
      'Te faltan 6 kg para llegar a 74 kg (tu último peso anotado: 80 kg).',
      'Comiendo lo que se te propone bajarías unos 0,44 kg a la semana: llegarías en unas 14 semanas (hacia febrero de 2027).',
    ]);
    expect(notes.every((n) => n.tone === 'info')).toBe(true);
  });

  it('con pesadas suficientes añade el ritmo real y la fecha a ese ritmo', () => {
    const { notes } = texts({ trendKgPerWeek: -0.3 });
    expect(notes.map((n) => n.text)).toContain('Tu peso de las últimas semanas baja a un ritmo de unos 0,3 kg a la semana: a ese ritmo llegarías en unas 20 semanas (hacia marzo de 2027).');
  });

  it('si el peso no va hacia el objetivo lo avisa; si está quieto, lo dice', () => {
    const opposite = texts({ trendKgPerWeek: 0.2 }).notes;
    expect(opposite.at(-1)).toEqual({ text: 'En las últimas semanas tu peso ha subido a un ritmo de unos 0,2 kg a la semana, al revés de lo que buscas.', tone: 'warn' });
    expect(texts({ trendKgPerWeek: 0.03 }).notes.at(-1)?.text).toBe('En las últimas semanas tu peso se ha mantenido estable.');
  });

  it('con «Mantener peso» y kilos por bajar avisa y ofrece pasar a «Perder peso»', () => {
    const { notes, suggestion } = texts({ goal: 'maintain', plannedKcal: 2400 });
    expect(notes[1]).toEqual({ text: '«Mantener peso» no te lleva a bajar esos kilos: ese objetivo de salud no apunta a tu peso objetivo.', tone: 'warn' });
    expect(notes).toHaveLength(2); // y no promete una fecha por calorías que no bajan el peso
    expect(suggestion).toEqual({ goal: 'lose', label: 'Perder peso' });
  });

  it('un peso por encima del actual con «Perder peso» ofrece «Ganar peso»', () => {
    const { notes, suggestion } = texts({ targetKg: 86 });
    expect(notes[0]?.text).toBe('Te faltan 6 kg para llegar a 86 kg (tu último peso anotado: 80 kg).');
    expect(notes[1]?.text).toContain('no te lleva a subir esos kilos');
    expect(suggestion).toEqual({ goal: 'gain', label: 'Ganar peso' });
  });

  it('subir con un objetivo que sube dice cuánto y cuándo', () => {
    const { notes } = texts({ targetKg: 84, goal: 'muscle', plannedKcal: 2640 });
    expect(notes[1]?.text).toBe('Comiendo lo que se te propone subirías unos 0,22 kg a la semana: llegarías en unas 18 semanas (hacia marzo de 2027).');
  });

  it('si las calorías propuestas no mueven el peso (el suelo de calorías las deja en el mantenimiento) lo dice en vez de callar', () => {
    const { notes } = texts({ plannedKcal: 2400 });
    expect(notes[1]).toEqual({ text: 'Con las calorías que se te proponen tu peso apenas cambiaría, así que no se le puede poner fecha.', tone: 'info' });
  });

  it('al llegar: con «Perder peso» o «Ganar peso» ofrece mantener; con «Mantener peso» solo lo celebra; con «Definir» o «Ganar masa muscular» no empuja a nada', () => {
    const reached = texts({ targetKg: 79.8 });
    expect(reached.notes[0]?.text).toContain('Ya estás en tu peso objetivo (79,8 kg).');
    expect(reached.notes[0]?.text).toContain('«Mantener peso»');
    expect(reached.suggestion).toEqual({ goal: 'maintain', label: 'Mantener peso' });
    const kept = texts({ targetKg: 80.2, goal: 'maintain' });
    expect(kept.notes[0]?.text).toBe('Ya estás en tu peso objetivo (80,2 kg). Mantenerlo es lo que buscas.');
    expect(kept.suggestion).toBeNull();
    const defined = texts({ targetKg: 79.8, goal: 'define' });
    expect(defined.notes[0]?.text).toBe('Ya estás en tu peso objetivo (79,8 kg). Con «Definir» el peso puede quedarse quieto mientras cambia tu cuerpo.');
    expect(defined.suggestion).toBeNull();
  });

  it('«Te falta» en singular cuando es un kilo, y «una semana» sin «unas»', () => {
    expect(texts({ targetKg: 79 }).notes[0]?.text).toBe('Te falta 1 kg para llegar a 79 kg (tu último peso anotado: 80 kg).');
    const { notes } = texts({ targetKg: 79, plannedKcal: 400 });
    expect(notes[1]?.text).toContain('llegarías en una semana (hacia noviembre)');
  });

  it('avisa de un peso objetivo por debajo de lo saludable, salvo a quien sube hacia él desde aún más abajo', () => {
    const { notes } = texts({ targetKg: 55 });
    expect(notes.at(-1)).toEqual({
      text: '55 kg sería un IMC de 17,4, por debajo de lo saludable (18,5). Mejor consúltalo con un profesional antes de buscarlo.',
      tone: 'warn',
    });
    expect(texts({ currentKg: 48, targetKg: 52, goal: 'gain', plannedKcal: 2760 }).notes.some((n) => n.tone === 'warn')).toBe(false);
  });

  it('un plazo de más de dos años no se promete con fecha', () => {
    const { notes } = texts({ currentKg: 150, targetKg: 70, maintenanceKcal: 3000, plannedKcal: 2900 });
    expect(notes.at(-1)?.text).toContain('llegarías en más de dos años.');
  });
});

describe('weightGoalMessage: lo que pasaría con lo que se come de verdad', () => {
  it('con lo comido por debajo del mantenimiento y un objetivo que baja: cuánto bajaría y cuándo llegaría', () => {
    const { notes } = texts({ eaten: { avgKcal: 1950, days: 9 } });
    expect(notes.map((n) => n.text)).toContain(
      'Con lo que has comido estos últimos 9 días (unas 1950 kcal al día, frente a unas 2400 de mantenimiento) bajarías unos 0,41 kg a la semana: llegarías a 74 kg en unas 15 semanas (hacia febrero de 2027).'.replace(/\u00a0/g, ' '),
    );
    expect(notes.every((n) => n.tone === 'info')).toBe(true);
  });

  it('comiendo en el mantenimiento avisa de que no llegaría', () => {
    const { notes } = texts({ eaten: { avgKcal: 2400, days: 12 } });
    const note = notes.find((n) => n.text.startsWith('Con lo que has comido'));
    expect(note).toEqual({
      text: 'Con lo que has comido estos últimos 12 días (unas 2400 kcal al día, frente a unas 2400 de mantenimiento) tu peso apenas cambiaría: comiendo así no llegarías a 74 kg.',
      tone: 'warn',
    });
  });

  it('comiendo por encima del mantenimiento cuando hay que bajar avisa del revés', () => {
    const { notes } = texts({ eaten: { avgKcal: 2900, days: 12 } });
    const note = notes.find((n) => n.text.startsWith('Con lo que has comido'));
    expect(note?.tone).toBe('warn');
    expect(note?.text).toContain('subirías unos 0,45 kg a la semana, al revés de lo que buscas: comiendo así no llegarías a 74 kg.');
  });

  it('subir comiendo por encima del mantenimiento: dice cuándo llegaría', () => {
    const { notes } = texts({ targetKg: 84, goal: 'gain', plannedKcal: 2760, eaten: { avgKcal: 2800, days: 10 } });
    expect(notes.some((n) => n.text.includes('subirías unos 0,36 kg a la semana: llegarías a 84 kg en unas'))).toBe(true);
  });

  it('sin días de comida anotados suficientes dice qué falta en vez de callar', () => {
    const { notes } = texts({}, true);
    expect(notes.some((n) => n.text.startsWith(HINT) && n.tone === 'info')).toBe(true);
    expect(texts({ eaten: { avgKcal: 1950, days: 9 } }, true).notes.some((n) => n.text.startsWith(HINT))).toBe(false);
  });

  it('con el peso ya alcanzado no hace cuentas de plazo', () => {
    const { notes } = texts({ targetKg: 79.8, eaten: { avgKcal: 1950, days: 9 } }, true);
    expect(notes.some((n) => n.text.startsWith('Con lo que has comido') || n.text.startsWith(HINT))).toBe(false);
  });
});
