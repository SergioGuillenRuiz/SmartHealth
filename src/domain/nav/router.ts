import { flatDistanceM, type LatLon } from './geo';
import { edgePolyline, polylineLengthM, snapToEdges, type EdgeSnap, type Graph } from './graph';
import { NO_NAME } from './pack';
import type { Profile } from './profiles';

// La ruta: un A* sobre el grafo de tramos con el coste del perfil del entreno. El origen y el destino caen en mitad de un tramo, así que se parte de las dos puntas del tramo de salida
// (con lo que cuesta llegar hasta ellas) y se acaba en las dos del de llegada. El resultado es una polilínea con sus «tramos recorridos» (para sacar las instrucciones).

/** Un tramo recorrido de la ruta, en su sentido, con la parte que se usa (el primero y el último pueden ser solo una parte). */
export interface RouteLeg {
  edge: number;
  /** `true` si se va de `a` a `b`. */
  forward: boolean;
  /** Los puntos de este tramo, en el sentido de la marcha y recortados a lo que se recorre. */
  points: LatLon[];
  lengthM: number;
  cls: number;
  flags: number;
  name: number;
  /** Índice en `Route.points` del primer punto del tramo. */
  startIndex: number;
}

export interface Route {
  profile: Profile;
  points: LatLon[];
  /** Distancia acumulada (m) desde el inicio hasta cada punto de `points`. */
  cumM: number[];
  distanceM: number;
  durationS: number;
  legs: RouteLeg[];
  origin: EdgeSnap;
  destination: EdgeSnap;
}

export type RouteFailure = 'no-road-near-start' | 'no-road-near-destination' | 'no-route' | 'too-far';
export type RouteResult = { ok: true; route: Route } | { ok: false; reason: RouteFailure };

/**
 * Hasta dónde se busca una calle junto al punto de salida y de llegada (m), de cerca a lejos. El destino puede ser el centro de un parque o de un recinto, que queda lejos de cualquier calle:
 * la ruta acaba en el punto más cercano al que se puede llegar y la última instrucción dice cuánto falta.
 */
const START_RADII_M = [150, 400];
const END_RADII_M = [150, 500, 1500, 4000];
/** Una red con menos tramos que esto es una isla (un sendero suelto, una vía privada): si hay otra mayor cerca, se prefiere. */
const MIN_NETWORK_NODES = 30;
/** Cuántos tramos cercanos se prueban como salida antes de quedarse con el mejor. */
const START_CANDIDATES = 6;
/** Un tope de nodos a explorar (una ruta imposible no debe colgar el móvil). */
const MAX_EXPANSIONS = 3_000_000;
const MAX_DIRECT_DISTANCE_M = 120_000;

/** Los nodos a los que se puede llegar desde el punto de salida con ese perfil (respeta los sentidos únicos), y cuántos son. */
function reachableFrom(graph: Graph, profile: Profile, origin: EdgeSnap): { reach: Uint8Array; count: number } {
  const pack = graph.pack;
  const reach = new Uint8Array(pack.nodeCount);
  const stack: number[] = [];
  let count = 0;
  const visit = (node: number): void => {
    if (reach[node] === 1) return;
    reach[node] = 1;
    count++;
    stack.push(node);
  };
  const cost = (edge: number, dir: 0 | 1): number => profile.cost(pack.edgeCls[edge]!, pack.edgeFlags[edge]!, dir, 1);
  if (cost(origin.edge, 1) < Infinity) visit(pack.edgeA[origin.edge]!);
  if (cost(origin.edge, 0) < Infinity) visit(pack.edgeB[origin.edge]!);
  while (stack.length > 0) {
    const u = stack.pop()!;
    for (let k = graph.adjStart[u]!; k < graph.adjStart[u + 1]!; k++) {
      const entry = graph.adj[k]!;
      const edge = entry >> 1;
      const dir = (entry & 1) as 0 | 1;
      if (!(cost(edge, dir) < Infinity)) continue;
      visit(dir === 0 ? pack.edgeB[edge]! : pack.edgeA[edge]!);
    }
  }
  return { reach, count };
}

// Pila binaria de mínimos con arrays paralelos.
class Heap {
  private prio = new Float64Array(1024);
  private item = new Int32Array(1024);
  size = 0;

  push(priority: number, node: number): void {
    if (this.size === this.prio.length) {
      const bigger = new Float64Array(this.size * 2);
      bigger.set(this.prio);
      this.prio = bigger;
      const biggerItems = new Int32Array(this.size * 2);
      biggerItems.set(this.item);
      this.item = biggerItems;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent]! <= priority) break;
      this.prio[i] = this.prio[parent]!;
      this.item[i] = this.item[parent]!;
      i = parent;
    }
    this.prio[i] = priority;
    this.item[i] = node;
  }

  peekPriority(): number {
    return this.prio[0]!;
  }

  pop(): number {
    const top = this.item[0]!;
    const lastPrio = this.prio[--this.size]!;
    const lastItem = this.item[this.size]!;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.prio[child + 1]! < this.prio[child]!) child++;
      if (this.prio[child]! >= lastPrio) break;
      this.prio[i] = this.prio[child]!;
      this.item[i] = this.item[child]!;
      i = child;
    }
    this.prio[i] = lastPrio;
    this.item[i] = lastItem;
    return top;
  }
}

// Lo reutilizable entre rutas del mismo grafo (para no reservar megabytes en cada cálculo).
interface Workspace {
  cost: Float64Array;
  via: Int32Array; // entrada de adyacencia por la que se llegó (-1: es una salida; -2: sin visitar)
  epoch: Uint32Array;
  current: number;
}
const workspaces = new WeakMap<Graph, Workspace>();
function workspaceOf(graph: Graph): Workspace {
  let ws = workspaces.get(graph);
  if (!ws) {
    const n = graph.pack.nodeCount;
    ws = { cost: new Float64Array(n), via: new Int32Array(n), epoch: new Uint32Array(n), current: 0 };
    workspaces.set(graph, ws);
  }
  return ws;
}

const lenM = (graph: Graph, edge: number): number => graph.pack.edgeLenDm[edge]! / 10;
const nodeLat = (graph: Graph, node: number): number => graph.pack.nodeLat[node]! / 1e7;
const nodeLon = (graph: Graph, node: number): number => graph.pack.nodeLon[node]! / 1e7;

/** Un sub-trozo de una polilínea entre las distancias `fromM` y `toM` desde su inicio (en ese sentido). */
function slice(points: readonly LatLon[], fromM: number, toM: number): LatLon[] {
  const out: LatLon[] = [];
  let at = 0;
  const lerp = (a: LatLon, b: LatLon, t: number): LatLon => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = flatDistanceM(a.lat, a.lon, b.lat, b.lon);
    const start = at;
    const end = at + seg;
    at = end;
    if (end < fromM || start > toM) continue;
    if (out.length === 0) out.push(seg === 0 ? a : lerp(a, b, Math.max(0, (fromM - start) / seg)));
    out.push(toM >= end || seg === 0 ? b : lerp(a, b, (toM - start) / seg));
  }
  if (out.length === 0) out.push(points[0]!);
  return out;
}

const reverse = (points: readonly LatLon[]): LatLon[] => [...points].reverse();

/** Una ruta entre dos puntos para un perfil. */
export function findRoute(graph: Graph, profile: Profile, from: LatLon, to: LatLon): RouteResult {
  if (flatDistanceM(from.lat, from.lon, to.lat, to.lon) > MAX_DIRECT_DISTANCE_M) return { ok: false, reason: 'too-far' };
  const pack = graph.pack;
  const costOf = (edge: number, dir: 0 | 1, meters: number): number => profile.cost(pack.edgeCls[edge]!, pack.edgeFlags[edge]!, dir, meters);
  const usable = (e: number): boolean => costOf(e, 0, 1) < Infinity || costOf(e, 1, 1) < Infinity;

  // La salida: el tramo más cercano, salvo que esté en una isla de la red (un sendero suelto, una vía privada) y haya otra red mayor a poca distancia.
  let origin: EdgeSnap | null = null;
  let reach: Uint8Array | null = null;
  let reachCount = -1;
  for (const radius of START_RADII_M) {
    for (const candidate of snapToEdges(graph, from.lat, from.lon, radius, usable, START_CANDIDATES)) {
      const found = reachableFrom(graph, profile, candidate);
      if (found.count > reachCount) {
        origin = candidate;
        reach = found.reach;
        reachCount = found.count;
      }
      if (reachCount >= MIN_NETWORK_NODES) break;
    }
    if (origin && reachCount >= MIN_NETWORK_NODES) break;
  }
  if (!origin || !reach) return { ok: false, reason: 'no-road-near-start' };

  // La llegada: el tramo más cercano al destino AL QUE SE PUEDE LLEGAR desde la salida (con su sentido). Si el más cercano de todos es una isla, se llega al más cercano de la red de la persona.
  const reached = reach;
  const startEdge = origin.edge;
  const arrivable = (e: number): boolean => e === startEdge || (reached[pack.edgeA[e]!] === 1 && costOf(e, 0, 1) < Infinity) || (reached[pack.edgeB[e]!] === 1 && costOf(e, 1, 1) < Infinity);
  let destination: EdgeSnap | null = null;
  let anyRoadNear = false;
  for (const radius of END_RADII_M) {
    if (!anyRoadNear) anyRoadNear = snapToEdges(graph, to.lat, to.lon, radius, usable, 1).length > 0;
    destination = snapToEdges(graph, to.lat, to.lon, radius, arrivable, 1)[0] ?? null;
    if (destination) break;
  }
  if (!destination) return { ok: false, reason: anyRoadNear ? 'no-route' : 'no-road-near-destination' };
  const ws = workspaceOf(graph);
  ws.current++;
  if (ws.current === 0xffffffff) {
    ws.epoch.fill(0);
    ws.current = 1;
  }
  const epoch = ws.current;
  const heap = new Heap();
  const targetLat = destination.lat;
  const targetLon = destination.lon;
  const h = (node: number): number => flatDistanceM(nodeLat(graph, node), nodeLon(graph, node), targetLat, targetLon) * profile.minFactor;

  const seed = (node: number, cost: number): void => {
    if (!(cost < Infinity)) return;
    if (ws.epoch[node] === epoch && ws.cost[node]! <= cost) return;
    ws.epoch[node] = epoch;
    ws.cost[node] = cost;
    ws.via[node] = -1;
    heap.push(cost + h(node), node);
  };
  // Del punto de salida se sale por cualquiera de las dos puntas del tramo, si ese sentido se puede.
  const oEdge = origin.edge;
  const oLen = origin.lengthM;
  seed(pack.edgeA[oEdge]!, costOf(oEdge, 1, oLen * origin.t));
  seed(pack.edgeB[oEdge]!, costOf(oEdge, 0, oLen * (1 - origin.t)));

  // Se llega al destino por cualquiera de las dos puntas de su tramo.
  const dEdge = destination.edge;
  const dLen = destination.lengthM;
  const finishViaA = costOf(dEdge, 0, dLen * destination.t); // de la punta a hasta el punto
  const finishViaB = costOf(dEdge, 1, dLen * (1 - destination.t));
  const endA = pack.edgeA[dEdge]!;
  const endB = pack.edgeB[dEdge]!;

  let best = Infinity;
  let bestNode = -1;
  let expansions = 0;
  while (heap.size > 0) {
    const f = heap.peekPriority();
    if (f >= best) break;
    const u = heap.pop();
    const g = ws.cost[u]!;
    // Una entrada vieja (se encontró algo mejor después).
    if (f - h(u) > g + 1e-6) continue;
    if (++expansions > MAX_EXPANSIONS) break;
    if (u === endA && g + finishViaA < best) {
      best = g + finishViaA;
      bestNode = u;
    }
    if (u === endB && g + finishViaB < best) {
      best = g + finishViaB;
      bestNode = u;
    }
    for (let k = graph.adjStart[u]!; k < graph.adjStart[u + 1]!; k++) {
      const entry = graph.adj[k]!;
      const edge = entry >> 1;
      const dir = (entry & 1) as 0 | 1;
      const step = costOf(edge, dir, lenM(graph, edge));
      if (!(step < Infinity)) continue;
      const v = dir === 0 ? pack.edgeB[edge]! : pack.edgeA[edge]!;
      const ng = g + step;
      if (ws.epoch[v] === epoch && ws.cost[v]! <= ng) continue;
      ws.epoch[v] = epoch;
      ws.cost[v] = ng;
      ws.via[v] = k;
      heap.push(ng + h(v), v);
    }
  }

  // Si salida y llegada caen en el mismo tramo, ir directamente puede ser lo mejor.
  let directCost = Infinity;
  if (origin.edge === destination.edge) {
    const dir: 0 | 1 = destination.t >= origin.t ? 0 : 1;
    directCost = costOf(origin.edge, dir, oLen * Math.abs(destination.t - origin.t));
  }
  if (!(best < Infinity) && !(directCost < Infinity)) return { ok: false, reason: 'no-route' };

  const legs: RouteLeg[] = [];
  const addLeg = (edge: number, forward: boolean, pts: LatLon[]): void => {
    if (pts.length < 2 && legs.length > 0) return;
    legs.push({
      edge,
      forward,
      points: pts,
      lengthM: polylineLengthM(pts),
      cls: pack.edgeCls[edge]!,
      flags: pack.edgeFlags[edge]!,
      name: pack.edgeName[edge]!,
      startIndex: 0,
    });
  };

  if (directCost <= best) {
    const poly = edgePolyline(pack, origin.edge);
    const total = polylineLengthM(poly);
    const a = origin.t * total;
    const b = destination.t * total;
    const forward = b >= a;
    const part = slice(poly, Math.min(a, b), Math.max(a, b));
    addLeg(origin.edge, forward, forward ? part : reverse(part));
  } else {
    // Se recompone hacia atrás desde la punta por la que se llega al destino.
    const chain: Array<{ edge: number; forward: boolean }> = [];
    let node = bestNode;
    while (ws.via[node]! >= 0) {
      const entry = graph.adj[ws.via[node]!]!;
      const edge = entry >> 1;
      const dir = entry & 1;
      chain.push({ edge, forward: dir === 0 });
      node = dir === 0 ? pack.edgeA[edge]! : pack.edgeB[edge]!;
    }
    chain.reverse();
    const startNode = node; // la punta del tramo de salida por la que se sale
    // Tramo de salida: del punto a esa punta.
    const oPoly = edgePolyline(pack, origin.edge);
    const oTotal = polylineLengthM(oPoly);
    const oAt = origin.t * oTotal;
    if (startNode === pack.edgeB[origin.edge]) {
      const part = slice(oPoly, oAt, oTotal);
      if (oTotal - oAt > 0.01) addLeg(origin.edge, true, part);
    } else {
      const part = reverse(slice(oPoly, 0, oAt));
      if (oAt > 0.01) addLeg(origin.edge, false, part);
    }
    for (const step of chain) {
      const poly = edgePolyline(pack, step.edge);
      addLeg(step.edge, step.forward, step.forward ? poly : reverse(poly));
    }
    // Tramo de llegada: de la punta hasta el punto.
    const dPoly = edgePolyline(pack, destination.edge);
    const dTotal = polylineLengthM(dPoly);
    const dAt = destination.t * dTotal;
    if (bestNode === endA) {
      const part = slice(dPoly, 0, dAt);
      if (dAt > 0.01) addLeg(destination.edge, true, part);
    } else {
      const part = reverse(slice(dPoly, dAt, dTotal));
      if (dTotal - dAt > 0.01) addLeg(destination.edge, false, part);
    }
  }

  // Se une todo en una polilínea.
  const points: LatLon[] = [];
  const cumM: number[] = [];
  let travelled = 0;
  let duration = 0;
  for (const leg of legs) {
    leg.startIndex = points.length === 0 ? 0 : points.length - 1;
    for (let i = 0; i < leg.points.length; i++) {
      const p = leg.points[i]!;
      if (points.length > 0 && i === 0) continue; // el punto de unión ya está
      if (points.length > 0) travelled += flatDistanceM(points[points.length - 1]!.lat, points[points.length - 1]!.lon, p.lat, p.lon);
      points.push(p);
      cumM.push(travelled);
    }
    duration += leg.lengthM / profile.speed(leg.cls, leg.flags);
  }
  if (points.length === 0) points.push({ lat: origin.lat, lon: origin.lon }, { lat: destination.lat, lon: destination.lon }), cumM.push(0, flatDistanceM(origin.lat, origin.lon, destination.lat, destination.lon));
  return { ok: true, route: { profile, points, cumM, distanceM: cumM[cumM.length - 1] ?? 0, durationS: duration, legs, origin, destination } };
}

/** El nombre de la calle del tramo de la ruta, o `''`. */
export const legNameId = (leg: RouteLeg): number => leg.name;
export const hasName = (leg: RouteLeg): boolean => leg.name !== NO_NAME;
