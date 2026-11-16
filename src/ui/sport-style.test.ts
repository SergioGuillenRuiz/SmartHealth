import { describe, expect, it } from 'vitest';
import { SPORTS } from '../domain/sports';
import { WALKING_KEY } from '../domain/breakdown';
import { partIcon, sportBackground, TINTS } from './sport-style';

describe('estilo de los deportes', () => {
  it('cada deporte que se ofrece tiene su medalla de color', () => {
    for (const sport of SPORTS) expect(TINTS, sport.id).toHaveProperty(sport.id);
    expect(TINTS).toHaveProperty('walking');
    expect(TINTS).toHaveProperty('other');
  });

  it('dos deportes que suelen coincidir en un día no comparten color (corredor y baloncesto, andar y caminar)', () => {
    const color = (id: keyof typeof TINTS): string => TINTS[id][1];
    const seen = new Set<string>();
    for (const id of ['walking', 'walk', 'run', 'hike', 'cycle', 'bicimad', 'swim', 'gym', 'yoga', 'football', 'basketball', 'tennis', 'padel'] as const) {
      expect(seen.has(color(id)), id).toBe(false);
      seen.add(color(id));
    }
  });

  it('un id desconocido o retirado se pinta como «Otros»', () => {
    expect(sportBackground('nada')).toBe(sportBackground('other'));
    expect(sportBackground('hiit')).toBe(sportBackground('other'));
    expect(sportBackground('run')).toContain('#ee8434');
  });

  it('andar usa el icono de «Caminar» y cada deporte el suyo', () => {
    expect(partIcon({ sport: WALKING_KEY })).toBe(SPORTS.find((s) => s.id === 'walk')?.icon);
    expect(partIcon({ sport: 'cycle' })).toBe(SPORTS.find((s) => s.id === 'cycle')?.icon);
  });
});
