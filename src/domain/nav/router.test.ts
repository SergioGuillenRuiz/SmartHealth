import { describe, expect, it } from 'vitest';
import { flatDistanceM } from './geo';
import { buildGraph, snapToEdge } from './graph';
import { buildSteps } from './maneuvers';
import { FLAG, HW, PackError, readPack, writePack } from './pack';
import { PROFILES, relaxedProfile } from './profiles';
import { findRoute } from './router';
import { buildSyntheticCity } from './synthetic-city';

const city = buildSyntheticCity();
const pack = readPack(writePack(city.input));
const graph = buildGraph(pack);

describe('el paquete de mapa', () => {
  it('lo que se escribe se lee igual y es coherente', () => {
    expect(pack.nodeCount).toBe(city.input.nodeLat.length);
    expect(pack.edgeCount).toBe(city.input.edgeA.length);
    expect(pack.meta.name).toBe('Ciudad de prueba');
    expect(pack.edgeCls[city.edge('g_0_0', 'g_1_0')]).toBe(HW.RESIDENTIAL);
  });
  it('un archivo cortado, de otra cosa o estropeado se rechaza con un motivo', () => {
    const buffer = writePack(city.input);
    expect(() => readPack(buffer.slice(0, 10))).toThrow(PackError);
    expect(() => readPack(buffer.slice(0, buffer.byteLength - 100))).toThrow(PackError);
    const wrongMagic = buffer.slice(0);
    new Uint32Array(wrongMagic, 0, 1)[0] = 1234;
    expect(() => readPack(wrongMagic)).toThrow(/no es un mapa/);
    const broken = buffer.slice(0);
    // Un tramo que apunta a un nodo que no existe.
    const table = new Uint32Array(broken, 16, 23 * 4);
    const edgeA = new Uint32Array(broken, table[3 * 4 + 1]!, table[3 * 4 + 3]!);
    edgeA[0] = 9_999_999;
    expect(() => readPack(broken)).toThrow(/no es coherente/);
  });
});

describe('buscar la ruta', () => {
  it('a pie, de una esquina a otra, por calles que existen y con una longitud razonable', () => {
    const from = city.at('g_0_0');
    const to = city.at('g_2_0');
    const result = findRoute(graph, PROFILES.walk, from, to);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.distanceM).toBeGreaterThan(190);
    expect(result.route.distanceM).toBeLessThan(215);
    expect(result.route.points[0]!.lat).toBeCloseTo(from.lat, 4);
    expect(flatDistanceM(result.route.points.at(-1)!.lat, result.route.points.at(-1)!.lon, to.lat, to.lon)).toBeLessThan(2);
  });

  it('desde y hasta mitad de una calle', () => {
    const a = { lat: city.at('g_0_0').lat, lon: city.at('g_0_0').lon + 0.0005 }; // ~40 m al este de la esquina
    const b = city.at('g_3_0');
    const result = findRoute(graph, PROFILES.walk, a, b);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.route.distanceM).toBeGreaterThan(250);
  });

  it('en el mismo tramo va directo', () => {
    const a = city.at('g_0_0');
    const b = { lat: a.lat, lon: a.lon + 0.0008 };
    const result = findRoute(graph, PROFILES.walk, a, b);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.route.legs).toHaveLength(1);
      expect(result.route.distanceM).toBeLessThan(80);
    }
  });

  it('atraviesa el parque por el sendero cuando ahorra mucho a pie, y en bici no entra por el sendero de tierra', () => {
    const from = city.at('g_2_2');
    const to = city.at('g_4_4');
    const walk = findRoute(graph, PROFILES.walk, from, to);
    expect(walk.ok).toBe(true);
    if (walk.ok) expect(walk.route.legs.some((l) => l.cls === HW.PATH)).toBe(true);
    const bike = findRoute(graph, PROFILES.bike, from, to);
    expect(bike.ok).toBe(true);
    if (bike.ok) expect(bike.route.legs.every((l) => l.cls !== HW.PATH && l.cls !== HW.STEPS)).toBe(true);
  });

  it('la bici usa el carril bici del parque y respeta el sentido único; a pie se puede ir en contra', () => {
    const bike = findRoute(graph, PROFILES.bike, city.at('g_2_2'), city.at('g_4_2'));
    expect(bike.ok).toBe(true);
    // Un sentido único hacia el este en la fila mid+1: de este a oeste en bici hay que dar un rodeo; a pie no.
    const west = city.at('g_1_6');
    const east = city.at('g_4_6');
    const eastward = findRoute(graph, PROFILES.bike, west, east);
    const westward = findRoute(graph, PROFILES.bike, east, west);
    const walking = findRoute(graph, PROFILES.walk, east, west);
    expect(eastward.ok && westward.ok && walking.ok).toBe(true);
    if (eastward.ok && westward.ok && walking.ok) {
      expect(westward.route.distanceM).toBeGreaterThan(eastward.route.distanceM + 100);
      expect(walking.route.distanceM).toBeLessThan(westward.route.distanceM);
      for (const leg of westward.route.legs) if (leg.flags & FLAG.ONEWAY_FWD) expect(leg.forward).toBe(true);
    }
  });

  it('corrigiendo a quien se ha salido (perfil relajado): la bici puede ir en contra de un sentido único con un recargo, en vez de dar un rodeo de coche', () => {
    const west = city.at('g_1_6');
    const east = city.at('g_4_6');
    const strict = findRoute(graph, PROFILES.bike, east, west);
    const relaxed = findRoute(graph, relaxedProfile(PROFILES.bike), east, west);
    const eastward = findRoute(graph, PROFILES.bike, west, east);
    expect(strict.ok && relaxed.ok && eastward.ok).toBe(true);
    if (strict.ok && relaxed.ok && eastward.ok) {
      expect(strict.route.distanceM).toBeGreaterThan(eastward.route.distanceM + 100); // el rodeo de siempre
      expect(relaxed.route.distanceM).toBeLessThan(strict.route.distanceM - 100);
      expect(relaxed.route.distanceM).toBeLessThanOrEqual(eastward.route.distanceM + 5); // va directo, en contra
    }
  });

  it('el perfil relajado sigue sin meter la bici por las autopistas, por donde tiene prohibido ni por escaleras; y a pie no cambia nada', () => {
    const relaxed = relaxedProfile(PROFILES.bike);
    const road = (flags: number, cls: number = HW.RESIDENTIAL): number => relaxed.cost(cls, flags, 1, 100);
    expect(road(FLAG.ONEWAY_FWD)).toBeLessThan(Infinity);
    expect(PROFILES.bike.cost(HW.RESIDENTIAL, FLAG.ONEWAY_FWD, 1, 100)).toBe(Infinity);
    expect(road(FLAG.ONEWAY_FWD)).toBeCloseTo(PROFILES.bike.cost(HW.RESIDENTIAL, 0, 1, 100) * 1.6, 5);
    expect(road(FLAG.ONEWAY_FWD | FLAG.BIKE_NO)).toBe(Infinity);
    expect(road(0, HW.MOTORWAY)).toBe(Infinity);
    expect(road(0, HW.STEPS)).toBe(Infinity);
    // Una vía peatonal sin permiso para bicis: se empuja la bici, con un recargo; con el permiso, como siempre.
    expect(PROFILES.bike.cost(HW.FOOTWAY, 0, 0, 100)).toBe(Infinity);
    expect(relaxed.cost(HW.FOOTWAY, 0, 0, 100)).toBeGreaterThan(PROFILES.bike.cost(HW.FOOTWAY, FLAG.BIKE_YES, 0, 100) * 2);
    expect(relaxed.cost(HW.FOOTWAY, FLAG.BIKE_YES, 0, 100)).toBe(PROFILES.bike.cost(HW.FOOTWAY, FLAG.BIKE_YES, 0, 100));
    // A pie no hay normas de coche que relajar.
    expect(relaxedProfile(PROFILES.walk)).toBe(PROFILES.walk);
    expect(relaxedProfile(PROFILES.run)).toBe(PROFILES.run);
  });

  it('el río: a pie se cruza por la pasarela y en bici por el puente', () => {
    const from = city.at('g_7_3');
    const to = city.at('g_8_3');
    const walk = findRoute(graph, PROFILES.walk, from, to);
    const bike = findRoute(graph, PROFILES.bike, from, to);
    expect(walk.ok && bike.ok).toBe(true);
    if (walk.ok && bike.ok) {
      expect(walk.route.distanceM).toBeLessThan(120);
      expect(walk.route.legs.some((l) => l.cls === HW.FOOTWAY)).toBe(true);
      expect(bike.route.distanceM).toBeGreaterThan(walk.route.distanceM + 300);
      expect(bike.route.legs.every((l) => l.cls !== HW.FOOTWAY)).toBe(true);
    }
  });

  it('sin calle cerca del origen o del destino lo dice, y una ruta imposible también', () => {
    const far = { lat: city.center.lat + 0.05, lon: city.center.lon };
    const r1 = findRoute(graph, PROFILES.walk, far, city.at('g_2_0'));
    expect(r1).toEqual({ ok: false, reason: 'no-road-near-start' });
    const r2 = findRoute(graph, PROFILES.walk, city.at('g_2_0'), far);
    expect(r2).toEqual({ ok: false, reason: 'no-road-near-destination' });
    const r3 = findRoute(graph, PROFILES.walk, city.at('g_0_0'), { lat: 41.5, lon: -3.7 });
    expect(r3.ok).toBe(false);
  });

  it('la ruta empieza y acaba donde se pidió y la distancia acumulada crece', () => {
    const result = findRoute(graph, PROFILES.run, city.at('g_0_0'), city.at('g_9_9'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { cumM, points, distanceM, durationS } = result.route;
    expect(cumM).toHaveLength(points.length);
    for (let i = 1; i < cumM.length; i++) expect(cumM[i]!).toBeGreaterThanOrEqual(cumM[i - 1]!);
    expect(distanceM).toBeCloseTo(cumM.at(-1)!, 3);
    expect(durationS).toBeGreaterThan(distanceM / 4);
    expect(snapToEdge(graph, points[0]!.lat, points[0]!.lon, 5)).not.toBeNull();
  });
});

describe('destinos sin camino hasta ellos (un parque, un recinto)', () => {
  // «Recinto Ferial»: queda pegado a un sendero que no se une a ninguna calle. El tramo más cercano de todos es esa isla, pero no se llega a él.
  const recinto = { lat: city.at('isl_a').lat + 0.00005, lon: city.at('isl_a').lon + 0.00018 };

  it('la isla existe y es lo más cercano al recinto (si no, esta prueba no prueba nada)', () => {
    const nearest = snapToEdge(graph, recinto.lat, recinto.lon, 400);
    expect(nearest?.edge).toBe(city.edge('isl_a', 'isl_b'));
  });

  it('a pie y en bici se llega al punto más cercano de la red a la que se puede ir, en vez de decir «no hay camino»', () => {
    for (const profile of [PROFILES.walk, PROFILES.bike, PROFILES.run]) {
      const result = findRoute(graph, profile, city.at('g_1_1'), recinto);
      expect(result.ok, profile.id).toBe(true);
      if (!result.ok) continue;
      const end = result.route.points.at(-1)!;
      // La ruta acaba en la calle (no en la isla) y queda un buen trozo hasta el recinto.
      expect(result.route.destination.edge).not.toBe(city.edge('isl_a', 'isl_b'));
      expect(flatDistanceM(end.lat, end.lon, recinto.lat, recinto.lon)).toBeGreaterThan(100);
      expect(result.route.destination.distM).toBeGreaterThan(100);
    }
  });

  it('la última instrucción dice cuánto falta y hacia dónde, no «has llegado»', () => {
    const result = findRoute(graph, PROFILES.walk, city.at('g_1_1'), recinto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const steps = buildSteps(graph, result.route, recinto);
    const last = steps.at(-1)!;
    expect(last.type).toBe('arrive');
    expect(last.text).toMatch(/Aquí acaba el camino\. Tu destino queda a \d+ metros hacia el (este|noreste|sureste)/);
  });

  it('un destino que tiene calle a menos de 40 m sigue diciendo «has llegado»', () => {
    const result = findRoute(graph, PROFILES.walk, city.at('g_0_0'), city.at('g_2_0'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(buildSteps(graph, result.route, city.at('g_2_0')).at(-1)!.text).toMatch(/^Has llegado/);
  });

  it('si la persona está dentro de la isla, sale hacia la red grande en vez de quedarse sin ruta', () => {
    const onIsland = { lat: city.at('isl_a').lat + 0.00002, lon: city.at('isl_a').lon };
    const result = findRoute(graph, PROFILES.walk, onIsland, city.at('g_7_7'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.origin.edge).not.toBe(city.edge('isl_a', 'isl_b'));
    expect(result.route.distanceM).toBeGreaterThan(200);
  });

  it('el centro del parque (que no es un cruce ni queda a una calle) sigue dando ruta', () => {
    const park = { lat: city.at('p_mid').lat, lon: city.at('p_mid').lon };
    const result = findRoute(graph, PROFILES.bike, city.at('g_8_1'), park);
    expect(result.ok).toBe(true);
  });

  it('con una red mayor lejos y sin nada alcanzable cerca, lo dice con el motivo', () => {
    const far = { lat: city.center.lat + 0.05, lon: city.center.lon };
    expect(findRoute(graph, PROFILES.walk, city.at('g_2_0'), far)).toEqual({ ok: false, reason: 'no-road-near-destination' });
  });
});
