// Metros que se suben en un paseo, medidos con el barómetro del móvil: la presión baja unos 12 Pa por cada metro de subida. La altitud
// del GPS no sirve para esto (±10–20 m, con saltos al cambiar de satélites); el barómetro da la altura relativa con ±1 m.

/** Subir tanto, y solo tanto, cuenta como subida: por debajo es ruido del sensor (rachas de viento, un portazo, la mano que se mueve). */
const DEAD_BAND_M = 2.5;
/** La mediana de las últimas lecturas quita los picos sueltos. */
const MEDIAN_OF = 5;
const MIN_HPA = 300;
const MAX_HPA = 1100;
/** Energía de subir un metro a pie: 1,8 ml de O₂ por kg (ACSM, componente vertical de la marcha) × 5 kcal por litro = 0,009 kcal/kg. */
export const CLIMB_KCAL_PER_KG_M = 0.009;

/** Altura (m) de una presión respecto a otra (atmósfera estándar): solo importan las diferencias. */
export function heightBetween(pressureHpa: number, referenceHpa: number): number {
  return 44_330 * (1 - Math.pow(pressureHpa / referenceHpa, 1 / 5.255));
}

/**
 * Suma la subida de una serie de lecturas de presión. Con una banda muerta: se sube cuando la altura pasa de la de referencia más la
 * banda, y la referencia baja cuando se baja más que la banda; así el ruido no suma metros de más ni se pierde una subida sostenida
 * (se pierde a lo sumo lo que quede por debajo de la banda al final). Solo cuenta lo que se sube: bajar no cuesta energía de la misma forma.
 */
export class AscentTracker {
  private referenceHpa: number | null = null;
  private recent: number[] = [];
  private anchorM: number | null = null;
  private ascent = 0;

  /** Una lectura de presión (hPa). Una fuera de rango (un sensor que falla) se ignora. */
  add(pressureHpa: number): void {
    if (!(pressureHpa >= MIN_HPA && pressureHpa <= MAX_HPA)) return;
    this.referenceHpa ??= pressureHpa;
    this.recent.push(pressureHpa);
    if (this.recent.length > MEDIAN_OF) this.recent.shift();
    if (this.recent.length < MEDIAN_OF) return; // sin lecturas para la mediana aún
    const sorted = [...this.recent].sort((a, b) => a - b);
    const height = heightBetween(sorted[Math.floor(sorted.length / 2)] as number, this.referenceHpa);
    if (this.anchorM === null) {
      this.anchorM = height;
    } else if (height >= this.anchorM + DEAD_BAND_M) {
      this.ascent += height - this.anchorM;
      this.anchorM = height;
    } else if (height <= this.anchorM - DEAD_BAND_M) {
      this.anchorM = height;
    }
  }

  /** Corta la serie (una pausa, un hueco largo): lo que venga después no se compara con lo anterior. */
  breakSeries(): void {
    this.recent = [];
    this.anchorM = null;
  }

  get ascentM(): number {
    return this.ascent;
  }
}
