import { beepsFor, vibrationFor, type Beep, type NavCue } from '../../domain/nav/cues';
import type { Cuer } from '../../domain/nav/guidance';

// Los zumbidos del navegador: el audio del propio WebView (Web Audio), sin voz sintética, sin descargar nada y sin permisos. Cada zumbido es un oscilador de sierra (grave y áspero) cuyo
// volumen tiembla muy rápido (unas 38 veces por segundo, como un motor de vibración) con una envolvente corta para que no chasquee, y una panoramización dura: izquierda = solo el
// auricular izquierdo, derecha = solo el derecho, los dos = centro. Con el altavoz del móvil suena igual por los dos lados. Si el móvil puede, además vibra con el mismo ritmo.
// El aviso puede programarse para dentro de unos milisegundos (`delayMs`): el reloj del audio es exacto, así que un giro que llega entre dos lecturas del GPS suena en su momento y no en la lectura siguiente.

export interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}
export interface NodeLike {
  connect(destination: unknown): unknown;
  disconnect?(): void;
}
export interface OscillatorLike extends NodeLike {
  type: string;
  frequency: { value: number };
  onended: (() => void) | null;
  start(time: number): void;
  stop(time: number): void;
}
export interface GainLike extends NodeLike {
  gain: ParamLike;
}
export interface PannerLike extends NodeLike {
  pan: { value: number };
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close?(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  createStereoPanner?(): PannerLike;
  /** Lo que tarda el sonido en salir por el altavoz desde que se programa (s), si el navegador lo dice. */
  readonly outputLatency?: number;
  readonly baseLatency?: number;
}

/** Hace vibrar el móvil con un patrón (ms). Devuelve `false` si no puede. */
export type Vibrator = (pattern: number[]) => boolean;

/** Volumen general de los pitidos (el del móvil manda por encima). */
const MASTER_GAIN = 0.85;
const ATTACK_S = 0.008;
const RELEASE_S = 0.02;
/** Margen para que el primer zumbido no se corte si el audio tarda en arrancar. */
const LEAD_S = 0.04;
/** Lo más que se adelanta un zumbido para compensar lo que tarda el audio en salir (s). */
const MAX_LATENCY_COMP_S = 0.25;

const panOf = (ear: Beep['ear']): number => (ear === 'left' ? -1 : ear === 'right' ? 1 : 0);

export class ToneCuer implements Cuer {
  private readonly playing = new Set<OscillatorLike>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: AudioContextLike,
    private readonly onProblem?: (message: string) => void,
    private readonly vibrate?: Vibrator,
  ) {}

  /** Debe llamarse desde un gesto de la persona (el toque en «Iniciar»): el audio del WebView no arranca solo. */
  unlock(): void {
    try {
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
    } catch {
      /* sin audio no hay nada que despertar */
    }
  }

  /** Cuánto antes hay que programar el sonido para que SALGA en el momento pedido (lo que tarda el audio del móvil en llegar al altavoz). */
  private latencyS(): number {
    const reported = this.ctx.outputLatency ?? this.ctx.baseLatency ?? 0;
    return Number.isFinite(reported) ? Math.min(MAX_LATENCY_COMP_S, Math.max(0, reported)) : 0;
  }

  /** `delayMs`: dentro de cuánto debe sonar (0 = ahora). */
  cue(cue: NavCue, options?: { interrupt?: boolean; delayMs?: number }): void {
    try {
      if (options?.interrupt) this.stop();
      this.unlock();
      const delayS = Math.max(0, (options?.delayMs ?? 0) / 1000);
      const start = this.ctx.currentTime + Math.max(LEAD_S, delayS - this.latencyS());
      for (const beep of beepsFor(cue)) this.beep(beep, start);
      this.shake(cue, delayS);
    } catch {
      this.onProblem?.('El móvil no puede reproducir los avisos sonoros ahora: la guía seguirá solo en pantalla.');
    }
  }

  /** La vibración del móvil, con el mismo ritmo. Mejor esfuerzo: si el móvil no deja vibrar, el sonido va solo. */
  private shake(cue: NavCue, delayS: number): void {
    if (!this.vibrate) return;
    const pattern = vibrationFor(cue);
    const go = (): void => {
      try {
        this.vibrate?.(pattern);
      } catch {
        /* el móvil no deja vibrar */
      }
    };
    if (delayS <= 0.05) {
      go();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      go();
    }, Math.max(0, delayS * 1000 - this.latencyS() * 1000));
    this.timers.add(timer);
  }

  private beep(beep: Beep, base: number): void {
    const ctx = this.ctx;
    const at = base + beep.atMs / 1000;
    const end = at + beep.durMs / 1000;
    const osc = ctx.createOscillator();
    osc.type = beep.wave;
    osc.frequency.value = beep.hz;
    const gain = ctx.createGain();
    const peak = Math.min(1, beep.gain * MASTER_GAIN);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + ATTACK_S);
    // El temblor: el volumen sube y baja a `buzzHz` veces por segundo (entre el máximo y el máximo menos la profundidad), que es lo que hace que suene a zumbido y no a pitido.
    if (beep.buzzHz > 0 && beep.buzzDepth > 0) {
      const half = 1 / (2 * beep.buzzHz);
      const low = peak * (1 - Math.min(1, beep.buzzDepth));
      let dipping = true;
      for (let time = at + ATTACK_S + half; time < end - RELEASE_S - half / 2; time += half) {
        gain.gain.linearRampToValueAtTime(dipping ? low : peak, time);
        dipping = !dipping;
      }
      gain.gain.linearRampToValueAtTime(peak, Math.max(at + ATTACK_S, end - RELEASE_S));
    } else {
      gain.gain.setValueAtTime(peak, Math.max(at + ATTACK_S, end - RELEASE_S));
    }
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain);
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = panOf(beep.ear);
      gain.connect(panner);
      panner.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    osc.onended = () => {
      this.playing.delete(osc);
      try {
        osc.disconnect?.();
      } catch {
        /* ya estaba suelto */
      }
    };
    this.playing.add(osc);
    osc.start(at);
    osc.stop(end + 0.01);
  }

  /** Corta lo que aún suena (y lo que estaba programado para sonar). */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const osc of this.playing) {
      try {
        osc.stop(this.ctx.currentTime);
      } catch {
        /* ya había parado */
      }
    }
    this.playing.clear();
  }

  /** Suelta el audio del WebView (al terminar la navegación). */
  close(): void {
    this.stop();
    void this.ctx.close?.().catch(() => undefined);
  }
}

type AudioWindow = { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike; navigator?: { vibrate?: (pattern: number[]) => boolean } };

/** La vibración del WebView, si la tiene (necesita que la persona haya tocado la pantalla antes: el toque en «Iniciar» lo cumple). */
function vibratorOf(win: AudioWindow | undefined): Vibrator | undefined {
  const nav = win?.navigator;
  if (!nav || typeof nav.vibrate !== 'function') return undefined;
  return (pattern) => nav.vibrate!.call(nav, pattern);
}

/** ¿Puede este WebView reproducir tonos? */
export function tonesAvailable(win: AudioWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as AudioWindow)): boolean {
  return !!win && (typeof win.AudioContext === 'function' || typeof win.webkitAudioContext === 'function');
}

/** Los tonos del WebView actual, o `null` si no puede reproducirlos. Llamarlo desde un gesto de la persona. */
export function createToneCuer(onProblem?: (message: string) => void, win: AudioWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as AudioWindow)): ToneCuer | null {
  const Ctor = win?.AudioContext ?? win?.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    const cuer = new ToneCuer(new Ctor(), onProblem, vibratorOf(win));
    cuer.unlock();
    return cuer;
  } catch {
    return null;
  }
}
