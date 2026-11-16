// ¿Está al día una posición del GPS? La hora de la posición (`tsMs`) es la del GPS y la de llegada (`receivedMs`), la del móvil: si el reloj del móvil va adelantado o atrasado más de unos segundos
// (hora puesta a mano, un fallo de la red), TODAS las posiciones parecerían viejas y la guía callaría los giros para siempre. Lo que de verdad delata una posición atrasada no es esa diferencia, sino que
// CAMBIE: en un lote atrasado cada posición se midió un segundo o más después de la anterior y llegó a la vez, así que la diferencia se encoge de golpe a cada una; en una corriente normal casi no se
// mueve. Por eso, si la diferencia lleva tres posiciones seguidas sin moverse más de unas décimas (llegan a su ritmo, sea el que sea), se toma por el desfase de los dos relojes y se descuenta; mientras
// no se sabe, se mide tal cual.

export interface FixAge {
  /** Se midió hace más de `staleMs` (descontado el desfase de los relojes): historia, no debe hacer sonar nada. */
  stale: boolean;
  /** Cuánto hace de la medida, entre 0 y 3 s: lo que la persona ha avanzado desde entonces. */
  ageMs: number;
}

/** Una diferencia mayor que esta entre los dos relojes se toma por desfase (por debajo es el retraso normal de entrega y no se descuenta). */
const SKEW_MIN_MS = 2000;
/** Entre dos posiciones seguidas, la diferencia puede variar hasta esto y seguir contando como «la misma» (el retraso de entrega baila unas décimas; un lote atrasado la encoge un segundo o más a cada posición). */
const STEADY_TOLERANCE_MS = 400;
const STEADY_RUN = 3;

export interface FixClock {
  observe(tsMs: number, receivedMs: number): FixAge;
  reset(): void;
}

export function createFixClock(staleMs: number): FixClock {
  let skewMs = 0;
  let lastDiff: number | null = null;
  let run = 0;
  return {
    observe(tsMs, receivedMs) {
      const diff = receivedMs - tsMs;
      if (lastDiff !== null && Math.abs(diff - lastDiff) <= STEADY_TOLERANCE_MS) run++;
      else run = 0;
      // El desfase solo se fija con una diferencia que se mantiene: un lote atrasado (muchas posiciones de golpe) o una sola posición vieja nunca lo cambian.
      if (run >= STEADY_RUN) skewMs = Math.abs(diff) > SKEW_MIN_MS ? diff : 0;
      lastDiff = diff;
      const age = diff - skewMs;
      return { stale: age > staleMs, ageMs: Math.min(3000, Math.max(0, age)) };
    },
    reset() {
      skewMs = 0;
      lastDiff = null;
      run = 0;
    },
  };
}
