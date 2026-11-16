import { metersPerPixel, type LatLon } from '../../domain/nav/geo';
import { forEachEdgeInBox, type Graph } from '../../domain/nav/graph';
import { placesInBox, shapesInBox, type MapIndex } from '../../domain/nav/map-index';
import { HW, isLineShape, isMarkerPlace, nameOf, NO_NAME, PLACE, SHAPE } from '../../domain/nav/pack';
import { marginM } from '../../domain/nav/zones';
import { projectionOf, toScreen, visibleBox, type Camera } from './camera';

// El dibujo del mapa en un canvas. Un estilo sobrio y pensado para mirar de reojo corriendo o en bici: fondo de papel cálido, casi todo en tonos muy próximos y un único color vivo —la ruta—,
// que es lo que se tiene que ver. Las calles son blancas y finas (solo las grandes llevan un borde), los edificios una mancha plana un punto más oscura que el fondo, los parques y el agua
// en pasteles, y los comercios, paradas y servicios aparecen como marcas pequeñas de color por categoría solo cuando hay sitio (a partir de ~zoom 16), con su nombre al acercarse más.
// Lo que no sirve para llegar a un sitio andando, corriendo o en bici (tráfico, fotos, capas) no se dibuja. Hay una variante oscura.

export interface MapTheme {
  bg: string;
  park: string;
  wood: string;
  grass: string;
  water: string;
  sand: string;
  waterLine: string;
  cemetery: string;
  campus: string;
  pitch: string;
  pitchLine: string;
  parking: string;
  commercial: string;
  building: string;
  buildingEdge: string;
  rail: string;
  railTie: string;
  casing: string;
  minor: string;
  tertiary: string;
  secondary: string;
  primary: string;
  primaryCasing: string;
  path: string;
  cycleway: string;
  track: string;
  label: string;
  labelMuted: string;
  halo: string;
  parkLabel: string;
  waterLabel: string;
  route: string;
  routeCasing: string;
  routeGlow: string;
  routePassed: string;
  puck: string;
  accuracy: string;
  pin: string;
  /** El recorrido ya hecho (al revisar un entreno) y su borde, y el punto de salida. */
  trace: string;
  traceCasing: string;
  traceGlow: string;
  start: string;
  /** Las marcas de comercios y servicios, por categoría. */
  marker: Record<number, string>;
}

const MARKERS_LIGHT: Record<number, string> = {
  [PLACE.FOOD]: '#e8912d',
  [PLACE.CAFE]: '#b8734a',
  [PLACE.SHOP]: '#5a7fd6',
  [PLACE.HEALTH]: '#df4b5a',
  [PLACE.TRANSIT]: '#2f6fb5',
  [PLACE.BIKE]: '#2e9b6a',
  [PLACE.SERVICE]: '#7d8590',
  [PLACE.EDU]: '#8a6bc9',
  [PLACE.UTILITY]: '#2aa3b8',
  [PLACE.POI]: '#9b59c4',
  [PLACE.STATION]: '#2f6fb5',
};

const MARKERS_DARK: Record<number, string> = {
  [PLACE.FOOD]: '#f2a64f',
  [PLACE.CAFE]: '#d49a76',
  [PLACE.SHOP]: '#7f9ee6',
  [PLACE.HEALTH]: '#f2707c',
  [PLACE.TRANSIT]: '#6aa3e0',
  [PLACE.BIKE]: '#58c595',
  [PLACE.SERVICE]: '#9aa3ad',
  [PLACE.EDU]: '#ad92e0',
  [PLACE.UTILITY]: '#52c0d3',
  [PLACE.POI]: '#bf86e0',
  [PLACE.STATION]: '#6aa3e0',
};

export const LIGHT: MapTheme = {
  bg: '#f4f2ee',
  park: '#dce9d6',
  wood: '#cfe1c9',
  grass: '#e4eddc',
  water: '#c9e0ef',
  sand: '#efe8d5',
  waterLine: '#b3d3e8',
  cemetery: '#e1e8dc',
  campus: '#ebe6dd',
  pitch: '#d3e6cc',
  pitchLine: 'rgba(255,255,255,0.85)',
  parking: '#eceae5',
  commercial: '#eeeae2',
  building: '#e6e1d8',
  buildingEdge: 'rgba(120,108,90,0.28)',
  rail: '#c4beb2',
  railTie: '#f4f2ee',
  casing: '#e3ded5',
  minor: '#ffffff',
  tertiary: '#ffffff',
  secondary: '#fffaf0',
  primary: '#fff1cf',
  primaryCasing: '#ecd9a6',
  path: '#c7bfb1',
  cycleway: '#7cc59a',
  track: '#c8b79b',
  label: '#857f74',
  labelMuted: '#9d978c',
  halo: 'rgba(244,242,238,0.94)',
  parkLabel: '#5f8a63',
  waterLabel: '#6b9cbd',
  route: '#2f6fed',
  routeCasing: '#ffffff',
  routeGlow: 'rgba(47,111,237,0.20)',
  routePassed: '#a8bde6',
  puck: '#2f6fed',
  accuracy: 'rgba(47,111,237,0.13)',
  pin: '#ee4b3c',
  trace: '#ff5b3a',
  traceCasing: '#ffffff',
  traceGlow: 'rgba(255,91,58,0.20)',
  start: '#1f9d63',
  marker: MARKERS_LIGHT,
};

export const DARK: MapTheme = {
  bg: '#1a1c20',
  park: '#1f2c25',
  wood: '#1c2922',
  grass: '#212f27',
  water: '#1b2f40',
  sand: '#2d2b22',
  waterLine: '#244358',
  cemetery: '#232a25',
  campus: '#22252a',
  pitch: '#244031',
  pitchLine: 'rgba(255,255,255,0.28)',
  parking: '#22252a',
  commercial: '#212328',
  building: '#25282d',
  buildingEdge: 'rgba(255,255,255,0.07)',
  rail: '#4a4f57',
  railTie: '#1a1c20',
  casing: '#16181b',
  minor: '#363a41',
  tertiary: '#3b4047',
  secondary: '#454a52',
  primary: '#565b63',
  primaryCasing: '#2a2d32',
  path: '#4a4f57',
  cycleway: '#3f9d72',
  track: '#6b6050',
  label: '#9aa1a9',
  labelMuted: '#7c838b',
  halo: 'rgba(26,28,32,0.92)',
  parkLabel: '#79b88c',
  waterLabel: '#6f9fc0',
  route: '#6aa5ff',
  routeCasing: '#14161a',
  routeGlow: 'rgba(106,165,255,0.24)',
  routePassed: '#4b5d7f',
  puck: '#6aa5ff',
  accuracy: 'rgba(106,165,255,0.16)',
  pin: '#ff7a6b',
  trace: '#ff8a65',
  traceCasing: '#14161a',
  traceGlow: 'rgba(255,138,101,0.22)',
  start: '#5fd49c',
  marker: MARKERS_DARK,
};

type Group = 'motorway' | 'primary' | 'secondary' | 'tertiary' | 'minor' | 'pedestrian' | 'path' | 'cycleway' | 'track';

const GROUP_OF: Record<number, Group> = {
  [HW.MOTORWAY]: 'motorway',
  [HW.TRUNK]: 'motorway',
  [HW.PRIMARY]: 'primary',
  [HW.SECONDARY]: 'secondary',
  [HW.TERTIARY]: 'tertiary',
  [HW.UNCLASSIFIED]: 'minor',
  [HW.RESIDENTIAL]: 'minor',
  [HW.LIVING_STREET]: 'minor',
  [HW.SERVICE]: 'minor',
  [HW.PEDESTRIAN]: 'pedestrian',
  [HW.FOOTWAY]: 'path',
  [HW.PATH]: 'path',
  [HW.STEPS]: 'path',
  [HW.CYCLEWAY]: 'cycleway',
  [HW.TRACK]: 'track',
};

/** Orden de dibujo: de lo menos a lo más importante. */
const ORDER: Group[] = ['track', 'path', 'cycleway', 'pedestrian', 'minor', 'tertiary', 'secondary', 'primary', 'motorway'];
const MIN_ZOOM: Record<Group, number> = { motorway: 11, primary: 12, secondary: 13, tertiary: 14, minor: 14.8, pedestrian: 15, path: 15.8, cycleway: 15, track: 15.8 };
/** Ancho real en metros y mínimo en píxeles. */
const WIDTH: Record<Group, [number, number]> = { motorway: [14, 2.6], primary: [12, 2.4], secondary: [10, 2.1], tertiary: [8, 1.9], minor: [6, 1.4], pedestrian: [5, 1.5], path: [1.6, 1.1], cycleway: [2.2, 1.3], track: [2.2, 1.1] };
const DASHED = new Set<Group>(['path', 'track', 'cycleway']);

// Cuándo aparece cada cosa (zoom): los edificios se funden entre 14,8 y 16; las marcas pequeñas, a partir de 16,2; sus nombres, a partir de 17,2.
const BUILDING_CHUNK = 250;
const BUILDINGS_FROM = 14.8;
const BUILDINGS_FULL = 16;
const BUILDING_EDGE_FROM = 17;
const MARKERS_FROM = 16.2;
const MARKER_LABELS_FROM = 17.2;
const TRANSIT_FROM = 16.8;

export interface MapOverlay {
  route?: { points: readonly LatLon[]; cumM: readonly number[]; progressM: number } | null;
  destination?: LatLon | null;
  position?: { lat: number; lon: number; heading: number | null; accuracyM: number | null } | null;
  /** Por donde se fue (pares [lat, lon]): se dibuja con salida y llegada. */
  trace?: ReadonlyArray<readonly [number, number]> | null;
}

export interface MapData {
  graph: Graph;
  index: MapIndex;
}

const fillOf = (theme: MapTheme, g: Group): string =>
  g === 'motorway' || g === 'primary' ? theme.primary : g === 'secondary' ? theme.secondary : g === 'tertiary' ? theme.tertiary : g === 'path' ? theme.path : g === 'cycleway' ? theme.cycleway : g === 'track' ? theme.track : theme.minor;

interface Label {
  text: string;
  x: number;
  y: number;
  angle: number;
}

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Dibuja el mapa entero. `dpr` es la densidad de píxeles del canvas (el tamaño de la cámara va en píxeles CSS). */
export function drawMap(ctx: CanvasRenderingContext2D, cam: Camera, data: MapData, overlay: MapOverlay, theme: MapTheme, dpr = 1): void {
  const { width, height } = cam;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);

  const pack = data.graph.pack;
  const proj = projectionOf(cam);
  const box = visibleBox(cam, 60);
  const sx = proj.kLon / 1e7;
  const sy = proj.kLat / 1e7;
  const lon0 = Math.round(cam.lon * 1e7);
  const lat0 = Math.round(cam.lat * 1e7);
  const rx = (lon7: number): number => (lon7 - lon0) * sx;
  const ry = (lat7: number): number => -(lat7 - lat0) * sy;

  // Todo lo del mapa se dibuja relativo al centro y con el lienzo girado: los números se mantienen pequeños (los píxeles del mundo a zoom alto no caben con precisión en un decimal de 32 bits).
  ctx.save();
  ctx.translate(width / 2, height * cam.anchorY);
  ctx.rotate((-cam.bearing * Math.PI) / 180);

  // Zonas: un trazo por tipo. Los edificios aparte (tienen su propia transparencia según el zoom y la distancia a la caja de detalle).
  const shapeIds = shapesInBox(data.index, box);
  const kindPath = new Map<number, Path2D>();
  const lines: Array<{ kind: number; path: Path2D }> = [];
  // Los edificios, en tres tandas de transparencia y cada una en trozos de pocos cientos: un solo trazo con miles de polígonos pequeños tarda mucho más en rellenarse que los mismos en trozos.
  const buildingChunks: Array<{ bucket: number; path: Path2D; count: number }> = [];
  const openChunk: Array<{ bucket: number; path: Path2D; count: number } | undefined> = [undefined, undefined, undefined];
  const chunkFor = (bucket: number): Path2D => {
    const last = openChunk[bucket];
    if (last && last.count < BUILDING_CHUNK) {
      last.count++;
      return last.path;
    }
    const fresh = { bucket, path: new Path2D(), count: 1 };
    buildingChunks.push(fresh);
    openChunk[bucket] = fresh;
    return fresh.path;
  };
  const bucketAlpha = [0.35, 0.7, 1];
  const detail = pack.meta.detail;
  const shapeBox = data.index.shapeBox;
  const showBuildings = cam.zoom >= BUILDINGS_FROM;
  let anyBuilding = false;
  for (const s of shapeIds) {
    const kind = pack.shapeKind[s]!;
    const from = pack.shapeStart[s]!;
    const to = pack.shapeStart[s + 1]!;
    let path: Path2D;
    if (kind === SHAPE.BUILDING) {
      if (!showBuildings) continue;
      // Lo que mide en pantalla: lo diminuto no aporta (y a zoom bajo son decenas de miles).
      const wPx = (shapeBox[s * 4 + 3]! - shapeBox[s * 4 + 1]!) * proj.kLon;
      const hPx = (shapeBox[s * 4 + 2]! - shapeBox[s * 4]!) * proj.kLat;
      if (wPx < 1.6 && hPx < 1.6) continue;
      // Hacia el borde de la caja de detalle se desvanecen: fuera de ella no hay edificios y no debe verse un corte.
      let bucket = 2;
      if (detail) {
        const edgeM = marginM(detail, (shapeBox[s * 4]! + shapeBox[s * 4 + 2]!) / 2, (shapeBox[s * 4 + 1]! + shapeBox[s * 4 + 3]!) / 2);
        bucket = edgeM < 60 ? 0 : edgeM < 180 ? 1 : 2;
      }
      path = chunkFor(bucket);
      anyBuilding = true;
    } else {
      path = isLineShape(kind) ? new Path2D() : (kindPath.get(kind) ?? kindPath.set(kind, new Path2D()).get(kind)!);
    }
    for (let i = from; i < to; i++) {
      const x = rx(pack.shapeLon[i]!);
      const y = ry(pack.shapeLat[i]!);
      if (i === from) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    if (isLineShape(kind)) lines.push({ kind, path });
    else path.closePath();
  }
  const areaColor: Array<[number, string]> = [
    [SHAPE.COMMERCIAL, theme.commercial],
    [SHAPE.CAMPUS, theme.campus],
    [SHAPE.PARKING, theme.parking],
    [SHAPE.SAND, theme.sand],
    [SHAPE.GRASS, theme.grass],
    [SHAPE.CEMETERY, theme.cemetery],
    [SHAPE.WOOD, theme.wood],
    [SHAPE.PARK, theme.park],
    [SHAPE.WATER, theme.water],
  ];
  for (const [kind, color] of areaColor) {
    const path = kindPath.get(kind);
    if (!path) continue;
    ctx.fillStyle = color;
    ctx.fill(path);
  }
  // Los campos deportivos: un verde más vivo con su línea blanca fina.
  const pitches = kindPath.get(SHAPE.PITCH);
  if (pitches) {
    ctx.fillStyle = theme.pitch;
    ctx.fill(pitches);
    if (cam.zoom >= 16) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.pitchLine;
      ctx.stroke(pitches);
    }
  }
  const waterEdge = kindPath.get(SHAPE.WATER);
  if (waterEdge && cam.zoom >= 14) {
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = theme.waterLine;
    ctx.stroke(waterEdge);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const { kind, path } of lines) {
    if (kind === SHAPE.RAIL) continue;
    ctx.strokeStyle = theme.waterLine;
    ctx.lineWidth = Math.max(kind === SHAPE.RIVER ? 8 / proj.mpp : 2 / proj.mpp, kind === SHAPE.RIVER ? 3 : 1.4);
    ctx.stroke(path);
  }
  // Las vías de tren: una línea fina con travesaños, debajo de las calles (los puentes y pasos las cruzan por encima).
  if (cam.zoom >= 13.5) {
    ctx.lineCap = 'butt';
    ctx.lineWidth = cam.zoom >= 16 ? 2.2 : 1.5;
    ctx.strokeStyle = theme.rail;
    for (const { kind, path } of lines) if (kind === SHAPE.RAIL) ctx.stroke(path);
    if (cam.zoom >= 15) {
      ctx.setLineDash([5, 6]);
      ctx.lineWidth = cam.zoom >= 16 ? 1.1 : 0.8;
      ctx.strokeStyle = theme.railTie;
      for (const { kind, path } of lines) if (kind === SHAPE.RAIL) ctx.stroke(path);
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'round';
  }
  // Los edificios: una mancha plana; a partir de cierto zoom, con un borde finísimo para separar los contiguos.
  if (anyBuilding) {
    const fade = clamp01((cam.zoom - BUILDINGS_FROM) / (BUILDINGS_FULL - BUILDINGS_FROM));
    ctx.fillStyle = theme.building;
    ctx.strokeStyle = theme.buildingEdge;
    ctx.lineWidth = 0.8;
    for (const { bucket, path } of buildingChunks) {
      ctx.globalAlpha = fade * bucketAlpha[bucket]!;
      ctx.fill(path);
      if (cam.zoom >= BUILDING_EDGE_FROM) ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  // Calles: un trazo por grupo.
  const paths = new Map<Group, Path2D>();
  const labels: Label[] = [];
  const wantLabels = cam.zoom >= 16;
  forEachEdgeInBox(data.graph, box.minLat, box.minLon, box.maxLat, box.maxLon, (e) => {
    const group = GROUP_OF[pack.edgeCls[e]!];
    if (group === undefined || cam.zoom < MIN_ZOOM[group] - (pack.edgeCls[e] === HW.SERVICE ? -1.2 : 0)) return;
    let path = paths.get(group);
    if (!path) {
      path = new Path2D();
      paths.set(group, path);
    }
    const a = pack.edgeA[e]!;
    const b = pack.edgeB[e]!;
    const x0 = rx(pack.nodeLon[a]!);
    const y0 = ry(pack.nodeLat[a]!);
    path.moveTo(x0, y0);
    let px = x0;
    let py = y0;
    let longest = 0;
    let mx = x0;
    let my = y0;
    let mAngle = 0;
    const consider = (x: number, y: number): void => {
      const d = Math.hypot(x - px, y - py);
      if (d > longest) {
        longest = d;
        mx = (x + px) / 2;
        my = (y + py) / 2;
        mAngle = Math.atan2(y - py, x - px);
      }
      px = x;
      py = y;
    };
    for (let g = pack.edgeGeomStart[e]!; g < pack.edgeGeomStart[e + 1]!; g++) {
      const x = rx(pack.geomLon[g]!);
      const y = ry(pack.geomLat[g]!);
      path.lineTo(x, y);
      consider(x, y);
    }
    const x1 = rx(pack.nodeLon[b]!);
    const y1 = ry(pack.nodeLat[b]!);
    path.lineTo(x1, y1);
    consider(x1, y1);
    if (wantLabels && longest > 55 && pack.edgeName[e] !== NO_NAME && (group === 'minor' || group === 'tertiary' || group === 'secondary' || group === 'primary' || group === 'pedestrian')) {
      labels.push({ text: nameOf(pack, pack.edgeName[e]!), x: mx, y: my, angle: mAngle });
    }
  });
  const widthPx = (g: Group): number => Math.max(WIDTH[g][0] / proj.mpp, WIDTH[g][1]);
  // Borde: solo las grandes a zoom medio; todas las anchas cuando hay sitio para que se vea (así la calle pequeña queda limpia).
  for (const g of ORDER) {
    const path = paths.get(g);
    if (!path || DASHED.has(g)) continue;
    const big = g === 'primary' || g === 'motorway' || g === 'secondary';
    if (!big && cam.zoom < 15.8) continue;
    ctx.strokeStyle = g === 'primary' || g === 'motorway' ? theme.primaryCasing : theme.casing;
    ctx.lineWidth = widthPx(g) + (cam.zoom >= 16.5 ? 2 : 1.4);
    ctx.stroke(path);
  }
  for (const g of ORDER) {
    const path = paths.get(g);
    if (!path) continue;
    ctx.strokeStyle = fillOf(theme, g);
    ctx.lineWidth = widthPx(g);
    ctx.setLineDash(DASHED.has(g) ? [Math.max(3, widthPx(g) * 2.4), Math.max(3, widthPx(g) * 1.8)] : []);
    ctx.lineCap = DASHED.has(g) ? 'butt' : 'round';
    ctx.stroke(path);
  }
  ctx.setLineDash([]);
  ctx.lineCap = 'round';

  // La ruta: un resplandor suave, un borde blanco, la parte que falta en el color vivo y la que ya se hizo apagada.
  const route = overlay.route;
  if (route && route.points.length >= 2) {
    const base = new Path2D();
    const passed = new Path2D();
    let lastX = NaN;
    let lastY = NaN;
    let startedPassed = false;
    for (let i = 0; i < route.points.length; i++) {
      const p = route.points[i]!;
      const x = rx(Math.round(p.lon * 1e7));
      const y = ry(Math.round(p.lat * 1e7));
      if (Number.isFinite(lastX) && Math.hypot(x - lastX, y - lastY) < 0.6 && i < route.points.length - 1) continue;
      const done = (route.cumM[i] ?? 0) <= route.progressM;
      if (i === 0) base.moveTo(x, y);
      else base.lineTo(x, y);
      if (done) {
        if (!startedPassed) {
          passed.moveTo(x, y);
          startedPassed = true;
        } else passed.lineTo(x, y);
      }
      lastX = x;
      lastY = y;
    }
    const core = Math.max(4.5, 6 / Math.sqrt(proj.mpp + 0.25));
    ctx.lineWidth = core + 11;
    ctx.strokeStyle = theme.routeGlow;
    ctx.stroke(base);
    ctx.lineWidth = core + 3;
    ctx.strokeStyle = theme.routeCasing;
    ctx.stroke(base);
    ctx.lineWidth = core;
    ctx.strokeStyle = theme.route;
    ctx.stroke(base);
    ctx.strokeStyle = theme.routePassed;
    ctx.stroke(passed);
  }
  ctx.restore();

  // Rótulos en pantalla (sin girar): calles y lugares.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const taken: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    const r = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
    if (r.x1 < 0 || r.y1 < 0 || r.x0 > width || r.y0 > height) return false;
    for (const t of taken) if (r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0) return false;
    taken.push(r);
    return true;
  };
  const b = (cam.bearing * Math.PI) / 180;
  const cos = Math.cos(b);
  const sin = Math.sin(b);
  const screenOf = (x: number, y: number): { x: number; y: number } => ({ x: width / 2 + x * cos + y * sin, y: height * cam.anchorY - x * sin + y * cos });
  const drawText = (text: string, x: number, y: number, size: number, color: string, weight = 500): void => {
    ctx.lineJoin = 'round';
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.lineWidth = 3.4;
    ctx.strokeStyle = theme.halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  // Los lugares con nombre (ciudades, barrios, parques, estaciones, sitios de interés) y las marcas de comercios y servicios.
  interface PlaceItem {
    kind: number;
    text: string;
    x: number;
    y: number;
    weight: number;
  }
  const named: PlaceItem[] = [];
  const marks: PlaceItem[] = [];
  if (cam.zoom >= 12) {
    for (const p of placesInBox(data.index, box)) {
      const kind = pack.placeKind[p]!;
      if (kind === PLACE.STREET) continue;
      const pt = screenOf(rx(pack.placeLon[p]!), ry(pack.placeLat[p]!));
      if (isMarkerPlace(kind)) {
        if (cam.zoom < MARKERS_FROM || (kind === PLACE.TRANSIT && cam.zoom < TRANSIT_FROM)) continue;
        if (pt.x < -8 || pt.y < -8 || pt.x > width + 8 || pt.y > height + 8) continue;
        marks.push({ kind, text: nameOf(pack, pack.placeName[p]!), x: pt.x, y: pt.y, weight: pack.placeName[p] === NO_NAME ? 0 : 1 });
        continue;
      }
      const minZoom = kind === PLACE.CITY || kind === PLACE.TOWN ? 12 : kind === PLACE.VILLAGE ? 13 : kind === PLACE.SUBURB || kind === PLACE.NEIGHBOURHOOD ? 14.5 : 15.5;
      if (cam.zoom < minZoom) continue;
      named.push({ kind, text: nameOf(pack, pack.placeName[p]!), x: pt.x, y: pt.y, weight: kind <= PLACE.VILLAGE ? 3 : kind === PLACE.SUBURB || kind === PLACE.NEIGHBOURHOOD ? 2 : 1 });
    }
  }
  named.sort((p, q) => q.weight - p.weight);
  let count = 0;
  for (const l of named) {
    if (count >= 40) break;
    const landmark = l.kind === PLACE.POI || l.kind === PLACE.STATION;
    const small = l.weight <= 1;
    ctx.font = `${small ? 600 : 650} ${small ? 12 : l.weight === 3 ? 14 : 12}px ${FONT}`;
    const w = ctx.measureText(l.text).width + 8;
    // Un sitio de interés lleva su marca a la izquierda del nombre.
    const off = landmark && cam.zoom >= 15.5 ? 7 : 0;
    if (!fits(l.x + off, l.y, w + off * 2, 16)) continue;
    const color = l.kind === PLACE.PARK ? theme.parkLabel : landmark ? theme.marker[l.kind]! : theme.label;
    if (landmark && cam.zoom >= 15.5) drawMark(ctx, l.kind, l.x - w / 2 - 2, l.y, 4.2, theme);
    drawText(l.text, l.x + off, l.y, small ? 12 : l.weight === 3 ? 14 : 12, color, small ? 600 : 650);
    count++;
  }
  // Calles: el nombre sobre su tramo más largo, girado como la calle (nunca boca abajo), sin pisar otro rótulo ni repetirse cerca.
  const seen = new Map<string, Array<{ x: number; y: number }>>();
  let streets = 0;
  for (const l of labels) {
    if (streets >= 60) break;
    const p1 = screenOf(l.x, l.y);
    const dx = Math.cos(l.angle);
    const dy = Math.sin(l.angle);
    const q = screenOf(l.x + dx, l.y + dy);
    let angle = Math.atan2(q.y - p1.y, q.x - p1.x);
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle < -Math.PI / 2) angle += Math.PI;
    ctx.font = `500 11px ${FONT}`;
    const w = ctx.measureText(l.text).width + 6;
    const near = seen.get(l.text);
    if (near?.some((s) => Math.hypot(s.x - p1.x, s.y - p1.y) < 160)) continue;
    // Para el choque de cajas se usa la caja girada aproximada por su círculo envolvente reducido.
    if (!fits(p1.x, p1.y, Math.min(w, 70 + Math.abs(Math.cos(angle)) * w * 0.4), 14 + Math.abs(Math.sin(angle)) * w * 0.6)) continue;
    ctx.save();
    ctx.translate(p1.x, p1.y);
    ctx.rotate(angle);
    drawText(l.text, 0, 0, 11, theme.label);
    ctx.restore();
    (seen.get(l.text) ?? seen.set(l.text, []).get(l.text)!).push({ x: p1.x, y: p1.y });
    streets++;
  }
  ctx.restore();

  // Las marcas de comercios y servicios (encima de los nombres de calles): dos pasadas, primero los puntos y luego los nombres de los que caben.
  if (marks.length > 0) drawMarks(ctx, marks, cam.zoom, theme, width, height, fits, drawText);

  if (overlay.trace && overlay.trace.length >= 2) drawTrace(ctx, cam, overlay.trace, theme);

  // Destino y posición.
  if (overlay.destination) {
    const d = toScreen(cam, overlay.destination.lat, overlay.destination.lon);
    drawPin(ctx, d.x, d.y, theme);
  }
  if (overlay.position) drawPuck(ctx, cam, overlay.position, theme, proj.mpp);
}

/** Una marca de categoría con la punta/centro en (x, y): un punto de color con anillo blanco; paradas y estaciones, cuadradas; salud, con una cruz; sitios de interés, un rombo. */
function drawMark(ctx: CanvasRenderingContext2D, kind: number, x: number, y: number, r: number, theme: MapTheme): void {
  const color = theme.marker[kind] ?? theme.label;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.fillStyle = color;
  ctx.strokeStyle = theme.routeCasing;
  ctx.lineWidth = Math.max(1.2, r * 0.38);
  ctx.beginPath();
  if (kind === PLACE.TRANSIT || kind === PLACE.STATION) {
    const s = r * 0.92;
    // `roundRect` no está en los WebView más viejos: sin él, un cuadrado.
    if (typeof ctx.roundRect === 'function') ctx.roundRect(-s, -s, s * 2, s * 2, s * 0.45);
    else ctx.rect(-s, -s, s * 2, s * 2);
  } else if (kind === PLACE.POI) {
    const s = r * 1.25;
    ctx.moveTo(0, -s);
    ctx.lineTo(s, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s, 0);
    ctx.closePath();
  } else {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.fill();
  if (r >= 4) {
    ctx.fillStyle = '#ffffff';
    if (kind === PLACE.HEALTH) {
      const t = r * 0.5;
      const k = r * 0.17;
      ctx.fillRect(-t, -k, t * 2, k * 2);
      ctx.fillRect(-k, -t, k * 2, t * 2);
    } else if (kind === PLACE.TRANSIT || kind === PLACE.STATION) {
      ctx.fillRect(-r * 0.42, -r * 0.42, r * 0.84, r * 0.5);
      ctx.fillRect(-r * 0.42, r * 0.2, r * 0.84, r * 0.14);
    } else if (kind === PLACE.BIKE) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Los puntos de comercios y servicios y, a zoom alto, el nombre de los que tienen y caben. Sin amontonar: dos puntos a menos de un par de píxeles se quedan en uno. */
function drawMarks(
  ctx: CanvasRenderingContext2D,
  marks: ReadonlyArray<{ kind: number; text: string; x: number; y: number; weight: number }>,
  zoom: number,
  theme: MapTheme,
  width: number,
  height: number,
  fits: (x: number, y: number, w: number, h: number) => boolean,
  drawText: (text: string, x: number, y: number, size: number, color: string, weight?: number) => void,
): void {
  const r = Math.max(3.6, Math.min(6.8, 3.6 + (zoom - MARKERS_FROM) * 1.6));
  const cell = Math.max(5, r * 1.7);
  const used = new Set<number>();
  const drawn: typeof marks[number][] = [];
  // Los que tienen nombre primero: si dos puntos chocan, se queda el que se puede nombrar.
  const ordered = [...marks].sort((p, q) => q.weight - p.weight);
  for (const m of ordered) {
    if (m.x < -8 || m.y < -8 || m.x > width + 8 || m.y > height + 8) continue;
    const key = Math.round(m.x / cell) * 4096 + Math.round(m.y / cell);
    if (used.has(key)) continue;
    used.add(key);
    drawn.push(m);
    if (drawn.length >= 900) break;
  }
  ctx.save();
  for (const m of drawn) drawMark(ctx, m.kind, m.x, m.y, r, theme);
  ctx.restore();
  if (zoom < MARKER_LABELS_FROM) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let labelled = 0;
  for (const m of drawn) {
    if (labelled >= 70) break;
    if (m.text === '') continue;
    ctx.font = `600 11px ${FONT}`;
    const w = ctx.measureText(m.text).width + 6;
    const x = m.x + r + 4;
    if (!fits(x + w / 2, m.y, w, 14)) continue;
    drawText(m.text, x + w / 2, m.y, 11, theme.marker[m.kind] ? mix(theme.marker[m.kind]!, theme.label) : theme.label, 600);
    labelled++;
  }
  ctx.restore();
}

/** Un color a medio camino entre el de una categoría y el del texto (así el rótulo tiene el matiz pero se lee). */
function mix(a: string, b: string): string {
  const pa = hexOf(a);
  const pb = hexOf(b);
  if (!pa || !pb) return b;
  const m = (i: number): number => Math.round(pa[i]! * 0.45 + pb[i]! * 0.55);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

function hexOf(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** La posición: un halo con la precisión, un punto con borde blanco y, si se conoce el rumbo, un haz que lo indica. */
function drawPuck(ctx: CanvasRenderingContext2D, cam: Camera, position: { lat: number; lon: number; heading: number | null; accuracyM: number | null }, theme: MapTheme, mpp: number): void {
  const p = toScreen(cam, position.lat, position.lon);
  if (position.accuracyM !== null && position.accuracyM > 0) {
    ctx.beginPath();
    ctx.fillStyle = theme.accuracy;
    ctx.arc(p.x, p.y, Math.min(120, Math.max(11, position.accuracyM / mpp)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.save();
  ctx.translate(p.x, p.y);
  if (position.heading !== null) {
    const a = ((position.heading - cam.bearing) * Math.PI) / 180;
    ctx.rotate(a);
    // El haz: un abanico suave que sale del punto hacia donde se mira.
    const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, 34);
    grad.addColorStop(0, theme.accuracy.replace(/[\d.]+\)$/, '0.55)'));
    grad.addColorStop(1, theme.accuracy.replace(/[\d.]+\)$/, '0)'));
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 34, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.rotate(-a);
  }
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.arc(0, 0, 6.2, 0, Math.PI * 2);
  ctx.fillStyle = theme.puck;
  ctx.fill();
  ctx.restore();
}

/** El destino: una chincheta en gota, de un solo color y con un punto blanco, con la punta en (x, y). */
function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, theme: MapTheme): void {
  ctx.save();
  ctx.translate(x, y);
  // Una sombra en el suelo, para que se vea dónde está la punta.
  ctx.beginPath();
  ctx.ellipse(0, 0, 6, 2.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-3, -8, -11, -14, -11, -22);
  ctx.arc(0, -22, 11, Math.PI, 0, false);
  ctx.bezierCurveTo(11, -14, 3, -8, 0, 0);
  ctx.closePath();
  ctx.fillStyle = theme.pin;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = theme.routeCasing;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -22, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}

/**
 * El recorrido de un entreno ya hecho: un resplandor suave, una línea con borde, un punto verde en la salida y la chincheta en la llegada. Trabaja en coordenadas de pantalla (`toScreen`), así
 * que va después del mapa, sobre el mismo contexto y sin tocar su transformación.
 */
export function drawTrace(ctx: CanvasRenderingContext2D, cam: Camera, trace: ReadonlyArray<readonly [number, number]>, theme: MapTheme): void {
  if (trace.length < 2) return;
  const path = new Path2D();
  let started = false;
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i < trace.length; i++) {
    const [lat, lon] = trace[i]!;
    const p = toScreen(cam, lat, lon);
    // Los puntos a menos de un píxel uno de otro no cambian el dibujo (el último sí se conserva para que la línea llegue a su sitio).
    if (last && i < trace.length - 1 && Math.hypot(p.x - last.x, p.y - last.y) < 1) continue;
    if (!started) {
      path.moveTo(p.x, p.y);
      started = true;
    } else path.lineTo(p.x, p.y);
    last = p;
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.lineWidth = 14;
  ctx.strokeStyle = theme.traceGlow;
  ctx.stroke(path);
  ctx.lineWidth = 8;
  ctx.strokeStyle = theme.traceCasing;
  ctx.stroke(path);
  ctx.lineWidth = 5;
  ctx.strokeStyle = theme.trace;
  ctx.stroke(path);
  const first = trace[0]!;
  const end = trace[trace.length - 1]!;
  const a = toScreen(cam, first[0], first[1]);
  ctx.beginPath();
  ctx.arc(a.x, a.y, 8.5, 0, Math.PI * 2);
  ctx.fillStyle = theme.traceCasing;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(a.x, a.y, 5.8, 0, Math.PI * 2);
  ctx.fillStyle = theme.start;
  ctx.fill();
  ctx.restore();
  const b = toScreen(cam, end[0], end[1]);
  drawPin(ctx, b.x, b.y, theme);
}

/** Una distancia «redonda» (50 m, 100 m, 2 km…) que ocupe entre 56 y 120 px, para la barra de escala. */
export function scaleBar(metersPerPixel: number): { meters: number; widthPx: number; label: string } {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
  let pick = steps[steps.length - 1]!;
  for (const m of steps) {
    if (m / metersPerPixel >= 56) {
      pick = m;
      break;
    }
  }
  return { meters: pick, widthPx: pick / metersPerPixel, label: pick >= 1000 ? `${pick / 1000} km` : `${pick} m` };
}

/**
 * Un lienzo sin mapa (no hay una zona guardada que cubra el recorrido): el fondo liso con una cuadrícula muy tenue, el recorrido y la escala. Es lo que se ve al revisar un entreno hecho donde no
 * se navegó nunca.
 */
export function drawBlankWithTrace(ctx: CanvasRenderingContext2D, cam: Camera, trace: ReadonlyArray<readonly [number, number]>, theme: MapTheme, dpr = 1): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, cam.width, cam.height);
  drawGrid(ctx, cam, theme);
  drawTrace(ctx, cam, trace, theme);
  drawScale(ctx, cam, theme);
}

/** Una cuadrícula de líneas finas cada «distancia redonda», para que un recorrido sin mapa tenga referencia de tamaño. */
function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, theme: MapTheme): void {
  const bar = scaleBar(metersPerPixel(cam.lat, cam.zoom));
  const step = bar.widthPx;
  if (!(step >= 24)) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.casing;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  const cx = cam.width / 2;
  const cy = cam.height * cam.anchorY;
  for (let x = cx - Math.ceil(cx / step) * step; x <= cam.width; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, cam.height);
  }
  for (let y = cy - Math.ceil(cy / step) * step; y <= cam.height; y += step) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(cam.width, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** La barra de escala abajo a la izquierda. */
export function drawScale(ctx: CanvasRenderingContext2D, cam: Camera, theme: MapTheme): void {
  const bar = scaleBar(metersPerPixel(cam.lat, cam.zoom));
  const x = 12;
  const y = cam.height - 12;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + bar.widthPx, y);
  ctx.lineTo(x + bar.widthPx, y - 5);
  ctx.lineWidth = 4;
  ctx.strokeStyle = theme.halo;
  ctx.stroke();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = theme.label;
  ctx.stroke();
  ctx.font = `600 11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = theme.halo;
  ctx.strokeText(bar.label, x + 2, y - 6);
  ctx.fillStyle = theme.label;
  ctx.fillText(bar.label, x + 2, y - 6);
  ctx.restore();
}
