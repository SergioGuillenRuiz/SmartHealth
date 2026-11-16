/** Lo que hace falta saber del resultado de leer un tipo de dato del anillo (un `TypeOutcome` o un `SyncOutcomeRecord` lo cumplen). */
export interface OutcomeLike {
  type: string;
  status: string;
  detail?: string | undefined;
}

/**
 * Un silencio que no es un fallo: algunos anillos (el R99, comprobado) no contestan nunca a la consulta dedicada de oxígeno
 * (`05 1a`), y sus lecturas ya vienen en el registro de constantes, que sí se leyó. Avisar en cada sincronización de algo que no
 * falta sería ruido, tanto en el aviso de la sincronización como en el diagnóstico del anillo.
 */
export function isExpectedSilence(outcome: OutcomeLike, outcomes: readonly OutcomeLike[]): boolean {
  return outcome.type === 'spo2' && outcome.status === 'timeout' && outcome.detail === 'sin cabecera' && outcomes.some((o) => o.type === 'all' && o.status === 'ok');
}
