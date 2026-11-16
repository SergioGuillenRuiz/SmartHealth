import { M_PER_DEG, metersPerPixel, toRad, type LatLon } from '../../domain/nav/geo';

// La cámara del mapa: qué punto está en el centro, a qué zoom, hacia dónde mira (el rumbo apunta arriba, como en Google Maps cuando se navega) y el tamaño de la vista. Las cuentas son
// locales (planas alrededor del centro): para unos kilómetros de vista no se distinguen del Mercator y evitan el logaritmo en cada punto.

export interface Camera {
  lat: number;
  lon: number;
  /** Zoom de teselas (fraccionario): a 17 una calle ocupa unos 6 px de ancho. */
  zoom: number;
  /** Hacia dónde mira la cámara en grados (0 = norte arriba). */
  bearing: number;
  width: number;
  height: number;
  /** Dónde cae el centro en vertical (0 = arriba, 1 = abajo): al navegar se baja para ver más camino por delante. */
  anchorY: number;
}

export const MIN_ZOOM = 12;
export const MAX_ZOOM = 19.5;

export const clampZoom = (z: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** Píxeles por metro a la latitud y zoom de la cámara. */
export const pxPerMeter = (cam: Pick<Camera, 'lat' | 'zoom'>): number => 1 / metersPerPixel(cam.lat, cam.zoom);

export interface Projection {
  /** Píxeles por grado de latitud y de longitud. */
  kLat: number;
  kLon: number;
  mpp: number;
}

export function projectionOf(cam: Pick<Camera, 'lat' | 'zoom'>): Projection {
  const mpp = metersPerPixel(cam.lat, cam.zoom);
  return { kLat: M_PER_DEG / mpp, kLon: (M_PER_DEG * Math.cos(toRad(cam.lat))) / mpp, mpp };
}

/** Un punto como desplazamiento en píxeles del centro del mapa (x a la derecha, y hacia abajo), SIN girar. */
export function offsetOf(cam: Pick<Camera, 'lat' | 'lon' | 'zoom'>, lat: number, lon: number, proj: Projection = projectionOf(cam)): { x: number; y: number } {
  return { x: (lon - cam.lon) * proj.kLon, y: -(lat - cam.lat) * proj.kLat };
}

/** Un punto del mapa en la pantalla (con la cámara girada). */
export function toScreen(cam: Camera, lat: number, lon: number): { x: number; y: number } {
  const o = offsetOf(cam, lat, lon);
  const b = toRad(cam.bearing);
  const cos = Math.cos(b);
  const sin = Math.sin(b);
  // Girar el mapa −bearing: lo que está en el rumbo queda arriba.
  return { x: cam.width / 2 + o.x * cos + o.y * sin, y: cam.height * cam.anchorY - o.x * sin + o.y * cos };
}

/** Lo contrario: qué punto del mapa hay bajo un píxel de la pantalla. */
export function toLatLon(cam: Camera, x: number, y: number): LatLon {
  const b = toRad(cam.bearing);
  const cos = Math.cos(b);
  const sin = Math.sin(b);
  const sx = x - cam.width / 2;
  const sy = y - cam.height * cam.anchorY;
  const ox = sx * cos - sy * sin;
  const oy = sx * sin + sy * cos;
  const proj = projectionOf(cam);
  return { lat: cam.lat - oy / proj.kLat, lon: cam.lon + ox / proj.kLon };
}

/** La caja (grados) que contiene lo que se ve, con un margen (px). */
export function visibleBox(cam: Camera, marginPx = 40): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
  const proj = projectionOf(cam);
  const radius = Math.hypot(cam.width, cam.height) / 2 + marginPx + Math.abs(cam.anchorY - 0.5) * cam.height;
  return { minLat: cam.lat - radius / proj.kLat, maxLat: cam.lat + radius / proj.kLat, minLon: cam.lon - radius / proj.kLon, maxLon: cam.lon + radius / proj.kLon };
}

/** El zoom y el centro que dejan ver todos los puntos dados en una vista de `width` × `height` con un margen. */
export function fitPoints(points: readonly LatLon[], width: number, height: number, paddingPx = 40): Pick<Camera, 'lat' | 'lon' | 'zoom'> {
  if (points.length === 0) return { lat: 40.4168, lon: -3.7038, zoom: 15 };
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const lat = (minLat + maxLat) / 2;
  const lon = (minLon + maxLon) / 2;
  const widthM = Math.max(30, (maxLon - minLon) * M_PER_DEG * Math.cos(toRad(lat)));
  const heightM = Math.max(30, (maxLat - minLat) * M_PER_DEG);
  const availW = Math.max(50, width - 2 * paddingPx);
  const availH = Math.max(50, height - 2 * paddingPx);
  const mppNeeded = Math.max(widthM / availW, heightM / availH);
  // mpp = cos(lat) · 2πR / (256 · 2^z)  →  z = log2(cos(lat) · 2πR / (256 · mpp))
  const z = Math.log2((Math.cos(toRad(lat)) * 2 * Math.PI * 6_371_008.8) / (256 * mppNeeded));
  return { lat, lon, zoom: clampZoom(z) };
}
