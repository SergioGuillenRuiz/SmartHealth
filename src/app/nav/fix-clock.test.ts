import { describe, expect, it } from 'vitest';
import { createFixClock } from './fix-clock';

const STALE = 8000;

/** Posiciones que llegan a su ritmo (una por segundo) con un desfase constante entre el reloj del GPS y el del móvil. */
function stream(clock: ReturnType<typeof createFixClock>, count: number, skewMs: number, startMs = 1_000_000_000): Array<ReturnType<ReturnType<typeof createFixClock>['observe']>> {
  const out = [];
  for (let k = 0; k < count; k++) {
    const received = startMs + k * 1000;
    out.push(clock.observe(received - skewMs - 300, received)); // 300 ms de retraso normal de entrega, más el desfase de los relojes
  }
  return out;
}

describe('createFixClock: ¿está al día una posición?', () => {
  it('con los relojes en hora, una posición con su retraso normal está al día y su edad es ese retraso', () => {
    const results = stream(createFixClock(STALE), 8, 0);
    expect(results.every((r) => !r.stale)).toBe(true);
    expect(results.at(-1)?.ageMs).toBe(300);
  });

  it('una posición medida hace mucho (sin nada antes que lo explique) es historia', () => {
    const clock = createFixClock(STALE);
    expect(clock.observe(1_000_000_000 - 300_000, 1_000_000_000)).toMatchObject({ stale: true, ageMs: 3000 });
  });

  it('un lote atrasado (muchas posiciones de golpe, medidas de segundo en segundo) es historia entero, aunque antes llegaran al día', () => {
    const clock = createFixClock(STALE);
    stream(clock, 6, 0);
    // La pantalla estuvo apagada un minuto: al encenderla llegan 60 posiciones de golpe (misma hora de llegada), de la más vieja a la más nueva.
    const received = 1_000_000_000 + 6 * 1000 + 60_000;
    const batch = Array.from({ length: 60 }, (_, k) => clock.observe(1_000_000_000 + 6 * 1000 + k * 1000, received));
    // Las que se midieron hace más de 8 s son historia; solo las últimas, medidas hace menos, vuelven a valer.
    expect(batch.slice(0, 50).every((r) => r.stale)).toBe(true);
    expect(batch.at(-1)?.stale).toBe(false);
  });

  it('con el reloj del móvil adelantado o atrasado un minuto, las posiciones que llegan a su ritmo NO se toman por viejas (ni cuando el desfase es negativo)', () => {
    for (const skew of [60_000, -60_000, 25_000, -12_000]) {
      const results = stream(createFixClock(STALE), 10, skew);
      // Las dos o tres primeras se miden sin saber el desfase; en cuanto se repite, se descuenta y todas están al día.
      expect(results.slice(4).every((r) => !r.stale), `desfase ${skew}`).toBe(true);
      expect(results.at(-1)?.ageMs, `desfase ${skew}`).toBeLessThanOrEqual(3000);
    }
  });

  it('también con posiciones más seguidas que una por segundo (las de las pruebas llegan cada ~120 ms) y un año de desfase', () => {
    const clock = createFixClock(STALE);
    const results = Array.from({ length: 12 }, (_, k) => clock.observe(1_000_000_000 + k * 120, 1_000_000_000 + 365 * 86_400_000 + k * 120));
    expect(results.slice(4).every((r) => !r.stale)).toBe(true);
  });

  it('con el desfase conocido, un lote atrasado sigue siendo historia', () => {
    const clock = createFixClock(STALE);
    stream(clock, 8, 60_000);
    const received = 1_000_000_000 + 8 * 1000 + 40_000;
    const batch = Array.from({ length: 40 }, (_, k) => clock.observe(1_000_000_000 + 8 * 1000 + k * 1000 - 60_300, received));
    expect(batch.slice(0, 30).every((r) => r.stale)).toBe(true);
  });

  it('«reset» olvida el desfase: una navegación nueva parte de cero', () => {
    const clock = createFixClock(STALE);
    stream(clock, 8, 60_000);
    clock.reset();
    expect(clock.observe(1_000_000_000 - 60_300, 1_000_000_000).stale).toBe(true);
  });
});
