import { flatDistanceM, fromE7, M_PER_DEG, projectOnSegment, toRad, type LatLon } from './geo';
import type { MapPack } from './pack';

// Lo que se construye al abrir el paquete para poder buscar rutas y dibujar: la lista de tramos que salen de cada nodo (CSR) y una rejilla espacial de tramos para encontrar «lo que hay
// por aquí» (el tramo más cercano a un punto, lo que cae en una tesela). Todo en arrays tipados.

/** Tamaño de las celdas de la rejilla (grados): ~550 m de lado. */
const CELL_DEG = 0.005;

export interface Graph {
  pack: MapPack;
  /** `adjStart[n]..adjStart[n+1]` son las entradas de `adj` de los tramos que tocan el nodo `n`. */
  adjStart: Uint32Array;
  /** Cada entrada es `tramo * 2 + sentido`: 0 = se sale del nodo por el extremo `a` (se va de a a b), 1 = se sale por `b` (de b a a). */
  adj: Uint32Array;
  grid: {
    minLat: number;
    minLon: number;
    cols: number;
    rows: number;
    cellStart: Uint32Array;
    cellEdges: Uint32Array;
  };
  /** Para no repetir un tramo que está en varias celdas al buscar (se compara con `stamp`). */
  seen: Uint32Array;
  stamp: number;
}

/** Los extremos del tramo `i` y su geometría intermedia, en grados, de `a` a `b`. */
export function edgePolyline(pack: MapPack, edge: number): LatLon[] {
  const out: LatLon[] = [{ lat: fromE7(pack.nodeLat[pack.edgeA[edge]!]!), lon: fromE7(pack.nodeLon[pack.edgeA[edge]!]!) }];
  for (let g = pack.edgeGeomStart[edge]!; g < pack.edgeGeomStart[edge + 1]!; g++) out.push({ lat: fromE7(pack.geomLat[g]!), lon: fromE7(pack.geomLon[g]!) });
  out.push({ lat: fromE7(pack.nodeLat[pack.edgeB[edge]!]!), lon: fromE7(pack.nodeLon[pack.edgeB[edge]!]!) });
  return out;
}

/** La longitud geométrica de una polilínea (m). */
export function polylineLengthM(points: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += flatDistanceM(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon);
  return total;
}

export function buildGraph(pack: MapPack): Graph {
  const n = pack.nodeCount;
  const m = pack.edgeCount;
  const degree = new Uint32Array(n + 1);
  for (let e = 0; e < m; e++) {
    degree[pack.edgeA[e]!]!++;
    degree[pack.edgeB[e]!]!++;
  }
  const adjStart = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i]! + degree[i]!;
  const fill = adjStart.slice(0, n);
  const adj = new Uint32Array(adjStart[n]!);
  for (let e = 0; e < m; e++) {
    adj[fill[pack.edgeA[e]!]!++] = e * 2;
    adj[fill[pack.edgeB[e]!]!++] = e * 2 + 1;
  }

  // La rejilla: cada tramo en las celdas de su caja.
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  const widen = (la: number, lo: number): void => {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  };
  for (let i = 0; i < n; i++) widen(fromE7(pack.nodeLat[i]!), fromE7(pack.nodeLon[i]!));
  for (let i = 0; i < pack.geomLat.length; i++) widen(fromE7(pack.geomLat[i]!), fromE7(pack.geomLon[i]!));
  if (!Number.isFinite(minLat)) {
    minLat = minLon = 0;
    maxLat = maxLon = 0;
  }
  const cols = Math.max(1, Math.floor((maxLon - minLon) / CELL_DEG) + 1);
  const rows = Math.max(1, Math.floor((maxLat - minLat) / CELL_DEG) + 1);
  const cellOf = (la: number, lo: number): [number, number] => [Math.min(cols - 1, Math.max(0, Math.floor((lo - minLon) / CELL_DEG))), Math.min(rows - 1, Math.max(0, Math.floor((la - minLat) / CELL_DEG)))];
  const edgeBox = (e: number, out: [number, number, number, number]): void => {
    let a = fromE7(pack.nodeLat[pack.edgeA[e]!]!);
    let b = fromE7(pack.nodeLon[pack.edgeA[e]!]!);
    let loLa = a;
    let hiLa = a;
    let loLo = b;
    let hiLo = b;
    const take = (la: number, lo: number): void => {
      if (la < loLa) loLa = la;
      if (la > hiLa) hiLa = la;
      if (lo < loLo) loLo = lo;
      if (lo > hiLo) hiLo = lo;
    };
    for (let g = pack.edgeGeomStart[e]!; g < pack.edgeGeomStart[e + 1]!; g++) take(fromE7(pack.geomLat[g]!), fromE7(pack.geomLon[g]!));
    a = fromE7(pack.nodeLat[pack.edgeB[e]!]!);
    b = fromE7(pack.nodeLon[pack.edgeB[e]!]!);
    take(a, b);
    const [c0, r0] = cellOf(loLa, loLo);
    const [c1, r1] = cellOf(hiLa, hiLo);
    out[0] = c0;
    out[1] = r0;
    out[2] = c1;
    out[3] = r1;
  };
  const counts = new Uint32Array(cols * rows + 1);
  const box: [number, number, number, number] = [0, 0, 0, 0];
  for (let e = 0; e < m; e++) {
    edgeBox(e, box);
    for (let r = box[1]; r <= box[3]; r++) for (let c = box[0]; c <= box[2]; c++) counts[r * cols + c + 1]!++;
  }
  const cellStart = new Uint32Array(cols * rows + 1);
  for (let i = 0; i < cols * rows; i++) cellStart[i + 1] = cellStart[i]! + counts[i + 1]!;
  const cursor = cellStart.slice(0, cols * rows);
  const cellEdges = new Uint32Array(cellStart[cols * rows]!);
  for (let e = 0; e < m; e++) {
    edgeBox(e, box);
    for (let r = box[1]; r <= box[3]; r++) for (let c = box[0]; c <= box[2]; c++) cellEdges[cursor[r * cols + c]!++] = e;
  }
  return { pack, adjStart, adj, grid: { minLat, minLon, cols, rows, cellStart, cellEdges }, seen: new Uint32Array(m), stamp: 0 };
}

/** Llama a `visit` con cada tramo (una vez) que está en alguna celda que toca la caja dada. */
export function forEachEdgeInBox(graph: Graph, minLat: number, minLon: number, maxLat: number, maxLon: number, visit: (edge: number) => void): void {
  const g = graph.grid;
  const c0 = Math.max(0, Math.floor((minLon - g.minLon) / CELL_DEG));
  const c1 = Math.min(g.cols - 1, Math.floor((maxLon - g.minLon) / CELL_DEG));
  const r0 = Math.max(0, Math.floor((minLat - g.minLat) / CELL_DEG));
  const r1 = Math.min(g.rows - 1, Math.floor((maxLat - g.minLat) / CELL_DEG));
  if (c0 > c1 || r0 > r1) return;
  const stamp = ++graph.stamp;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * g.cols + c;
      for (let i = g.cellStart[cell]!; i < g.cellStart[cell + 1]!; i++) {
        const e = g.cellEdges[i]!;
        if (graph.seen[e] === stamp) continue;
        graph.seen[e] = stamp;
        visit(e);
      }
    }
  }
}

/** Dónde cae un punto sobre un tramo. */
export interface EdgeSnap {
  edge: number;
  /** Fracción del tramo (por longitud) en que cae: 0 = en `a`, 1 = en `b`. */
  t: number;
  lat: number;
  lon: number;
  /** Distancia del punto original al tramo (m). */
  distM: number;
  /** Longitud geométrica del tramo (m). */
  lengthM: number;
}

/**
 * Los tramos más cercanos a `(lat, lon)` en un radio (m) que `accept` admita (p. ej. «se puede ir a pie»), del más cercano al más lejano y hasta `limit`. Mide sobre la polilínea del tramo
 * (no solo sobre sus extremos) y da la fracción en que cae.
 */
export function snapToEdges(graph: Graph, lat: number, lon: number, radiusM: number, accept: (edge: number) => boolean = () => true, limit = 1): EdgeSnap[] {
  const pack = graph.pack;
  const dLat = radiusM / M_PER_DEG;
  const dLon = radiusM / (M_PER_DEG * Math.cos(toRad(lat)));
  const found: EdgeSnap[] = [];
  forEachEdgeInBox(graph, lat - dLat, lon - dLon, lat + dLat, lon + dLon, (e) => {
    if (!accept(e)) return;
    const pts = edgePolyline(pack, e);
    let alongM = 0;
    let bestHere: { distM: number; alongM: number; lat: number; lon: number } | null = null;
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const segM = flatDistanceM(a.lat, a.lon, b.lat, b.lon);
      const proj = projectOnSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);
      if (bestHere === null || proj.distM < bestHere.distM) bestHere = { distM: proj.distM, alongM: alongM + proj.t * segM, lat: proj.lat, lon: proj.lon };
      alongM += segM;
      total += segM;
    }
    if (bestHere === null || bestHere.distM > radiusM) return;
    found.push({ edge: e, t: total === 0 ? 0 : bestHere.alongM / total, lat: bestHere.lat, lon: bestHere.lon, distM: bestHere.distM, lengthM: total });
  });
  found.sort((a, b) => a.distM - b.distM);
  return found.slice(0, Math.max(1, limit));
}

/** El tramo más cercano a `(lat, lon)` en un radio (m) que `accept` admita, o `null`. */
export function snapToEdge(graph: Graph, lat: number, lon: number, radiusM: number, accept: (edge: number) => boolean = () => true): EdgeSnap | null {
  return snapToEdges(graph, lat, lon, radiusM, accept, 1)[0] ?? null;
}
