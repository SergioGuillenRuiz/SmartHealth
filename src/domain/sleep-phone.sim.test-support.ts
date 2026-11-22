import { mergeSpans, type PhoneActivity, type PhoneSpan } from './phone-activity';
import { rng, simulateLife, type Archetype, type SimLife, type SimOptions } from './sleep-offring.sim.test-support';

// Lo que hace el MÓVIL de una persona que deja el anillo de noche, para medir `sleep-phone.ts`. Parte de la vida de `sleep-offring.sim.test-support.ts` (sus noches de verdad, los pasos del
// anillo de día, lo anotado y las sincronizaciones) y le añade el uso del móvil: sesiones de pantalla de día y de tarde, el rato en la cama (hay quien se duerme con el móvil en la mano y
// quien lo deja un rato antes), mirarlo de madrugada, la alarma de la mañana y las noches con el móvil apagado. Con semilla fija. Solo para pruebas.

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface PhoneSimOptions extends SimOptions {
  /** Probabilidad de usar el móvil en la cama hasta dormirse (si no, lo deja de 2 a 40 min antes). */
  inBed?: number;
  /** Veces, de media, que lo mira de madrugada (a la mitad se queda un rato más). */
  nightChecks?: number;
  /** Fracción de noches con el móvil apagado (no hay registro de ellas). */
  phoneOff?: number;
  /** Sesiones por hora de día despierta. */
  rate?: number;
  /** Fracción de noches en que se pasa un buen rato (30–90 min) con el móvil de madrugada. */
  scrollNight?: number;
  /** Fracción de mañanas con alarma (la pantalla se enciende al despertar). */
  alarm?: number;
}

export interface PhoneLife extends SimLife {
  phone: PhoneActivity;
}

export function simulatePhoneLife(arch: Archetype, days: number, seed: number, options: PhoneSimOptions = {}): PhoneLife {
  const life = simulateLife(arch, days, seed, options);
  const random = rng(seed * 7919 + 13);
  const between = (lo: number, hi: number): number => lo + random() * (hi - lo);
  const normal = (): number => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += random();
    return (sum - 3) * Math.SQRT2;
  };
  const rate = options.rate ?? 4;
  const uses: PhoneSpan[] = [];
  const offGaps: PhoneSpan[] = [];

  const session = (startMs: number, long = false): PhoneSpan => {
    const minutes = long ? between(15, 60) : Math.min(12, Math.max(0.3, Math.exp(normal() * 0.8) * 1.2));
    return { startMs, endMs: startMs + minutes * MIN };
  };
  const dayStart = new Date(2026, 5, 1, 0, 0, 0, 0).getTime();
  let previousWake = dayStart + 7 * HOUR;
  life.nights.forEach((night, d) => {
    const bed = night.startMs;
    const wake = night.endMs;
    const off = random() < (options.phoneOff ?? 0.05);
    // El día hasta acostarse: la primera vez que lo coge tras despertar (con alarma, al despertar; si no, un rato después) y sesiones sueltas.
    const alarm = random() < (options.alarm ?? 0.55);
    // La última vez que lo usa: se duerme con él (la pantalla se apaga sola un minuto después) o lo deja antes.
    const inBed = random() < (options.inBed ?? 0.5);
    const lastEnd = inBed ? bed + between(0.5, 3) * MIN : bed - between(2, 40) * MIN;
    let t = previousWake + (alarm ? between(-2, 8) * MIN : random() < 0.4 ? between(0, 3) * MIN : between(3, 25) * MIN);
    while (t < lastEnd - 1 * MIN) {
      const s = session(t, random() < 0.03);
      if (s.startMs < lastEnd) uses.push({ startMs: s.startMs, endMs: Math.min(s.endMs, Math.max(s.startMs + 20_000, lastEnd)) });
      const hourOfDay = new Date(t).getHours();
      const perHour = hourOfDay >= 19 ? rate * 1.5 : rate;
      t = Math.max(s.endMs, t) + (-Math.log(Math.max(1e-6, random())) / perHour) * HOUR;
    }
    // Un último rato, el de acostarse.
    uses.push({ startMs: lastEnd - between(0.5, 12) * MIN, endMs: lastEnd });
    // De madrugada.
    const checks = poisson(random, options.nightChecks ?? 0.6);
    for (let i = 0; i < checks; i++) {
      const at = between(bed + 60 * MIN, Math.max(bed + 61 * MIN, wake - 45 * MIN));
      uses.push(session(at, random() < 0.5));
    }
    if (random() < (options.scrollNight ?? 0)) uses.push(session(between(bed + 90 * MIN, Math.max(bed + 91 * MIN, wake - 90 * MIN)), true));
    // El móvil apagado: ni uso ni registro.
    if (off) {
      const from = bed - 20 * MIN;
      const to = wake + between(0, 60) * MIN;
      offGaps.push({ startMs: from, endMs: to });
    }
    void d;
    previousWake = wake;
  });
  const endMs = life.endMs;
  let coverage: PhoneSpan[] = [{ startMs: dayStart, endMs }];
  for (const gap of offGaps) coverage = coverage.flatMap((c) => (gap.endMs <= c.startMs || gap.startMs >= c.endMs ? [c] : [{ startMs: c.startMs, endMs: Math.max(c.startMs, gap.startMs) }, { startMs: Math.min(c.endMs, gap.endMs), endMs: c.endMs }].filter((x) => x.endMs > x.startMs)));
  const kept = uses.filter((u) => !offGaps.some((g) => u.startMs < g.endMs && u.endMs > g.startMs));
  return { ...life, phone: { uses: mergeSpans(kept, 60_000), coverage } };
}

function poisson(random: () => number, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= random();
  } while (p > limit);
  return k - 1;
}
