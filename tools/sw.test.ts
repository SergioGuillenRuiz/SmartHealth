import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// El service worker es JavaScript plano (public/sw.js); aquí se ejecuta en un entorno simulado para comprobar a qué
// peticiones responde. (Playwright no sirve para esto: su modo «sin red» no afecta a las peticiones del propio worker.)

const SCOPE = 'https://host.example/SmartRing/';
const SHELL = { kind: 'carcasa' };

function loadWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const precached = new Map<string, unknown>([[`${SCOPE}index.html`, SHELL], [`${SCOPE}assets/app.js`, { kind: 'app.js (caché)' }]]);
  const network: string[] = [];
  let networkDown = false;
  const sandbox = {
    URL,
    Request: class {
      constructor(readonly url: string) {}
    },
    self: {
      location: new URL(SCOPE),
      registration: { scope: SCOPE },
      clients: { claim: async () => undefined },
      skipWaiting: async () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, listener),
    },
    caches: {
      open: async () => ({
        match: async (request: string | { url: string }) => precached.get(typeof request === 'string' ? request : request.url),
        addAll: async () => undefined,
      }),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async (request: { url: string }) => {
      network.push(request.url);
      if (networkDown) throw new TypeError('Failed to fetch');
      return { kind: 'red', url: request.url };
    },
  };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), sandbox);

  /** Lanza una petición por el worker. `undefined` = el worker no responde (la maneja el navegador). */
  async function request(url: string, init: { mode?: string; method?: string } = {}): Promise<unknown> {
    let responded: Promise<unknown> | undefined;
    listeners.get('fetch')?.({ request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'navigate' }, respondWith: (promise: Promise<unknown>) => (responded = promise) });
    return responded === undefined ? undefined : responded;
  }
  return { request, network, setNetworkDown: (down: boolean) => (networkDown = down) };
}

describe('service worker: qué peticiones responde', () => {
  it('la raíz de la app abre la carcasa precacheada, también con query, sin tocar la red', async () => {
    const sw = loadWorker();
    sw.setNetworkDown(true);
    expect(await sw.request(SCOPE)).toBe(SHELL);
    expect(await sw.request(`${SCOPE}?demo=1`)).toBe(SHELL);
    expect(await sw.request(`${SCOPE}index.html`)).toBe(SHELL);
    expect(sw.network).toEqual([]);
  });

  it('una ruta que no es de la app NO recibe la carcasa (la pantalla quedaría en blanco): va a la red', async () => {
    const sw = loadWorker();
    expect(await sw.request(`${SCOPE}no-existe/ruta`)).toEqual({ kind: 'red', url: `${SCOPE}no-existe/ruta` });
    expect(sw.network).toEqual([`${SCOPE}no-existe/ruta`]);
    // Sin red, esa navegación falla en vez de mostrar una carcasa rota.
    sw.setNetworkDown(true);
    await expect(sw.request(`${SCOPE}otra`)).rejects.toThrow('Failed to fetch');
  });

  it('los archivos precacheados salen del caché y el resto va a la red', async () => {
    const sw = loadWorker();
    expect(await sw.request(`${SCOPE}assets/app.js`, { mode: 'cors' })).toEqual({ kind: 'app.js (caché)' });
    expect(await sw.request(`${SCOPE}assets/otro.js`, { mode: 'cors' })).toEqual({ kind: 'red', url: `${SCOPE}assets/otro.js` });
  });

  it('no toca lo que no es suyo: otros orígenes y peticiones que no son GET', async () => {
    const sw = loadWorker();
    expect(await sw.request('https://otro.example/x.js', { mode: 'cors' })).toBeUndefined();
    expect(await sw.request(`${SCOPE}assets/app.js`, { mode: 'cors', method: 'POST' })).toBeUndefined();
  });
});
