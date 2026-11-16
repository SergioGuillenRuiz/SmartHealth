// Saca las capturas del README (docs/capturas/) con la app en modo demostración (datos de ejemplo, anillo simulado).
// Uso: npm run build && npx vite preview --port 4173 --host 127.0.0.1 &  y luego  node scripts/capturas.mjs [url]
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4173';
const out = (name) => `docs/capturas/${name}.png`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  locale: 'es-ES',
  timezoneId: 'Europe/Madrid',
  hasTouch: true,
});
const page = await context.newPage();
const settle = () => page.waitForTimeout(900);
const tab = async (name) => {
  await page.locator('nav').getByRole('button', { name }).click();
  await settle();
};

await page.goto(`${base}/?demo=1`);
await page.getByRole('region', { name: 'Actividad diaria' }).waitFor();
await settle();
await page.screenshot({ path: out('resumen') });

// Los detalles de una comida: calorías, valoración y «Cambiar cantidades».
await page.locator('main.pager > section.page:not([inert]) .food-meals__main').first().click();
await page.getByRole('dialog', { name: 'Comida', exact: true }).waitFor();
await settle();
await page.screenshot({ path: out('comida') });
await page.keyboard.press('Escape');
await settle();

await tab('Deportes');
await page.screenshot({ path: out('deportes') });

await tab('Salud');
await page.screenshot({ path: out('salud') });

await tab('Resumen');
await page.getByRole('button', { name: /^Dispositivos:/ }).click();
await page.getByRole('dialog', { name: 'Dispositivos', exact: true }).waitFor();
await settle();
await page.screenshot({ path: out('dispositivos') });

await browser.close();
