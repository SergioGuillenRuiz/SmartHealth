import { describe, expect, it } from 'vitest';
import type { PhoneDiag } from '../app/phone-activity';
import { describePhoneDiag } from './phone-diag';

const NOW = new Date(2026, 9, 10, 12, 0).getTime();
const DAY = 86_400_000;
const diag = (extra: Partial<PhoneDiag> = {}): PhoneDiag => ({ readAtMs: NOW, firstMs: NOW - 7 * DAY, lastEventMs: NOW - 5 * 60_000, screenEvents: 120, unlockEvents: 60, appEvents: 800, uses: 85, ...extra });

describe('describePhoneDiag', () => {
  it('sin lectura, lo dice', () => {
    expect(describePhoneDiag(null, NOW)).toBe('Todavía no se ha hecho ninguna lectura.');
  });

  it('cuenta los días de registro, los usos y cuándo fue el último movimiento', () => {
    expect(describePhoneDiag(diag(), NOW)).toBe('Registro de 7 días · 85 usos del móvil · último movimiento hace 5 min.');
    expect(describePhoneDiag(diag({ firstMs: NOW - 3 * 60 * 60_000, uses: 1 }), NOW)).toBe('Registro de 1 día · 1 uso del móvil · último movimiento hace 5 min.');
  });

  it('si Android no tiene ningún evento, no hay con qué estimar y se dice', () => {
    expect(describePhoneDiag(diag({ firstMs: 0, lastEventMs: 0, uses: 0 }), NOW)).toContain('ningún evento de uso');
  });

  it('avisa si el móvil no da los eventos de pantalla', () => {
    expect(describePhoneDiag(diag({ screenEvents: 0 }), NOW)).toContain('no da la pantalla encendida y apagada');
    expect(describePhoneDiag(diag(), NOW)).not.toContain('no da la pantalla');
  });
});
