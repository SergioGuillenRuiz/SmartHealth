import { describe, expect, it } from 'vitest';
import type { NavCue } from './cues';
import { Guidance, type Fix } from './guidance';
import { CapturingCuer, fixAt, lineRoute, step } from './guidance.test-support';
import { PROFILES } from './profiles';
import type { Step } from './maneuvers';

// La guía avisa con un zumbido unos 5 SEGUNDOS antes de cada giro, a la velocidad real de la persona: lo importante es CUÁNDO (en tiempo, no solo en metros), en QUÉ OÍDO, que no se repita nada
// y que se recupere si el GPS se va de la ruta.

const STEPS: Step[] = [
  step('depart', 0, 'Camina hacia el este por Calle Mayor', { street: 'Calle Mayor' }),
  step('turn', 400, 'Gira a la izquierda en Calle de Génova', { turn: 'left', street: 'Calle de Génova' }),
  step('turn', 700, 'Gira a la derecha en Calle de Goya', { turn: 'right', street: 'Calle de Goya' }),
  step('arrive', 900, 'Has llegado a tu destino'),
];

/** Recorre la ruta a `speed` con una lectura por segundo y devuelve lo que sonó (con el punto de la ruta en que sonó). */
function run(speed: number, options: { steps?: Step[]; length?: number; profile?: keyof typeof PROFILES } = {}) {
  const profile = PROFILES[options.profile ?? 'walk'];
  const route = lineRoute(options.length ?? 900, profile);
  const cuer = new CapturingCuer();
  const guidance = new Guidance(route, options.steps ?? STEPS, cuer, { nominalSpeedMs: speed });
  const states = [];
  for (let t = 0; t * speed <= route.distanceM + 5; t++) {
    cuer.at = Math.min(route.distanceM, t * speed);
    states.push(guidance.update(fixAt(route, Math.min(route.distanceM, t * speed), t * 1000, 0, speed)));
  }
  return { cuer, states, route, guidance };
}

/** Una persona que recorre la ruta con su propia velocidad en cada instante (`speedAt(t)` en m/s). Devuelve cuántos SEGUNDOS antes de llegar a cada giro sonó su aviso (el momento de sonar es el de la lectura más lo que se programó). */
function secondsBeforeTurns(
  speedAt: (t: number) => number,
  options: { turnsAt?: number[]; lagMs?: number; noiseM?: number; seed?: number; lateral?: number } = {},
): Array<{ turnAtM: number; seconds: number; cue: NavCue }> {
  const turnsAt = options.turnsAt ?? [400];
  const length = Math.max(...turnsAt) + 200;
  const route = lineRoute(length);
  const steps = [step('depart', 0, 'Sal'), ...turnsAt.map((m, i) => step('turn', m, 'Gira', { turn: i % 2 === 0 ? 'left' : 'right' })), step('arrive', length, 'Has llegado')];
  const cuer = new CapturingCuer();
  const guidance = new Guidance(route, steps, cuer, { nominalSpeedMs: speedAt(0) });
  // El camino real, segundo a segundo, a 100 Hz para saber cuándo se llega a cada punto.
  const truth: number[] = [0];
  for (let i = 1; i <= 60 * 100 * 60; i++) {
    const next = truth[i - 1]! + speedAt((i - 1) / 100) / 100;
    truth.push(next);
    if (next > length + 20) break;
  }
  const timeAt = (m: number): number => truth.findIndex((x) => x >= m) / 100;
  let seed = options.seed ?? 7;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return ((seed / 4294967296) * 2 - 1) * (options.noiseM ?? 0);
  };
  const heard: Array<{ cue: NavCue; soundAtS: number }> = [];
  const lag = options.lagMs ?? 0;
  for (let t = 0; t < truth.length / 100; t += 1) {
    const measuredAt = t; // la lectura se midió en el instante t…
    const arrivesAt = t + lag / 1000; // …y llega a la guía algo más tarde
    const along = truth[Math.round(measuredAt * 100)] ?? length;
    if (along > length) break;
    const before = cuer.cues.length;
    cuer.at = along;
    guidance.update({ ...fixAt(route, Math.max(0, Math.min(length, along + noise())), Math.round(measuredAt * 1000), options.lateral ?? 0, speedAt(measuredAt)), ageMs: lag });
    for (const c of cuer.cues.slice(before)) heard.push({ cue: c.cue, soundAtS: arrivesAt + c.delayMs / 1000 });
  }
  return turnsAt.map((m) => {
    const alert = heard.find((h) => (h.cue.kind === 'turn' || h.cue.kind === 'reverse') && h.soundAtS < timeAt(m) + 0.5 && h.soundAtS > timeAt(m) - 20);
    return { turnAtM: m, seconds: alert ? timeAt(m) - alert.soundAtS : Number.NaN, cue: alert?.cue ?? { kind: 'turn', ear: 'both' } };
  });
}

describe('cuándo avisa y en qué oído', () => {
  it('avisa unos 5 segundos antes del giro, a cualquier velocidad (andando, corriendo, en bici y deprisa en bici)', () => {
    for (const speed of [3, 4, 5, 8]) {
      const [turn] = secondsBeforeTurns(() => speed);
      expect(turn!.seconds, `${speed} m/s`).toBeGreaterThan(4.4);
      expect(turn!.seconds, `${speed} m/s`).toBeLessThan(5.6);
    }
  });

  it('a paso de paseo (1,4 m/s) avisa a 8 m del giro como mínimo, unos 5,7 s antes: más cerca ya sería pasarse el cruce', () => {
    const [turn] = secondsBeforeTurns(() => 1.4);
    expect(turn!.seconds).toBeGreaterThan(5);
    expect(turn!.seconds).toBeLessThan(6.5);
  });

  it('si la persona acelera por el camino, el aviso se adelanta; si frena, se retrasa: siempre ≈ 5 s de marcha real', () => {
    const speeding = secondsBeforeTurns((t) => Math.min(6, 2 + t * 0.12));
    expect(speeding[0]!.seconds).toBeGreaterThan(4);
    expect(speeding[0]!.seconds).toBeLessThan(6);
    const braking = secondsBeforeTurns((t) => Math.max(2.2, 7 - t * 0.12));
    expect(braking[0]!.seconds).toBeGreaterThan(4);
    expect(braking[0]!.seconds).toBeLessThan(6.2);
  });

  it('el GPS llega con retraso (la lectura es de hace 1,5 s): se cuenta lo que se ha avanzado desde entonces y el aviso sigue siendo de ≈ 5 s', () => {
    const [turn] = secondsBeforeTurns(() => 4, { lagMs: 1500 });
    expect(turn!.seconds).toBeGreaterThan(4.3);
    expect(turn!.seconds).toBeLessThan(5.7);
  });

  it('con el GPS bailando 3 m de error el aviso se desvía menos de un segundo y medio', () => {
    for (const seed of [1, 2, 3, 4]) {
      const [turn] = secondsBeforeTurns(() => 3.5, { noiseM: 3, seed });
      expect(Math.abs(turn!.seconds - 5), `semilla ${seed}`).toBeLessThan(1.5);
    }
  });

  it('el aviso se programa entre dos lecturas (delayMs) para sonar en su instante y no en la lectura siguiente', () => {
    const { cuer } = run(4);
    const turn = cuer.cues.find((c) => c.cue.kind === 'turn' && c.cue.ear === 'left')!;
    expect(turn.delayMs).toBeGreaterThan(0);
    expect(turn.delayMs).toBeLessThan(1700);
    expect(turn.interrupt).toBe(false); // lo programado no corta nada que suene
  });

  it('el giro a la izquierda suena en el oído izquierdo y el de la derecha en el derecho, una sola vez cada uno', () => {
    const { cuer } = run(1.4);
    const turns = cuer.cues.filter((c) => c.cue.kind === 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.cue.ear).toBe('left');
    expect(turns[0]!.atM).toBeLessThan(400);
    expect(turns[1]!.cue.ear).toBe('right');
    expect(turns[1]!.atM).toBeGreaterThan(500);
  });

  it('el orden de lo que suena en un recorrido entero (sin avisos de «sigue recto» ni de salida)', () => {
    const { cuer } = run(1.4);
    expect(cuer.described).toEqual(['2 zumbidos cortos, oído izquierdo', '2 zumbidos cortos, oído derecho', 'tres notas limpias que suben, como un timbre: has llegado']);
    expect(cuer.cues.at(-1)!.cue.kind).toBe('arrive');
  });

  it('nada suena dos veces', () => {
    const { cuer } = run(1.4);
    const keys = cuer.cues.map((c) => `${c.cue.kind}|${c.cue.ear}|${Math.round(c.atM / 100)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('corriendo y en bici avisa más lejos del giro porque se recorre más por segundo', () => {
    const metersBefore = (r: ReturnType<typeof run>, speed: number): number => {
      const c = r.cuer.cues.find((x) => x.cue.kind === 'turn' && x.cue.ear === 'left')!;
      return 400 - (c.atM + (c.delayMs / 1000) * speed);
    };
    const walk = metersBefore(run(1.4), 1.4);
    const run3 = metersBefore(run(3, { profile: 'run' }), 3);
    const bike = metersBefore(run(6, { profile: 'bike' }), 6);
    expect(run3).toBeGreaterThan(walk + 4);
    expect(bike).toBeGreaterThan(run3 + 10);
    expect(bike).toBeGreaterThan(26);
  });

  it('parado en un semáforo antes del giro no suena; suena al echar a andar, una sola vez', () => {
    const route = lineRoute(600);
    const steps = [step('depart', 0, 'Sal'), step('turn', 400, 'Gira', { turn: 'left' }), step('arrive', 600, 'Has llegado')];
    const cuer = new CapturingCuer();
    const guidance = new Guidance(route, steps, cuer, { nominalSpeedMs: 1.4 });
    let t = 0;
    for (; t * 1.4 <= 370; t++) guidance.update(fixAt(route, t * 1.4, t * 1000, 0, 1.4));
    const stopAt = 370;
    for (let k = 0; k < 40; k++, t++) guidance.update(fixAt(route, stopAt, t * 1000, 0, 0)); // 40 s parado a 30 m del giro
    expect(cuer.cues.filter((c) => c.cue.kind === 'turn')).toHaveLength(0);
    for (let k = 1; k <= 40; k++, t++) guidance.update(fixAt(route, stopAt + k * 1.4, t * 1000, 0, 1.4));
    expect(cuer.cues.filter((c) => c.cue.kind === 'turn')).toHaveLength(1);
  });

  it('dos giros tan juntos que el segundo caería dentro del aviso del primero suenan en un solo aviso: el primero y, tras una pausa, el segundo en su oído', () => {
    // En bici (6 m/s) 8 m entre giros son 1,3 s: el aviso del segundo pisaría al del primero.
    const steps = [step('depart', 0, 'Camina hacia el este por Calle Mayor'), step('turn', 200, 'Gira a la izquierda en A', { turn: 'left' }), step('turn', 208, 'Gira a la derecha en B', { turn: 'right' }), step('arrive', 500, 'Has llegado a tu destino')];
    const { cuer } = run(6, { steps, length: 500, profile: 'bike' });
    const chained = cuer.cues.find((c) => c.cue.then !== undefined);
    expect(chained).toBeDefined();
    expect(chained!.cue.ear).toBe('left');
    expect(chained!.cue.then!.ear).toBe('right');
    // El segundo no vuelve a avisarse solo: ya sonó dentro del primero.
    expect(cuer.cues.filter((c) => c.cue.kind === 'turn' && c.cue.ear === 'right')).toHaveLength(0);
  });

  it('dos giros a unos segundos uno de otro NO se juntan: cada uno suena en su momento', () => {
    // A 1,4 m/s, 12 m entre giros son 8,5 s: el aviso del segundo llega con tiempo de sobra tras el primero.
    const steps = [step('depart', 0, 'Sal'), step('turn', 200, 'A', { turn: 'left' }), step('turn', 212, 'B', { turn: 'right' }), step('arrive', 500, 'Has llegado')];
    const { cuer } = run(1.4, { steps, length: 500 });
    expect(cuer.cues.filter((c) => c.cue.kind === 'turn' && c.cue.then === undefined)).toHaveLength(2);
  });

  it('dos giros separados lo bastante suenan cada uno en su momento, unos 5 s antes de cada uno', () => {
    const [first, second] = secondsBeforeTurns(() => 3, { turnsAt: [300, 360] });
    expect(first!.seconds).toBeGreaterThan(4.3);
    expect(first!.seconds).toBeLessThan(5.7);
    expect(second!.seconds).toBeGreaterThan(4.3);
    expect(second!.seconds).toBeLessThan(5.7);
  });

  it('seguir recto y la salida no suenan: una bifurcación suave suena como cualquier otro giro, a su lado', () => {
    const steps = [step('depart', 0, 'Camina por X'), step('turn', 300, 'Mantente a la derecha', { turn: 'keep-right' }), step('arrive', 600, 'Has llegado a tu destino')];
    const { cuer } = run(1.4, { steps, length: 600 });
    expect(cuer.described.filter((d) => d.includes('2 zumbidos cortos, oído derecho'))).toHaveLength(1);
    expect(cuer.cues.some((c) => c.cue.ear === 'left')).toBe(false);
  });

  it('silenciada no suena pero sigue calculando', () => {
    const route = lineRoute(900);
    const cuer = new CapturingCuer();
    const guidance = new Guidance(route, STEPS, cuer, { nominalSpeedMs: 1.4, muted: true });
    const state = guidance.update(fixAt(route, 300, 0, 0, 1.4));
    expect(cuer.cues).toHaveLength(0);
    expect(state.nextStep?.text).toBe('Gira a la izquierda en Calle de Génova');
    expect(state.distToNextM).toBeCloseTo(100, 0);
    expect(state.remainingM).toBeCloseTo(600, 0);
  });
});

describe('el estado', () => {
  it('lo que falta, la siguiente instrucción y la llegada', () => {
    const { states } = run(1.4);
    const mid = states[Math.floor(states.length / 2)]!;
    expect(mid.status).toBe('navigating');
    expect(mid.remainingM + mid.progressM).toBeCloseTo(900, 0);
    expect(mid.remainingS).toBeGreaterThan(0);
    expect(states.at(-1)!.status).toBe('arrived');
    expect(states.at(-1)!.remainingM).toBeLessThan(16);
  });

  it('un GPS malo (mucho error) no mueve nada', () => {
    const route = lineRoute(900);
    const guidance = new Guidance(route, STEPS, new CapturingCuer(), { nominalSpeedMs: 1.4 });
    const good = guidance.update(fixAt(route, 100, 0, 0, 1.4));
    const bad = guidance.update(fixAt(route, 700, 1000, 0, 1.4, 150));
    expect(bad).toBe(good);
  });
});

describe('fuera de la ruta', () => {
  it('tras unos segundos fuera pide otra ruta, y la guía no suena por ello (puede ser un atajo: lo del cambio de sentido lo decide el navegador)', () => {
    const route = lineRoute(900);
    const cuer = new CapturingCuer();
    const guidance = new Guidance(route, STEPS, cuer, { nominalSpeedMs: 1.4 });
    let t = 0;
    for (; t < 20; t++) guidance.update(fixAt(route, t * 1.4, t * 1000, 0, 1.4));
    const states = [];
    for (let k = 0; k < 10; k++, t++) states.push(guidance.update(fixAt(route, 30, t * 1000, 45, 1.4)));
    expect(states[0]!.rerouteNeeded).toBe(false); // una lectura suelta no basta
    expect(states.at(-1)!.rerouteNeeded).toBe(true);
    expect(states.at(-1)!.status).toBe('off-route');
    expect(cuer.cues).toHaveLength(0);
  });

  it('muy lejos pide la ruta antes', () => {
    const route = lineRoute(900);
    const guidance = new Guidance(route, STEPS, new CapturingCuer(), { nominalSpeedMs: 1.4 });
    for (let t = 0; t < 10; t++) guidance.update(fixAt(route, t * 1.4, t * 1000, 0, 1.4));
    guidance.update(fixAt(route, 20, 10_000, 200, 1.4));
    expect(guidance.update(fixAt(route, 20, 11_000, 200, 1.4)).rerouteNeeded).toBe(true);
  });

  it('una desviación corta y vuelta a la ruta no pide nada', () => {
    const route = lineRoute(900);
    const guidance = new Guidance(route, STEPS, new CapturingCuer(), { nominalSpeedMs: 1.4 });
    let t = 0;
    for (; t < 10; t++) guidance.update(fixAt(route, t * 1.4, t * 1000, 0, 1.4));
    for (let k = 0; k < 3; k++, t++) expect(guidance.update(fixAt(route, 14 + k, t * 1000, 40, 1.4)).rerouteNeeded).toBe(false);
    for (let k = 0; k < 5; k++, t++) expect(guidance.update(fixAt(route, 20 + k, t * 1000, 0, 1.4)).status).toBe('navigating');
  });

  it('antes de llegar al inicio de la ruta no suena nada y no pide otra', () => {
    const route = lineRoute(900);
    const cuer = new CapturingCuer();
    const guidance = new Guidance(route, STEPS, cuer, { nominalSpeedMs: 1.4 });
    const state = guidance.update(fixAt(route, 0, 0, 60, 1.4));
    expect(state.status).toBe('approaching');
    expect(state.rerouteNeeded).toBe(false);
    expect(cuer.cues).toHaveLength(0);
    // Al ponerse sobre la ruta empieza.
    expect(guidance.update(fixAt(route, 0, 5000, 3, 1.4)).status).toBe('navigating');
  });

  it('se puede estar a medio kilómetro del inicio (un parque sin caminos mapeados) sin pedir otra ruta por ello', () => {
    const route = lineRoute(900);
    const guidance = new Guidance(route, STEPS, new CapturingCuer(), { nominalSpeedMs: 1.4 });
    const state = guidance.update(fixAt(route, 0, 0, 300, 1.4));
    expect(state.status).toBe('approaching');
    expect(state.rerouteNeeded).toBe(false);
  });

  it('una ruta nueva no suena aparte (la equivocación ya sonó) y la guía vuelve a empezar', () => {
    const route = lineRoute(900);
    const cuer = new CapturingCuer();
    const guidance = new Guidance(route, STEPS, cuer, { nominalSpeedMs: 1.4 });
    for (let t = 0; t < 20; t++) guidance.update(fixAt(route, t * 1.4, t * 1000, 0, 1.4));
    const fresh = lineRoute(300);
    const before = cuer.cues.length;
    guidance.replaceRoute(fresh, [step('depart', 0, 'Camina hacia el este por Calle Nueva'), step('arrive', 300, 'Has llegado a tu destino')]);
    expect(cuer.cues).toHaveLength(before);
    const state = guidance.update(fixAt(fresh, 5, 30_000, 0, 1.4));
    expect(state.status).toBe('navigating');
    expect(state.remainingM).toBeCloseTo(295, 0);
  });
});

describe('sin velocidad del GPS', () => {
  it('la saca del avance entre lecturas', () => {
    const route = lineRoute(900);
    const guidance = new Guidance(route, STEPS, new CapturingCuer(), { nominalSpeedMs: 1.4 });
    let state;
    for (let t = 0; t < 30; t++) {
      const fix: Fix = { ...fixAt(route, t * 4, t * 1000, 0, null), speedMs: null };
      state = guidance.update(fix);
    }
    expect(state!.speedMs).toBeGreaterThan(3);
  });
});
