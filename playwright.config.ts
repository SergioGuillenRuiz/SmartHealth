import { defineConfig, devices } from '@playwright/test';
import { FAKE_CAMERA_FILE } from './tests/e2e/camera';

const port = 4173;

// Las pruebas e2e corren contra la app COMPILADA (`vite preview`), igual que la verá la persona usuaria,
// con el anillo simulado (modo ?demo=1). Chromium ya viene instalado en el entorno: no se descarga nada.
export default defineConfig({
  testDir: 'tests/e2e',
  // Genera el vídeo de la cámara falsa con el que se prueba el escáner de códigos de barras.
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: 'tests/e2e/.artifacts',
  // En el CI los equipos son más lentos (2 núcleos): más margen y dos procesos en paralelo.
  timeout: process.env.CI ? 90_000 : 45_000,
  expect: { timeout: process.env.CI ? 20_000 : 10_000 },
  workers: process.env.CI ? 2 : undefined,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    trace: 'retain-on-failure',
    permissions: ['camera'],
  },
  projects: [
    {
      name: 'movil',
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          args: [
            '--no-sandbox',
            // Una cámara que no existe y que «ve» un código de barras: así el escáner se prueba de punta a punta, con el lector de verdad.
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-video-capture=${FAKE_CAMERA_FILE}`,
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --host 127.0.0.1 --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
