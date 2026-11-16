import { describe, expect, it } from 'vitest';
import { groupSleep, type SleepNight } from '../../domain/sleep';
import type { SleepSessionRecord } from '../../domain/types';
import { analyzeSleep } from './sleep-analysis';

const at = (day: number, h: number, m = 0): number => new Date(2026, 6, day, h, m, 0).getTime();

/** Una noche con las fases dadas (en minutos), una detrás de otra desde las 23:00. */
function night(stages: Array<['deep' | 'light' | 'rem' | 'awake', number]>): SleepNight {
  let cursor = at(8, 23);
  const segments = stages.map(([stage, minutes]) => {
    const segment = { stage, startMs: cursor, durationSec: minutes * 60 };
    cursor += minutes * 60_000;
    return segment;
  });
  const session: SleepSessionRecord = { startMs: at(8, 23), endMs: cursor, segments };
  const found = groupSleep([session]).get(`2026-07-${String(new Date(cursor).getDate()).padStart(2, '0')}`)?.night;
  if (!found) throw new Error('sin noche');
  return found;
}

describe('analyzeSleep', () => {
  it('una noche de objetivo cumplido, con profundo y REM normales y sin despertares: bien', () => {
    // 8 h: 1 h 36 profundo (20 %), 4 h 48 ligero (60 %), 1 h 36 REM (20 %).
    const result = analyzeSleep(night([['light', 288], ['deep', 96], ['rem', 96]]), 8);
    expect(result).toEqual({ tone: 'good', text: 'Dormiste 8 h, el 100 % de tu objetivo. Fases y despertares sin nada que destacar: sigue así.' });
  });

  it('el ejemplo de Smart Health (9 h 45, profundo 23 %, REM 14 %, sin despertares) sale bien: un REM del 14 % no es un problema', () => {
    // 2 h 15 profundo, 6 h 6 ligero, 1 h 24 REM.
    const result = analyzeSleep(night([['light', 366], ['deep', 135], ['rem', 84]]), 8);
    expect(result?.tone).toBe('good');
    expect(result?.text).toContain('Dormiste 9 h 45 min, el 122 % de tu objetivo.');
    expect(result?.text).toContain('sigue así');
  });

  it('una noche algo corta lo dice con el porcentaje, sin dramatizar', () => {
    // 6 h 30 de 8 h: 81 %.
    const result = analyzeSleep(night([['light', 240], ['deep', 80], ['rem', 70]]), 8);
    expect(result?.tone).toBe('attention');
    expect(result?.text).toMatch(/^Dormiste algo menos de lo que te habías propuesto: 6 h 30 min, el 81 % de tu objetivo\./);
  });

  it('una noche corta de verdad', () => {
    const result = analyzeSleep(night([['light', 200], ['deep', 50], ['rem', 50]]), 8);
    expect(result?.tone).toBe('attention');
    expect(result?.text).toMatch(/^Noche corta: 5 h, el 63 % de tu objetivo\./);
  });

  it('señala el profundo muy bajo, el REM muy bajo y los despertares, juntos y bien escritos', () => {
    // 8 h: profundo 5 %, REM 8 %, 5 despertares (el último rato despierto es el despertar definitivo y no cuenta).
    const result = analyzeSleep(night([['light', 100], ['awake', 5], ['deep', 24], ['light', 100], ['awake', 5], ['light', 100], ['awake', 5], ['rem', 38], ['awake', 5], ['light', 100], ['awake', 5], ['light', 18], ['awake', 5]]), 8);
    expect(result?.tone).toBe('attention');
    expect(result?.text).toContain('Ojo: el sueño profundo fue bajo (5 %), el REM fue bajo (8 %) y te despertaste 5 veces.');
  });

  it('con 2, 3 o 4 despertares no se dice nada: es lo normal', () => {
    // 8 h, profundo 20 %, REM 20 %, y cuatro rachas despierto entre medias.
    const result = analyzeSleep(night([['light', 100], ['awake', 3], ['deep', 96], ['awake', 3], ['light', 94], ['awake', 3], ['rem', 96], ['awake', 3], ['light', 94]]), 8);
    expect(result).toEqual({ tone: 'good', text: 'Dormiste 8 h, el 100 % de tu objetivo. Fases y despertares sin nada que destacar: sigue así.' });
  });

  it('el límite se aplica a lo que se ve: 7 h 11 min de 8 h salen como «90 %» y cuentan como suficiente; 5 h 58 min como «75 %» y no como noche corta', () => {
    // 431 min = 89,8 % → «90 %».
    const enough = analyzeSleep(night([['light', 300], ['deep', 70], ['rem', 61]]), 8);
    expect(enough).toEqual({ tone: 'good', text: 'Dormiste 7 h 11 min, el 90 % de tu objetivo. Fases y despertares sin nada que destacar: sigue así.' });
    // 358 min = 74,6 % → «75 %».
    expect(analyzeSleep(night([['light', 250], ['deep', 55], ['rem', 53]]), 8)?.text).toMatch(/^Dormiste algo menos de lo que te habías propuesto: 5 h 58 min, el 75 % de tu objetivo\./);
    // 357 min = 74,4 % → «74 %».
    expect(analyzeSleep(night([['light', 250], ['deep', 55], ['rem', 52]]), 8)?.text).toMatch(/^Noche corta: 5 h 57 min, el 74 % de tu objetivo\./);
  });

  it('lo mismo con las fases: un 9,6 % de profundo sale como «10 %» y no es «bajo»', () => {
    // 480 min: profundo 46 (9,58 % → 10 %), REM 96 (20 %).
    expect(analyzeSleep(night([['light', 338], ['deep', 46], ['rem', 96]]), 8)?.tone).toBe('good');
    // 45 min (9,4 % → 9 %) sí.
    expect(analyzeSleep(night([['light', 339], ['deep', 45], ['rem', 96]]), 8)?.text).toContain('el sueño profundo fue bajo (9 %)');
  });

  it('una fase de la que el anillo no da nada no se juzga: no es que no la hubiera, es que no la distingue', () => {
    // Profundo y ligero, sin un solo tramo REM, y un rato despierto: hay fases, pero el REM no se evalúa.
    const noRem = analyzeSleep(night([['light', 350], ['deep', 110], ['awake', 5]]), 8);
    expect(noRem?.text).not.toContain('REM');
    expect(noRem?.tone).toBe('good');
    // Sin profundo: tampoco se dice que fuera «bajo».
    expect(analyzeSleep(night([['light', 380], ['rem', 100], ['awake', 5]]), 8)?.text).not.toContain('profundo');
  });

  it('con un solo problema, una sola cosa', () => {
    const result = analyzeSleep(night([['light', 280], ['deep', 30], ['rem', 100]]), 8);
    expect(result?.text).toContain('Ojo: el sueño profundo fue bajo (7 %).');
  });

  it('en una noche de menos de 3 h no se juzga el reparto de fases', () => {
    const result = analyzeSleep(night([['light', 120], ['deep', 5], ['rem', 5]]), 8);
    expect(result?.text).not.toContain('Ojo');
  });

  it('sin fases (solo la duración) no hay análisis', () => {
    expect(analyzeSleep(night([['light', 450]]), 8)).toBeNull();
  });
});
