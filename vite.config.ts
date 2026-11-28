import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { ocrAssets } from './tools/ocr-assets.ts';
import { contentSecurityPolicy, pwaPrecache } from './tools/pwa-precache.ts';

export default defineConfig(({ mode }) => ({
  // Rutas relativas: la app funciona igual en la raíz de un dominio o en un subdirectorio.
  base: './',
  // `vite build --mode native` es la compilación que se mete en el APK de Android (ver `npm run build:native`); `--mode beta`, la versión WEB para betatesters (ver `src/app/beta.ts` y `beta-web/`).
  plugins: [preact(), ocrAssets(), pwaPrecache(), contentSecurityPolicy({ native: mode === 'native' })],
  define: {
    // Para saber qué compilación produjo un informe de pruebas.
    __BUILD_ID__: JSON.stringify(process.env.BUILD_ID?.slice(0, 7) ?? 'local'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Las ilustraciones de las comidas (130 SVG de 1-15 KB, `ui/food-photos/`) van como archivos aparte, no como texto dentro del código: el código de arranque no crece medio megabyte.
    assetsInlineLimit: (file) => (/[\\/]food-photos[\\/]/.test(file) ? false : undefined),
  },
}));
