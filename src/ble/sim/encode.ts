import type { Bytes } from '../bytes';
import type { AllRecord, HeartRecord, SleepSession, SleepStage, SportRecord, Spo2Record } from '../records';
import { msToRingSeconds } from '../time';

// Codificadores de los registros del historial: la operación inversa de `records.ts`.
// Solo los usa el anillo simulado (pruebas y modo demostración), pero tenerlos garantiza que cada
// decodificador se ejercita con un viaje completo codificar → decodificar además de con capturas reales.

function writeU16(out: Uint8Array, at: number, value: number): void {
  out[at] = value & 0xff;
  out[at + 1] = (value >> 8) & 0xff;
}

function writeU24(out: Uint8Array, at: number, value: number): void {
  out[at] = value & 0xff;
  out[at + 1] = (value >> 8) & 0xff;
  out[at + 2] = (value >> 16) & 0xff;
}

function writeU32(out: Uint8Array, at: number, value: number): void {
  out[at] = value & 0xff;
  out[at + 1] = (value >>> 8) & 0xff;
  out[at + 2] = (value >>> 16) & 0xff;
  out[at + 3] = (value >>> 24) & 0xff;
}

const sec = (ms: number): number => msToRingSeconds(ms);
/**
 * Los instantes de una sesión de sueño o de un tramo de actividad se escriben desde su INICIO, con segundos del reloj del anillo (que
 * no salta con el cambio de hora): así dura lo que duró, y es como los lee `records.ts`. Convertir cada extremo por separado con la
 * hora de pared daba una noche de 7 h con 8 h de fases el día del cambio, que el saneado descarta.
 */
const secFrom = (startMs: number): ((ms: number) => number) => {
  const base = sec(startMs);
  return (ms) => base + Math.round((ms - startMs) / 1000);
};
const clamp16 = (n: number): number => Math.max(0, Math.min(0xffff, Math.round(n)));
const clamp8 = (n: number): number => Math.max(0, Math.min(0xff, Math.round(n)));

export function encodeSport(records: readonly SportRecord[]): Bytes {
  const out = new Uint8Array(records.length * 14);
  records.forEach((r, i) => {
    const at = i * 14;
    writeU32(out, at, sec(r.startMs));
    writeU32(out, at + 4, secFrom(r.startMs)(r.endMs));
    writeU16(out, at + 8, clamp16(r.steps));
    writeU16(out, at + 10, clamp16(r.distanceM));
    writeU16(out, at + 12, clamp16(r.calories));
  });
  return out;
}

export function encodeHeart(records: readonly HeartRecord[]): Bytes {
  const out = new Uint8Array(records.length * 6);
  records.forEach((r, i) => {
    const at = i * 6;
    writeU32(out, at, sec(r.tsMs));
    out[at + 4] = 0; // modo: muestreo automático
    out[at + 5] = clamp8(r.bpm);
  });
  return out;
}

export function encodeSpo2(records: readonly Spo2Record[]): Bytes {
  const out = new Uint8Array(records.length * 6);
  records.forEach((r, i) => {
    const at = i * 6;
    writeU32(out, at, sec(r.tsMs));
    out[at + 4] = 0;
    out[at + 5] = clamp8(r.percent);
  });
  return out;
}

export function encodeAll(records: readonly AllRecord[]): Bytes {
  const out = new Uint8Array(records.length * 20);
  records.forEach((r, i) => {
    const at = i * 20;
    writeU32(out, at, sec(r.tsMs));
    writeU16(out, at + 4, clamp16(r.steps));
    out[at + 6] = clamp8(r.bpm);
    out[at + 9] = clamp8(r.spo2);
    out[at + 10] = clamp8(r.respiratoryRate);
    out[at + 14] = 15; // temperatura "nunca medida": el anillo deja 0,15 como relleno
  });
  return out;
}

const STAGE_TAG: Record<SleepStage, number> = { deep: 0xf1, light: 0xf2, rem: 0xf3, awake: 0xf4, nap: 0xf5 };

export function encodeSleep(sessions: readonly SleepSession[]): Bytes {
  const parts: Uint8Array[] = [];
  for (const session of sessions) {
    const length = 20 + session.segments.length * 8;
    const block = new Uint8Array(length);
    block[0] = 0xaf;
    block[1] = 0xfa;
    writeU16(block, 2, length);
    const rel = secFrom(session.startMs);
    writeU32(block, 4, sec(session.startMs));
    writeU32(block, 8, rel(session.endMs));
    const total = (stage: SleepStage): number =>
      session.segments.filter((s) => s.stage === stage).reduce((a, s) => a + s.durationSec, 0);
    const awake = total('awake');
    writeU16(block, 12, awake > 0 ? clamp16(awake) : 0xffff);
    writeU16(block, 14, clamp16(total('rem')));
    writeU16(block, 16, clamp16(total('deep')));
    writeU16(block, 18, clamp16(total('light')));
    session.segments.forEach((seg, i) => {
      const at = 20 + i * 8;
      block[at] = STAGE_TAG[seg.stage];
      writeU32(block, at + 1, rel(seg.startMs));
      writeU24(block, at + 5, seg.durationSec);
    });
    parts.push(block);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
