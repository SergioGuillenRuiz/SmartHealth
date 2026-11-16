import { describe, expect, it, vi } from 'vitest';
import { languageScript, patchedWorker, WORKER_PRELUDE } from './ocr-assets.ts';

// El idioma del lector de fotos NO se sirve como `spa.traineddata.gz` (en el APK daba 404 y la lectura no acababa nunca): va en un `.js` y el trabajador lo contesta él mismo.
// Aquí se ejecuta el código que se le pone delante al trabajador, en un «mundo» de mentira, para ver que contesta con los bytes y deja pasar el resto de peticiones.

interface FakeWorkerScope {
  fetch: (input: unknown) => Promise<Response>;
  __spaTraineddata?: string | null;
}

function runPrelude(gz: Buffer, realFetch: (input: unknown) => Promise<Response>): { scope: FakeWorkerScope; importScripts: ReturnType<typeof vi.fn> } {
  const scope: FakeWorkerScope = { fetch: realFetch };
  const importScripts = vi.fn((url: string) => {
    expect(url).toBe('spa-data.js');
    new Function('self', languageScript(gz))(scope);
  });
  new Function('self', 'importScripts', 'atob', 'Response', 'Uint8Array', 'Promise', WORKER_PRELUDE)(scope, importScripts, atob, Response, Uint8Array, Promise);
  return { scope, importScripts };
}

describe('el idioma del lector de fotos', () => {
  const gz = Buffer.from([0x1f, 0x8b, 8, 0, 255, 0, 1, 2, 3]);

  it('el archivo del idioma deja los bytes en base64 en una variable del trabajador', () => {
    expect(languageScript(Buffer.from([1, 2, 3, 255]))).toBe('self.__spaTraineddata="AQID/w==";\n');
  });

  it('cuando Tesseract pide spa.traineddata.gz, el trabajador contesta con los bytes (sin red)', async () => {
    const realFetch = vi.fn(() => Promise.reject(new Error('no debería salir a la red')));
    const { scope, importScripts } = runPrelude(gz, realFetch);
    const response = await scope.fetch('https://localhost/ocr/spa.traineddata.gz');
    expect(response.ok).toBe(true);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...gz]);
    expect(realFetch).not.toHaveBeenCalled();
    expect(importScripts).toHaveBeenCalledTimes(1);
    expect(scope.__spaTraineddata).toBeNull(); // no deja 2,8 MB de texto en memoria
  });

  it('también contesta si se pide con una petición (Request) o con parámetros en la dirección', async () => {
    const { scope } = runPrelude(gz, vi.fn());
    const byQuery = await scope.fetch('https://localhost/ocr/spa.traineddata.gz?v=3');
    expect(byQuery.ok).toBe(true);
    const byRequest = await scope.fetch({ url: 'https://localhost/ocr/spa.traineddata.gz' });
    expect([...new Uint8Array(await byRequest.arrayBuffer())]).toEqual([...gz]);
  });

  it('otras peticiones siguen su camino', async () => {
    const answer = new Response('hola');
    const realFetch = vi.fn(() => Promise.resolve(answer));
    const { scope, importScripts } = runPrelude(gz, realFetch);
    await expect(scope.fetch('https://localhost/otra-cosa.json')).resolves.toBe(answer);
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(importScripts).not.toHaveBeenCalled();
  });

  it('si el archivo del idioma no se puede cargar, la petición falla (no se queda colgada)', async () => {
    const scope: FakeWorkerScope = { fetch: vi.fn() };
    const importScripts = (): never => {
      throw new Error('no se pudo cargar spa-data.js');
    };
    new Function('self', 'importScripts', 'atob', 'Response', 'Uint8Array', 'Promise', WORKER_PRELUDE)(scope, importScripts, atob, Response, Uint8Array, Promise);
    await expect(scope.fetch('https://localhost/ocr/spa.traineddata.gz')).rejects.toThrow('spa-data.js');
  });

  it('el trabajador lleva el código de arriba delante del suyo, entero', () => {
    const original = '(()=>{/* trabajador de Tesseract */})();\n//# sourceMappingURL=worker.min.js.map';
    const patched = patchedWorker(original);
    expect(patched.startsWith(WORKER_PRELUDE)).toBe(true);
    expect(patched.endsWith(original)).toBe(true);
  });
});
