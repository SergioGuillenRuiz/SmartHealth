import { fromE7 } from './geo';
import type { MapPack } from './pack';

// Lo que hace falta para dibujar solo lo que se ve: la caja de cada zona (parque, agua…) y una rejilla con los lugares con nombre. Se construye una vez al abrir el paquete.

const PLACE_CELL_DEG = 0.01;

export interface Box {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface MapIndex {
  pack: MapPack;
  shapeBox: Float32Array; // por zona: minLat, minLon, maxLat, maxLon
  placeGrid: Map<number, number[]>;
}

const cellKey = (row: number, col: number): number => row * 100_003 + col;

export function buildMapIndex(pack: MapPack): MapIndex {
  const shapeBox = new Float32Array(pack.shapeCount * 4);
  for (let s = 0; s < pack.shapeCount; s++) {
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    for (let i = pack.shapeStart[s]!; i < pack.shapeStart[s + 1]!; i++) {
      const la = pack.shapeLat[i]!;
      const lo = pack.shapeLon[i]!;
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }
    shapeBox.set([fromE7(minLat), fromE7(minLon), fromE7(maxLat), fromE7(maxLon)], s * 4);
  }
  const placeGrid = new Map<number, number[]>();
  for (let p = 0; p < pack.placeCount; p++) {
    const key = cellKey(Math.floor(fromE7(pack.placeLat[p]!) / PLACE_CELL_DEG), Math.floor(fromE7(pack.placeLon[p]!) / PLACE_CELL_DEG));
    const list = placeGrid.get(key);
    if (list) list.push(p);
    else placeGrid.set(key, [p]);
  }
  return { pack, shapeBox, placeGrid };
}

/** Las zonas cuya caja toca la dada. */
export function shapesInBox(index: MapIndex, box: Box): number[] {
  const out: number[] = [];
  const b = index.shapeBox;
  for (let s = 0; s < index.pack.shapeCount; s++) {
    if (b[s * 4 + 2]! < box.minLat || b[s * 4]! > box.maxLat || b[s * 4 + 3]! < box.minLon || b[s * 4 + 1]! > box.maxLon) continue;
    out.push(s);
  }
  return out;
}

/** Los lugares dentro de la caja dada. */
export function placesInBox(index: MapIndex, box: Box): number[] {
  const out: number[] = [];
  const pack = index.pack;
  for (let r = Math.floor(box.minLat / PLACE_CELL_DEG); r <= Math.floor(box.maxLat / PLACE_CELL_DEG); r++) {
    for (let c = Math.floor(box.minLon / PLACE_CELL_DEG); c <= Math.floor(box.maxLon / PLACE_CELL_DEG); c++) {
      for (const p of index.placeGrid.get(cellKey(r, c)) ?? []) {
        const la = fromE7(pack.placeLat[p]!);
        const lo = fromE7(pack.placeLon[p]!);
        if (la >= box.minLat && la <= box.maxLat && lo >= box.minLon && lo <= box.maxLon) out.push(p);
      }
    }
  }
  return out;
}
