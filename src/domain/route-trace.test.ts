import { describe, expect, it } from 'vitest';
import { flatDistance, isValidRoute, MAX_RAW_POINTS, MAX_ROUTE_POINTS, mergeRoutes, MIN_POINT_SPACING_M, routeBounds, RouteCollector, routePoint, simplifyRoute, type RoutePoint } from './route-trace';

const M = 111_195;
/** Un punto a `north` metros al norte y `east` al este de Madrid. */
const at = (north: number, east = 0): RoutePoint => routePoint(40.4 + north / M, -3.7 + east / (M * Math.cos((40.4 * Math.PI) / 180)));

describe('routePoint: 5 decimales', () => {
  it('redondea a ≈ 1 m', () => {
    expect(routePoint(40.123456789, -3.987654321)).toEqual([40.12346, -3.98765]);
  });
});

describe('simplifyRoute (Douglas–Peucker)', () => {
  it('una recta de mil puntos queda en sus dos extremos', () => {
    const line = Array.from({ length: 1000 }, (_, i) => at(i * 3));
    expect(simplifyRoute(line)).toEqual([line[0], line[999]]);
  });

  it('conserva las esquinas: un tramo al norte y otro al este deja tres puntos', () => {
    const l: RoutePoint[] = [];
    for (let i = 0; i <= 100; i++) l.push(at(i * 5));
    for (let i = 1; i <= 100; i++) l.push(at(500, i * 5));
    const s = simplifyRoute(l);
    expect(s).toHaveLength(3);
    expect(s[1]).toEqual(at(500));
  });

  it('nunca pasa del tope y mantiene la salida y la llegada aunque el recorrido sea enrevesado', () => {
    const wiggly = Array.from({ length: 20_000 }, (_, i) => at(i * 2, 30 * Math.sin(i / 7) + 12 * Math.sin(i / 2.3)));
    const s = simplifyRoute(wiggly);
    expect(s.length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
    expect(s.length).toBeGreaterThan(50);
    expect(s[0]).toEqual(wiggly[0]);
    expect(s[s.length - 1]).toEqual(wiggly[wiggly.length - 1]);
  });

  it('la forma simplificada se aparta poco de la original (nunca más de unas decenas de metros)', () => {
    const curve = Array.from({ length: 5000 }, (_, i) => at(i * 1.5, 200 * Math.sin(i / 400)));
    const s = simplifyRoute(curve, 120);
    let worst = 0;
    for (const p of curve) {
      let best = Infinity;
      for (let i = 1; i < s.length; i++) best = Math.min(best, segmentDistance(p, s[i - 1]!, s[i]!));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(25);
  });

  it('con dos puntos o menos no hace nada', () => {
    expect(simplifyRoute([])).toEqual([]);
    expect(simplifyRoute([at(0)])).toEqual([at(0)]);
    expect(simplifyRoute([at(0), at(50)])).toEqual([at(0), at(50)]);
  });
});

/** Distancia (m) de `p` al segmento a–b. */
function segmentDistance(p: RoutePoint, a: RoutePoint, b: RoutePoint): number {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * M * k;
  const ay = (a[0] - p[0]) * M;
  const bx = (b[1] - p[1]) * M * k;
  const by = (b[0] - p[0]) * M;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

describe('RouteCollector: lo que se recoge mientras se graba', () => {
  it('los puntos a menos de la separación mínima no se guardan (el temblor del GPS parado)', () => {
    const c = new RouteCollector();
    for (let i = 0; i < 200; i++) c.add(40.4 + (i % 3) * 1e-6, -3.7 + (i % 2) * 1e-6);
    expect(c.rawLength).toBe(1);
    expect(c.points()).toBeUndefined();
  });

  it('anda en línea recta y guarda uno cada ~8 m; el recorrido simplificado son los dos extremos', () => {
    const c = new RouteCollector();
    for (let i = 0; i <= 500; i++) c.add(...at(i * 2));
    expect(c.rawLength).toBeLessThanOrEqual(130);
    expect(c.rawLength).toBeGreaterThan(100);
    const p = c.points()!;
    expect(p).toHaveLength(2);
    expect(flatDistance(p[0]!, p[1]!)).toBeGreaterThan(990);
  });

  it('el recorrido acaba donde se acabó de verdad aunque el último paso quede dentro de la separación mínima', () => {
    const c = new RouteCollector();
    c.add(...at(0));
    c.add(...at(100));
    c.add(...at(103)); // a 3 m del anterior: no se guarda en bruto, pero es el final
    const p = c.points()!;
    expect(p[p.length - 1]).toEqual(at(103));
  });

  it('coordenadas imposibles (NaN, fuera de rango) se ignoran', () => {
    const c = new RouteCollector();
    c.add(NaN, -3);
    c.add(95, -3);
    c.add(40, 200);
    expect(c.rawLength).toBe(0);
  });

  it('un día entero grabando no hace crecer la memoria sin límite: se aclara y se dobla la separación', () => {
    const c = new RouteCollector();
    for (let i = 0; i < MAX_RAW_POINTS * 3; i++) c.add(...at(i * (MIN_POINT_SPACING_M + 1)));
    expect(c.rawLength).toBeLessThanOrEqual(MAX_RAW_POINTS);
    const p = c.points()!;
    expect(p[0]).toEqual(at(0));
    expect(p.length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
  });

  it('pedir el recorrido varias veces sin puntos nuevos devuelve lo mismo (se reutiliza lo simplificado) y copias independientes', () => {
    const c = new RouteCollector();
    for (let i = 0; i <= 300; i++) c.add(...at(i * 10, 40 * Math.sin(i / 9)));
    const a = c.points()!;
    const b = c.points()!;
    expect(b).toEqual(a);
    a[0]![0] = 0;
    expect(c.points()![0]![0]).not.toBe(0);
  });
});

describe('mergeRoutes e isValidRoute', () => {
  it('une el de antes y el recuperado, y respeta el tope', () => {
    const a = Array.from({ length: 500 }, (_, i) => at(i * 10, 25 * Math.sin(i / 5)));
    const b = Array.from({ length: 500 }, (_, i) => at(5000 + i * 10, 25 * Math.cos(i / 5)));
    const m = mergeRoutes(a, b);
    expect(m.length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
    expect(m[0]).toEqual(a[0]);
    expect(m[m.length - 1]).toEqual(b[499]);
    expect(mergeRoutes(undefined, [at(0), at(20)])).toEqual([at(0), at(20)]);
  });

  it('acepta una lista de pares válidos y rechaza lo raro', () => {
    expect(isValidRoute([at(0), at(10)])).toBe(true);
    expect(isValidRoute([])).toBe(true);
    expect(isValidRoute('texto')).toBe(false);
    expect(isValidRoute([[40, -3, 5]])).toBe(false);
    expect(isValidRoute([[40, 'x']])).toBe(false);
    expect(isValidRoute([[91, 0]])).toBe(false);
    expect(isValidRoute([[0, 181]])).toBe(false);
    expect(isValidRoute([[NaN, 0]])).toBe(false);
    expect(isValidRoute(Array.from({ length: MAX_ROUTE_POINTS + 1 }, () => [40, -3]))).toBe(false);
  });

  it('routeBounds da la caja y null si no hay puntos', () => {
    expect(routeBounds([])).toBeNull();
    expect(routeBounds([[40, -3], [41, -4], [40.5, -3.5]])).toEqual({ minLat: 40, maxLat: 41, minLon: -4, maxLon: -3 });
  });
});
