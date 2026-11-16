import { describe, expect, it } from 'vitest';
import { OVERPASS_ENDPOINTS } from '../src/domain/nav/overpass';
import { contentSecurityPolicy, IMAGE_ORIGINS, NETWORK_ORIGINS } from './pwa-precache';

/** La política de contenido que Vite mete en `index.html` (el plugin la inyecta como una etiqueta `<meta>`). */
function policy(native: boolean): Map<string, string[]> {
  const hook = contentSecurityPolicy({ native }).transformIndexHtml as unknown as { handler: () => Array<{ attrs: { content: string } }> };
  const content = hook.handler()[0]?.attrs.content ?? '';
  return new Map(content.split('; ').map((part) => [part.split(' ')[0] as string, part.split(' ').slice(1)]));
}

describe('la política de contenido de la app', () => {
  for (const native of [false, true]) {
    describe(native ? 'en el APK' : 'en la web', () => {
      const csp = policy(native);

      it('solo deja conectar a la propia app, a Open Food Facts (la foto de los productos) y a Overpass (el mapa de la zona), y cargar imágenes de sus dominios', () => {
        const expected = ['https://world.openfoodfacts.org', 'https://overpass-api.de', 'https://overpass.kumi.systems'];
        expect(csp.get('connect-src')).toEqual(["'self'", ...expected]);
        expect(NETWORK_ORIGINS).toEqual(expected);
        expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'https://images.openfoodfacts.org', 'https://static.openfoodfacts.org']);
        expect(IMAGE_ORIGINS.every((origin) => origin.endsWith('.openfoodfacts.org'))).toBe(true);
      });

      it('no carga nada de fuera ni admite eval: parte de «nada» y solo abre lo que la app usa', () => {
        expect(csp.get('default-src')).toEqual(["'none'"]);
        for (const directive of ['script-src', 'style-src', 'font-src', 'worker-src', 'manifest-src']) {
          expect(csp.get(directive)?.some((source) => /^https?:/.test(source)), directive).toBe(false);
        }
        expect(csp.get('script-src')).not.toContain("'unsafe-eval'");
        expect(csp.get('form-action')).toEqual(["'none'"]);
        expect(csp.get('base-uri')).toEqual(["'none'"]);
      });

      it('permite compilar el WebAssembly del lector de códigos de barras', () => {
        expect(csp.get('script-src')).toContain("'wasm-unsafe-eval'");
      });
    });
  }

  it('ni la web ni el APK admiten scripts en línea (el puente de Capacitor entra como script de inicio del WebView, no como script de la página)', () => {
    expect(policy(true).get('script-src')).not.toContain("'unsafe-inline'");
    expect(policy(false).get('script-src')).not.toContain("'unsafe-inline'");
    expect(policy(true).get('script-src')).toEqual(policy(false).get('script-src'));
  });

  it('los servidores de Overpass que usa la app son exactamente los que la política deja', () => {
    const overpass = NETWORK_ORIGINS.filter((origin) => origin.includes('overpass'));
    expect(OVERPASS_ENDPOINTS.map((url) => new URL(url).origin).sort()).toEqual([...overpass].sort());
    expect(OVERPASS_ENDPOINTS.every((url) => url.startsWith('https://'))).toBe(true);
  });
});
