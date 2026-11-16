// Geodesia para el navegador: distancias, rumbos, proyección de un punto sobre un tramo y las cuentas de las teselas (Web Mercator). Todo en metros y grados; las coordenadas del paquete
// de mapa van en grados × 1e7 enteros (`E7`) para ocupar la mitad y dar ~1 cm de resolución.

export interface LatLon {
  lat: number;
  lon: number;
}

export const E7 = 1e7;
export const EARTH_RADIUS_M = 6_371_008.8;
/** Metros por grado de latitud (con el radio medio). */
export const M_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_M;

export const toRad = (deg: number): number => (deg * Math.PI) / 180;
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;
export const e7 = (deg: number): number => Math.round(deg * E7);
export const fromE7 = (value: number): number => value / E7;

/** Metros por grado de longitud a esa latitud. */
export const mPerDegLon = (lat: number): number => M_PER_DEG * Math.cos(toRad(lat));

/** Distancia entre dos puntos (m), por haversine. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distancia rápida entre dos puntos cercanos (menos de unos 50 km), proyectando en plano: la del A* y las proyecciones, donde importa la velocidad. */
export function flatDistanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dy = (bLat - aLat) * M_PER_DEG;
  const dx = (bLon - aLon) * M_PER_DEG * Math.cos(toRad((aLat + bLat) / 2));
  return Math.hypot(dx, dy);
}

/** Rumbo inicial de `a` a `b` en grados (0 = norte, 90 = este), de 0 a 360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Lo que hay que girar para pasar del rumbo `from` al rumbo `to`, en grados de −180 a 180 (positivo = a la derecha, en el sentido de las agujas del reloj). */
export function turnDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** El punto a `distanceM` de `from` en el rumbo `bearing`. */
export function destinationPoint(from: LatLon, bearing: number, distanceM: number): LatLon {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(bearing);
  const φ1 = toRad(from.lat);
  const λ1 = toRad(from.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

export interface SegmentProjection {
  /** Dónde cae la proyección en el tramo: 0 = en `a`, 1 = en `b` (siempre entre 0 y 1). */
  t: number;
  lat: number;
  lon: number;
  /** Distancia del punto a su proyección (m). */
  distM: number;
}

/** Proyecta el punto `(lat, lon)` sobre el tramo `a`→`b` (planos locales: vale para tramos de hasta unos kilómetros). */
export function projectOnSegment(lat: number, lon: number, aLat: number, aLon: number, bLat: number, bLon: number): SegmentProjection {
  const kx = M_PER_DEG * Math.cos(toRad(aLat));
  const ax = 0;
  const ay = 0;
  const bx = (bLon - aLon) * kx;
  const by = (bLat - aLat) * M_PER_DEG;
  const px = (lon - aLon) * kx;
  const py = (lat - aLat) * M_PER_DEG;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : ((px - ax) * bx + (py - ay) * by) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * bx;
  const qy = ay + t * by;
  return { t, lat: aLat + qy / M_PER_DEG, lon: aLon + qx / kx, distM: Math.hypot(px - qx, py - qy) };
}

// ───────────────────────────── Web Mercator (teselas) ─────────────────────────────

export const TILE_SIZE = 256;
/// Latitud máxima del Mercator de las teselas.
export const MAX_MERCATOR_LAT = 85.0511287798;

/** La coordenada x (en teselas, fraccionaria) de una longitud a un zoom. */
export const lonToTileX = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z;

/** La coordenada y (en teselas, fraccionaria) de una latitud a un zoom. */
export function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const s = Math.sin(toRad(clamped));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}

export const tileXToLon = (x: number, z: number): number => (x / 2 ** z) * 360 - 180;

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return toDeg(Math.atan(Math.sinh(n)));
}

/** Metros por píxel (de 256 px por tesela) a una latitud y un zoom. */
export const metersPerPixel = (lat: number, z: number): number => (Math.cos(toRad(lat)) * 2 * Math.PI * EARTH_RADIUS_M) / (TILE_SIZE * 2 ** z);

/** La caja de latitud/longitud de una tesela. */
export function tileBounds(z: number, x: number, y: number): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
  return { minLat: tileYToLat(y + 1, z), maxLat: tileYToLat(y, z), minLon: tileXToLon(x, z), maxLon: tileXToLon(x + 1, z) };
}

/** El rumbo en texto («norte», «noreste»…): para «Dirígete al noreste por…». */
export function compassName(bearing: number): string {
  const names = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
  return names[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}
