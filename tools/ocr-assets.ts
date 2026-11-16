import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// Lo que necesita el lector de etiquetas (OCR, `src/app/label-ocr.ts`) para funcionar SIN internet: el trabajador de Tesseract, su núcleo de WebAssembly y los datos del
// español. Van dentro de la app, en `ocr/`.
//
// Los datos del idioma NO van como `spa.traineddata.gz`: en el APK ese archivo daba 404 (el servidor local de Android lo servía vacío) y la lectura se quedaba esperando para siempre.
// Los archivos `.js` sí se sirven bien (el núcleo, de 3,9 MB, es uno), así que el idioma va dentro de `ocr/spa-data.js` (los bytes del `.gz` en base64) y el trabajador lleva delante
// unas líneas (`WORKER_PRELUDE`) que contestan con ellos cuando Tesseract pide `spa.traineddata.gz`, sin salir a ninguna red.

const NODE_MODULES_ROOT = '../node_modules/';
const WORKER = `${NODE_MODULES_ROOT}tesseract.js/dist/worker.min.js`;
const CORE = `${NODE_MODULES_ROOT}tesseract.js-core/tesseract-core-simd-lstm.wasm.js`;
const LANGUAGE = `${NODE_MODULES_ROOT}@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz`;

const read = (from: string): Buffer => readFileSync(fileURLToPath(new URL(from, import.meta.url)));

/** El archivo con los datos del español: un `.js` que deja los bytes del `.gz` (en base64) en una variable del trabajador. */
export function languageScript(gz: Buffer): string {
  return `self.__spaTraineddata="${gz.toString('base64')}";\n`;
}

/**
 * Lo que va antes del código del trabajador de Tesseract: cuando pide `…/spa.traineddata.gz`, carga `spa-data.js` (junto al trabajador) y contesta con esos bytes como si fueran la
 * respuesta de la red. Cualquier otra petición sigue su camino.
 */
export const WORKER_PRELUDE = `(function () {
  var realFetch = self.fetch;
  self.fetch = function (input) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/\\/spa\\.traineddata\\.gz(\\?|$)/.test(url)) {
      try {
        if (!self.__spaTraineddata) importScripts('spa-data.js');
        var text = atob(self.__spaTraineddata);
        self.__spaTraineddata = null;
        var bytes = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return Promise.resolve(new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return realFetch.apply(self, arguments);
  };
})();
`;

/** El trabajador de Tesseract con {@link WORKER_PRELUDE} delante. */
export function patchedWorker(original: string): string {
  return WORKER_PRELUDE + original;
}

interface OcrFile {
  name: string;
  type: string;
  build: () => Buffer | string;
}

const FILES: ReadonlyArray<OcrFile> = [
  { name: 'worker.min.js', type: 'text/javascript', build: () => patchedWorker(read(WORKER).toString('utf8')) },
  { name: 'tesseract-core-simd-lstm.wasm.js', type: 'text/javascript', build: () => read(CORE) },
  { name: 'spa-data.js', type: 'text/javascript', build: () => languageScript(read(LANGUAGE)) },
];

export function ocrAssets(): Plugin {
  return {
    name: 'smartring-ocr-assets',
    // En la compilación, los archivos entran en el paquete (antes de que la lista de precaché se calcule: ver `pwaPrecache`).
    generateBundle() {
      for (const { name, build } of FILES) this.emitFile({ type: 'asset', fileName: `ocr/${name}`, source: build() });
    },
    // En desarrollo se sirven desde `node_modules`.
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = /\/ocr\/([^/?]+)/.exec(request.url ?? '')?.[1];
        const file = FILES.find((f) => f.name === name);
        if (file === undefined) return next();
        response.setHeader('Content-Type', file.type);
        response.end(file.build());
        return undefined;
      });
    },
  };
}
