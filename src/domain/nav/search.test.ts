import { describe, expect, it } from 'vitest';
import { PLACE, readPack, writePack } from './pack';
import { buildSearchIndex, normalizeText, searchPlaces } from './search';
import { buildSyntheticCity } from './synthetic-city';

const city = buildSyntheticCity();
const index = buildSearchIndex(readPack(writePack(city.input)));

describe('buscar un destino', () => {
  it('normaliza tildes, mayúsculas y abreviaturas', () => {
    expect(normalizeText('Calle de Alcalá')).toBe('calle de alcala');
    expect(normalizeText('C/ Alcalá')).toBe('calle alcala');
    expect(normalizeText('Avda. de la Castellana')).toBe('avenida de la castellana');
    expect(normalizeText('  Pza.  Mayor ')).toBe('plaza mayor');
  });

  it('encuentra una calle sin tildes y con abreviatura', () => {
    const r = searchPlaces(index, 'c/ alcala');
    expect(r[0]).toMatchObject({ name: 'Calle de Alcalá', kind: PLACE.STREET, area: 'Barrio Centro', kindLabel: 'Calle' });
  });

  it('cada palabra escrita ha de ser el principio de una palabra del nombre', () => {
    expect(searchPlaces(index, 'parque ciud')[0]?.name).toBe('Parque de la Ciudadela');
    expect(searchPlaces(index, 'ciudadela parque')[0]?.name).toBe('Parque de la Ciudadela');
    expect(searchPlaces(index, 'xyz')).toEqual([]);
    expect(searchPlaces(index, 'a')).toEqual([]);
    expect(searchPlaces(index, '')).toEqual([]);
  });

  it('los lugares pesan más que las calles y lo más cercano gana a igualdad', () => {
    const r = searchPlaces(index, 'estacion');
    expect(r[0]).toMatchObject({ name: 'Estación Central', kind: PLACE.STATION });
    const both = searchPlaces(index, 'plaza del sol', city.at('g_0_0'));
    expect(both.length).toBeGreaterThan(0);
    expect(both[0]!.distanceM).not.toBeNull();
  });

  it('con la posición, da la distancia y ordena por cercanía entre iguales', () => {
    const near = city.at('g_0_0');
    const r = searchPlaces(index, 'calle', near, 20);
    const streets = r.filter((x) => x.kind === PLACE.STREET);
    expect(streets.length).toBeGreaterThan(5);
    for (let i = 1; i < streets.length; i++) expect(streets[i - 1]!.distanceM!).toBeLessThanOrEqual(streets[i]!.distanceM! + 400);
  });

  it('respeta el límite y no repite', () => {
    const r = searchPlaces(index, 'calle', null, 3);
    expect(r).toHaveLength(3);
    expect(new Set(r.map((x) => `${x.name}|${x.area}`)).size).toBe(3);
  });
});
