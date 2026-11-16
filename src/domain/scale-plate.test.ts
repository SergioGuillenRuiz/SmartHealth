import { describe, expect, it } from 'vitest';
import { netWeight } from './scale-plate';

describe('netWeight', () => {
  it('sin nada pesado antes, es lo que marca la báscula', () => {
    expect(netWeight(355, 0)).toEqual({ baselineG: 0, netG: 355 });
  });

  it('con algo ya pesado encima, resta lo ya pesado', () => {
    expect(netWeight(475, 355)).toEqual({ baselineG: 355, netG: 120 });
    expect(netWeight(355, 355)).toEqual({ baselineG: 355, netG: 0 });
  });

  it('si el peso baja de lo ya pesado (se quitó o se taró), se empieza de cero', () => {
    expect(netWeight(150, 355)).toEqual({ baselineG: 0, netG: 150 }); // se quitó lo pesado y se puso otra cosa
    expect(netWeight(0, 355)).toEqual({ baselineG: 0, netG: 0 }); // TARA con todo encima, o la báscula vacía
    expect(netWeight(120, 355)).toEqual({ baselineG: 0, netG: 120 }); // TARA y luego otro ingrediente
  });

  it('el baile de unos gramos no se toma por una tara', () => {
    expect(netWeight(352, 355)).toEqual({ baselineG: 355, netG: 0 });
  });
});
