/**
 * Qué pasó con el GPS y el pulso mientras la pantalla estuvo apagada (o la app oculta) en un entreno.
 *
 * Cuatro rondas intentaron arreglar «con la pantalla apagada no funciona ni el GPS ni el pulso» sin poder ver qué hacía el móvil: el
 * entreno corre en un WebView y un servicio nativo, y cualquiera de los dos puede quedar parado, o el sistema entero haber cerrado la
 * app, sin que nada lo contara. Esto lo cuenta: al volver a verse la app, compara lo que se recibió con lo que tocaba y, si falta
 * algo, lo dice con palabras y con las cifras que explican por qué (para una captura de pantalla). Es una función pura: no toca nada.
 */

/** Lo que dice el servicio nativo de cómo está el móvil (lo trae `TrackerState`; lo que el móvil no sabe contestar, ausente). */
export interface ServiceFacts {
  /** El servicio del entreno estaba vivo al volver. */
  running: boolean;
  /** Android no restringe la app en segundo plano (la exención del ahorro de batería). */
  batteryExempt: boolean;
  /** El ahorro de batería de Android estaba activado. */
  powerSave?: boolean;
  /** Android estaba en reposo profundo (Doze). */
  idle?: boolean;
  /** Android tiene la app «restringida» en segundo plano. */
  bgRestricted?: boolean;
  /** El permiso de ubicación es «Permitir siempre» (y no solo «con la app abierta»). */
  bgLocation?: boolean;
  /** Xiaomi/Redmi/Poco: el «Inicio automático» de la app está activado. */
  autostart?: boolean;
  /** Cubo de uso de Android (5 exenta, 10 activa, 20 de trabajo, 30 frecuente, 40 rara, 45 restringida). */
  bucket?: number;
}

/** Lo que el servicio nativo cuenta de cómo está el móvil, como `ServiceFacts` (lo ausente sigue ausente). */
export function serviceFactsOf(state: {
  running: boolean;
  batteryExempt: boolean;
  powerSave?: boolean;
  idle?: boolean;
  bgRestricted?: boolean;
  bgLocation?: boolean;
  autostart?: boolean;
  bucket?: number;
}): ServiceFacts {
  return {
    running: state.running,
    batteryExempt: state.batteryExempt,
    ...(state.powerSave !== undefined ? { powerSave: state.powerSave } : {}),
    ...(state.idle !== undefined ? { idle: state.idle } : {}),
    ...(state.bgRestricted !== undefined ? { bgRestricted: state.bgRestricted } : {}),
    ...(state.bgLocation !== undefined ? { bgLocation: state.bgLocation } : {}),
    ...(state.autostart !== undefined ? { autostart: state.autostart } : {}),
    ...(state.bucket !== undefined ? { bucket: state.bucket } : {}),
  };
}

export interface ScreenOffFacts {
  /** Cuándo se ocultó la app y cuándo volvió a verse (ms, reloj del móvil). */
  fromMs: number;
  toMs: number;
  /** Las horas (ms) de las posiciones del GPS recibidas, o `null` si este entreno no graba el GPS en segundo plano. */
  gpsMs: readonly number[] | null;
  /** Las horas (ms) de las lecturas de pulso recibidas, o `null` si no se esperaban (sin anillo, o el anillo rechazó el pulso). */
  pulseMs: readonly number[] | null;
  /** Avisos del lado nativo (cada 2 s) que llegaron: la hora a la que los mandó, a la que llegaron y su número de orden (1, 2, 3…; ausente en versiones sin él). */
  ticks: ReadonlyArray<{ nowMs: number; arrivedMs: number; n?: number }>;
  service: ServiceFacts | null;
  /** Lo último que dijo el reflejo nativo del pulso: cuántas veces vio parada la web, cuántas órdenes escribió al anillo y cuántas no pudo. */
  reflex?: { stalls: number; writes: number; failed: number } | null;
  /** Cuándo vio el lado nativo caerse la conexión con el anillo, si fue dentro de este tramo (0 o `null`: no). */
  ringDownAtMs: number | null;
  /** Qué trabajo del mapa estaba en marcha al ocultarse la app («bajando el mapa», «completando el mapa con los edificios y comercios»…), si había alguno: es el trabajo más pesado que hace la app. */
  mapBusy?: string | null;
}

export interface ScreenOffReport {
  /** Falta algo que debía haber llegado. Sin problema el informe solo sirve para la traza. */
  problem: boolean;
  /** Para la persona: qué se perdió y qué mirar en el móvil. */
  message: string;
  /** Las cifras, en una línea. */
  technical: string;
}

/** Un tramo más corto no se comenta: un vistazo a otra app no llega a perder nada. */
export const MIN_REPORT_MS = 60_000;
/** El GPS da una posición por segundo: con tantos segundos seguidos sin ninguna, falta un trozo. */
const GPS_GAP_MS = 30_000;
/** Y con menos de esta parte de las posiciones que tocaban, también. */
const GPS_MIN_SHARE = 0.5;
/** El pulso llega con cada cierre de medida (~35 s): con tanto sin ninguna lectura, falta un trozo. */
const PULSE_GAP_MS = 120_000;
/** El lado nativo avisa cada 2 s: un hueco de esto entre dos avisos es que el proceso entero estuvo parado. */
const NATIVE_GAP_MS = 30_000;
/** Los avisos llegaron tanto después de mandarlos: el WebView estuvo parado ese rato. */
const WEB_LAG_MS = 15_000;

/** «6 min», «45 s», «1 min 20 s». */
export function fmtSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** Cuántas hay dentro del tramo y el mayor hueco entre dos (contando los bordes del tramo). */
function spread(stamps: readonly number[], fromMs: number, toMs: number): { count: number; maxGapMs: number } {
  const inside = stamps.filter((t) => t >= fromMs && t <= toMs).sort((a, b) => a - b);
  if (inside.length === 0) return { count: 0, maxGapMs: toMs - fromMs };
  let maxGapMs = Math.max(inside[0]! - fromMs, toMs - inside[inside.length - 1]!);
  for (let i = 1; i < inside.length; i++) maxGapMs = Math.max(maxGapMs, inside[i]! - inside[i - 1]!);
  return { count: inside.length, maxGapMs };
}

const yesNo = (value: boolean | undefined): string => (value === undefined ? '?' : value ? 'sí' : 'no');

/** El informe de un tramo oculto, o `null` si fue demasiado corto para comentarlo. */
export function reportScreenOff(facts: ScreenOffFacts): ScreenOffReport | null {
  const { fromMs, toMs } = facts;
  const spanMs = toMs - fromMs;
  if (!(spanMs >= MIN_REPORT_MS)) return null;
  const expectedGps = Math.floor(spanMs / 1000);

  const gps = facts.gpsMs ? spread(facts.gpsMs, fromMs, toMs) : null;
  const gpsLost = gps !== null && (gps.maxGapMs >= GPS_GAP_MS || gps.count < expectedGps * GPS_MIN_SHARE);

  const pulse = facts.pulseMs ? spread(facts.pulseMs, fromMs, toMs) : null;
  const pulseLost = pulse !== null && spanMs >= 90_000 && (pulse.count === 0 || pulse.maxGapMs >= PULSE_GAP_MS);

  // Los avisos nativos dicen si estuvo parado el proceso entero (hueco entre los que mandó) o solo la web (los recibió tarde).
  const nativeTicks = facts.ticks.filter((t) => t.nowMs >= fromMs && t.nowMs <= toMs).sort((a, b) => a.nowMs - b.nowMs);
  let nativeGapMs = 0;
  let webLagMs = 0;
  // Avisos que el lado nativo numeró y la web no recibió: con la hora saltando minutos y la numeración seguida, el que estuvo parado fue el móvil; con la numeración saltando, los avisos se perdieron por el camino.
  let lostTicks = 0;
  if (nativeTicks.length > 0) {
    nativeGapMs = Math.max(nativeTicks[0]!.nowMs - fromMs, toMs - nativeTicks[nativeTicks.length - 1]!.nowMs);
    for (let i = 1; i < nativeTicks.length; i++) {
      nativeGapMs = Math.max(nativeGapMs, nativeTicks[i]!.nowMs - nativeTicks[i - 1]!.nowMs);
      const before = nativeTicks[i - 1]!.n;
      const now = nativeTicks[i]!.n;
      if (before !== undefined && now !== undefined && now > before + 1) lostTicks += now - before - 1;
    }
    for (const t of nativeTicks) webLagMs = Math.max(webLagMs, t.arrivedMs - t.nowMs);
  }
  // Un hueco de avisos que la numeración explica (casi todos los avisos que faltan figuran como perdidos) no es un móvil congelado.
  const missingTicks = Math.floor(nativeGapMs / 2000);
  const lostInTransit = lostTicks >= 10 && lostTicks >= missingTicks * 0.5;
  // Sin ningún aviso en un tramo largo: o no hay servicio nativo (navegador) o el proceso no corrió; solo cuenta si el servicio dice estar vivo.
  const nativeGapped = nativeTicks.length > 0 ? nativeGapMs >= NATIVE_GAP_MS : facts.service?.running === true && facts.ticks.length > 0;
  const nativeStopped = nativeGapped && !lostInTransit;
  const webStopped = webLagMs >= WEB_LAG_MS;
  const serviceDown = facts.service !== null && !facts.service.running;
  const ringDown = facts.ringDownAtMs !== null && facts.ringDownAtMs >= fromMs && facts.ringDownAtMs <= toMs;

  const parts: string[] = [`apagada ${fmtSpan(spanMs)}`];
  if (gps) parts.push(`GPS ${gps.count}/${expectedGps}, hueco ${fmtSpan(gps.maxGapMs)}`);
  if (pulse) parts.push(`pulso ${pulse.count}, hueco ${fmtSpan(pulse.maxGapMs)}`);
  parts.push(
    `nativo: ${nativeTicks.length === 0 ? 'sin avisos' : `hueco ${fmtSpan(nativeGapMs)}`}${lostTicks > 0 ? `, ${lostTicks} avisos perdidos` : ''}`,
    `web: ${webLagMs > 0 ? `${fmtSpan(webLagMs)} de retraso` : 'sin retraso'}`,
  );
  if (facts.service) {
    const s = facts.service;
    parts.push(`servicio ${yesNo(s.running)}`, `exenta ${yesNo(s.batteryExempt)}`, `ahorro ${yesNo(s.powerSave)}`, `reposo ${yesNo(s.idle)}`, `restringida ${yesNo(s.bgRestricted)}`, `siempre ${yesNo(s.bgLocation)}`, `inicio automático ${yesNo(s.autostart)}`);
    if (s.bucket !== undefined) parts.push(`cubo ${s.bucket}`);
  }
  if (facts.mapBusy) parts.push(`mapa: ${facts.mapBusy}`);
  if (facts.reflex) parts.push(`reflejo: ${facts.reflex.stalls} paradas, ${facts.reflex.writes} órdenes, ${facts.reflex.failed} fallos`);
  if (ringDown) parts.push('anillo caído');
  const technical = parts.join(' · ');

  const problem = gpsLost || pulseLost || serviceDown || nativeStopped || lostInTransit || ringDown;
  if (!problem) return { problem: false, message: '', technical };

  const lost: string[] = [];
  if (gpsLost && gps) lost.push(gps.count === 0 ? 'el GPS no dio ninguna posición' : `el GPS dio ${gps.count} de ${expectedGps} posiciones (el mayor hueco, ${fmtSpan(gps.maxGapMs)})`);
  if (pulseLost && pulse) lost.push(pulse.count === 0 ? 'no llegó ninguna lectura de pulso' : `el pulso tuvo un hueco de ${fmtSpan(pulse.maxGapMs)}`);
  const why: string[] = [];
  if (nativeStopped) why.push(`el móvil dejó la app congelada ${fmtSpan(nativeGapMs)}`);
  else if (lostInTransit) why.push(`la parte web de la app no recibió ${lostTicks} avisos del lado nativo mientras estuvo parada`);
  else if (webStopped) why.push(`la parte web de la app estuvo parada ${fmtSpan(webLagMs)}`);
  if (serviceDown) why.push('el servicio que graba el entreno se había parado');
  if (ringDown) why.push('el anillo se desconectó');
  if (facts.mapBusy) why.push(`se estaba ${facts.mapBusy} al apagarse la pantalla`);
  const head = `Con la pantalla apagada o la app oculta (${fmtSpan(spanMs)}) el móvil interrumpió la grabación`;
  const what = lost.length > 0 ? `: ${lost.join(' y ')}` : '';
  const because = why.length > 0 ? ` (${why.join('; ')})` : '';

  const advice: string[] = [];
  const s = facts.service;
  if (s?.powerSave) advice.push('Tienes activado el ahorro de batería de Android: limita el GPS y el Bluetooth con la pantalla apagada; desactívalo.');
  if (s && (!s.batteryExempt || s.bgRestricted)) advice.push('Android restringe la app en segundo plano: Ajustes → Aplicaciones → SmartHealth → Batería → Sin restricciones.');
  if (s?.autostart === false) {
    // El móvil dice que «Inicio automático» está apagado: es lo primero (viene apagado de serie en las apps de fuera de la tienda).
    advice.push('«Inicio automático» está DESACTIVADO para SmartHealth: actívalo en Ajustes → Aplicaciones → Permisos → Inicio automático (y bloquea la app en Recientes: mantén pulsada su tarjeta → candado).');
  } else if (nativeStopped || serviceDown || (s && gpsLost && pulseLost)) {
    advice.push(
      s?.autostart === true
        ? 'En Xiaomi/Poco bloquea SmartHealth en Recientes (mantén pulsada su tarjeta → candado).'
        : 'En Xiaomi/Poco: activa «Inicio automático» para SmartHealth y bloquéala en Recientes (mantén pulsada su tarjeta → candado).',
    );
  }
  if (s && gpsLost && s.bgLocation === false) advice.push('Prueba a poner el permiso de ubicación en «Permitir siempre».');
  return { problem: true, message: `${head}${what}${because}. ${advice.join(' ')} [${technical}]`.replace(/\s+/g, ' ').trim(), technical };
}

/**
 * Lo que conviene avisar al EMPEZAR un entreno, antes de que falle nada: ajustes del móvil que se sabe que cierran o frenan la app con la
 * pantalla apagada (y con ella el GPS y el pulso). `null` si no hay nada que decir (o el móvil no sabe contestar).
 */
export function phoneRisk(service: ServiceFacts): string | null {
  const risks: string[] = [];
  if (service.autostart === false) {
    risks.push('«Inicio automático» está desactivado para SmartHealth: con la pantalla apagada el móvil puede cerrar la app y se perderían el GPS y el pulso. Actívalo en Ajustes → Aplicaciones → Permisos → Inicio automático.');
  }
  if (service.powerSave === true) risks.push('El ahorro de batería de Android está activado: puede detener el GPS y el Bluetooth con la pantalla apagada.');
  if (service.batteryExempt === false || service.bgRestricted === true) {
    risks.push('Android restringe SmartHealth en segundo plano: ponle «Sin restricciones» en Ajustes → Aplicaciones → SmartHealth → Batería.');
  }
  return risks.length > 0 ? risks.join(' ') : null;
}

/**
 * Al abrir la app tras morir en mitad de un entreno: si el motor web (el WebView) murió durante él, lo dice. Es lo que cierra la app entera (con ella el GPS y el anillo) cuando el sistema lo mata por
 * falta de memoria, y el mapa cargado en memoria es lo que más pesa. `null` si no consta que muriera durante este entreno.
 */
export function recoveryCause(state: { renderGoneAt?: number; renderGoneCrashed?: boolean }, workoutStartMs: number): string | null {
  const at = state.renderGoneAt;
  if (at === undefined || !(at >= workoutStartMs)) return null;
  const time = new Date(at);
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  return state.renderGoneCrashed === true
    ? `Causa: a las ${clock} se cayó el motor web de Android (WebView) y con él la app.`
    : `Causa: a las ${clock} Android cerró el motor web de la app (WebView), casi seguro por falta de memoria, y con él la app. El mapa cargado es lo que más pesa: prueba sin «Navegación guiada».`;
}
