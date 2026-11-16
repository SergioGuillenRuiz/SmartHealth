import { describe, expect, it } from 'vitest';
import { writePack } from '../../domain/nav/pack';
import { buildSyntheticCity } from '../../domain/nav/synthetic-city';
import { loadSyntheticCity, openPack } from './pack-loader';

const city = buildSyntheticCity();

describe('abrir un paquete de mapa', () => {
  it('se abre y deja buscar y calcular', () => {
    const data = openPack(writePack(city.input), { title: 'Mi zona', zoneId: 'z1' });
    expect(data.pack.edgeCount).toBe(city.input.edgeA.length);
    expect(data.graph.adj.length).toBe(city.input.edgeA.length * 2);
    expect(data.title).toBe('Mi zona');
    expect(data.zoneId).toBe('z1');
  });

  it('sin cuadrado propio usa el que cubre el paquete', () => {
    const data = openPack(writePack(city.input));
    expect(data.box).toEqual(data.pack.meta.bbox);
    expect(data.zoneId).toBeNull();
  });

  it('un archivo cortado lanza un error de paquete (el gestor lo borra y lo vuelve a bajar)', () => {
    const buffer = writePack(city.input);
    expect(() => openPack(buffer.slice(0, buffer.byteLength - 500))).toThrow(/cortada|incompleta|coherente/);
  });

  it('la ciudad de prueba de la demostración no pide nada', async () => {
    const loaded = await loadSyntheticCity();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.data.title).toBe('Ciudad de prueba');
  });
});
