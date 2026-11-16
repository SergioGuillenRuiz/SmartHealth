import type { Step } from './maneuvers';

// Los avisos de la navegación son solo TRES, para que cualquiera los entienda sin aprender un código (ronda 45; antes eran nueve combinaciones):
//  1. GIRAR (a un lado, otro, en una rotonda…): dos zumbidos cortos. Con auriculares suenan en el oído del lado del giro; en una rotonda, en los dos. Siempre es el mismo sonido.
//  2. CAMBIO DE SENTIDO o EQUIVOCACIÓN (te has salido de la ruta, o hay que dar la vuelta): un zumbido largo y grave en los dos oídos. Es el mismo en los dos casos.
//  3. FINAL DE LA RUTA: tres notas limpias que suben, como un timbre, muy distintas de los zumbidos (no tienen nada de áspero), un poco más fuertes y más largas.
// No suena nada más: ni «seguir recto», ni escaleras, ni al empezar ni al calcular una ruta nueva. Los zumbidos son graves y ásperos, como un móvil vibrando, y se oyen (y se notan, si el móvil
// vibra) aunque haya ruido o lleves el móvil en el bolsillo. Es lógica pura: aquí se decide QUÉ suena y cómo es cada sonido; `app/nav/tones.ts` lo toca con el audio del móvil (y lo hace vibrar)
// y `guidance.ts` decide CUÁNDO (unos 5 segundos antes del giro, según la velocidad).

export type Ear = 'left' | 'right' | 'both';
/** `turn`: girar. `reverse`: cambio de sentido o equivocación. `arrive`: final de la ruta. */
export type CueKind = 'turn' | 'reverse' | 'arrive';

export interface NavCue {
  kind: CueKind;
  ear: Ear;
  /** Una maniobra tan pegada a esta que se avisa a continuación, en su oído. */
  then?: NavCue;
}

export interface Beep {
  /** Cuándo empieza, desde el inicio del aviso (ms). */
  atMs: number;
  durMs: number;
  /** El tono de fondo del zumbido (Hz). */
  hz: number;
  ear: Ear;
  /** Volumen relativo, de 0 a 1. */
  gain: number;
  wave: 'sine' | 'square' | 'triangle' | 'sawtooth';
  /** El temblor del volumen que lo hace «zumbar» (veces por segundo) y lo que baja el volumen en cada temblor (0 = sin temblor, 1 = hasta el silencio). */
  buzzHz: number;
  buzzDepth: number;
}

/** Qué aviso corresponde a una instrucción, o `null` si no suena nada (seguir recto, salir, escaleras). */
export function cueForStep(step: Step): NavCue | null {
  if (step.type === 'arrive') return { kind: 'arrive', ear: 'both' };
  // Una rotonda es un giro sin lado: el mismo sonido en los dos oídos.
  if (step.type === 'roundabout') return { kind: 'turn', ear: 'both' };
  if (step.type !== 'turn') return null;
  switch (step.turn) {
    case 'left':
    case 'sharp-left':
    case 'slight-left':
    case 'keep-left':
      return { kind: 'turn', ear: 'left' };
    case 'right':
    case 'sharp-right':
    case 'slight-right':
    case 'keep-right':
      return { kind: 'turn', ear: 'right' };
    case 'uturn':
      return { kind: 'reverse', ear: 'both' };
    default:
      return null;
  }
}

/** Cómo suena un zumbido: sierra (rica en armónicos, así se oye en el altavoz de un móvil) con un temblor rápido y profundo del volumen. */
const BUZZ = { hz: 190, durMs: 260, gapMs: 130, gain: 1, buzzHz: 38, buzzDepth: 0.85, wave: 'sawtooth' } as const;
/** Entre el final de un aviso y el del giro que viene pegado. */
const THEN_GAP_MS = 450;

/** Una fila de zumbidos iguales. */
function row(count: number, ear: Ear, overrides: Partial<Pick<Beep, 'hz' | 'durMs' | 'gain'>> & { gapMs?: number } = {}): Beep[] {
  const durMs = overrides.durMs ?? BUZZ.durMs;
  const gapMs = overrides.gapMs ?? BUZZ.gapMs;
  return Array.from({ length: count }, (_, i) => ({ atMs: i * (durMs + gapMs), durMs, hz: overrides.hz ?? BUZZ.hz, ear, gain: overrides.gain ?? BUZZ.gain, wave: BUZZ.wave, buzzHz: BUZZ.buzzHz, buzzDepth: BUZZ.buzzDepth }));
}

/** El timbre del final de la ruta: tres notas limpias (onda seno, sin temblor) que suben, en los dos oídos. Nada que ver con un zumbido. */
function chime(): Beep[] {
  return [660, 880, 1175].map((hz, i) => ({ atMs: i * 330, durMs: i === 2 ? 700 : 300, hz, ear: 'both' as const, gain: 1, wave: 'sine' as const, buzzHz: 0, buzzDepth: 0 }));
}

/** Lo que suena en un aviso, zumbido a zumbido. */
export function beepsFor(cue: NavCue): Beep[] {
  let beeps: Beep[];
  switch (cue.kind) {
    case 'turn':
      beeps = row(2, cue.ear);
      break;
    case 'reverse':
      beeps = row(1, 'both', { durMs: 900, hz: 120 });
      break;
    case 'arrive':
      beeps = chime();
      break;
  }
  if (cue.then) {
    // Un solo aviso pegado: tras el primero, con una pausa, el del siguiente giro en su oído.
    const { then: _ignored, ...next } = cue.then;
    const after = Math.max(0, ...beeps.map((b) => b.atMs + b.durMs)) + THEN_GAP_MS;
    beeps = [...beeps, ...beepsFor(next).map((b) => ({ ...b, atMs: b.atMs + after }))];
  }
  return beeps;
}

/** Cuánto dura un aviso entero (ms). */
export const cueDurationMs = (cue: NavCue): number => Math.max(0, ...beepsFor(cue).map((b) => b.atMs + b.durMs));

/** El patrón de vibración del móvil para un aviso (en ms: vibra, para, vibra…; empieza vibrando), con el mismo ritmo que los zumbidos. */
export function vibrationFor(cue: NavCue): number[] {
  const pattern: number[] = [];
  let cursor = 0;
  for (const beep of beepsFor(cue)) {
    if (pattern.length > 0) pattern.push(Math.max(0, beep.atMs - cursor));
    pattern.push(beep.durMs);
    cursor = beep.atMs + beep.durMs;
  }
  return pattern;
}

/** El aviso dicho con palabras (para pruebas, el registro y las etiquetas de accesibilidad). */
export function describeCue(cue: NavCue): string {
  const ear = cue.ear === 'left' ? 'izquierdo' : cue.ear === 'right' ? 'derecho' : 'los dos oídos';
  switch (cue.kind) {
    case 'turn':
      return `2 zumbidos cortos, oído ${ear}`;
    case 'reverse':
      return 'un zumbido largo y grave, los dos oídos: cambio de sentido o equivocación';
    case 'arrive':
      return 'tres notas limpias que suben, como un timbre: has llegado';
  }
}
