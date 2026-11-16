import { describe, expect, it } from 'vitest';
import { phaseText } from './ring-report';

describe('el informe de la sincronización', () => {
  it('phaseText cuenta cada parte en el orden en que ocurrió', () => {
    expect(
      phaseText([
        { stage: 'connecting', ms: 17100 },
        { stage: 'handshake', ms: 200 },
        { stage: 'history', ms: 29300 },
        { stage: 'closing', ms: 300 },
      ]),
    ).toBe('conexión 17,1\u00a0s · saludo 0,2\u00a0s · historial 29,3\u00a0s · cierre 0,3\u00a0s');
  });
});
