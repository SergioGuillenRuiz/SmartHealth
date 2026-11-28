import { describe, expect, it } from 'vitest';
import { emptyHistory } from '../ble/records';
import { maxCounterAt, sanitizeHistory } from './sanitize';

const NOW = new Date(2026, 6, 10, 14, 0, 0).getTime();
const h = (hours: number): number => NOW - hours * 3_600_000;

describe('sanitizeHistory', () => {
  it('deja pasar lo plausible y lo traduce a filas', () => {
    const rec = emptyHistory();
    rec.sport.push({ startMs: h(3), endMs: h(3) + 15 * 60_000, steps: 1500, distanceM: 1100, calories: 900 });
    rec.heart.push({ tsMs: h(2), bpm: 64 });
    rec.spo2.push({ tsMs: h(2), percent: 97 });
    rec.all.push({ tsMs: h(1), steps: 4200, bpm: 70, spo2: 98, respiratoryRate: 15 });
    const rows = sanitizeHistory(rec, NOW);
    expect(rows.buckets).toEqual([{ startMs: h(3), endMs: h(3) + 15 * 60_000, steps: 1500, ringDistanceM: 1100, ringCalories: 900 }]);
    expect(rows.counters).toEqual([{ tsMs: h(1), steps: 4200 }]);
    expect(rows.heart.map((x) => x.bpm).sort()).toEqual([64, 70]);
    expect(rows.spo2.map((x) => x.percent).sort()).toEqual([97, 98]);
    expect(rows.dropped).toEqual({});
  });

  it('FC y SpO2 con el mismo instante en el historial y en las constantes dan UNA fila; manda el historial dedicado', () => {
    const rec = emptyHistory();
    rec.all.push({ tsMs: h(2), steps: 100, bpm: 70, spo2: 95, respiratoryRate: 14 });
    rec.heart.push({ tsMs: h(2), bpm: 68 });
    rec.spo2.push({ tsMs: h(2), percent: 97 });
    const rows = sanitizeHistory(rec, NOW);
    // El pulso lo manda el historial dedicado, pero la respiración solo viene en las constantes: se conserva.
    expect(rows.heart).toEqual([{ tsMs: h(2), bpm: 68, source: 'ring-auto', resp: 14 }]);
    expect(rows.spo2).toEqual([{ tsMs: h(2), percent: 97 }]);
  });

  it('la respiración de las constantes se guarda con el pulso (la usa la estimación del sueño); sin dato o imposible, solo el pulso', () => {
    const rec = emptyHistory();
    rec.all.push({ tsMs: h(5), steps: 100, bpm: 60, spo2: 97, respiratoryRate: 13 });
    rec.all.push({ tsMs: h(4), steps: 100, bpm: 61, spo2: 97, respiratoryRate: 0 }); // 0: el anillo no la midió
    rec.all.push({ tsMs: h(3), steps: 100, bpm: 62, spo2: 97, respiratoryRate: 90 }); // imposible
    const rows = sanitizeHistory(rec, NOW);
    const byTs = new Map(rows.heart.map((x) => [x.tsMs, x]));
    expect(byTs.get(h(5))).toEqual({ tsMs: h(5), bpm: 60, source: 'ring-auto', resp: 13 });
    expect(byTs.get(h(4))).toEqual({ tsMs: h(4), bpm: 61, source: 'ring-auto' });
    expect(byTs.get(h(3))).toEqual({ tsMs: h(3), bpm: 62, source: 'ring-auto' });
    expect(rows.dropped).toEqual({});
  });

  it('descarta fechas imposibles (reloj roto) y futuras, y lo cuenta', () => {
    const rec = emptyHistory();
    rec.heart.push({ tsMs: new Date(2000, 0, 1).getTime(), bpm: 70 }); // reloj reiniciado
    rec.heart.push({ tsMs: NOW + 5 * 3_600_000, bpm: 70 }); // futuro
    rec.heart.push({ tsMs: h(1), bpm: 70 });
    const rows = sanitizeHistory(rec, NOW);
    expect(rows.heart).toHaveLength(1);
    expect(rows.dropped['FC con fecha imposible']).toBe(2);
  });

  it('descarta FC y SpO2 fuera de rango', () => {
    const rec = emptyHistory();
    rec.heart.push({ tsMs: h(1), bpm: 255 }, { tsMs: h(2), bpm: 12 });
    rec.spo2.push({ tsMs: h(1), percent: 40 }, { tsMs: h(2), percent: 101 });
    const rows = sanitizeHistory(rec, NOW);
    expect(rows.heart).toHaveLength(0);
    expect(rows.spo2).toHaveLength(0);
    expect(rows.dropped).toEqual({ 'FC fuera de rango': 2, 'SpO2 fuera de rango': 2 });
  });

  it('descarta tramos de actividad con cadencia o pasos imposibles', () => {
    const rec = emptyHistory();
    rec.sport.push({ startMs: h(3), endMs: h(3) + 5 * 60_000, steps: 2000, distanceM: 0, calories: 0 }); // 400 pasos/min
    rec.sport.push({ startMs: h(4), endMs: h(4) + 3_600_000, steps: 40_000, distanceM: 0, calories: 0 });
    rec.sport.push({ startMs: h(5), endMs: h(5) + 10 * 60_000, steps: 1000, distanceM: 0, calories: 0 }); // válido
    rec.sport.push({ startMs: h(6) + 1000, endMs: h(6), steps: 100, distanceM: 0, calories: 0 }); // fin antes que inicio
    const rows = sanitizeHistory(rec, NOW);
    expect(rows.buckets).toHaveLength(1);
    expect(Object.values(rows.dropped).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('un tramo de segundos (o de duración 0) con miles de pasos tampoco es posible', () => {
    const rec = emptyHistory();
    rec.sport.push({ startMs: h(3), endMs: h(3), steps: 30_000, distanceM: 0, calories: 0 }); // duración 0
    rec.sport.push({ startMs: h(4), endMs: h(4) + 30_000, steps: 20_000, distanceM: 0, calories: 0 }); // 30 s
    rec.sport.push({ startMs: h(5), endMs: h(5) + 30_000, steps: 60, distanceM: 0, calories: 0 }); // 30 s y 60 pasos: válido
    rec.sport.push({ startMs: h(6), endMs: h(6), steps: 12, distanceM: 0, calories: 0 }); // un punto con 12 pasos: válido
    const rows = sanitizeHistory(rec, NOW);
    expect(rows.buckets.map((b) => b.steps)).toEqual([60, 12]);
    expect(rows.dropped).toEqual({ 'tramo con cadencia imposible': 2 });
  });

  it('un contador acumulado imposible se descarta Y se cuenta (no desaparece en silencio)', () => {
    const rec = emptyHistory();
    rec.all.push({ tsMs: h(1), steps: 90_000, bpm: 0, spo2: 0, respiratoryRate: 0 });
    const rows = sanitizeHistory(rec, NOW, { steps: 70_000, distanceM: 0, calories: 0 });
    expect(rows.counters).toEqual([]);
    expect(rows.dropped).toEqual({ 'contador de pasos imposible': 2 });
  });

  it('unas fases que suman más que la propia sesión son un registro roto: se guarda la noche sin ellas', () => {
    const rec = emptyHistory();
    const night = (phaseSec: number) => [{ stage: 'deep' as const, startMs: h(12), durationSec: phaseSec }];
    rec.sleep.push({ startMs: h(12), endMs: h(12) + 7 * 3_600_000, segments: night(20 * 3600) }); // 20 h dormidas en 7 h en cama
    rec.sleep.push({ startMs: h(40), endMs: h(40) + 7 * 3_600_000, segments: night(7 * 3600) }); // llena la sesión: válido
    const rows = sanitizeHistory(rec, NOW);
    // La noche no se pierde: el anillo dijo cuándo se durmió y cuándo se despertó, aunque sus fases no cuadren.
    expect(rows.sleep).toHaveLength(2);
    expect(rows.sleep[0]).toEqual({ startMs: h(12), endMs: h(12) + 7 * 3_600_000, segments: [] });
    expect(rows.sleep[1]?.segments).toHaveLength(1);
    expect(rows.dropped).toEqual({ 'fases de sueño que no cuadran con la duración de la noche (se guarda solo la duración)': 1 });
  });

  it('descarta sesiones de sueño demasiado cortas o largas', () => {
    const rec = emptyHistory();
    const seg = [{ stage: 'light' as const, startMs: h(10), durationSec: 100 }];
    rec.sleep.push({ startMs: h(10), endMs: h(10) + 5 * 60_000, segments: seg }); // 5 min
    rec.sleep.push({ startMs: h(40), endMs: h(40) + 22 * 3_600_000, segments: seg }); // 22 h
    rec.sleep.push({ startMs: h(12), endMs: h(12) + 7 * 3_600_000, segments: seg });
    expect(sanitizeHistory(rec, NOW).sleep).toHaveLength(1);
  });

  it('añade los pasos leídos en directo como un punto del contador', () => {
    const rows = sanitizeHistory(emptyHistory(), NOW, { steps: 5230, distanceM: 3900, calories: 3100 });
    expect(rows.counters).toEqual([{ tsMs: NOW, steps: 5230 }]);
  });
});

describe('sanitizeHistory: el contador en directo lleva la hora de lectura, no la de guardar', () => {
  it('una sincronización que cruza la medianoche no pone el contador de ayer en el día nuevo', () => {
    const readAt = new Date(2026, 9, 14, 23, 59, 57).getTime();
    const savedAt = new Date(2026, 9, 15, 0, 0, 8).getTime();
    const rows = sanitizeHistory(emptyHistory(), savedAt, { steps: 8107, distanceM: 6000, calories: 300 }, readAt);
    expect(rows.counters).toEqual([{ tsMs: readAt, steps: 8107 }]);
  });

  it('sin hora de lectura se sigue sellando con la de guardar (como siempre)', () => {
    const rows = sanitizeHistory(emptyHistory(), NOW, { steps: 500, distanceM: 400, calories: 20 });
    expect(rows.counters).toEqual([{ tsMs: NOW, steps: 500 }]);
  });
});

describe('sanitizeHistory: el contador en directo tiene que caber en la hora del día', () => {
  const live = { steps: 12_000, distanceM: 9000, calories: 400 };

  it('a las 00:00:00,5 el total de ayer no es el de hoy (el reloj del anillo va unos segundos atrás): se descarta y se cuenta; a mediodía el mismo total es normal', () => {
    const justAfterMidnight = new Date(2026, 9, 15, 0, 0, 0, 500).getTime();
    const early = sanitizeHistory(emptyHistory(), justAfterMidnight, live);
    expect(early.counters).toEqual([]);
    expect(early.dropped).toEqual({ 'contador de pasos que no cuadra con la hora del día': 1 });
    const noon = new Date(2026, 9, 15, 12, 0, 0).getTime();
    expect(sanitizeHistory(emptyHistory(), noon, live).counters).toEqual([{ tsMs: noon, steps: 12_000 }]);
  });

  it('el tope es el ritmo máximo creíble desde medianoche (260 pasos/min) más un margen fijo, y nunca pasa del tope absoluto', () => {
    expect(maxCounterAt(new Date(2026, 9, 15, 0, 0, 0).getTime())).toBe(100);
    expect(maxCounterAt(new Date(2026, 9, 15, 0, 10, 0).getTime())).toBe(2700);
    expect(maxCounterAt(new Date(2026, 9, 15, 23, 0, 0).getTime())).toBe(60_000);
  });
});
