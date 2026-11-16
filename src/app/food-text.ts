import { FOOD_SOURCES } from '../data/foods/sources';
import { parseFoodTables, type FoodEntry } from '../domain/food-table';
import { analyzeMealText, MAX_TEXT_CHARS, type ProductLookup, type TextAnalysis } from '../domain/food-text';

// Anotar una comida con palabras («dos huevos revueltos con una tostada y un café con leche»): se calcula con la tabla de alimentos de
// la app (`src/data/foods/alimentos.txt`), sin internet ni IA. Ver `src/domain/food-text.ts` para lo que entiende y lo que no.

let table: readonly FoodEntry[] | null = null;

/** La tabla de alimentos, leída la primera vez que hace falta. */
export function foodTable(): readonly FoodEntry[] {
  table ??= parseFoodTables(FOOD_SOURCES);
  return table;
}

export type TextResult = { status: 'ok'; analysis: TextAnalysis } | { status: 'error'; message: string };

/**
 * Calcula lo que dice `text`, con la tabla de alimentos y —si se da `lookup`— buscando en la base de productos lo que la tabla no entiende. Nunca
 * lanza: lo que no se puede calcular vuelve como `{ status: 'error' }` con un mensaje para la persona.
 */
export function estimateMealFromText(text: string, lookup?: ProductLookup): TextResult {
  const prompt = text.trim();
  if (prompt === '') return { status: 'error', message: 'Escribe qué has comido.' };
  if (prompt.length > MAX_TEXT_CHARS) return { status: 'error', message: `El texto es demasiado largo: cuéntalo en menos de ${MAX_TEXT_CHARS.toLocaleString('es-ES')} letras.` };
  const analysis = analyzeMealText(prompt, foodTable(), lookup);
  if (analysis.items.length > 0) return { status: 'ok', analysis };
  const unknown = analysis.unknown.slice(0, 4).map((phrase) => `«${phrase}»`);
  return {
    status: 'error',
    message:
      unknown.length > 0
        ? `No he reconocido ningún alimento (${unknown.join(', ')}). Prueba con otras palabras («huevos», «arroz», «café con leche»), escribe sus calorías detrás («${analysis.unknown[0] ?? 'tarta'} 350 kcal») o anótalo a mano.`
        : 'No he encontrado comida en ese texto. Escribe los alimentos, por ejemplo «dos huevos y un café con leche».',
  };
}

export { draftOfAnalysis } from '../domain/food-text';
export type { TextAnalysis, TextItem } from '../domain/food-text';
