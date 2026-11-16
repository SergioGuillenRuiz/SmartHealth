import { bearingDeg, compassName, flatDistanceM, turnDeg, type LatLon } from './geo';
import { edgePolyline, type Graph } from './graph';
import { FLAG, HW, NO_NAME, nameOf } from './pack';
import type { Route, RouteLeg } from './router';

// De la ruta a las instrucciones: en qué cruces hay que decir algo (girar, mantenerse a un lado en una bifurcación, tomar una rotonda o unas escaleras) y cómo se dice en español. Donde la
// calle sigue sin alternativas o hay que seguir recto, no se dice nada: hablar de más cansa y hace perder las instrucciones que importan.

export type TurnKind = 'left' | 'right' | 'slight-left' | 'slight-right' | 'sharp-left' | 'sharp-right' | 'uturn' | 'keep-left' | 'keep-right' | 'straight';
export type StepType = 'depart' | 'turn' | 'roundabout' | 'steps' | 'arrive';

export interface Step {
  type: StepType;
  turn: TurnKind;
  /** Rotonda: qué salida se toma (1, 2, 3…). */
  exit: number | null;
  /** Nombre de la calle a la que se pasa (`''` si no tiene). */
  street: string;
  /** Cómo se llama a la vía cuando no tiene nombre («el sendero»). */
  generic: string;
  /** Índice en `route.points` donde ocurre y distancia acumulada (m) hasta ahí. */
  pointIndex: number;
  atM: number;
  /** Lo que queda de aquí a la siguiente instrucción (m). */
  lengthM: number;
  /** La instrucción completa («Gira a la derecha en Calle de Alcalá»). */
  text: string;
  /** El rumbo de salida (solo en `depart`, en grados). */
  heading: number | null;
  /** A qué lado queda el destino (solo en `arrive`). */
  side: 'left' | 'right' | null;
}

const LOOK_M = 12;
/** Si la ruta acaba a más de esto del destino pedido, la última instrucción dice cuánto falta. */
export const FAR_FINISH_M = 40;

const GENERIC: Record<number, string> = {
  [HW.PATH]: 'el sendero',
  [HW.FOOTWAY]: 'el camino peatonal',
  [HW.PEDESTRIAN]: 'la calle peatonal',
  [HW.CYCLEWAY]: 'el carril bici',
  [HW.TRACK]: 'el camino',
  [HW.STEPS]: 'las escaleras',
  [HW.SERVICE]: 'la calle de servicio',
};

const TURN_TEXT: Record<TurnKind, string> = {
  left: 'Gira a la izquierda',
  right: 'Gira a la derecha',
  'slight-left': 'Gira ligeramente a la izquierda',
  'slight-right': 'Gira ligeramente a la derecha',
  'sharp-left': 'Gira bruscamente a la izquierda',
  'sharp-right': 'Gira bruscamente a la derecha',
  uturn: 'Haz un cambio de sentido',
  'keep-left': 'Mantente a la izquierda',
  'keep-right': 'Mantente a la derecha',
  straight: 'Sigue recto',
};

const ORDINALS = ['primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava'];

/** El nombre de la salida de una rotonda («la segunda salida»). */
export const exitText = (n: number): string => (n >= 1 && n <= ORDINALS.length ? `la ${ORDINALS[n - 1]} salida` : `la salida número ${n}`);

/** El verbo de empezar según el entreno. */
const START_VERB: Record<string, string> = { walk: 'Camina', run: 'Corre', hike: 'Camina', bike: 'Pedalea' };

/** Cómo se llama a la calle en la instrucción: `en X` / `por X`. */
export function streetPhrase(street: string, generic: string, preposition: 'en' | 'por'): string {
  if (street !== '') return ` ${preposition} ${street}`;
  if (generic !== '') return ` por ${generic}`;
  return '';
}

export function classifyTurn(angle: number): TurnKind {
  const a = Math.abs(angle);
  const right = angle > 0;
  if (a <= 25) return 'straight';
  if (a <= 60) return right ? 'slight-right' : 'slight-left';
  if (a <= 125) return right ? 'right' : 'left';
  if (a <= 165) return right ? 'sharp-right' : 'sharp-left';
  return 'uturn';
}

/** El rumbo de la ruta mirando `LOOK_M` metros hacia atrás de un punto (`before`) o hacia delante (`after`). */
function headingNear(route: Route, index: number, direction: 'before' | 'after'): number {
  const here = route.points[index]!;
  const step = direction === 'before' ? -1 : 1;
  let j = index;
  for (;;) {
    const next = j + step;
    if (next < 0 || next >= route.points.length) break;
    j = next;
    if (flatDistanceM(here.lat, here.lon, route.points[j]!.lat, route.points[j]!.lon) >= LOOK_M) break;
  }
  if (j === index) return NaN;
  return direction === 'before' ? bearingDeg(route.points[j]!, here) : bearingDeg(here, route.points[j]!);
}

function nodeOfLegEnd(graph: Graph, leg: RouteLeg): number {
  return leg.forward ? graph.pack.edgeB[leg.edge]! : graph.pack.edgeA[leg.edge]!;
}

/** El rumbo con que sale del nodo un tramo (según su geometría), mirando `LOOK_M` metros. */
function edgeHeadingFrom(graph: Graph, edge: number, fromA: boolean): number {
  const pts = edgePolyline(graph.pack, edge);
  const ordered = fromA ? pts : [...pts].reverse();
  const origin = ordered[0]!;
  for (let i = 1; i < ordered.length; i++) {
    if (flatDistanceM(origin.lat, origin.lon, ordered[i]!.lat, ordered[i]!.lon) >= LOOK_M || i === ordered.length - 1) return bearingDeg(origin, ordered[i]!);
  }
  return 0;
}

interface Alternative {
  edge: number;
  heading: number;
  cls: number;
}

/** Por dónde más se podría salir del nodo (sin contar de dónde se viene ni a dónde se va) con este perfil. */
function alternativesAt(graph: Graph, route: Route, node: number, cameBy: RouteLeg, goesBy: RouteLeg): Alternative[] {
  const pack = graph.pack;
  const out: Alternative[] = [];
  for (let k = graph.adjStart[node]!; k < graph.adjStart[node + 1]!; k++) {
    const entry = graph.adj[k]!;
    const edge = entry >> 1;
    const dir = (entry & 1) as 0 | 1;
    if (edge === cameBy.edge || edge === goesBy.edge) continue;
    if (!(route.profile.cost(pack.edgeCls[edge]!, pack.edgeFlags[edge]!, dir, 1) < Infinity)) continue;
    out.push({ edge, heading: edgeHeadingFrom(graph, edge, dir === 0), cls: pack.edgeCls[edge]! });
  }
  return out;
}

/** Las instrucciones de una ruta. `destination` es el punto pedido (para decir a qué lado queda al llegar). */
export function buildSteps(graph: Graph, route: Route, destination?: LatLon): Step[] {
  const pack = graph.pack;
  const legs = route.legs;
  const steps: Step[] = [];
  const nameFor = (leg: RouteLeg): { street: string; generic: string } => ({ street: leg.name === NO_NAME ? '' : nameOf(pack, leg.name), generic: GENERIC[leg.cls] ?? '' });
  const verb = START_VERB[route.profile.id] ?? 'Sigue';

  if (legs.length === 0 || route.points.length < 2) {
    return [{ type: 'arrive', turn: 'straight', exit: null, street: '', generic: '', pointIndex: 0, atM: 0, lengthM: 0, text: 'Has llegado a tu destino', heading: null, side: null }];
  }

  // Salida.
  const first = nameFor(legs[0]!);
  const startHeading = headingNear(route, 0, 'after');
  const heading = Number.isNaN(startHeading) ? 0 : startHeading;
  steps.push({
    type: 'depart',
    turn: 'straight',
    exit: null,
    ...first,
    pointIndex: 0,
    atM: 0,
    lengthM: 0,
    text: `${verb} hacia el ${compassName(heading)}${streetPhrase(first.street, first.generic, 'por')}`,
    heading,
    side: null,
  });

  for (let i = 0; i + 1 < legs.length; i++) {
    const cameBy = legs[i]!;
    const goesBy = legs[i + 1]!;
    const node = nodeOfLegEnd(graph, cameBy);
    const index = goesBy.startIndex;
    const atM = route.cumM[index] ?? 0;

    // Una rotonda: se entra por un tramo normal en uno de rotonda y se sale por el siguiente normal.
    if ((goesBy.flags & FLAG.ROUNDABOUT) !== 0 && (cameBy.flags & FLAG.ROUNDABOUT) === 0) {
      let j = i + 1;
      let exits = 0;
      while (j < legs.length && (legs[j]!.flags & FLAG.ROUNDABOUT) !== 0) {
        const endNode = nodeOfLegEnd(graph, legs[j]!);
        // ¿Sale de ese nodo alguna vía que no sea de la rotonda?
        let hasExit = false;
        for (let k = graph.adjStart[endNode]!; k < graph.adjStart[endNode + 1]!; k++) {
          const entry = graph.adj[k]!;
          const edge = entry >> 1;
          if ((pack.edgeFlags[edge]! & FLAG.ROUNDABOUT) !== 0) continue;
          if (route.profile.cost(pack.edgeCls[edge]!, pack.edgeFlags[edge]!, (entry & 1) as 0 | 1, 1) < Infinity) hasExit = true;
        }
        if (hasExit) exits++;
        j++;
      }
      const exitLeg = legs[j];
      if (exitLeg) {
        const name = nameFor(exitLeg);
        steps.push({
          type: 'roundabout',
          turn: 'straight',
          exit: Math.max(1, exits),
          ...name,
          pointIndex: index,
          atM,
          lengthM: 0,
          text: `En la rotonda, toma ${exitText(Math.max(1, exits))}${streetPhrase(name.street, name.generic, 'en')}`,
          heading: null,
          side: null,
        });
        i = j - 1; // se sigue desde el tramo de salida
        continue;
      }
    }
    if ((cameBy.flags & FLAG.ROUNDABOUT) !== 0 && (goesBy.flags & FLAG.ROUNDABOUT) !== 0) continue;

    const inH = headingNear(route, index, 'before');
    const outH = headingNear(route, index, 'after');
    if (Number.isNaN(inH) || Number.isNaN(outH)) continue;
    const angle = turnDeg(inH, outH);
    const alternatives = alternativesAt(graph, route, node, cameBy, goesBy).filter((a) => !(a.cls === HW.SERVICE && goesBy.cls !== HW.SERVICE));
    const goes = nameFor(goesBy);
    const came = nameFor(cameBy);
    const nameChanges = goes.street !== '' && came.street !== '' && goes.street !== came.street;
    const stepsStart = goesBy.cls === HW.STEPS && cameBy.cls !== HW.STEPS;

    let turn: TurnKind | null = null;
    if (alternatives.length === 0) {
      // Sin más salidas no hace falta decir nada, salvo que la calle cambie de nombre girando.
      if (nameChanges && Math.abs(angle) > 25) turn = classifyTurn(angle);
    } else if (Math.abs(angle) <= 25) {
      // Seguir recto por un cruce no se dice; una bifurcación (otra salida casi en la misma dirección) sí.
      const close = alternatives.filter((a) => Math.abs(turnDeg(outH, a.heading)) < 40);
      if (close.length > 0) {
        const leftOfChosen = close.some((a) => turnDeg(outH, a.heading) < 0);
        const rightOfChosen = close.some((a) => turnDeg(outH, a.heading) > 0);
        turn = leftOfChosen && !rightOfChosen ? 'keep-right' : rightOfChosen && !leftOfChosen ? 'keep-left' : null;
      }
    } else {
      turn = classifyTurn(angle);
    }
    if (turn === null && !stepsStart) continue;
    const tail = streetPhrase(goes.street, goes.generic, 'en');
    steps.push({
      type: stepsStart && turn === null ? 'steps' : 'turn',
      turn: turn ?? 'straight',
      exit: null,
      ...goes,
      pointIndex: index,
      atM,
      lengthM: 0,
      text: turn === null ? 'Toma las escaleras' : `${TURN_TEXT[turn]}${stepsStart ? ' y toma las escaleras' : tail}`,
      heading: null,
      side: null,
    });
  }

  // Llegada: si el destino queda a un lado del final de la ruta, se dice. Y si queda lejos (el centro de un parque o de un recinto no tiene camino hasta él), se dice cuánto falta y hacia dónde.
  const last = route.points[route.points.length - 1]!;
  let side: 'left' | 'right' | null = null;
  const gapM = destination ? flatDistanceM(last.lat, last.lon, destination.lat, destination.lon) : 0;
  const farText = destination && gapM > FAR_FINISH_M ? `Aquí acaba el camino. Tu destino queda a ${sayDistance(gapM)} hacia el ${compassName(bearingDeg(last, destination))}` : null;
  if (destination && gapM > 8 && farText === null) {
    const lastHeading = headingNear(route, route.points.length - 1, 'before');
    if (!Number.isNaN(lastHeading)) {
      const toDest = turnDeg(lastHeading, bearingDeg(last, destination));
      if (Math.abs(toDest) > 20 && Math.abs(toDest) < 160) side = toDest > 0 ? 'right' : 'left';
    }
  }
  steps.push({
    type: 'arrive',
    turn: 'straight',
    exit: null,
    street: '',
    generic: '',
    pointIndex: route.points.length - 1,
    atM: route.distanceM,
    lengthM: 0,
    text: farText ?? (side === null ? 'Has llegado a tu destino' : `Has llegado a tu destino, queda a tu ${side === 'left' ? 'izquierda' : 'derecha'}`),
    heading: null,
    side,
  });

  // Se junta lo que ocurre casi a la vez (dos giros a menos de 12 m se dicen como uno) y se rellena cuánto falta de una instrucción a la siguiente.
  const merged: Step[] = [];
  for (const step of steps) {
    const previous = merged[merged.length - 1];
    if (previous && step.type !== 'arrive' && previous.type !== 'depart' && step.atM - previous.atM < 12 && step.type === 'turn' && previous.type === 'turn') {
      merged[merged.length - 1] = { ...previous, text: `${previous.text} y luego ${lowerFirst(step.text)}` };
      continue;
    }
    merged.push(step);
  }
  for (let i = 0; i < merged.length; i++) merged[i]!.lengthM = Math.max(0, (merged[i + 1]?.atM ?? route.distanceM) - merged[i]!.atM);
  return merged;
}

const lowerFirst = (s: string): string => (s === '' ? s : s[0]!.toLowerCase() + s.slice(1));

/** Una distancia dicha en voz alta: «80 metros», «250 metros», «1,2 kilómetros». */
export function sayDistance(meters: number): string {
  if (meters < 1000) {
    const rounded = meters < 100 ? Math.max(10, Math.round(meters / 10) * 10) : Math.round(meters / 50) * 50;
    return `${rounded} metros`;
  }
  const km = Math.round(meters / 100) / 10;
  if (km >= 10) return `${Math.round(km)} kilómetros`;
  return `${String(km).replace('.', ',')} ${km === 1 ? 'kilómetro' : 'kilómetros'}`;
}
