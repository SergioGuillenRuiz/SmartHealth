import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openDemo, openUserSection, test } from './fixtures';

// El acceso al uso del móvil para estimar el sueño de las noches sin anillo: solo existe en la app de Android. En la web no sale nada; en Android, sin el acceso, la app explica qué lee (solo horas)
// y lleva a los ajustes; con él, dice que lo lee. Aquí se simula lo que daría el sistema (`window.__smartringPhoneAccess`).

type Access = { checked: boolean; supported: boolean; granted: boolean };
const setAccess = (page: Page, value: Access): Promise<void> =>
  page.evaluate((v) => {
    (window as unknown as { __smartringPhoneAccess: { value: Access } }).__smartringPhoneAccess.value = v;
  }, value);

test.describe('uso del móvil', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('en la web no sale nada', async ({ page }) => {
    const goals = await openUserSection(page, 'Objetivos y medición');
    await expect(goals.getByLabel('Afinar el sueño con el uso del móvil')).toHaveCount(0);
    await expect(goals.getByText(/a qué horas usas el móvil/)).toHaveCount(0);
  });

  test('sin el acceso explica qué se lee y qué no, y ofrece ir a los ajustes de Android', async ({ page }) => {
    await setAccess(page, { checked: true, supported: true, granted: false });
    const goals = await openUserSection(page, 'Objetivos y medición');
    const card = goals.getByLabel('Afinar el sueño con el uso del móvil');
    await expect(card).toBeVisible();
    await expect(card).toContainText('solo horas, nunca qué apps ni qué haces, y nada sale del móvil');
    await expect(card.getByRole('button', { name: 'Dar acceso en los ajustes de Android' })).toBeVisible();
    const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(results.violations).toEqual([]);
  });

  test('con el acceso dado lo dice, sin botón', async ({ page }) => {
    await setAccess(page, { checked: true, supported: true, granted: true });
    const goals = await openUserSection(page, 'Objetivos y medición');
    await expect(goals.getByRole('status').filter({ hasText: 'Se lee a qué horas usas el móvil' })).toBeVisible();
    await expect(goals.getByRole('button', { name: 'Dar acceso en los ajustes de Android' })).toHaveCount(0);
  });
});
