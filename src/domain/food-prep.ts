// Cómo está lo que se pesa: crudo, cocido o con qué se ha cocinado. El analizador de texto ya entiende estas palabras («pechuga de pollo en crudo», «salmón a la plancha»): el selector del paso de
// pesar solo las añade al final de lo escrito, para que la persona no tenga que escribirlas. Pesar crudo o cocinado cambia las calorías por gramo (el arroz crudo tiene casi tres veces las del
// cocido) y la plancha, el horno y la fritura suman el aceite que se usa.

export type PrepId = 'crudo' | 'cocido' | 'plancha' | 'horno' | 'frito';

export interface PrepOption {
  id: PrepId;
  /** Lo que lleva el botón. */
  label: string;
  /** El icono propio de la forma de cocinar (`icon-custom.ts`): cada una se reconoce de un vistazo, también sin leer. */
  icon: string;
  /** Lo que se añade al texto: sin género («en crudo», «frito» vale para pollo y para patata) para que valga con cualquier alimento. */
  phrase: string;
}

export const PREP_OPTIONS: readonly PrepOption[] = [
  { id: 'crudo', icon: 'prep-raw', label: 'Crudo', phrase: 'en crudo' },
  { id: 'cocido', icon: 'prep-boiled', label: 'Cocido', phrase: 'cocido' },
  { id: 'plancha', icon: 'prep-pan', label: 'Plancha', phrase: 'a la plancha' },
  { id: 'horno', icon: 'prep-oven', label: 'Horno', phrase: 'al horno' },
  { id: 'frito', icon: 'prep-fried', label: 'Frito', phrase: 'frito' },
];

/** Lo escrito con la preparación elegida detrás («arroz» + crudo → «arroz en crudo»); sin preparación, lo escrito tal cual. */
export function withPrep(text: string, prep: PrepId | null): string {
  const typed = text.trim();
  if (prep === null) return typed;
  const option = PREP_OPTIONS.find((o) => o.id === prep);
  return option ? `${typed} ${option.phrase}` : typed;
}
