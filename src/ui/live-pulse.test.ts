import { describe, expect, it } from 'vitest';
import { pulseCaption } from './live-pulse';

const zone = { index: 3, name: 'Aeróbica', min: 0, max: 0 } as never;

describe('pulseCaption: la línea bajo el pulso de la pantalla en vivo', () => {
  it('con un pulso reciente, la zona (o que está por debajo de la primera)', () => {
    expect(pulseCaption({ bpm: 142, zone, lastPulse: { bpm: 142, ageMs: 5000 } })).toBe('Zona 3 · Aeróbica');
    expect(pulseCaption({ bpm: 70, zone: null, lastPulse: { bpm: 70, ageMs: 5000 } })).toBe('Por debajo de la zona 1');
  });

  it('antes de la primera lectura, que el sensor tarda en dar la primera', () => {
    expect(pulseCaption({ bpm: null, zone: null, lastPulse: null })).toBe('Esperando lectura: el sensor tarda ~30 s en dar el primero');
  });

  it('si ya hubo lecturas, dice cuánto hace de la última (no repite que el sensor está calentando)', () => {
    expect(pulseCaption({ bpm: null, zone: null, lastPulse: { bpm: 118, ageMs: 80_000 } })).toBe('Sin lectura nueva desde hace 1 min · última: 118 lpm');
    expect(pulseCaption({ bpm: null, zone: null, lastPulse: { bpm: 118, ageMs: 7 * 60_000 } })).toBe('Sin lectura nueva desde hace 7 min · última: 118 lpm');
    expect(pulseCaption({ bpm: null, zone: null, lastPulse: { bpm: 118, ageMs: 80 * 60_000 } })).toBe('Sin lectura nueva desde hace 1 h 20 min · última: 118 lpm');
  });
});
