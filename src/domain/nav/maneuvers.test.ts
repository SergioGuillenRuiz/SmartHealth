import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph';
import { buildSteps, classifyTurn, exitText, sayDistance } from './maneuvers';
import { readPack, writePack } from './pack';
import { PROFILES } from './profiles';
import { routeVia } from './router.test-support';
import { buildSyntheticCity } from './synthetic-city';

const city = buildSyntheticCity();
const graph = buildGraph(readPack(writePack(city.input)));
const via = (profile: keyof typeof PROFILES, ...keys: string[]) => routeVia(graph, PROFILES[profile], keys.map((k) => city.at(k)));
const texts = (route: ReturnType<typeof via>): string[] => buildSteps(graph, route).map((s) => s.text);

describe('instrucciones', () => {
  it('seguir recto por una calle solo da la salida y la llegada', () => {
    const route = via('walk', 'g_0_0', 'g_1_0', 'g_2_0', 'g_3_0');
    expect(texts(route)).toEqual(['Camina hacia el este por Calle de Alcalá', 'Has llegado a tu destino']);
  });

  it('un giro a la izquierda y otro a la derecha, con el nombre de la calle a la que se pasa', () => {
    const left = buildSteps(graph, via('walk', 'g_0_1', 'g_3_1', 'g_3_2'));
    expect(left.map((s) => s.type)).toEqual(['depart', 'turn', 'arrive']);
    expect(left[1]!.text).toBe('Gira a la izquierda en Calle de Génova');
    expect(left[1]!.turn).toBe('left');
    const right = buildSteps(graph, via('walk', 'g_0_1', 'g_3_1', 'g_3_0'));
    expect(right[1]!.text).toBe('Gira a la derecha en Calle de Génova');
    expect(right[1]!.turn).toBe('right');
  });

  it('cada instrucción dice dónde ocurre y cuánto queda a la siguiente, y esas distancias suman la ruta', () => {
    const route = via('walk', 'g_0_1', 'g_3_1', 'g_3_2');
    const steps = buildSteps(graph, route);
    expect(steps[0]!.atM).toBe(0);
    expect(steps[1]!.atM).toBeGreaterThan(280);
    expect(steps[1]!.atM).toBeLessThan(320);
    expect(steps.reduce((s, st) => s + st.lengthM, 0)).toBeCloseTo(route.distanceM, 3);
    expect(steps[2]!.atM).toBeCloseTo(route.distanceM, 3);
  });

  it('una rotonda: por qué salida se sale', () => {
    const straight = buildSteps(graph, via('walk', 'g_3_5', 'g_4_5', 'r_w', 'r_s', 'r_e', 'g_6_5'));
    const round = straight.find((s) => s.type === 'roundabout');
    expect(round?.text).toBe('En la rotonda, toma la segunda salida en Avenida Principal');
    expect(round?.exit).toBe(2);
    const first = buildSteps(graph, via('walk', 'g_4_5', 'r_w', 'r_s', 'g_5_4')).find((s) => s.type === 'roundabout');
    expect(first?.exit).toBe(1);
    expect(first?.text).toBe('En la rotonda, toma la primera salida en Avenida Central');
    // Sin instrucciones sueltas por cada nodo del anillo.
    expect(straight.filter((s) => s.type === 'turn')).toHaveLength(0);
  });

  it('las escaleras se avisan', () => {
    const steps = buildSteps(graph, via('walk', 'g_2_2', 'p_mid', 'g_2_4'));
    expect(steps.some((s) => /escaleras/.test(s.text))).toBe(true);
  });

  it('un tramo sin nombre se llama por lo que es', () => {
    const steps = buildSteps(graph, via('walk', 'g_2_2', 'p_mid'));
    expect(steps[0]!.text).toMatch(/^Camina hacia el noreste por Paseo del Parque$/);
    const bike = buildSteps(graph, via('bike', 'g_4_2', 'p_mid'));
    expect(bike[0]!.text).toMatch(/^Pedalea hacia el .+ por Carril bici del Parque$/);
  });

  it('el destino a un lado se dice', () => {
    const route = via('walk', 'g_0_1', 'g_3_1');
    const target = { lat: route.points.at(-1)!.lat + 0.00015, lon: route.points.at(-1)!.lon }; // ~17 m al norte de una ruta que va al este
    const arrive = buildSteps(graph, route, target).at(-1)!;
    expect(arrive.side).toBe('left');
    expect(arrive.text).toBe('Has llegado a tu destino, queda a tu izquierda');
  });
});

describe('frases', () => {
  it('los giros según el ángulo', () => {
    expect(classifyTurn(0)).toBe('straight');
    expect(classifyTurn(25)).toBe('straight');
    expect(classifyTurn(40)).toBe('slight-right');
    expect(classifyTurn(-40)).toBe('slight-left');
    expect(classifyTurn(90)).toBe('right');
    expect(classifyTurn(-90)).toBe('left');
    expect(classifyTurn(150)).toBe('sharp-right');
    expect(classifyTurn(-179)).toBe('uturn');
  });
  it('las distancias dichas en voz alta', () => {
    expect(sayDistance(8)).toBe('10 metros');
    expect(sayDistance(47)).toBe('50 metros');
    expect(sayDistance(130)).toBe('150 metros');
    expect(sayDistance(430)).toBe('450 metros');
    expect(sayDistance(1000)).toBe('1 kilómetro');
    expect(sayDistance(1240)).toBe('1,2 kilómetros');
    expect(sayDistance(12_300)).toBe('12 kilómetros');
  });
  it('las salidas de la rotonda', () => {
    expect(exitText(1)).toBe('la primera salida');
    expect(exitText(3)).toBe('la tercera salida');
    expect(exitText(12)).toBe('la salida número 12');
  });
});
