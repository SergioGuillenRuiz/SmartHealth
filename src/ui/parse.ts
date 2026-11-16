/**
 * Quita la unidad escrita detrás del número («118 kg», «2,5 km», «30 min»), pero solo si es una de las que admite el campo.
 * Sin unidad, o con otra que no es de ese campo («118 km» en un peso), el texto queda como está y no se entiende.
 */
function withoutUnit(text: string, units: readonly string[]): string {
  if (units.length === 0) return text;
  const found = new RegExp(`^(.*?\\d)\\s*(?:${units.join('|')})\\.?$`, 'i').exec(text.trim());
  return found?.[1] ?? text;
}

/** Número con coma o punto decimal ("10,5" / "10.5"), con su unidad detrás si el campo la admite. `null` si está vacío o no es un número. */
export function parseDecimal(text: string, units: readonly string[] = []): number | null {
  const clean = withoutUnit(text, units).trim().replace(/\s/g, '').replace(',', '.');
  if (clean === '') return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

/**
 * Como `parseDecimal`, para un campo ENTERO (calorías, minutos…): ahí el punto separa miles, así que «1.500» es mil quinientos
 * y no 1,5 (que se guardaba como 2 kcal sin avisar). «2.5» sigue siendo 2,5: el separador de miles lleva siempre tres cifras.
 */
export function parseWhole(text: string, units: readonly string[] = []): number | null {
  const clean = withoutUnit(text, units).trim().replace(/\s/g, '');
  const thousands = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(clean);
  return parseDecimal(thousands ? clean.replace(/\./g, '') : clean);
}

/** Unidades que se admiten escritas detrás de lo que se teclea en cada campo. */
export const UNITS = {
  kg: ['kg', 'kgs', 'kilos', 'kilo'],
  km: ['km', 'kms', 'kilómetros', 'kilometros'],
  min: ['min', 'mins', 'minutos', 'minuto'],
  kcal: ['kcal', 'kcals', 'calorías', 'calorias', 'cal'],
  cm: ['cm', 'cms', 'centímetros', 'centimetros'],
  m: ['m', 'mts', 'metros', 'metro'],
  g: ['g', 'gr', 'grs', 'gramos', 'gramo'],
  steps: ['pasos', 'paso'],
} as const;

/**
 * La altura en centímetros. La gente escribe «182», «182 cm», pero también «1,82» o «1.82 m»: un número por debajo de 3 es en metros (nadie
 * mide 1,8 cm), y con «m» detrás también. Lo que no se entiende da `null`.
 */
export function parseHeightCm(text: string): number | null {
  const meters = /^(.*?\d)\s*(?:m|mts|metros|metro)\.?$/i.exec(text.trim());
  const plain = parseDecimal(meters?.[1] ?? text, UNITS.cm);
  if (plain === null) return null;
  return meters || (plain > 0 && plain < 3) ? Math.round(plain * 1000) / 10 : plain;
}

/**
 * Una cantidad de líquido en ml. Sin unidad son ml («300»); con ella, «300 ml», «33 cl» o «0,5 l» / «1,5 litros». `null` si no se entiende o no es positiva.
 */
export function parseVolumeMl(text: string): number | null {
  const found = /^\s*(\d[\d.,]*)\s*(ml|mls|mililitros?|cl|cls|centilitros?|l|lt|lts|litros?)?\.?\s*$/i.exec(text);
  if (!found) return null;
  const unit = (found[2] ?? 'ml').toLowerCase();
  const amount = unit.startsWith('l') ? parseDecimal(found[1] ?? '') : parseWhole(found[1] ?? '');
  if (amount === null || amount <= 0) return null;
  const factor = unit.startsWith('c') ? 10 : unit.startsWith('l') ? 1000 : 1;
  return Math.round(amount * factor);
}
