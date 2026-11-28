// Lo que se sabe de cuándo la persona usa el móvil, para estimar el sueño de las noches en que no lleva el anillo.
//
// El móvil sabe cuándo se encendió la pantalla y cuándo se desbloqueó: es lo más fiable que hay de «estaba despierta». Aquí solo se guardan HORAS (de cuándo a cuándo estuvo en
// uso): ni qué apps, ni qué se hizo, ni nada que salga del móvil. `coverage` dice de qué tramos se leyó el registro entero: donde no hay uso pero SÍ cobertura, no se usó; donde no hay cobertura
// (el móvil apagado, la app sin permiso) no se sabe nada y no se opina.

export interface PhoneSpan {
  startMs: number;
  endMs: number;
}

export interface PhoneActivity {
  /** Cuándo estuvo la pantalla encendida o el móvil en uso (tramos ya unidos). */
  uses: readonly PhoneSpan[];
  /** Tramos de tiempo de los que se leyó el registro completo. */
  coverage: readonly PhoneSpan[];
}

export const NO_PHONE_ACTIVITY: PhoneActivity = { uses: [], coverage: [] };

/** Une los tramos (ordenados) que se tocan o están a menos de `gapMs` uno de otro. Descarta los vacíos o al revés. */
export function mergeSpans(spans: readonly PhoneSpan[], gapMs = 0): PhoneSpan[] {
  const sorted = spans.filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs >= s.startMs).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: PhoneSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startMs - last.endMs <= gapMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ startMs: span.startMs, endMs: span.endMs });
  }
  return merged;
}

/** Los tramos que manda la parte nativa como texto «inicio:fin;inicio:fin» (milisegundos). Lo que no se entiende se salta. */
export function parseSpans(text: string): PhoneSpan[] {
  const out: PhoneSpan[] = [];
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const startMs = Number(part.slice(0, colon));
    const endMs = Number(part.slice(colon + 1));
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > 0 && endMs >= startMs) out.push({ startMs, endMs });
  }
  return out;
}

/** Lo que cae dentro de `[fromMs, toMs]`, recortado. */
export function clipSpans(spans: readonly PhoneSpan[], fromMs: number, toMs: number): PhoneSpan[] {
  const out: PhoneSpan[] = [];
  for (const s of spans) {
    const startMs = Math.max(s.startMs, fromMs);
    const endMs = Math.min(s.endMs, toMs);
    if (endMs >= startMs && s.endMs >= fromMs && s.startMs <= toMs) out.push({ startMs, endMs });
  }
  return out;
}

/** Cuánto de `[a, b]` cubren los tramos (ordenados y sin solaparse). */
export function coveredMs(spans: readonly PhoneSpan[], a: number, b: number): number {
  let total = 0;
  for (const s of spans) {
    if (s.endMs <= a) continue;
    if (s.startMs >= b) break;
    total += Math.min(s.endMs, b) - Math.max(s.startMs, a);
  }
  return total;
}

/** Instantes sueltos repartidos por los tramos de uso (el principio, el final y uno cada `stepMs` entre medias): lo que usa la estimación con anillo como «estaba despierta». */
export function awakeInstants(uses: readonly PhoneSpan[], stepMs = 10 * 60_000): number[] {
  const out: number[] = [];
  for (const use of uses) {
    for (let t = use.startMs; t < use.endMs; t += stepMs) out.push(t);
    out.push(use.endMs);
  }
  return out;
}

/** El registro menos los tramos en que el móvil estuvo apagado (no se sabe qué pasó entonces). */
export function withoutSpans(spans: readonly PhoneSpan[], holes: readonly PhoneSpan[]): PhoneSpan[] {
  let out: PhoneSpan[] = spans.map((s) => ({ ...s }));
  for (const hole of mergeSpans(holes)) {
    out = out.flatMap((s) => {
      if (hole.endMs <= s.startMs || hole.startMs >= s.endMs) return [s];
      return [
        { startMs: s.startMs, endMs: Math.min(s.endMs, hole.startMs) },
        { startMs: Math.max(s.startMs, hole.endMs), endMs: s.endMs },
      ].filter((x) => x.endMs > x.startMs);
    });
  }
  return out;
}
