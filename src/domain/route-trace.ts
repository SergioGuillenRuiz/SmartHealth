// El recorrido de un entreno con GPS: la lista de posiciones por las que pasó, lo justo para dibujarlo en un mapa al revisarlo. Se guarda en el registro (`WorkoutRecord.route`) como pares
// [latitud, longitud] con 5 decimales (≈ 1 m: de sobra para un dibujo) y se simplifica para que un paseo de horas no pese más que unos pocos miles de bytes.

/** [latitud, longitud] en grados con 5 decimales. */
export type RoutePoint = [number, number];

/** Tope de puntos que se guardan en un entreno (tras simplificar). */
export const MAX_ROUTE_POINTS = 600;
/** Separación mínima entre dos puntos recogidos mientras se graba: por debajo es temblor del GPS. */
export const MIN_POINT_SPACING_M = 8;
/** Tope de puntos en bruto en memoria mientras se graba: al pasarlo se aclara a la mitad y se dobla la separación. */
export const MAX_RAW_POINTS = 4000;
/** Cuánto se aparta de la recta un punto para dejar de ser «de adorno» al simplificar (m). */
const BASE_TOLERANCE_M = 2.5;

const M_PER_DEG = 111_195; // metros por grado de latitud (esfera de la Tierra)
const roundDeg = (deg: number): number => Math.round(deg * 1e5) / 1e5;

export const routePoint = (lat: number, lon: number): RoutePoint => [roundDeg(lat), roundDeg(lon)];

/** ¿Son coordenadas de verdad? */
export const isCoordinate = (lat: unknown, lon: unknown): boolean =>
  typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Distancia aproximada entre dos puntos cercanos (m), con la proyección plana local: de sobra para separaciones de metros o kilómetros. */
export function flatDistance(a: readonly [number, number], b: readonly [number, number]): number {
  const kLon = M_PER_DEG * Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * M_PER_DEG, (b[1] - a[1]) * kLon);
}

/**
 * Deja los puntos que más cuentan para la forma del recorrido (Douglas–Peucker por presupuesto): se parte de la recta entre la salida y la llegada y, una y otra vez, se añade el punto que
 * más se aparta de la recta que lo cubre, hasta que ninguno se aparte más de unos metros o se llegue a `maxPoints`. Así un paseo recto son dos puntos y uno enrevesado usa todo el presupuesto
 * en sus curvas, sin saltos bruscos entre «mucho» y «casi nada». Con menos de tres puntos no hay nada que quitar.
 */
export function simplifyRoute(points: readonly RoutePoint[], maxPoints: number = MAX_ROUTE_POINTS): RoutePoint[] {
  const n = points.length;
  if (n <= 2) return points.map((p) => [p[0], p[1]]);
  const lat0 = points[0]![0];
  const kLon = M_PER_DEG * Math.cos(lat0 * (Math.PI / 180));
  // A metros respecto al primero: más simple y rápido que la geodesia en cada paso.
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (points[i]![1] - points[0]![1]) * kLon;
    ys[i] = (points[i]![0] - lat0) * M_PER_DEG;
  }
  const distToSegment = (i: number, a: number, b: number): number => {
    const dx = xs[b]! - xs[a]!;
    const dy = ys[b]! - ys[a]!;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(xs[i]! - xs[a]!, ys[i]! - ys[a]!);
    const t = Math.max(0, Math.min(1, ((xs[i]! - xs[a]!) * dx + (ys[i]! - ys[a]!) * dy) / len2));
    return Math.hypot(xs[i]! - (xs[a]! + t * dx), ys[i]! - (ys[a]! + t * dy));
  };
  /** El punto de (a, b) que más se aparta de la recta a–b, y cuánto. */
  const worstIn = (a: number, b: number): { index: number; dev: number } => {
    let index = -1;
    let dev = 0;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(i, a, b);
      if (d > dev) {
        dev = d;
        index = i;
      }
    }
    return { index, dev };
  };

  // Montículo de tramos, el que más se aparta arriba.
  interface Span {
    a: number;
    b: number;
    index: number;
    dev: number;
  }
  const heap: Span[] = [];
  const push = (span: Span): void => {
    heap.push(span);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.dev >= heap[i]!.dev) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const pop = (): Span => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let big = i;
        if (l < heap.length && heap[l]!.dev > heap[big]!.dev) big = l;
        if (r < heap.length && heap[r]!.dev > heap[big]!.dev) big = r;
        if (big === i) break;
        [heap[big], heap[i]] = [heap[i]!, heap[big]!];
        i = big;
      }
    }
    return top;
  };

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let kept = 2;
  const first = worstIn(0, n - 1);
  if (first.index >= 0) push({ a: 0, b: n - 1, ...first });
  while (heap.length > 0 && kept < maxPoints) {
    const span = pop();
    if (span.dev <= BASE_TOLERANCE_M) break;
    keep[span.index] = 1;
    kept++;
    const left = worstIn(span.a, span.index);
    if (left.index >= 0) push({ a: span.a, b: span.index, ...left });
    const right = worstIn(span.index, span.b);
    if (right.index >= 0) push({ a: span.index, b: span.b, ...right });
  }
  const out: RoutePoint[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([points[i]![0], points[i]![1]]);
  return out;
}

/** Une dos recorridos (el de antes y el recuperado después) y los simplifica juntos. */
export function mergeRoutes(a: readonly RoutePoint[] | undefined, b: readonly RoutePoint[] | undefined): RoutePoint[] {
  const joined = [...(a ?? []), ...(b ?? [])];
  return joined.length > MAX_ROUTE_POINTS ? simplifyRoute(joined) : joined.map((p) => [p[0], p[1]]);
}

/** ¿Es un recorrido que cabe en un registro? (Se usa al importar una copia de seguridad.) */
export function isValidRoute(v: unknown): v is RoutePoint[] {
  return Array.isArray(v) && v.length <= MAX_ROUTE_POINTS && v.every((p) => Array.isArray(p) && p.length === 2 && isCoordinate(p[0], p[1]));
}

/** La caja que contiene el recorrido, o `null` si no hay puntos. */
export function routeBounds(points: readonly RoutePoint[]): { minLat: number; maxLat: number; minLon: number; maxLon: number } | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of points) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Lo que recoge el grabador mientras dura el entreno: un punto cada `MIN_POINT_SPACING_M` como mínimo y, si la lista se hace enorme (un día entero grabando), se aclara a la mitad y se dobla
 * la separación, para que ni la memoria ni el tiempo de simplificar crezcan sin límite. `snapshot()` simplifica solo cuando cambia la lista.
 */
export class RouteCollector {
  private raw: RoutePoint[] = [];
  private gapM = MIN_POINT_SPACING_M;
  private cache: { length: number; last: RoutePoint | null; points: RoutePoint[] } | null = null;
  /** La última posición válida, aunque quede dentro de la separación: el recorrido termina donde de verdad se terminó. */
  private tail: RoutePoint | null = null;

  add(lat: number, lon: number): void {
    if (!isCoordinate(lat, lon)) return;
    const p = routePoint(lat, lon);
    this.tail = p;
    const last = this.raw[this.raw.length - 1];
    if (last && flatDistance(last, p) < this.gapM) return;
    this.raw.push(p);
    if (this.raw.length > MAX_RAW_POINTS) {
      this.raw = this.raw.filter((_, i, all) => i % 2 === 0 || i === all.length - 1);
      this.gapM *= 2;
    }
  }

  /** El recorrido simplificado, o `undefined` si aún no hay por dónde (menos de dos puntos separados). */
  points(): RoutePoint[] | undefined {
    const all = this.withTail();
    if (all.length < 2) return undefined;
    const last = all[all.length - 1]!;
    if (!this.cache || this.cache.length !== all.length || this.cache.last?.[0] !== last[0] || this.cache.last?.[1] !== last[1]) {
      this.cache = { length: all.length, last, points: simplifyRoute(all) };
    }
    return this.cache.points.map((p) => [p[0], p[1]]);
  }

  private withTail(): RoutePoint[] {
    const last = this.raw[this.raw.length - 1];
    if (!last || !this.tail || (last[0] === this.tail[0] && last[1] === this.tail[1])) return this.raw;
    return [...this.raw, this.tail];
  }

  /** Cuántos puntos lleva sin simplificar (para las pruebas). */
  get rawLength(): number {
    return this.raw.length;
  }
}
