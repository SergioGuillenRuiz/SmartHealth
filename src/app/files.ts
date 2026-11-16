import { isNative, NativeTools } from './native';

/** Dónde ha quedado un fichero guardado: lo que se le dice a la persona. */
export interface SavedFile {
  /** Dirección del fichero (en Android, para reescribirlo o compartirlo); `null` si no hay (descarga del navegador). */
  uri: string | null;
  /** Dónde ha quedado, legible: «Download/smarthealth-copia-2026-10-13.json». */
  location: string;
}

/** Descarga un texto como fichero en el navegador (lo que hace «Guardar enlace como…» sin pedir nada). */
export function downloadTextFile(filename: string, text: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Guarda un texto como un fichero que la persona pueda encontrar. En la app de Android va a la carpeta Descargas con el
 * plugin propio (MediaStore, sin permisos): el WebView ignora en silencio las descargas de un enlace `download`, así que con
 * eso solo la copia de seguridad parecería haberse guardado sin que existiera ningún fichero. En el navegador, una descarga
 * normal. Lanza si no se pudo guardar (Android anterior a 10, sin espacio…).
 */
export async function saveTextFile(filename: string, text: string, mime: string): Promise<SavedFile> {
  if (isNative()) {
    const saved = await NativeTools.saveToDownloads({ filename, text, mime });
    return { uri: saved.uri, location: saved.location };
  }
  downloadTextFile(filename, text, mime);
  return { uri: null, location: `Descargas del navegador/${filename}` };
}
