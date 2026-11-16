import { describe, expect, it } from 'vitest';
import { drinkProfile, gradeOf, nutrientProfile, type ProfileInput } from './nutrient-profile';

const base: ProfileInput = { kcal: 100, grams: 100, proteinG: 0, fatG: 0, fiberG: 0, sugarsG: 0, saltG: 0, produce: 'none', fatKind: 'usual', drink: false, naturalSugar: false };
const of = (over: Partial<ProfileInput>) => nutrientProfile({ ...base, ...over })!;

describe('gradeOf: la letra del Nutri-Score', () => {
  it.each([
    [-5, 'A'],
    [-1, 'A'],
    [0, 'B'],
    [2, 'B'],
    [3, 'C'],
    [10, 'C'],
    [11, 'D'],
    [18, 'D'],
    [19, 'E'],
  ])('%i → %s', (score, grade) => expect(gradeOf(score)).toBe(grade));
});

describe('nutrientProfile', () => {
  it('sin saber lo que pesaba (a partir de 20 g) no hay perfil', () => {
    expect(nutrientProfile({ ...base, grams: 10 })).toBeNull();
  });

  it('se calcula por 100 g: lo mismo en 50 g o en 500 g da la misma nota', () => {
    const small = of({ kcal: 50, grams: 50, proteinG: 10, fatG: 1, sugarsG: 0.5, saltG: 0.1 });
    const big = of({ kcal: 500, grams: 500, proteinG: 100, fatG: 10, sugarsG: 5, saltG: 1 });
    expect(small.grade).toBe(big.grade);
  });

  it('la proteína y la fibra suben la nota y el azúcar, la grasa y la sal la bajan', () => {
    const plain = of({ kcal: 250, proteinG: 5, fatG: 8, sugarsG: 2, saltG: 0.3 });
    expect(of({ kcal: 250, proteinG: 20, fatG: 8, sugarsG: 2, saltG: 0.3 }).points).toBeGreaterThanOrEqual(plain.points);
    expect(of({ kcal: 250, proteinG: 5, fatG: 8, sugarsG: 2, saltG: 0.3, fiberG: 6 }).points).toBeGreaterThanOrEqual(plain.points);
    expect(of({ kcal: 250, proteinG: 5, fatG: 8, sugarsG: 30, saltG: 0.3 }).points).toBeLessThan(plain.points);
    expect(of({ kcal: 250, proteinG: 5, fatG: 8, sugarsG: 2, saltG: 2 }).points).toBeLessThan(plain.points);
    expect(of({ kcal: 250, proteinG: 5, fatG: 30, sugarsG: 2, saltG: 0.3 }).points).toBeLessThan(plain.points);
  });

  it('con muchos puntos malos la proteína no salva un alimento (un bollo proteico, un embutido)', () => {
    const bun = of({ kcal: 450, proteinG: 25, fatG: 30, sugarsG: 30, saltG: 1.5, fatKind: 'saturated' });
    expect(bun.points).toBeLessThan(0);
  });

  it('una fruta o verdura sale con la mejor nota; con fruta de nombre pero más densa, solo con un punto', () => {
    expect(of({ kcal: 50, proteinG: 1, sugarsG: 10, fiberG: 2, naturalSugar: true, produce: 'mostly' }).grade).toBe('A');
    const stew = of({ kcal: 150, proteinG: 5, fatG: 4, sugarsG: 3, saltG: 0.8, fiberG: 2, produce: 'some' });
    expect(['B', 'C']).toContain(stew.grade);
  });

  it('el aceite y los frutos secos no se castigan por tanta grasa: cuenta la proporción de saturada', () => {
    const oil = of({ kcal: 900, proteinG: 0, fatG: 100, fatKind: 'healthy' });
    const butter = of({ kcal: 900, proteinG: 0, fatG: 100, fatKind: 'saturated' });
    expect(oil.points).toBeGreaterThan(butter.points);
  });

  it('sin la sal o los azúcares anotados la nota no pasa de «buena» (salvo en plantas)', () => {
    const lean = { proteinG: 30, kcal: 150, fatG: 3 };
    expect(of({ ...lean, sugarsG: undefined, saltG: undefined }).points).toBe(1);
    expect(of({ ...lean }).points).toBe(2);
    expect(of({ kcal: 40, proteinG: 2, sugarsG: undefined, saltG: undefined, fiberG: 3, produce: 'mostly' }).points).toBe(2);
  });

  it('«corePoints» no cuenta los azúcares ni la sal, que ya puntúa el criterio «Sal y azúcar»', () => {
    const salty = of({ kcal: 250, proteinG: 8, fatG: 8, sugarsG: 2, saltG: 3 });
    expect(salty.corePoints).toBeGreaterThan(salty.points);
  });

  it('dice lo que más pesa, de más a menos', () => {
    const p = of({ kcal: 400, proteinG: 30, fatG: 20, sugarsG: 28, saltG: 0.3, fiberG: 4 });
    expect(p.good).toContain('mucha proteína');
    expect(p.good).toContain('con fibra');
    expect(p.bad[0]).toBe('mucho azúcar');
    expect(p.notable.length).toBe(p.good.length + p.bad.length);
  });
});

describe('drinkProfile', () => {
  it('agua y café solo: la mejor nota; un refresco azucarado, la peor', () => {
    expect(drinkProfile({ kcal: 0, grams: 300 })!.points).toBe(2);
    expect(drinkProfile({ kcal: 139, grams: 330, sugarsG: 35 })!.points).toBe(-2);
    expect(drinkProfile({ kcal: 90, grams: 200, sugarsG: 18 })!.points).toBe(-2);
  });

  it('sin saber cuánto se bebió no hay perfil', () => {
    expect(drinkProfile({ kcal: 100, grams: 10 })).toBeNull();
  });
});
