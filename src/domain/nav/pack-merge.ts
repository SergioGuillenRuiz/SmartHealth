import { isMarkerPlace, NO_NAME, nameOf, type MapPack, type PackInput } from './pack.ts';

// Sumar el DETALLE (edificios, recintos, comercios, paradas y servicios) a un mapa que solo lleva lo ligero (ronda 46). El mapa se abre antes con las calles, las zonas verdes y el agua; el
// detalle se baja después, aparte, y se funde con él aquí: las calles (nodos y tramos) no cambian, y se añaden las formas y los lugares del paquete de detalle con sus nombres puestos en la
// tabla de nombres del mapa. Es lógica pura sobre los arrays del paquete: lo hace sobre un mapa YA GUARDADO, sin volver a pedir las calles.

/** Las formas y los lugares que ya están en el mapa, para no repetirlos si el detalle los trae también (un estadio o un hospital salen en las dos consultas). */
function knownKeys(base: MapPack): { shapes: Set<string>; places: Set<string> } {
  const shapes = new Set<string>();
  for (let i = 0; i < base.shapeCount; i++) {
    const from = base.shapeStart[i]!;
    const to = base.shapeStart[i + 1]!;
    shapes.add(`${base.shapeKind[i]}:${base.shapeLat[from]}:${base.shapeLon[from]}:${to - from}`);
  }
  const places = new Set<string>();
  for (let i = 0; i < base.placeCount; i++) places.add(`${base.placeKind[i]}:${base.placeLat[i]}:${base.placeLon[i]}`);
  return { shapes, places };
}

/**
 * El mapa `base` con el detalle de `detail` (un paquete hecho solo con lo pesado: ver `overpassDetailQuery`). Devuelve el contenido para escribir (`writePack`). El `meta.detail` del resultado
 * es la caja del detalle: fuera de ella el mapa no tiene edificios y se dibujan desvanecidos hacia su borde.
 */
export function withDetail(base: MapPack, detail: PackInput): PackInput {
  const known = knownKeys(base);

  // Los nombres: los del mapa, y los del detalle que aún no estén (los comercios traen cientos de nombres nuevos y los de calles y parques se repiten).
  const nameCount = Math.max(0, base.nameOffsets.length - 1);
  const names: string[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < nameCount; i++) {
    const text = nameOf(base, i);
    names.push(text);
    if (!index.has(text)) index.set(text, i);
  }
  const mapName = (id: number): number => {
    if (id === NO_NAME) return NO_NAME;
    const text = detail.names[id];
    if (text === undefined) return NO_NAME;
    let at = index.get(text);
    if (at === undefined) {
      at = names.length;
      names.push(text);
      index.set(text, at);
    }
    return at;
  };

  // Las formas nuevas (sin las que ya estaban).
  const shapeKind: number[] = Array.from(base.shapeKind);
  const shapeStart: number[] = Array.from(base.shapeStart);
  const shapeLat: number[] = Array.from(base.shapeLat);
  const shapeLon: number[] = Array.from(base.shapeLon);
  const detailShapes = detail.shapeKind.length;
  for (let i = 0; i < detailShapes; i++) {
    const from = detail.shapeStart[i]!;
    const to = detail.shapeStart[i + 1]!;
    const key = `${detail.shapeKind[i]}:${detail.shapeLat[from]}:${detail.shapeLon[from]}:${to - from}`;
    if (known.shapes.has(key)) continue;
    known.shapes.add(key);
    shapeKind.push(detail.shapeKind[i]!);
    for (let p = from; p < to; p++) {
      shapeLat.push(detail.shapeLat[p]!);
      shapeLon.push(detail.shapeLon[p]!);
    }
    shapeStart.push(shapeLat.length);
  }

  // Los lugares nuevos. La zona (`placeArea`: el barrio en que está) no se sabe en el paquete de detalle, que no lleva los barrios: sin nombre de zona.
  const placeKind: number[] = Array.from(base.placeKind);
  const placeLat: number[] = Array.from(base.placeLat);
  const placeLon: number[] = Array.from(base.placeLon);
  const placeName: number[] = Array.from(base.placeName);
  const placeArea: number[] = Array.from(base.placeArea);
  const detailPlaces = detail.placeKind.length;
  for (let i = 0; i < detailPlaces; i++) {
    const key = `${detail.placeKind[i]}:${detail.placeLat[i]}:${detail.placeLon[i]}`;
    if (known.places.has(key)) continue;
    const name = mapName(detail.placeName[i]!);
    // Solo las marcas (comercios, paradas, fuentes…) pueden no tener nombre; cualquier otro lugar sin él haría inválido el mapa.
    if (name === NO_NAME && !isMarkerPlace(detail.placeKind[i]!)) continue;
    known.places.add(key);
    placeKind.push(detail.placeKind[i]!);
    placeLat.push(detail.placeLat[i]!);
    placeLon.push(detail.placeLon[i]!);
    placeName.push(name);
    placeArea.push(NO_NAME);
  }

  return {
    meta: { ...base.meta, ...(detail.meta.detail ? { detail: detail.meta.detail } : {}) },
    nodeLat: base.nodeLat,
    nodeLon: base.nodeLon,
    edgeA: base.edgeA,
    edgeB: base.edgeB,
    edgeLenDm: base.edgeLenDm,
    edgeCls: base.edgeCls,
    edgeFlags: base.edgeFlags,
    edgeName: base.edgeName,
    edgeGeomStart: base.edgeGeomStart,
    geomLat: base.geomLat,
    geomLon: base.geomLon,
    names,
    shapeKind,
    shapeStart,
    shapeLat,
    shapeLon,
    placeKind,
    placeLat,
    placeLon,
    placeName,
    placeArea,
  };
}
