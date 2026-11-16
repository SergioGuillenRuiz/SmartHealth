import { downloadTextFile } from '../app/files';
import { isNative, NativeTools } from '../app/native';

export interface SavedFile {
  /** Dirección del fichero guardado (en Android, para reescribirlo y compartirlo); `null` si no hay (descarga del navegador). */
  uri: string | null;
  /** Dónde ha quedado, para decírselo a la persona: «Download/SmartHealth-prueba-….txt». */
  location: string;
}

export interface ReportSaver {
  readonly filename: string;
  /**
   * Guarda el informe. Con `final: false` es un guardado de seguridad a mitad de la prueba: solo donde se puede reescribir
   * el mismo fichero (Android); en el navegador no hace nada y devuelve `null`. Lanza si no se pudo guardar.
   */
  save(text: string, options: { final: boolean }): Promise<SavedFile | null>;
  /** ¿Se puede abrir el menú de compartir del sistema? */
  canShare(): boolean;
  /** Comparte el fichero guardado o, si no hay, `text`. */
  share(text: string): Promise<void>;
}

/**
 * En Android, a la carpeta Descargas con el plugin propio (MediaStore, sin permisos) y reescribiendo siempre el mismo
 * fichero; en el navegador, una descarga normal al final.
 */
export function createReportSaver(filename: string): ReportSaver {
  let last: SavedFile | null = null;
  /** ¿El último guardado que salió bien fue el final? Si no, el fichero es un parcial y se comparte el texto entero. */
  let lastWasFinal = false;

  if (isNative()) {
    return {
      filename,
      async save(text, { final }) {
        const saved = await NativeTools.saveToDownloads({ filename, text, mime: 'text/plain', ...(last?.uri ? { uri: last.uri } : {}) });
        last = { uri: saved.uri, location: saved.location };
        lastWasFinal = final;
        return last;
      },
      canShare: () => true,
      share: (text) => NativeTools.share({ title: 'Informe de la prueba de SmartHealth', mime: 'text/plain', ...(last?.uri && lastWasFinal ? { uri: last.uri } : { text }) }),
    };
  }

  return {
    filename,
    async save(text, { final }) {
      if (!final) return null;
      downloadTextFile(filename, text);
      last = { uri: null, location: `Descargas del navegador/${filename}` };
      return last;
    },
    canShare: () => typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    async share(text) {
      await navigator.share({ title: 'Informe de la prueba de SmartHealth', files: [new File([text], filename, { type: 'text/plain' })] });
    },
  };
}
