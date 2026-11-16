import type { IntakeTotals, NutritionTargets } from './nutrition';

// Los indicadores que puede enseñar el panel de «Nutrición» del Resumen (ronda 59): la persona elige cuáles quiere ver, de 0 a 8 (dos filas de cuatro). Cada uno es un anillo con lo del
// día frente a su meta (o su máximo, si es de los que no conviene pasarse). Aquí está el catálogo y de dónde sale cada valor y cada meta; cómo se dibuja es cosa de `ui/summary/`.

export type PanelIndicatorId = 'protein' | 'carbs' | 'fat' | 'salt' | 'fiber' | 'sugars' | 'water';

/** Cuántos indicadores caben: dos filas de cuatro. */
export const MAX_PANEL_INDICATORS = 8;

export interface PanelIndicator {
  id: PanelIndicatorId;
  label: string;
  /** Variable de color (`tokens.css`). */
  color: string;
  /** `limit`: un máximo (la sal, los azúcares): se pone rojo al pasarse. `goal`: una meta que se busca llegar a ella. */
  kind: 'goal' | 'limit';
  unit: 'g' | 'ml';
  /** Decimales con los que se enseña el valor (la sal lleva una décima). */
  decimals: 0 | 1;
  /** Lo que dice el lector de pantalla del anillo («Sal (máximo al día)»). */
  aria: string;
  /** Una frase corta para el selector («Lo que conviene no pasar de…»). */
  hint: string;
}

export const PANEL_INDICATORS: readonly PanelIndicator[] = [
  { id: 'protein', label: 'Proteína', color: 'var(--macro-protein)', kind: 'goal', unit: 'g', decimals: 0, aria: 'Proteína', hint: 'Los gramos del día frente a tu meta' },
  { id: 'carbs', label: 'Hidratos', color: 'var(--macro-carbs)', kind: 'goal', unit: 'g', decimals: 0, aria: 'Hidratos', hint: 'Los gramos del día frente a tu meta' },
  { id: 'fat', label: 'Grasas', color: 'var(--macro-fat)', kind: 'goal', unit: 'g', decimals: 0, aria: 'Grasas', hint: 'Los gramos del día frente a tu meta' },
  // La sal es un máximo (OMS: menos de 5 g al día), no una meta: se llena hasta ahí y se pone roja si se pasa.
  { id: 'salt', label: 'Sal', color: 'var(--macro-salt)', kind: 'limit', unit: 'g', decimals: 1, aria: 'Sal (máximo al día)', hint: 'Un máximo: menos de 5 g al día (OMS)' },
  { id: 'fiber', label: 'Fibra', color: 'var(--steps)', kind: 'goal', unit: 'g', decimals: 0, aria: 'Fibra', hint: 'Una meta: 25 g al día (EFSA)' },
  { id: 'sugars', label: 'Azúcares', color: 'var(--macro-carbs)', kind: 'limit', unit: 'g', decimals: 0, aria: 'Azúcares (máximo al día)', hint: 'Un máximo: el 10 % de las calorías (OMS, para los azúcares libres; aquí cuentan todos)' },
  { id: 'water', label: 'Agua', color: 'var(--water)', kind: 'goal', unit: 'ml', decimals: 0, aria: 'Agua', hint: 'Lo bebido frente a tu meta del día' },
];

const BY_ID: ReadonlyMap<string, PanelIndicator> = new Map(PANEL_INDICATORS.map((i) => [i.id, i]));
export const panelIndicatorOf = (id: PanelIndicatorId): PanelIndicator => BY_ID.get(id) as PanelIndicator;
export const isPanelIndicatorId = (value: unknown): value is PanelIndicatorId => typeof value === 'string' && BY_ID.has(value);

/** Lo que se ve antes de que la persona elija: los cuatro de siempre. */
export const DEFAULT_NUTRITION_PANEL: readonly PanelIndicatorId[] = ['protein', 'carbs', 'fat', 'salt'];

/** Meta diaria de fibra (g): la ingesta adecuada de la EFSA para un adulto. */
export const FIBER_GOAL_G = 25;
/** Máximo de azúcares: el 10 % de las calorías propuestas (la OMS lo recomienda para los azúcares libres; el panel suma todos los anotados, también los de la fruta y la leche, así que es orientativo). */
export const SUGARS_MAX_SHARE = 0.1;

/** La lista de indicadores elegidos, limpia: solo los que existen, sin repetir, en el orden dado y como mucho ocho. Lo que no es una lista vuelve al valor por omisión; una lista vacía es válida. */
export function sanitizeNutritionPanel(value: unknown): PanelIndicatorId[] {
  if (!Array.isArray(value)) return [...DEFAULT_NUTRITION_PANEL];
  const seen = new Set<PanelIndicatorId>();
  for (const item of value) if (isPanelIndicatorId(item) && seen.size < MAX_PANEL_INDICATORS) seen.add(item);
  return [...seen];
}

/** La meta (o el máximo) de un indicador: las de las metas de la persona, la fibra fija, los azúcares según sus calorías y el agua la que toca ese día. */
export function panelTarget(id: PanelIndicatorId, targets: NutritionTargets, waterGoalMl: number): number {
  switch (id) {
    case 'protein':
      return targets.proteinG;
    case 'carbs':
      return targets.carbsG;
    case 'fat':
      return targets.fatG;
    case 'salt':
      return targets.saltG;
    case 'fiber':
      return FIBER_GOAL_G;
    case 'sugars':
      return Math.round((targets.kcal * SUGARS_MAX_SHARE) / 4);
    case 'water':
      return waterGoalMl;
  }
}

/** Lo del día de un indicador. Sin nada anotado, cero (no anotar nada no es lo mismo que comer cero, pero el anillo está vacío igual). */
export function panelValue(id: PanelIndicatorId, intake: IntakeTotals | null, waterMl: number): number {
  switch (id) {
    case 'protein':
      return intake?.proteinG ?? 0;
    case 'carbs':
      return intake?.carbsG ?? 0;
    case 'fat':
      return intake?.fatG ?? 0;
    case 'salt':
      return intake?.saltG ?? 0;
    case 'fiber':
      return intake?.fiberG ?? 0;
    case 'sugars':
      return intake?.sugarsG ?? 0;
    case 'water':
      return waterMl;
  }
}
