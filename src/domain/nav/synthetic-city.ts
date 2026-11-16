import { e7, M_PER_DEG, toRad, type LatLon } from './geo';
import { FLAG, HW, NO_NAME, PLACE, SHAPE, type PackInput } from './pack';

// Una ciudad de mentira para probar el navegador sin datos reales (pruebas unitarias, e2e y la demostración): una cuadrícula de calles con nombre, dos avenidas, una rotonda en el cruce
// del centro, un parque con senderos (uno de ellos, carril bici), un río con un puente para coches y una pasarela solo peatonal, una calle de sentido único, unas escaleras y algunos lugares.
// Con `blockM` de 100 m y 10 manzanas mide un kilómetro de lado.

export interface SyntheticCity {
  input: PackInput;
  /** El índice del nodo de la cuadrícula en la columna `i` y la fila `j` (0 = suroeste), o de uno con nombre (`r_n`, `p_mid`…). */
  node(key: string): number;
  /** La posición de un nodo (grados). */
  at(key: string): LatLon;
  /** El tramo entre dos nodos (en cualquier orden). */
  edge(a: string, b: string): number;
  center: LatLon;
}

export const SYNTHETIC_CENTER: LatLon = { lat: 40.4168, lon: -3.7038 };

const EAST_WEST = ['Calle de Alcalá', 'Calle Mayor', 'Calle del Arenal', 'Calle de Preciados', 'Calle de Hortaleza', 'Avenida Principal', 'Calle de Fuencarral', 'Calle de Atocha', 'Calle de Toledo', 'Calle de Segovia', 'Calle de Bailén'];
const NORTH_SOUTH = ['Calle de Serrano', 'Calle de Velázquez', 'Calle de Goya', 'Calle de Génova', 'Calle de Embajadores', 'Avenida Central', 'Calle de Lavapiés', 'Calle de Argumosa', 'Calle de Montera', 'Calle de Carretas', 'Calle de Alfonso XII'];

export function buildSyntheticCity(options: { center?: LatLon; blocks?: number; blockM?: number } = {}): SyntheticCity {
  const center = options.center ?? SYNTHETIC_CENTER;
  const blocks = options.blocks ?? 10;
  const blockM = options.blockM ?? 100;
  const n = blocks + 1;
  const mid = Math.floor(n / 2);
  const kx = M_PER_DEG * Math.cos(toRad(center.lat));
  // Los metros (este, norte) desde la esquina suroeste, como grados.
  const origin = { lat: center.lat - (blocks * blockM) / 2 / M_PER_DEG, lon: center.lon - (blocks * blockM) / 2 / kx };
  const ll = (x: number, y: number): [number, number] => [e7(origin.lat + y / M_PER_DEG), e7(origin.lon + x / kx)];

  const nodes: Array<[number, number]> = [];
  const keys = new Map<string, number>();
  const names: string[] = [];
  const nameIds = new Map<string, number>();
  const nameId = (name: string | null): number => {
    if (name === null) return NO_NAME;
    let id = nameIds.get(name);
    if (id === undefined) {
      id = names.length;
      names.push(name);
      nameIds.set(name, id);
    }
    return id;
  };
  const place = (key: string, x: number, y: number): number => {
    const known = keys.get(key);
    if (known !== undefined) return known;
    keys.set(key, nodes.length);
    nodes.push(ll(x, y));
    return nodes.length - 1;
  };
  const gridXY = (i: number, j: number): [number, number] => [i * blockM, j * blockM];

  const edges: Array<{ a: number; b: number; cls: number; flags: number; name: number; geom: Array<[number, number]> }> = [];
  const edgeIndex = new Map<string, number>();
  const link = (aKey: string, aXY: [number, number], bKey: string, bXY: [number, number], cls: number, flags: number, name: string | null, via: Array<[number, number]> = []): void => {
    const a = place(aKey, aXY[0], aXY[1]);
    const b = place(bKey, bXY[0], bXY[1]);
    edgeIndex.set(`${a}-${b}`, edges.length);
    edgeIndex.set(`${b}-${a}`, edges.length);
    edges.push({ a, b, cls, flags, name: nameId(name), geom: via.map(([x, y]) => ll(x, y)) });
  };

  const riverX = (mid + 2.5) * blockM; // entre las columnas mid+2 y mid+3
  const riverCol = mid + 2; // la columna a la izquierda del río
  const bridgeRow = Math.min(blocks - 2, mid + 3);
  const footbridgeRow = 3;
  const parkLo = 2;
  const parkHi = 4;
  const roundabout = { i: mid, j: mid, radius: 25 };

  const streetFlags = FLAG.LIT | FLAG.SIDEWALK;
  // Calles este-oeste.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - 1; i++) {
      const aKey = `g_${i}_${j}`;
      const bKey = `g_${i + 1}_${j}`;
      let ak = aKey;
      let bk = bKey;
      let aXY = gridXY(i, j);
      let bXY = gridXY(i + 1, j);
      if (j === roundabout.j && i + 1 === roundabout.i) {
        bk = 'r_w';
        bXY = [roundabout.i * blockM - roundabout.radius, roundabout.j * blockM];
      }
      if (j === roundabout.j && i === roundabout.i) {
        ak = 'r_e';
        aXY = [roundabout.i * blockM + roundabout.radius, roundabout.j * blockM];
      }
      // Dentro del parque no hay calles (solo senderos).
      const interior = (ii: number, jj: number): boolean => ii > parkLo && ii < parkHi && jj > parkLo && jj < parkHi;
      if (interior(i, j) || interior(i + 1, j)) continue;
      // El río solo se cruza por el puente y la pasarela.
      let cls: number = j === mid ? HW.TERTIARY : HW.RESIDENTIAL;
      let flags = streetFlags;
      let name: string | null = j === mid ? 'Avenida Principal' : EAST_WEST[j % EAST_WEST.length]!;
      if (i === riverCol) {
        if (j === bridgeRow) flags |= FLAG.BRIDGE;
        else if (j === footbridgeRow) {
          cls = HW.FOOTWAY;
          flags = FLAG.BRIDGE | FLAG.BIKE_NO | FLAG.LIT;
          name = 'Pasarela del Manzanares';
        } else continue;
      }
      if (j === mid + 1 && i < n - 2) flags |= FLAG.ONEWAY_FWD; // un sentido único hacia el este
      link(ak, aXY, bk, bXY, cls, flags, name);
    }
  }
  // Calles norte-sur.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - 1; j++) {
      let ak = `g_${i}_${j}`;
      let bk = `g_${i}_${j + 1}`;
      let aXY = gridXY(i, j);
      let bXY = gridXY(i, j + 1);
      if (i === roundabout.i && j + 1 === roundabout.j) {
        bk = 'r_s';
        bXY = [roundabout.i * blockM, roundabout.j * blockM - roundabout.radius];
      }
      if (i === roundabout.i && j === roundabout.j) {
        ak = 'r_n';
        aXY = [roundabout.i * blockM, roundabout.j * blockM + roundabout.radius];
      }
      const interior = (ii: number, jj: number): boolean => ii > parkLo && ii < parkHi && jj > parkLo && jj < parkHi;
      if (interior(i, j) || interior(i, j + 1)) continue;
      link(ak, aXY, bk, bXY, i === mid ? HW.TERTIARY : HW.RESIDENTIAL, streetFlags, i === mid ? 'Avenida Central' : NORTH_SOUTH[i % NORTH_SOUTH.length]!);
    }
  }
  // La rotonda: un anillo de cuatro tramos de sentido único, en sentido contrario a las agujas del reloj (se conduce por la derecha).
  const rc: [number, number] = [roundabout.i * blockM, roundabout.j * blockM];
  const rp = (dx: number, dy: number): [number, number] => [rc[0] + dx, rc[1] + dy];
  const R = roundabout.radius;
  const ring = FLAG.ROUNDABOUT | FLAG.ONEWAY_FWD | FLAG.LIT;
  link('r_n', rp(0, R), 'r_w', rp(-R, 0), HW.TERTIARY, ring, 'Plaza del Sol', [rp(-R * 0.71, R * 0.71)]);
  link('r_w', rp(-R, 0), 'r_s', rp(0, -R), HW.TERTIARY, ring, 'Plaza del Sol', [rp(-R * 0.71, -R * 0.71)]);
  link('r_s', rp(0, -R), 'r_e', rp(R, 0), HW.TERTIARY, ring, 'Plaza del Sol', [rp(R * 0.71, -R * 0.71)]);
  link('r_e', rp(R, 0), 'r_n', rp(0, R), HW.TERTIARY, ring, 'Plaza del Sol', [rp(R * 0.71, R * 0.71)]);

  // El parque: un sendero de tierra en diagonal que pasa por su centro, un carril bici hasta la esquina sureste y unas escaleras en el lado oeste.
  const pm: [number, number] = gridXY(3, 3);
  link(`g_${parkLo}_${parkLo}`, gridXY(parkLo, parkLo), 'p_mid', pm, HW.PATH, FLAG.UNPAVED, 'Paseo del Parque', [
    [parkLo * blockM + 30, parkLo * blockM + 45],
    [parkLo * blockM + 65, parkLo * blockM + 70],
  ]);
  link('p_mid', pm, `g_${parkHi}_${parkHi}`, gridXY(parkHi, parkHi), HW.PATH, FLAG.UNPAVED, 'Paseo del Parque', [[pm[0] + 40, pm[1] + 35]]);
  link('p_mid', pm, `g_${parkHi}_${parkLo}`, gridXY(parkHi, parkLo), HW.CYCLEWAY, FLAG.LIT | FLAG.BIKE_YES, 'Carril bici del Parque', [[pm[0] + 50, pm[1] - 45]]);
  link('p_mid', pm, `g_${parkLo}_${parkHi}`, gridXY(parkLo, parkHi), HW.STEPS, FLAG.BIKE_NO, null, [[pm[0] - 45, pm[1] + 50]]);

  // Calles sin nombre y una pista: un callejón de servicio y una pista de tierra al norte.
  link(`g_${n - 1}_${n - 1}`, gridXY(n - 1, n - 1), 'track_end', [(n - 1) * blockM + 150, (n - 1) * blockM + 60], HW.TRACK, FLAG.UNPAVED | FLAG.BIKE_YES, null, [[(n - 1) * blockM + 80, (n - 1) * blockM + 20]]);

  // Un recinto aparte, al este de la ciudad: un sendero suelto que no se une a ninguna calle (como el de un recinto ferial o un campus) y un sitio con nombre pegado a él. El sendero está más cerca del
  // sitio que cualquier calle, pero no se llega a él: la ruta tiene que acabar en la calle más cercana a la que sí se puede ir.
  link('isl_a', [blocks * blockM + 180, (blocks / 2) * blockM - 30], 'isl_b', [blocks * blockM + 180, (blocks / 2) * blockM + 60], HW.PATH, FLAG.UNPAVED, 'Paseo del Recinto');

  // Formas que se dibujan.
  const shapeKind: number[] = [];
  const shapeStart: number[] = [0];
  const shapeLat: number[] = [];
  const shapeLon: number[] = [];
  const shape = (kind: number, pts: Array<[number, number]>): void => {
    shapeKind.push(kind);
    for (const [x, y] of pts) {
      const [la, lo] = ll(x, y);
      shapeLat.push(la);
      shapeLon.push(lo);
    }
    shapeStart.push(shapeLat.length);
  };
  const pl = parkLo * blockM;
  const ph = parkHi * blockM;
  shape(SHAPE.PARK, [
    [pl, pl],
    [ph, pl],
    [ph, ph],
    [pl, ph],
  ]);
  shape(SHAPE.WATER, [
    [(blocks - 1.4) * blockM, (blocks - 1.4) * blockM],
    [(blocks - 0.6) * blockM, (blocks - 1.4) * blockM],
    [(blocks - 0.6) * blockM, (blocks - 0.6) * blockM],
    [(blocks - 1.4) * blockM, (blocks - 0.6) * blockM],
  ]);
  shape(SHAPE.RIVER, [
    [riverX, -80],
    [riverX + 15, blocks * blockM * 0.4],
    [riverX - 10, blocks * blockM * 0.75],
    [riverX, blocks * blockM + 80],
  ]);

  // El resto de lo que hay en una ciudad (ronda 44): una vía de tren al sur, un cementerio, un campo deportivo en el parque, un colegio con su recinto, un aparcamiento, una zona comercial y los
  // edificios de cada manzana (menos las del parque, las del río, la rotonda y el lago). Todo determinista: las pruebas y las capturas siempre ven lo mismo.
  const block = (i: number, j: number, x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [
    [i * blockM + x0, j * blockM + y0],
    [i * blockM + x1, j * blockM + y0],
    [i * blockM + x1, j * blockM + y1],
    [i * blockM + x0, j * blockM + y1],
  ];
  const closeRing = (pts: Array<[number, number]>): Array<[number, number]> => [...pts, pts[0]!];
  shape(SHAPE.RAIL, [
    [-120, -55],
    [blocks * blockM * 0.5, -48],
    [blocks * blockM + 120, -62],
  ]);
  shape(SHAPE.CEMETERY, closeRing(block(0, blocks - 2, 12, 12, 88, 88)));
  shape(SHAPE.PITCH, closeRing([[pl + 35, pl + 120], [pl + 95, pl + 120], [pl + 95, pl + 160], [pl + 35, pl + 160]]));
  shape(SHAPE.CAMPUS, closeRing(block(5, 0, 8, 8, 92, 92)));
  shape(SHAPE.PARKING, closeRing(block(4, blocks - 3, 14, 14, 86, 56)));
  shape(SHAPE.COMMERCIAL, closeRing(block(blocks - 2, 1, 6, 6, 94, 94)));
  const skipBlock = (i: number, j: number): boolean =>
    (i >= parkLo && i < parkHi && j >= parkLo && j < parkHi) || // el parque
    i === riverCol - 0 || i === riverCol + 0 || // la columna que cruza el río
    (i === mid - 1 && j === mid - 1) || (i === mid && j === mid - 1) || (i === mid - 1 && j === mid) || (i === mid && j === mid) || // la rotonda
    (i >= blocks - 2 && j >= blocks - 2) || // el lago
    (i === 0 && j === blocks - 2) || // el cementerio
    (i === 5 && j === 0) || (i === 4 && j === blocks - 3) || (i === blocks - 2 && j === 1); // el colegio, el aparcamiento y la zona comercial
  for (let i = 0; i < blocks; i++) {
    for (let j = 0; j < blocks; j++) {
      if (skipBlock(i, j)) continue;
      const h = (i * 7 + j * 13) % 5; // 0..4: da variedad sin azar
      if (h === 0) shape(SHAPE.BUILDING, closeRing(block(i, j, 14, 14, 86, 86))); // una manzana entera (un patio no se dibuja)
      else if (h === 1) {
        shape(SHAPE.BUILDING, closeRing(block(i, j, 12, 12, 46, 88)));
        shape(SHAPE.BUILDING, closeRing(block(i, j, 54, 12, 88, 60)));
      } else if (h === 2) {
        shape(SHAPE.BUILDING, closeRing(block(i, j, 12, 12, 88, 40)));
        shape(SHAPE.BUILDING, closeRing(block(i, j, 12, 52, 56, 88)));
        shape(SHAPE.BUILDING, closeRing(block(i, j, 66, 52, 88, 88)));
      } else if (h === 3) {
        // Una L.
        shape(SHAPE.BUILDING, closeRing([[i * blockM + 14, j * blockM + 14], [i * blockM + 86, j * blockM + 14], [i * blockM + 86, j * blockM + 44], [i * blockM + 44, j * blockM + 44], [i * blockM + 44, j * blockM + 86], [i * blockM + 14, j * blockM + 86]]));
      } else {
        shape(SHAPE.BUILDING, closeRing(block(i, j, 16, 16, 50, 50)));
        shape(SHAPE.BUILDING, closeRing(block(i, j, 58, 16, 86, 50)));
        shape(SHAPE.BUILDING, closeRing(block(i, j, 16, 58, 86, 86)));
      }
    }
  }
  // Los edificios del colegio, dentro de su recinto.
  shape(SHAPE.BUILDING, closeRing(block(5, 0, 16, 16, 60, 50)));
  shape(SHAPE.BUILDING, closeRing(block(5, 0, 16, 60, 40, 84)));

  // Lugares: una entrada por calle (a mitad de su calle, con su barrio) y unos cuantos sitios con nombre.
  const placeKind: number[] = [];
  const placeLat: number[] = [];
  const placeLon: number[] = [];
  const placeName: number[] = [];
  const placeArea: number[] = [];
  const addPlace = (kind: number, x: number, y: number, name: string, area: string | null): void => {
    const [la, lo] = ll(x, y);
    placeKind.push(kind);
    placeLat.push(la);
    placeLon.push(lo);
    placeName.push(nameId(name));
    placeArea.push(nameId(area));
  };
  const seen = new Set<string>();
  for (const e of edges) {
    const name = e.name === NO_NAME ? null : names[e.name]!;
    if (name === null || seen.has(name) || name === 'Plaza del Sol' || name === 'Pasarela del Manzanares') continue;
    seen.add(name);
    const mid2 = [(nodes[e.a]![0] + nodes[e.b]![0]) / 2, (nodes[e.a]![1] + nodes[e.b]![1]) / 2] as const;
    placeKind.push(PLACE.STREET);
    placeLat.push(Math.round(mid2[0]));
    placeLon.push(Math.round(mid2[1]));
    placeName.push(e.name);
    placeArea.push(nameId('Barrio Centro'));
  }
  addPlace(PLACE.TOWN, blocks * blockM * 0.5, blocks * blockM * 0.5, 'Villa Sintética', null);
  addPlace(PLACE.SUBURB, blocks * blockM * 0.25, blocks * blockM * 0.25, 'Barrio Centro', 'Villa Sintética');
  addPlace(PLACE.PARK, pm[0], pm[1], 'Parque de la Ciudadela', 'Barrio Centro');
  addPlace(PLACE.STATION, 9 * blockM, 1 * blockM, 'Estación Central', 'Villa Sintética');
  addPlace(PLACE.POI, 1 * blockM, (blocks - 2) * blockM, 'Café Luna', 'Barrio Centro');
  addPlace(PLACE.POI, mid * blockM + 30, mid * blockM + 30, 'Plaza del Sol', 'Barrio Centro');
  addPlace(PLACE.POI, blocks * blockM + 195, (blocks / 2) * blockM + 15, 'Recinto Ferial', 'Villa Sintética');
  // Comercios y servicios de la caja de detalle (algunos sin nombre: una parada, una fuente).
  const marker = (kind: number, x: number, y: number, name: string | null): void => {
    const [la, lo] = ll(x, y);
    placeKind.push(kind);
    placeLat.push(la);
    placeLon.push(lo);
    placeName.push(nameId(name));
    placeArea.push(nameId(name === null ? null : 'Barrio Centro'));
  };
  marker(PLACE.FOOD, 1 * blockM + 8, 6 * blockM + 8, 'Casa Lucio');
  marker(PLACE.FOOD, 6 * blockM - 8, 8 * blockM - 8, 'Pizzería Napoli');
  marker(PLACE.CAFE, 3 * blockM + 8, 7 * blockM + 8, 'Café del Parque');
  marker(PLACE.CAFE, 7 * blockM - 8, 4 * blockM + 8, 'Bar La Esquina');
  marker(PLACE.SHOP, 2 * blockM + 8, 1 * blockM + 8, 'Panadería Sol');
  marker(PLACE.SHOP, 6 * blockM + 8, 6 * blockM + 8, 'Supermercado Centro');
  marker(PLACE.SHOP, 8 * blockM + 8, 5 * blockM - 8, 'Librería Cervantes');
  marker(PLACE.SHOP, 1 * blockM - 8, 3 * blockM + 8, null);
  marker(PLACE.HEALTH, 4 * blockM - 8, 5 * blockM + 8, 'Farmacia 24 h');
  marker(PLACE.TRANSIT, 4 * blockM + 8, mid * blockM + 8, 'Parada Avenida Principal');
  marker(PLACE.TRANSIT, 8 * blockM - 8, mid * blockM - 8, null);
  marker(PLACE.BIKE, 4 * blockM + 8, 3 * blockM - 8, 'BiciMAD 12');
  marker(PLACE.SERVICE, 5 * blockM - 8, 3 * blockM + 8, 'Banco del Centro');
  marker(PLACE.EDU, 5 * blockM + 8, 1 * blockM - 8, 'Colegio San Isidro');
  marker(PLACE.UTILITY, pm[0] + 12, pm[1] - 12, null);
  marker(PLACE.UTILITY, pm[0] - 30, pm[1] + 22, 'Aseos del Parque');

  // Se pasa todo a arrays.
  const edgeGeomStart: number[] = [0];
  const geomLat: number[] = [];
  const geomLon: number[] = [];
  const lenDm: number[] = [];
  edges.forEach((e) => {
    let metres = 0;
    let prev = nodes[e.a]!;
    for (const p of [...e.geom, nodes[e.b]!]) {
      metres += Math.hypot((p[1] - prev[1]) / 1e7 * kx, (p[0] - prev[0]) / 1e7 * M_PER_DEG);
      prev = p;
    }
    lenDm.push(Math.max(1, Math.round(metres * 10)));
    for (const [la, lo] of e.geom) {
      geomLat.push(la);
      geomLon.push(lo);
    }
    edgeGeomStart.push(geomLat.length);
  });

  const bbox = { minLat: origin.lat - 0.002, minLon: origin.lon - 0.003, maxLat: origin.lat + (blocks * blockM) / M_PER_DEG + 0.002, maxLon: origin.lon + (blocks * blockM) / kx + 0.003 };
  const input: PackInput = {
    meta: { name: 'Ciudad de prueba', source: 'sintético', generatedAt: '2026-01-01T00:00:00Z', bbox, detail: bbox },
    nodeLat: nodes.map((p) => p[0]),
    nodeLon: nodes.map((p) => p[1]),
    edgeA: edges.map((e) => e.a),
    edgeB: edges.map((e) => e.b),
    edgeLenDm: lenDm,
    edgeCls: edges.map((e) => e.cls),
    edgeFlags: edges.map((e) => e.flags),
    edgeName: edges.map((e) => e.name),
    edgeGeomStart,
    geomLat,
    geomLon,
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
  const nodeOf = (key: string): number => {
    const found = keys.get(key);
    if (found === undefined) throw new Error(`Nodo desconocido: ${key}`);
    return found;
  };
  return {
    input,
    center,
    node: nodeOf,
    at: (key) => ({ lat: nodes[nodeOf(key)]![0] / 1e7, lon: nodes[nodeOf(key)]![1] / 1e7 }),
    edge: (a, b) => {
      const found = edgeIndex.get(`${nodeOf(a)}-${nodeOf(b)}`);
      if (found === undefined) throw new Error(`No hay tramo entre ${a} y ${b}`);
      return found;
    },
  };
}
