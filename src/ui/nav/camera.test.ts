import { describe, expect, it } from 'vitest';
import { destinationPoint, flatDistanceM } from '../../domain/nav/geo';
import { fitPoints, pxPerMeter, toLatLon, toScreen, visibleBox, type Camera } from './camera';

const cam = (over: Partial<Camera> = {}): Camera => ({ lat: 40.4, lon: -3.7, zoom: 17, bearing: 0, width: 400, height: 600, anchorY: 0.5, ...over });

describe('la cámara', () => {
  it('el centro cae donde dice el ancla', () => {
    expect(toScreen(cam(), 40.4, -3.7)).toEqual({ x: 200, y: 300 });
    const low = toScreen(cam({ anchorY: 0.7 }), 40.4, -3.7);
    expect(low.x).toBeCloseTo(200, 6);
    expect(low.y).toBeCloseTo(420, 6);
  });

  it('el norte queda arriba y el este a la derecha con rumbo 0', () => {
    const c = cam();
    const north = toScreen(c, 40.4 + 0.001, -3.7);
    const east = toScreen(c, 40.4, -3.7 + 0.001);
    expect(north.y).toBeLessThan(300);
    expect(north.x).toBeCloseTo(200, 6);
    expect(east.x).toBeGreaterThan(200);
    expect(east.y).toBeCloseTo(300, 6);
  });

  it('con el rumbo hacia el este, lo que queda al este se ve ARRIBA', () => {
    const c = cam({ bearing: 90 });
    const east = toScreen(c, 40.4, -3.7 + 0.001);
    expect(east.x).toBeCloseTo(200, 3);
    expect(east.y).toBeLessThan(300);
    const north = toScreen(c, 40.4 + 0.001, -3.7);
    expect(north.x).toBeLessThan(200); // el norte queda a la izquierda cuando se mira al este
  });

  it('ida y vuelta: pantalla → mapa → pantalla', () => {
    for (const bearing of [0, 37, 90, 181, 300]) {
      const c = cam({ bearing, anchorY: 0.65, zoom: 16.3 });
      const p = toLatLon(c, 120, 80);
      const back = toScreen(c, p.lat, p.lon);
      expect(back.x).toBeCloseTo(120, 4);
      expect(back.y).toBeCloseTo(80, 4);
    }
  });

  it('la escala: 100 m son tantos píxeles como dice pxPerMeter', () => {
    const c = cam();
    const p = destinationPoint({ lat: c.lat, lon: c.lon }, 90, 100);
    const s = toScreen(c, p.lat, p.lon);
    expect(s.x - 200).toBeCloseTo(100 * pxPerMeter(c), 0);
  });

  it('la caja visible contiene los cuatro rincones', () => {
    const c = cam({ bearing: 55, anchorY: 0.7 });
    const box = visibleBox(c, 0);
    for (const [x, y] of [[0, 0], [400, 0], [0, 600], [400, 600]] as const) {
      const p = toLatLon(c, x, y);
      expect(p.lat).toBeGreaterThanOrEqual(box.minLat);
      expect(p.lat).toBeLessThanOrEqual(box.maxLat);
      expect(p.lon).toBeGreaterThanOrEqual(box.minLon);
      expect(p.lon).toBeLessThanOrEqual(box.maxLon);
    }
  });

  it('encuadrar unos puntos los deja dentro', () => {
    const a = { lat: 40.4, lon: -3.7 };
    const b = destinationPoint(a, 45, 1500);
    const fit = fitPoints([a, b], 400, 300, 30);
    const c = cam({ ...fit, width: 400, height: 300 });
    for (const p of [a, b]) {
      const s = toScreen(c, p.lat, p.lon);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(400);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(300);
    }
    expect(flatDistanceM(fit.lat, fit.lon, (a.lat + b.lat) / 2, (a.lon + b.lon) / 2)).toBeLessThan(1);
    expect(fitPoints([], 400, 300).zoom).toBe(15);
  });
});
