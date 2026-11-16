import { describe, expect, it } from 'vitest';
import { draftOfAnalysis, estimateMealFromText, foodTable } from './food-text';

describe('foodTable', () => {
  it('lee la tabla de alimentos de la app una sola vez', () => {
    expect(foodTable().length).toBeGreaterThan(250);
    expect(foodTable()).toBe(foodTable());
  });
});

describe('estimateMealFromText', () => {
  it('calcula lo escrito con la tabla de alimentos', () => {
    const result = estimateMealFromText('  dos huevos revueltos con una tostada y un café con leche ');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.analysis.items.map((item) => item.name)).toEqual(['Huevos revueltos ×2', 'Tostada', 'Café con leche']);
    expect(draftOfAnalysis(result.analysis)).toMatchObject({ kcal: 415, name: 'Huevos revueltos ×2 + Tostada + Café con leche' });
  });

  it('pide que se escriba algo', () => {
    expect(estimateMealFromText('')).toEqual({ status: 'error', message: 'Escribe qué has comido.' });
    expect(estimateMealFromText('   \n ')).toEqual({ status: 'error', message: 'Escribe qué has comido.' });
  });

  it('un texto larguísimo se rechaza con un aviso', () => {
    const result = estimateMealFromText('huevo '.repeat(400));
    expect(result).toEqual({ status: 'error', message: expect.stringContaining('demasiado largo') });
  });

  it('si no reconoce nada, dice qué palabras no entendió', () => {
    const result = estimateMealFromText('un zarandajo con frumbulón');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('No he reconocido ningún alimento');
      expect(result.message).toContain('«zarandajo');
    }
  });

  it('si no hay ni palabras raras, lo dice sin enumerar nada', () => {
    const result = estimateMealFromText('hoy me he comido');
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toContain('No he encontrado comida');
  });

  it('con comida y palabras sueltas sin entender, calcula lo que entiende y lo avisa', () => {
    const result = estimateMealFromText('arroz con zarandajo');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.analysis.items).toHaveLength(1);
      expect(result.analysis.unknown).toEqual(['zarandajo']);
    }
  });
});
