import { describe, expect, it } from 'vitest';
import { beepsFor, cueDurationMs, cueForStep, describeCue, vibrationFor, type CueKind, type NavCue } from './cues';
import { step } from './guidance.test-support';
import type { TurnKind } from './maneuvers';

const turn = (kind: TurnKind) => step('turn', 100, 'x', { turn: kind });

describe('solo hay tres avisos (ronda 45)', () => {
  it('cualquier giro —brusco, normal, suave o «mantente»— es el MISMO sonido, en el oído de su lado', () => {
    const left = beepsFor(cueForStep(turn('left'))!);
    for (const [kind, ear] of [['left', 'left'], ['sharp-left', 'left'], ['slight-left', 'left'], ['keep-left', 'left'], ['right', 'right'], ['sharp-right', 'right'], ['slight-right', 'right'], ['keep-right', 'right']] as const) {
      const cue = cueForStep(turn(kind))!;
      expect(cue.kind, kind).toBe('turn');
      expect(cue.ear, kind).toBe(ear);
      const beeps = beepsFor(cue);
      expect(beeps, kind).toHaveLength(2);
      expect(beeps.every((b) => b.ear === ear)).toBe(true);
      // Mismo zumbido: solo cambia el oído.
      expect(beeps.map((b) => ({ ...b, ear: 'left' }))).toEqual(left);
    }
  });

  it('una rotonda es un giro sin lado: el mismo zumbido en los dos oídos (no tantos como salidas)', () => {
    for (const exit of [1, 2, 5]) {
      const cue = cueForStep(step('roundabout', 100, 'x', { exit }))!;
      expect(cue.kind).toBe('turn');
      expect(beepsFor(cue)).toHaveLength(2);
      expect(beepsFor(cue).every((b) => b.ear === 'both')).toBe(true);
    }
  });

  it('el cambio de sentido (y la equivocación, ver `guidance.test.ts`) es otro único sonido: un zumbido largo y grave en los dos oídos', () => {
    const u = cueForStep(turn('uturn'))!;
    expect(u.kind).toBe('reverse');
    const beeps = beepsFor(u);
    expect(beeps).toHaveLength(1);
    expect(beeps[0]!.ear).toBe('both');
    expect(beeps[0]!.durMs).toBeGreaterThanOrEqual(800);
    expect(beeps[0]!.hz).toBeLessThan(beepsFor(cueForStep(turn('left'))!)[0]!.hz);
  });

  it('el final de la ruta es muy distinto de los zumbidos: notas limpias que suben (sin temblor ni onda de sierra), más largas y en los dos oídos', () => {
    const arrived = beepsFor(cueForStep(step('arrive', 900, 'x'))!);
    expect(arrived).toHaveLength(3);
    expect(arrived.map((b) => b.hz)).toEqual([...arrived.map((b) => b.hz)].sort((a, b) => a - b));
    expect(new Set(arrived.map((b) => b.hz)).size).toBe(3);
    for (const b of arrived) {
      expect(b.wave).toBe('sine');
      expect(b.buzzHz).toBe(0);
      expect(b.ear).toBe('both');
      expect(b.hz).toBeGreaterThan(500); // agudo: nada que ver con el zumbido grave de un giro
    }
    const zumbido = beepsFor(cueForStep(turn('left'))!)[0]!;
    expect(arrived.at(-1)!.durMs).toBeGreaterThan(zumbido.durMs * 2);
  });

  it('seguir recto, salir y las escaleras no suenan: no hay más avisos que esos tres', () => {
    expect(cueForStep(turn('straight'))).toBeNull();
    expect(cueForStep(step('depart', 0, 'Sal'))).toBeNull();
    expect(cueForStep(step('steps', 100, 'x'))).toBeNull();
    const all = new Set<CueKind>();
    for (const kind of ['left', 'right', 'slight-left', 'keep-right', 'sharp-left', 'uturn'] as const) all.add(cueForStep(turn(kind))!.kind);
    all.add(cueForStep(step('roundabout', 100, 'x', { exit: 2 }))!.kind);
    all.add(cueForStep(step('arrive', 900, 'x'))!.kind);
    expect([...all].sort()).toEqual(['arrive', 'reverse', 'turn']);
  });
});

describe('cómo suena', () => {
  it('los de girar y de cambio de sentido son zumbidos: onda de sierra con un temblor rápido y profundo, y graves', () => {
    const cues: NavCue[] = [
      { kind: 'turn', ear: 'left' },
      { kind: 'turn', ear: 'both' },
      { kind: 'reverse', ear: 'both' },
    ];
    for (const cue of cues) {
      for (const b of beepsFor(cue)) {
        expect(b.wave, cue.kind).toBe('sawtooth');
        expect(b.buzzHz, cue.kind).toBeGreaterThanOrEqual(25); // un temblor rápido, como un motor de vibración, no un pulso lento
        expect(b.buzzDepth, cue.kind).toBeGreaterThanOrEqual(0.5);
        expect(b.hz, cue.kind).toBeLessThan(400); // grave: un pitido agudo es lo que no gustó
      }
    }
  });

  it('los zumbidos no se pisan y un aviso entero dura poco más de un segundo como mucho (cabe de sobra en los 5 s de margen)', () => {
    for (const kind of ['left', 'right', 'uturn', 'slight-left'] as const) {
      const cue = cueForStep(turn(kind))!;
      const beeps = beepsFor(cue);
      for (let i = 1; i < beeps.length; i++) expect(beeps[i]!.atMs).toBeGreaterThanOrEqual(beeps[i - 1]!.atMs + beeps[i - 1]!.durMs);
      expect(cueDurationMs(cue)).toBeLessThan(1100);
    }
    expect(cueDurationMs({ kind: 'arrive', ear: 'both' })).toBeLessThan(1700);
  });

  it('un giro pegado a otro suena después del primero, con una pausa, en su propio oído', () => {
    const cue: NavCue = { ...cueForStep(turn('left'))!, then: cueForStep(turn('right'))! };
    const beeps = beepsFor(cue);
    expect(beeps).toHaveLength(4);
    expect(beeps.slice(0, 2).every((b) => b.ear === 'left')).toBe(true);
    expect(beeps.slice(2).every((b) => b.ear === 'right')).toBe(true);
    expect(beeps[2]!.atMs - (beeps[1]!.atMs + beeps[1]!.durMs)).toBeGreaterThanOrEqual(400);
  });

  it('describeCue lo cuenta con palabras', () => {
    expect(describeCue(cueForStep(turn('left'))!)).toBe('2 zumbidos cortos, oído izquierdo');
    expect(describeCue(cueForStep(turn('keep-right'))!)).toBe('2 zumbidos cortos, oído derecho');
    expect(describeCue(cueForStep(step('roundabout', 100, 'x', { exit: 3 }))!)).toBe('2 zumbidos cortos, oído los dos oídos');
    expect(describeCue({ kind: 'reverse', ear: 'both' })).toContain('cambio de sentido o equivocación');
    expect(describeCue({ kind: 'arrive', ear: 'both' })).toContain('has llegado');
  });
});

describe('la vibración del móvil lleva el mismo ritmo que los zumbidos', () => {
  it('empieza vibrando y alterna vibra/para: duraciones de los zumbidos y huecos entre ellos', () => {
    const cue = cueForStep(turn('left'))!;
    const beeps = beepsFor(cue);
    const pattern = vibrationFor(cue);
    expect(pattern).toEqual([beeps[0]!.durMs, beeps[1]!.atMs - (beeps[0]!.atMs + beeps[0]!.durMs), beeps[1]!.durMs]);
    expect(pattern.length % 2).toBe(1); // acaba vibrando
  });

  it('un giro con otro pegado vibra los cuatro', () => {
    const cue: NavCue = { ...cueForStep(turn('left'))!, then: cueForStep(turn('right'))! };
    expect(vibrationFor(cue)).toHaveLength(7);
  });

  it('el cambio de sentido vibra una vez, largo', () => {
    expect(vibrationFor({ kind: 'reverse', ear: 'both' })).toEqual([900]);
  });
});
