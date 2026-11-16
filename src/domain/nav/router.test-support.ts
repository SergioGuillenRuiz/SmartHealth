import { flatDistanceM, type LatLon } from './geo';
import type { Graph } from './graph';
import type { Profile } from './profiles';
import { findRoute, type Route } from './router';

/** Una ruta que pasa por cada punto en orden (cada tramo con `findRoute`): para probar con recorridos exactos en vez de los que elija el A*. */
export function routeVia(graph: Graph, profile: Profile, waypoints: readonly LatLon[]): Route {
  const parts: Route[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const result = findRoute(graph, profile, waypoints[i - 1]!, waypoints[i]!);
    if (!result.ok) throw new Error(`No hay ruta entre los puntos ${i - 1} y ${i}: ${result.reason}`);
    parts.push(result.route);
  }
  const points: LatLon[] = [];
  const cumM: number[] = [];
  const legs: Route['legs'] = [];
  let travelled = 0;
  for (const part of parts) {
    for (const leg of part.legs) {
      const copy = { ...leg, startIndex: points.length === 0 ? 0 : points.length - 1 };
      for (let i = 0; i < leg.points.length; i++) {
        const p = leg.points[i]!;
        if (points.length > 0 && i === 0) continue;
        if (points.length > 0) travelled += flatDistanceM(points[points.length - 1]!.lat, points[points.length - 1]!.lon, p.lat, p.lon);
        points.push(p);
        cumM.push(travelled);
      }
      legs.push(copy);
    }
  }
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const durationS = parts.reduce((s, p) => s + p.durationS, 0);
  return { profile, points, cumM, distanceM: travelled, durationS, legs, origin: first.origin, destination: last.destination };
}
