import { describe, expect, it } from 'vitest';
import { atHourMs, type DayKey } from './dates';
import { exerciseLossMl, exerciseWater, GLASS_ML, HYDRATION_LABEL, hydrationStatus, waterGoalMl, type WaterEntry } from './hydration';

const DAY: DayKey = '2026-10-19';
const man = { heightCm: 180, weightKg: 80, birthDate: '1986-03-02' };
const woman = { heightCm: 165, weightKg: 60, birthDate: '1986-03-02' };

describe('waterGoalMl: la meta de agua para beber', () => {
  it('35 ml por kilo de agua total y el 80 % en bebidas: 80 kg → 2250 ml, 60 kg → 1700 ml', () => {
    expect(waterGoalMl(man, DAY)).toBe(2250);
    expect(waterGoalMl(woman, DAY)).toBe(1700);
  });

  it('en la horquilla de las referencias (EFSA 2,0 l mujeres y 2,5 l hombres de agua total, el 80 % en bebidas)', () => {
    expect(waterGoalMl(woman, DAY) / 0.8).toBeGreaterThan(1800);
    expect(waterGoalMl(woman, DAY) / 0.8).toBeLessThan(2400);
    expect(waterGoalMl(man, DAY) / 0.8).toBeGreaterThan(2400);
    expect(waterGoalMl(man, DAY) / 0.8).toBeLessThan(3200);
  });

  it('a partir de los 65 años son 30 ml por kilo, con una transición suave desde los 55', () => {
    const at = (age: number) => waterGoalMl({ ...man, birthDate: `${2026 - age}-01-01` }, DAY);
    expect(at(40)).toBe(2250);
    expect(at(55)).toBe(2250);
    expect(at(60)).toBeLessThan(2250);
    expect(at(60)).toBeGreaterThan(at(65));
    expect(at(65)).toBe(1900);
    expect(at(80)).toBe(1900);
  });

  it('con obesidad cuenta el peso ajustado, no el entero (el exceso de grasa casi no necesita agua)', () => {
    const heavy = { heightCm: 170, weightKg: 120, birthDate: '1986-03-02' };
    const goal = waterGoalMl(heavy, DAY);
    expect(goal).toBe(2650); // y no 3360 ml (120 kg × 35 ml × 0,8)
    expect(goal).toBeGreaterThan(waterGoalMl(man, DAY));
  });

  it('nunca baja de 1,5 l de agua total ni pasa de 3,7 l, y va en múltiplos de 50', () => {
    const tiny = { heightCm: 150, weightKg: 38, birthDate: '1940-01-01' };
    const huge = { heightCm: 210, weightKg: 150, birthDate: '1990-01-01' };
    expect(waterGoalMl(tiny, DAY)).toBe(1200);
    expect(waterGoalMl(huge, DAY)).toBeLessThanOrEqual(2950);
    for (const p of [man, woman, tiny, huge]) expect(waterGoalMl(p, DAY) % 50).toBe(0);
  });
});

describe('hydrationStatus: cómo va el día', () => {
  const entry = (hour: number, ml: number, id = `${hour}-${ml}`): WaterEntry => ({ id, tsMs: atHourMs(DAY, hour), ml });
  const status = (entries: WaterEntry[], hour: number, extra: { wakeMs?: number | null; day?: DayKey } = {}) =>
    hydrationStatus({ entries, goalMl: 2000, nowMs: atHourMs(extra.day === undefined ? DAY : '2026-10-21', hour), day: extra.day ?? DAY, wakeMs: extra.wakeMs });

  it('suma las tomas, cuenta los vasos y dice cuándo fue la última', () => {
    const s = status([entry(8, 250), entry(11, 500), entry(13, 250)], 14);
    expect(s.intakeMl).toBe(1000);
    expect(s.glasses).toBe(1000 / GLASS_ML);
    expect(s.lastDrinkMs).toBe(atHourMs(DAY, 13));
    expect(status([], 14).lastDrinkMs).toBeNull();
  });

  it('reparte la meta por las 16 horas despierto desde las 07:00: a las 15:00 toca la mitad', () => {
    expect(status([entry(8, 100)], 15).expectedMl).toBe(1000);
    expect(status([entry(8, 100)], 7).expectedMl).toBe(0);
    expect(status([entry(8, 100)], 23).expectedMl).toBe(2000);
    expect(status([entry(8, 100)], 23, {}).expectedMl).toBe(2000);
  });

  it('con la hora de levantarse del anillo, el reparto empieza ahí', () => {
    const wake = atHourMs(DAY, 11);
    expect(status([entry(12, 100)], 19, { wakeMs: wake }).expectedMl).toBe(1000);
    // Una hora de levantarse de otro día o de la tarde no vale: se usa la de siempre.
    expect(status([entry(12, 100)], 15, { wakeMs: atHourMs(DAY, 20) }).expectedMl).toBe(1000);
  });

  it('el nivel sigue lo bebido frente a lo esperado a esa hora', () => {
    // A las 15:00 tocaría 1000 ml.
    expect(status([entry(9, 1000)], 15).level).toBe('good');
    expect(status([entry(9, 800)], 15).level).toBe('fair');
    expect(status([entry(9, 400)], 15).level).toBe('low');
    expect(status([entry(9, 400)], 15).score).toBeCloseTo(0.4, 5);
    expect(status([entry(9, 2000)], 15).score).toBe(1);
  });

  it('sin ninguna toma anotada no se dice que esté deshidratado: no hay datos', () => {
    const s = status([], 15);
    expect(s.level).toBe('none');
    expect(s.score).toBe(0);
    expect(HYDRATION_LABEL.none).toMatch(/Sin agua anotada/);
  });

  it('a primera hora un vaso basta: se compara con una décima parte de la meta como mínimo', () => {
    expect(status([entry(7, 250)], 7).level).toBe('good');
    expect(status([entry(7, 150)], 8).level).toBe('fair'); // a las 08:00 tocaría 125 ml, pero se compara con 200 (una décima parte de la meta)
  });

  it('un día que ya acabó se compara con la meta entera', () => {
    expect(status([entry(9, 1500), entry(18, 600)], 10, { day: DAY }).level).toBe('good');
    expect(status([entry(9, 1500)], 10, { day: DAY }).level).toBe('fair');
    expect(status([entry(9, 1000)], 10, { day: DAY }).level).toBe('low');
    expect(status([], 10, { day: DAY }).level).toBe('none');
    expect(status([entry(9, 1000)], 10, { day: DAY }).expectedMl).toBe(2000);
  });

  it('beber mucho más de lo necesario se dice (más de 1,6 veces la meta y al menos 3,5 l)', () => {
    expect(status([entry(9, 2000), entry(12, 1600)], 15).level).toBe('excess');
    expect(status([entry(9, 2000), entry(12, 1000)], 15).level).toBe('good'); // 3 l: mucho, pero aún no
  });
});

describe('exerciseLossMl y exerciseWater: lo que se pierde con el ejercicio', () => {
  const hour = 3_600_000;

  it('sale de lo medido: andar a paso vivo ~150–200 ml/h, bici ~700 ml/h, correr ~1 l/h (con la respiración)', () => {
    expect(exerciseLossMl(230, 1)).toBeGreaterThan(130);
    expect(exerciseLossMl(230, 1)).toBeLessThan(230);
    expect(exerciseLossMl(490, 1)).toBeGreaterThan(650);
    expect(exerciseLossMl(490, 1)).toBeLessThan(850);
    expect(exerciseLossMl(630, 1)).toBeGreaterThan(950);
    expect(exerciseLossMl(630, 1)).toBeLessThan(1200);
  });

  it('crece con la intensidad: la misma hora a más ritmo pierde mucho más que el doble', () => {
    expect(exerciseLossMl(600, 1)).toBeGreaterThan(2 * exerciseLossMl(300, 1));
  });

  it('el ritmo suave casi no suda (lo que se gasta por debajo de 160 kcal/h solo suma la respiración) y nunca pierde de más ni a la inversa', () => {
    expect(exerciseLossMl(100, 1)).toBeCloseTo(15, 5); // 0,15 ml por kcal
    expect(exerciseLossMl(0, 1)).toBe(0);
    expect(exerciseLossMl(300, 0)).toBe(0);
    expect(exerciseLossMl(-5, 1)).toBe(0);
    // Un dato disparatado (10 000 kcal en una hora) topa en 2 l/h de sudor.
    expect(exerciseLossMl(10_000, 1)).toBeLessThan(2_000 + 0.15 * 10_000 + 1);
  });

  it('una hora de carrera suma más de un litro a la meta; 10 000 pasos, solo un poco', () => {
    const run = exerciseWater({ workouts: [{ kcal: 630, activeMs: hour }], walkingKcal: 0, walkingSteps: 0 });
    expect(run.totalMl).toBeGreaterThanOrEqual(1000);
    expect(run.totalMl).toBeLessThanOrEqual(1150);
    expect(run.walkingMl).toBe(0);
    const walk = exerciseWater({ workouts: [], walkingKcal: 330, walkingSteps: 10_000 });
    expect(walk.totalMl).toBeGreaterThanOrEqual(100);
    expect(walk.totalMl).toBeLessThanOrEqual(300);
    expect(walk.workoutsMl).toBe(0);
  });

  it('suma los entrenos y el andar, va en múltiplos de 50 y un día quieto no suma nada', () => {
    const both = exerciseWater({ workouts: [{ kcal: 400, activeMs: hour }, { kcal: 200, activeMs: 0.5 * hour }], walkingKcal: 200, walkingSteps: 6_000 });
    expect(both.totalMl % 50).toBe(0);
    expect(both.totalMl).toBeGreaterThan(both.workoutsMl - 50);
    expect(exerciseWater({ workouts: [], walkingKcal: 0, walkingSteps: 0 }).totalMl).toBe(0);
    expect(exerciseWater({ workouts: [], walkingKcal: 8, walkingSteps: 200 }).totalMl).toBe(0); // un paseo al buzón es ruido
  });

  it('tiene tope: una jornada de ultrarresistencia no dispara la meta más allá de 4 l', () => {
    expect(exerciseWater({ workouts: [{ kcal: 5_000, activeMs: 8 * hour }], walkingKcal: 0, walkingSteps: 0 }).totalMl).toBeLessThanOrEqual(4_000);
  });
});

describe('hydrationStatus con ejercicio', () => {
  const at = (day: DayKey, hour: number): number => atHourMs(day, hour);
  const sip = (ml: number): WaterEntry => ({ id: `w${ml}`, tsMs: at(DAY, 9), ml });

  it('la meta del día es la base más el ejercicio, y lo esperado lo lleva entero desde que se hizo', () => {
    const noon = hydrationStatus({ entries: [sip(500)], goalMl: 2000, exerciseMl: 600, nowMs: at(DAY, 15), day: DAY });
    expect(noon.goalMl).toBe(2600);
    expect(noon.exerciseMl).toBe(600);
    // A las 15:00 toca la mitad de la base (1000) y lo del ejercicio entero (600).
    expect(noon.expectedMl).toBe(1600);
    const without = hydrationStatus({ entries: [sip(500)], goalMl: 2000, nowMs: at(DAY, 15), day: DAY });
    expect(without.goalMl).toBe(2000);
    expect(without.exerciseMl).toBe(0);
    expect(without.expectedMl).toBe(1000);
  });

  it('el mismo vaso de agua sale peor con ejercicio: el nivel tiene en cuenta lo que se ha sudado', () => {
    const entries = [sip(1000)];
    expect(hydrationStatus({ entries, goalMl: 2000, nowMs: at(DAY, 15), day: DAY }).level).toBe('good');
    expect(hydrationStatus({ entries, goalMl: 2000, exerciseMl: 800, nowMs: at(DAY, 15), day: DAY }).level).not.toBe('good');
  });

  it('un día que ya acabó se compara con la meta entera (base y ejercicio)', () => {
    const past = hydrationStatus({ entries: [sip(2000)], goalMl: 2000, exerciseMl: 500, nowMs: at('2026-10-20', 10), day: DAY });
    expect(past.goalMl).toBe(2500);
    expect(past.expectedMl).toBe(2500);
  });
});
