export interface GpsFix {
  lat: number;
  lon: number;
  /** Radio de error horizontal (m). */
  accuracyM: number;
  tsMs: number;
  /**
   * Velocidad que mide el propio GPS por efecto Doppler (m/s). Es mucho más fiable que derivarla de las posiciones:
   * `null` o ausente si el dispositivo no la da.
   */
  speedMs?: number | null;
  /** Presión del barómetro (hPa) cuando se midió la posición, si el móvil la dio: el desnivel de un paseo sale de ella. */
  pressureHpa?: number | null;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Distancia sobre la esfera entre dos puntos (fórmula del haversine), en metros. */
export function haversineM(a: Pick<GpsFix, 'lat' | 'lon'>, b: Pick<GpsFix, 'lat' | 'lon'>): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GpsOptions {
  /** Se descartan lecturas peores que esto. */
  maxAccuracyM?: number;
  /** Velocidad máxima creíble: por encima es un salto del GPS, no movimiento (m/s). */
  maxSpeedMs?: number;
  /** Desplazamiento mínimo para sumar: el GPS "tiembla" aunque estés quieto. */
  minStepM?: number;
  /** Por debajo de esta velocidad Doppler se está parado: no se suma nada (m/s). */
  stillSpeedMs?: number;
  /** Entre dos lecturas más separadas que esto no se integra la velocidad: no se sabe qué pasó en medio (s). */
  maxSpeedGapS?: number;
  /** Aceleración máxima creíble de la velocidad del GPS (m/s²): una lectura que la supera es un glitch del chip. */
  maxAccelerationMs2?: number;
}

/**
 * Parado según la velocidad del GPS, pero con las posiciones alejándose más que esto durante al menos este tiempo: la
 * velocidad no es de fiar (un dispositivo que da siempre 0). Es un umbral ALTO a propósito: con el GPS flojo de ciudad las
 * posiciones de alguien parado vagan decenas de metros y no deben confundirse con andar; lo que se busca es un recorrido
 * de verdad que la velocidad no ve.
 */
const STUCK_SPEED_DISTANCE_M = 100;
const STUCK_SPEED_AFTER_S = 30;

/**
 * Sin velocidad, un desplazamiento solo se suma si supera esto por la precisión de la lectura. El GPS de ciudad «vaga» decenas de
 * metros y sumar paso a paso ese vagar inflaba un paseo hasta un 30 % (y 600 m «recorridos» parado diez minutos); a 2,5 veces la
 * precisión el error de un paseo, una carrera o la bici queda en ±2 % y parado no se suma nada que importe.
 */
const STEP_GATE_ACCURACY = 2.5;
/**
 * Un salto de posición es imposible si supera lo que se puede avanzar a la velocidad máxima del deporte más el margen de la
 * propia imprecisión de las dos lecturas (con una lectura por segundo, el ruido normal de ciudad es de unos metros).
 */
const JUMP_ACCURACY_SLACK = 1.5;
/**
 * La velocidad del GPS no cambia de golpe: nadie pasa de 1 a 9 m/s en un segundo. Una lectura cuya velocidad se aparta de la anterior
 * más de lo que permite la aceleración del deporte (andar ~2 m/s², correr 4, bici 5; con un margen fijo) es un glitch del chip y
 * se descarta; la siguiente integra el tiempo que dejó. Sin esto, un pico suelto de velocidad suma metros que no se anduvieron.
 */
const DEFAULT_MAX_ACCELERATION_MS2 = 5;
const SPEED_JUMP_SLACK_MS = 1;
/**
 * Mientras aún no se ha avanzado nada, una lectura ESTO veces más precisa que el punto de referencia lo sustituye sin sumar el salto
 * entre ambos (si cae dentro del ruido): al arrancar, las primeras lecturas (de red, o de un GPS que aún no ha fijado) son malas y
 * se corrigen solas, y esa corrección no es andar.
 */
const BETTER_ANCHOR_RATIO = 2;
/**
 * Sin velocidad, el vagar de un GPS flojo parado acaba superando la puerta de desplazamiento, pero despacio: decenas de metros en
 * minutos. Andar de verdad la supera en segundos. Un desplazamiento que se ha tardado en recorrer más de lo que tarda andar muy
 * despacio (por debajo de esta velocidad media) no se suma.
 */
const MIN_CHORD_SPEED_MS = 0.4;

/** Una velocidad Doppler utilizable: un número finito, no negativo y creíble. */
function usableSpeed(speedMs: number | null | undefined, maxSpeedMs: number): number | null {
  return typeof speedMs === 'number' && Number.isFinite(speedMs) && speedMs >= 0 && speedMs <= maxSpeedMs ? speedMs : null;
}

/**
 * Acumula la distancia de un recorrido filtrando el ruido típico del GPS del móvil: fijaciones imprecisas,
 * saltos imposibles y el temblor en reposo (que, sumado, infla la distancia de forma notable).
 *
 * La distancia sale de la VELOCIDAD que mide el GPS (efecto Doppler) integrada en el tiempo cuando el dispositivo la da:
 * no depende del ruido de las posiciones, que sumado paso a paso la infla (un paseo con GPS flojo de ciudad salía hasta
 * un 40 % más largo, y parado 10 minutos «recorría» más de 300 m) y que se queda corto en las curvas. Sin velocidad,
 * o si resulta no ser de fiar, se suman las cuerdas entre posiciones con la puerta anti-temblor.
 */
export class GpsTracker {
  distanceM = 0;
  accepted = 0;
  rejected = 0;
  /**
   * `true` si la última lectura era válida (aunque no sumara distancia: estar parado también es una lectura), `false` si se
   * descartó (mala precisión, un salto imposible, una hora repetida). Distingue «parado» de «sin señal».
   */
  lastReadingValid = false;
  private last: GpsFix | null = null;
  private lastSpeed: number | null = null;
  /** Cuándo llegó la última lectura válida (no el punto de referencia, que sin velocidad puede quedarse atrás): da los huecos. */
  private lastFixMs: number | null = null;
  /** Lo último que se sumó de golpe por haber visto que la velocidad no era de fiar (ver `takeRetroactive`). */
  private retroactive: { fromMs: number; meters: number } | null = null;
  /** Dónde empezó el tramo «parado» que dice la velocidad, para comprobar que de verdad no se avanzó. */
  private stillSince: GpsFix | null = null;
  private speedUnreliable = false;
  /** Si ya se ha avanzado algo desde que empezó el tramo: hasta entonces el punto de referencia es el de arranque (ver `BETTER_ANCHOR_RATIO`). */
  private moved = false;
  /** Una lectura con la hora muy anterior a la del punto de referencia, a la espera de que otra la confirme (ver `confirmsEarlierClock`). */
  private earlier: GpsFix | null = null;
  private readonly maxAccuracyM: number;
  private readonly maxSpeedMs: number;
  private readonly minStepM: number;
  private readonly stillSpeedMs: number;
  private readonly maxSpeedGapS: number;
  private readonly maxAccelerationMs2: number;

  constructor(options: GpsOptions = {}) {
    this.maxAccelerationMs2 = options.maxAccelerationMs2 ?? DEFAULT_MAX_ACCELERATION_MS2;
    this.maxAccuracyM = options.maxAccuracyM ?? 30;
    this.maxSpeedMs = options.maxSpeedMs ?? 15;
    this.minStepM = options.minStepM ?? 5;
    this.stillSpeedMs = options.stillSpeedMs ?? 0.7;
    this.maxSpeedGapS = options.maxSpeedGapS ?? 10;
  }

  /** Devuelve `true` si la lectura se usó. */
  add(fix: GpsFix): boolean {
    this.lastReadingValid = false;
    if (!(fix.accuracyM <= this.maxAccuracyM) || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) {
      this.rejected++;
      return false;
    }
    const speed = this.speedUnreliable ? null : usableSpeed(fix.speedMs, this.maxSpeedMs);
    if (!this.last) {
      this.last = fix;
      this.lastSpeed = speed;
      this.lastFixMs = fix.tsMs;
      this.moved = false;
      this.accepted++;
      this.lastReadingValid = true;
      return true;
    }
    const dt = (fix.tsMs - this.last.tsMs) / 1000;
    if (dt <= 0) {
      // Duplicada o desordenada: se descarta. Una hora MUY anterior a la del punto de referencia es otra cosa: o una lectura vieja
      // que llega tarde (que también se descarta) o el punto de referencia llevaba la hora mal (una lectura con la hora adelantada,
      // un cambio en la base de tiempo del GPS) y todas las siguientes parecen del pasado: descartarlo todo hasta que el reloj la
      // alcance dejaría el GPS muerto. Dos lecturas seguidas con la hora creciendo lo confirman y se empieza un tramo nuevo.
      if (dt < -this.maxSpeedGapS && this.confirmsEarlierClock(fix)) {
        this.breakSegment();
        return this.add(fix);
      }
      this.rejected++;
      return false;
    }
    this.earlier = null;
    const d = haversineM(this.last, fix);
    if (d > this.maxSpeedMs * dt + JUMP_ACCURACY_SLACK * (fix.accuracyM + this.last.accuracyM)) {
      this.rejected++;
      return false;
    }
    if (speed !== null && this.lastSpeed !== null && Math.abs(speed - this.lastSpeed) > this.maxAccelerationMs2 * dt + SPEED_JUMP_SLACK_MS) {
      this.rejected++;
      return false;
    }

    // Una lectura válida tras un hueco largo (túnel, pantalla apagada): el punto de referencia es de antes del hueco.
    const resumed = this.lastFixMs !== null && (fix.tsMs - this.lastFixMs) / 1000 > this.maxSpeedGapS;
    this.lastFixMs = fix.tsMs;

    if (speed !== null && this.lastSpeed !== null && dt <= this.maxSpeedGapS) {
      // Velocidad media entre las dos lecturas × tiempo. Solo se está parado si LAS DOS están por debajo del umbral: con el ruido
      // de la velocidad, andar despacio (0,8 m/s) tiene a menudo una de las dos por debajo, y contarla como 0 recortaba hasta un 30 %.
      const still = this.lastSpeed < this.stillSpeedMs && speed < this.stillSpeedMs;
      if (!still) {
        this.distanceM += 0.5 * (this.lastSpeed + speed) * dt;
        this.moved = true;
      }
      this.checkSpeedIsTrusted(fix, still);
      this.last = fix;
      this.lastSpeed = speed;
      this.accepted++;
      this.lastReadingValid = true;
      return true;
    }

    // Sin velocidad utilizable: cuerdas entre posiciones. Por debajo de la puerta no se avanza ni se mueve el punto de
    // referencia: así el temblor no se acumula. Tras un hueco, en cambio, el punto de referencia se renueva aunque no se sume
    // nada: el de antes del hueco ya no sirve para medir lo que viene (y el tiempo que lleva ahí no es de andar despacio).
    this.lastReadingValid = true;
    // La puerta mira la peor de las dos lecturas: el desplazamiento entre una mala y una buena es sobre todo error de la mala.
    if (d < Math.max(this.minStepM, Math.max(fix.accuracyM, this.last.accuracyM) * STEP_GATE_ACCURACY)) {
      // Dentro del ruido no se suma. El punto de referencia se renueva al volver de un hueco y, mientras aún no se ha avanzado nada
      // (el arranque, con una lectura de red o de un GPS que aún no ha fijado), cuando llega una lectura mucho más precisa: lo que
      // se corrige no es lo que se anduvo. Una vez en marcha no: renovarlo cada vez que mejora la precisión tiraría lo andado desde
      // el último punto, y con la precisión cambiando por tramos recortaría varios por ciento.
      if (resumed || (!this.moved && fix.accuracyM * BETTER_ANCHOR_RATIO <= this.last.accuracyM)) this.reanchor(fix, speed);
      return false;
    }
    if (!resumed && d / dt < MIN_CHORD_SPEED_MS) return false;
    this.distanceM += d;
    this.moved = true;
    this.reanchor(fix, speed);
    this.accepted++;
    return true;
  }

  /**
   * Una lectura con la hora muy anterior a la del punto de referencia: se guarda y confirma la nueva hora la siguiente, si llega
   * después de ella y sin hueco. Una lectura vieja suelta (la posición y la hora de hace un minuto) no la confirma nadie.
   */
  private confirmsEarlierClock(fix: GpsFix): boolean {
    const before = this.earlier;
    this.earlier = fix;
    return before !== null && fix.tsMs > before.tsMs && (fix.tsMs - before.tsMs) / 1000 <= this.maxSpeedGapS;
  }

  private reanchor(fix: GpsFix, speed: number | null): void {
    this.last = fix;
    this.lastSpeed = speed;
    this.stillSince = null;
  }

  /**
   * Una velocidad que dice «parado» mientras las posiciones avanzan decenas de metros no es de fiar (un dispositivo que
   * da siempre 0): se recoge lo avanzado y se pasa a las posiciones para el resto del recorrido.
   */
  private checkSpeedIsTrusted(fix: GpsFix, still: boolean): void {
    if (!still) {
      this.stillSince = null;
      return;
    }
    this.stillSince ??= fix;
    const anchor = this.stillSince;
    if ((fix.tsMs - anchor.tsMs) / 1000 < STUCK_SPEED_AFTER_S) return;
    const away = haversineM(anchor, fix);
    if (away > Math.max(STUCK_SPEED_DISTANCE_M, fix.accuracyM * 6)) {
      this.distanceM += away;
      this.retroactive = { fromMs: anchor.tsMs, meters: away };
      this.speedUnreliable = true;
      this.stillSince = null;
    }
  }

  /**
   * Cuando se descubre que la velocidad no era de fiar, lo avanzado desde que empezó el tramo «parado» se suma de golpe: esto
   * dice desde cuándo y cuántos metros, para que quien reparte la distancia por minutos lo ponga donde ocurrió. Se vacía al leerlo.
   */
  takeRetroactive(): { fromMs: number; meters: number } | null {
    const retroactive = this.retroactive;
    this.retroactive = null;
    return retroactive;
  }

  /** Calidad actual de la señal para mostrarla al usuario. */
  quality(nowMs: number): 'none' | 'poor' | 'good' {
    if (!this.last || nowMs - this.last.tsMs > 20_000) return 'none';
    return this.last.accuracyM <= 15 ? 'good' : 'poor';
  }

  /** Corta el tramo: la siguiente lectura no se une con la anterior (tras una pausa, el usuario pudo moverse). */
  breakSegment(): void {
    this.last = null;
    this.lastSpeed = null;
    this.lastFixMs = null;
    this.stillSince = null;
    this.moved = false;
    this.earlier = null;
    // Tras una pausa se da otra oportunidad a la velocidad del GPS: si de verdad no es de fiar, volverá a verse.
    this.speedUnreliable = false;
  }

  reset(): void {
    this.distanceM = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.retroactive = null;
    this.last = null;
    this.lastSpeed = null;
    this.lastFixMs = null;
    this.stillSince = null;
    this.moved = false;
    this.earlier = null;
    this.speedUnreliable = false;
    this.lastReadingValid = false;
  }
}
