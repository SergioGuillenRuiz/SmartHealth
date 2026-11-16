import { defineConfig, devices } from '@playwright/test';

const port = 4174;

// Pruebas de la compilación PARA BETATESTERS (`vite build --mode beta`, ver `src/app/beta.ts`): se compila aparte, en `dist-beta`, para no pisar la de las pruebas normales, y se abre SIN `?demo=1`
// (como la abrirá un betatester dentro del APK). Se lanza con `npm run e2e:beta`.
export default defineConfig({
  testDir: 'tests/beta',
  outputDir: 'tests/beta/.artifacts',
  timeout: process.env.CI ? 90_000 : 45_000,
  expect: { timeout: process.env.CI ? 20_000 : 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL: process.env.BETA_URL ?? `http://127.0.0.1:${port}`, locale: 'es-ES', timezoneId: 'Europe/Madrid', trace: 'retain-on-failure' },
  projects: [{ name: 'movil', use: { ...devices['Pixel 7'], launchOptions: { args: ['--no-sandbox'] } } }],
  // Con BETA_URL (p. ej. el servidor del ZIP ya arrancado) se prueba ESE servidor en vez de compilar y servir `dist-beta`.
  webServer: process.env.BETA_URL
    ? undefined
    : {
        command: `npx tsc --noEmit && npx vite build --mode beta --outDir dist-beta && npx vite preview --outDir dist-beta --port ${port} --host 127.0.0.1 --strictPort`,
        url: `http://127.0.0.1:${port}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
