import { describe, expect, it } from 'vitest';
import { estimateWorkout, type WorkoutRecord } from './workout';
import type { ResolvedProfile } from './profile';
import { isSportId, SPORTS, sportById, sportSupport } from './sports';

const R99 = new Set(['steps', 'sleep', 'heartRate', 'spo2']);

describe('sportSupport (lo que el anillo ofrece → qué se ofrece en cada deporte)', () => {
  it('sin información (aún no sincronizado) no recorta nada: se intenta y, si falta, se avisa', () => {
    for (const sport of SPORTS) expect(sportSupport(sport, null).ringUseful).toBe(true);
    expect(sportSupport(sportById('walk'), null)).toEqual({ heartRate: true, steps: true, ringUseful: true });
  });

  it('un anillo completo da pulso en todo y pasos solo en las actividades a pie', () => {
    expect(sportSupport(sportById('run'), R99)).toEqual({ heartRate: true, steps: true, ringUseful: true });
    expect(sportSupport(sportById('cycle'), R99)).toEqual({ heartRate: true, steps: false, ringUseful: true });
    expect(sportSupport(sportById('yoga'), R99)).toEqual({ heartRate: true, steps: false, ringUseful: true });
  });

  it('sin pulso quedan los pasos a pie; en el resto el anillo no aporta nada en directo', () => {
    const noHr = new Set(['steps', 'sleep']);
    expect(sportSupport(sportById('walk'), noHr)).toEqual({ heartRate: false, steps: true, ringUseful: true });
    expect(sportSupport(sportById('cycle'), noHr)).toEqual({ heartRate: false, steps: false, ringUseful: false });
    expect(sportSupport(sportById('gym'), noHr).ringUseful).toBe(false);
  });

  it('sin pasos las actividades a pie solo cuentan con el pulso', () => {
    const noSteps = new Set(['heartRate']);
    expect(sportSupport(sportById('hike'), noSteps)).toEqual({ heartRate: true, steps: false, ringUseful: true });
  });

  it('sin pulso ni pasos nada se hace con el anillo', () => {
    for (const sport of SPORTS) expect(sportSupport(sport, new Set(['sleep'])).ringUseful).toBe(false);
  });
});

describe('catálogo de deportes', () => {
  it('ofrece una lista corta de deportes corrientes, con BiciMAD y sin los más raros', () => {
    expect(SPORTS.map((s) => s.id)).toEqual(['walk', 'run', 'hike', 'cycle', 'bicimad', 'swim', 'gym', 'yoga', 'football', 'basketball', 'tennis', 'padel']);
    expect(new Set(SPORTS.map((s) => s.icon)).size).toBe(SPORTS.length); // cada deporte con su propio icono
    expect(SPORTS.map((s) => s.name)).toContain('Senderismo');
  });

  it('BiciMAD es una bici con GPS, sin pasos y sin MET por velocidad (el motor pone parte del esfuerzo)', () => {
    const bicimad = sportById('bicimad');
    expect(bicimad).toMatchObject({ name: 'BiciMAD', kind: 'cycling', gpsUseful: true, genericMet: 4.0 });
    expect(bicimad.speedMet).toBeUndefined();
    expect(sportSupport(bicimad, R99)).toEqual({ heartRate: true, steps: false, ringUseful: true });
  });

  it('los deportes retirados se siguen leyendo con su nombre y no se convierten en «Caminar»', () => {
    for (const id of ['hiit', 'badminton', 'tabletennis', 'rope', 'elliptical', 'rowing', 'dance']) {
      expect(isSportId(id)).toBe(true);
      expect(sportById(id).id).toBe(id);
      expect(SPORTS.some((s) => s.id === id)).toBe(false);
    }
    expect(sportById('rope').name).toBe('Comba');
    expect(sportById('algo-que-no-existe').id).toBe('walk');
    expect(isSportId('algo-que-no-existe')).toBe(false);
  });
});

describe('BiciMAD frente a una bici normal en el mismo recorrido', () => {
  const profile: ResolvedProfile = { date: '2026-01-01', heightCm: 178, weightKg: 80, sex: 'male', birthDate: '1985-06-15', extrapolated: false };
  const hour = 3_600_000;
  const ride = (sport: 'cycle' | 'bicimad'): WorkoutRecord => ({ id: sport, sport, startMs: 0, endMs: hour, pausedMs: 0, source: 'live', distanceM: 14_000, distanceSource: 'gps' });

  it('la bici normal estima por velocidad y BiciMAD por su MET de asistencia alta (menos esfuerzo)', () => {
    const normal = estimateWorkout(ride('cycle'), profile);
    const electric = estimateWorkout(ride('bicimad'), profile);
    expect(normal.kcalMethod).toBe('speed-met');
    expect(electric.kcalMethod).toBe('met');
    expect(electric.kcal).toBe(Math.round((4.0 - 1) * 80)); // (MET − 1) × kg × h
    expect(electric.kcal).toBeLessThan(normal.kcal);
    expect(electric.distanceM).toBe(14_000);
  });
});
