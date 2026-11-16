/* SmartHealth · service worker.
 *
 * Precachea la app (lo ligero) para que abra sin conexión; lo pesado se guarda al usarlo por primera vez (los datos viven en IndexedDB, no en la red).
 * La lista de archivos y la versión se inyectan al compilar: ver tools/pwa-precache.ts.
 *
 * Actualizaciones: una versión nueva se instala en segundo plano y NO toma el control sola, para no cambiar
 * el código a mitad de un entrenamiento. La app avisa y, si la persona lo pide, envía SKIP_WAITING.
 */
const VERSION = '__SW_VERSION__';
const PRECACHE = /*__PRECACHE__*/ [];
// Los archivos grandes (la base de productos, el lector de fotos…) NO se bajan al instalar: competirían con el arranque de la app (en un móvil con una red lenta, la primera visita tardaba minutos).
// Se guardan en el caché la primera vez que la app los pide y, desde entonces, funcionan sin red.
const LAZY = new Set(/*__LAZY__*/ []);
const CACHE = `smartring-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('smartring-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (request.mode === 'navigate') {
        // App de una sola página SIN rutas: la raíz del alcance (o index.html) abre la carcasa precacheada, ignorando la
        // query (p. ej. ?demo=1), y así funciona sin red. Cualquier otra ruta no es de la app: devolverle la carcasa
        // dejaría la pantalla en blanco (sus ./assets/… relativos resolverían mal), así que va a la red.
        const scope = new URL(self.registration.scope);
        const isShell = url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`;
        if (isShell) {
          const shell = await cache.match(new URL('./index.html', scope).href);
          if (shell) return shell;
        }
        return fetch(request);
      }
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      const scopePath = new URL(self.registration.scope).pathname;
      if (response.ok && response.status === 200 && url.pathname.startsWith(scopePath) && LAZY.has(`./${url.pathname.slice(scopePath.length)}`)) {
        event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
      }
      return response;
    })(),
  );
});
