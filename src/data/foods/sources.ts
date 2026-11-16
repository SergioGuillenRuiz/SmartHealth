// Los archivos de la tabla de alimentos (`alimentos*.txt`, uno por familia de alimentos), tal cual: se leen con `parseFoodTables`.
// Añadir un archivo nuevo a la carpeta basta: se recoge solo.
export const FOOD_SOURCES: Readonly<Record<string, string>> = import.meta.glob('./alimentos*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
