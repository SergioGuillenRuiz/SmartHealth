import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Lo que pesa más que esto no se precachea al instalar el service worker: se guarda al usarlo por primera vez (ver `public/sw.js`). */
export const LAZY_OVER_BYTES = 1_500_000;

/**
 * Inyecta en `sw.js` (copiado de /public) la lista de archivos a precachear y una versión derivada de su
 * contenido: si no cambia ningún archivo, la versión no cambia y el navegador no reinstala nada.
 */
export function pwaPrecache(): Plugin {
  let outDir = '';
  return {
    name: 'smartring-pwa-precache',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = walk(outDir)
        .map((full) => relative(outDir, full).split(sep).join('/'))
        .filter((path) => path !== 'sw.js' && !path.endsWith('.map'))
        .sort();
      const hash = createHash('sha256');
      for (const path of files) hash.update(path).update(readFileSync(join(outDir, path)));
      const swPath = join(outDir, 'sw.js');
      const source = readFileSync(swPath, 'utf8');
      if (!source.includes('__SW_VERSION__') || !source.includes('/*__PRECACHE__*/ []') || !source.includes('/*__LAZY__*/ []')) {
        throw new Error('sw.js no contiene los marcadores de precaché esperados.');
      }
      const heavy = files.filter((path) => statSync(join(outDir, path)).size > LAZY_OVER_BYTES);
      const light = files.filter((path) => !heavy.includes(path));
      writeFileSync(
        swPath,
        source
          .replace('__SW_VERSION__', hash.digest('hex').slice(0, 12))
          .replace('/*__PRECACHE__*/ []', JSON.stringify(light.map((path) => `./${path}`)))
          .replace('/*__LAZY__*/ []', JSON.stringify(heavy.map((path) => `./${path}`))),
      );
    },
  };
}

/**
 * Los sitios de internet con los que puede hablar la app, SOLO dos servicios y cada uno para una cosa: Open Food Facts, para la foto de los productos que se anotaron con su código de barras
 * (`app/product-image.ts`; hasta entonces la app no usaba internet); y OpenStreetMap a través de Overpass (`overpass-api.de` y, de respaldo, `overpass.kumi.systems`), de donde se baja el mapa de
 * la zona en que está la persona al navegar (`app/nav/area-download.ts`; ronda 39: antes el mapa iba dentro del APK y pesaba demasiado). `NETWORK_ORIGINS` es lo que puede consultar
 * (`connect-src`) e `IMAGE_ORIGINS` de dónde puede cargar las fotos (`img-src`). Cualquier destino nuevo hay que añadirlo aquí, en el permiso del APK y en el control del CI, los tres a propósito.
 */
export const NETWORK_ORIGINS: readonly string[] = ['https://world.openfoodfacts.org', 'https://overpass-api.de', 'https://overpass.kumi.systems'];
export const IMAGE_ORIGINS: readonly string[] = ['https://images.openfoodfacts.org', 'https://static.openfoodfacts.org'];

/**
 * Política de seguridad de contenido de la app compilada: no carga nada de fuera (ni scripts, ni estilos, ni
 * fuentes) y no admite scripts en línea; de datos solo sale el código de barras de un producto hacia Open Food Facts, de donde vienen sus fotos (`IMAGE_ORIGINS`), la zona aproximada en que está la persona hacia Overpass al navegar y, si la persona lo activa, la copia de seguridad hacia su Google Drive (`NETWORK_ORIGINS`). Defensa en profundidad para una app que
 * maneja datos de salud. Solo en el build: el servidor de desarrollo inyecta código en línea para recargar en caliente.
 */
const policy = (_native: boolean): string => [
  "default-src 'none'",
  // Sin scripts en línea tampoco en el APK (ronda 43, auditoría de seguridad): Capacitor inyecta su puente como «script de inicio de documento» del WebView (ni siquiera pasa por la política) en
  // todos los WebView modernos (`WebViewFeature.DOCUMENT_START_SCRIPT`, Android System WebView ≥ 75 aprox.); el script en línea solo era el recurso de los WebView antiguos. Lo mismo que en la web:
  // ni scripts de fuera ni `eval`. 'wasm-unsafe-eval' solo permite compilar el WebAssembly propio de la app (el lector de códigos de barras y el lector de fotos): no habilita `eval` ni `new Function`.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  ["img-src", "'self'", 'data:', ...IMAGE_ORIGINS].join(' '),
  "font-src 'self'",
  ['connect-src', "'self'", ...NETWORK_ORIGINS].join(' '),
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function contentSecurityPolicy(options: { native?: boolean } = {}): Plugin {
  return {
    name: 'smartring-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy(options.native === true) }, injectTo: 'head-prepend' }],
    },
  };
}
