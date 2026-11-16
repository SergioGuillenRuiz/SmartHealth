import type { Page } from '@playwright/test';
import { activePage, expect, goTab, goToDayWithWorkouts, openDemo, openPanel, openUserSection, test } from './fixtures';

/** Regla del proyecto: los datos nunca se representan con tablas (ni `<table>` ni roles de tabla). */
const TABLES = 'table, [role="table"], [role="grid"], [role="treegrid"], [role="row"], [role="columnheader"], [role="cell"]';

const noTables = async (page: Page, where: string): Promise<void> => {
  expect(await page.locator(TABLES).count(), `hay una tabla en ${where}`).toBe(0);
  await expect(page.getByRole('button', { name: /como tabla/i })).toHaveCount(0);
};

test('ninguna pantalla representa datos en tablas', async ({ page }) => {
  await openDemo(page);

  // Resumen: la tarjeta principal y cada hoja de detalle (en un día con entrenos y en uno con sueño y pulso).
  await goToDayWithWorkouts(page);
  await noTables(page, 'el Resumen');
  for (const panel of ['Sueño', 'Ritmo cardiaco'] as const) {
    await openPanel(page, panel);
    await noTables(page, `la hoja «${panel}»`);
    await page.keyboard.press('Escape');
  }

  // Deportes: la lista, el historial (con cada periodo) y el detalle de un entreno.
  await goTab(page, 'Deportes');
  await noTables(page, 'Deportes');
  const card = activePage(page).getByRole('region', { name: 'Entrenamientos' });
  for (const period of ['Día', 'Semana', 'Mes']) {
    await card.getByRole('button', { name: period, exact: true }).click();
    await noTables(page, `el historial por ${period.toLowerCase()}`);
  }
  await card.getByRole('button', { name: 'Todos', exact: true }).click();
  await activePage(page).locator('ul.wk-list > li button').first().click();
  await expect(page.getByRole('dialog', { name: 'Entrenamiento', exact: true })).toBeVisible();
  await noTables(page, 'el detalle de un entreno');
  await page.keyboard.press('Escape');

  // Salud: la evolución en cada periodo, con el sueño y el oxígeno.
  await goTab(page, 'Salud');
  const hero = activePage(page).getByRole('region', { name: 'Evolución', exact: true });
  const bar = activePage(page).getByRole('group', { name: 'Periodo de todos los gráficos' });
  for (const period of ['7 días', '30 días', '90 días', '1 año', 'Todo']) {
    await bar.getByRole('button', { name: period, exact: true }).click();
    await expect(bar.getByRole('button', { name: period, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(hero.getByRole('img', { name: /^Evolución entre el/ })).toBeVisible();
    await expect(activePage(page).locator('figure.chart.is-stale')).toHaveCount(0);
    await noTables(page, `Salud (${period})`);
  }

  // Menú de perfil y sus apartados, y la hoja del anillo.
  for (const section of ['Mis datos', 'Objetivos y medición', 'Mis productos', 'Datos y copias de seguridad'] as const) {
    await openUserSection(page, section);
    await noTables(page, `«${section}»`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: /^Dispositivos:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Dispositivos' })).toBeVisible();
  await noTables(page, 'la hoja del anillo');
});
