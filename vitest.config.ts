import { defineConfig } from 'vitest/config';

// Las pruebas de tiempo dependen de la zona horaria; se fija para que sean deterministas en
// cualquier máquina. La app en sí usa la zona del dispositivo en ejecución.
process.env.TZ = 'Europe/Madrid';

export default defineConfig({
  // Constantes que en la app compilada inyecta Vite (ver `vite.config.ts`).
  define: { __BUILD_ID__: JSON.stringify('prueba'), __BUILD_TIME__: JSON.stringify('2026-01-01T00:00:00.000Z') },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tools/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
