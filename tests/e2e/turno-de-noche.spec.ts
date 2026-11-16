import { activePage, expect, goTab, openDemo, openUserSection, test } from './fixtures';

// Las demostraciones de quien duerme de noche y de quien hace turno de noche (`?demo=1&horario=dia`: duerme de ~08:15 a ~18:15, entrena y come de madrugada).

// La «ventana de sueño por noche» (Salud) tenía fijo el origen del eje a las 18:00: con un horario de día las barras salían por encima del gráfico.
for (const [name, url] of [
  ['con horario de noche', '/?demo=1'],
  ['con horario de día', '/?demo=1&horario=dia'],
] as const) {
  test(`Salud: la ventana de sueño por noche cabe entera en el gráfico ${name}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await goTab(page, 'Salud');
    const chart = activePage(page).getByRole('img', { name: /Hora de acostarse y de despertar de las últimas/ });
    await chart.scrollIntoViewIfNeeded();
    await expect(chart).toBeVisible();
    const { svg, bars } = await chart.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        svg: { top: box.top, bottom: box.bottom },
        bars: [...el.querySelectorAll('rect')]
          .filter((r) => r.getAttribute('fill') === 'var(--sleep)')
          .map((r) => {
            const b = r.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom };
          }),
      };
    });
    expect(bars.length).toBeGreaterThan(20);
    const axisBand = 22; // la franja de las fechas, debajo del gráfico
    for (const bar of bars) {
      expect(bar.top).toBeGreaterThanOrEqual(svg.top - 1);
      expect(bar.bottom).toBeLessThanOrEqual(svg.bottom - axisBand + 1);
    }
    // Y las marcas de la hora van en orden, de la primera a la última (no hay un 04:00 al final ni un 18:00 al principio de un horario de día).
    const ticks = await chart.locator('text.plot__tick[text-anchor="end"]').allTextContents();
    expect(ticks.length).toBeGreaterThanOrEqual(4);
  });
}

test('los días empiezan a las 00:00: no hay ajuste de «Inicio del día»', async ({ page }) => {
  await openDemo(page);
  const goals = await openUserSection(page, 'Objetivos y medición');
  await expect(goals.getByRole('group', { name: 'Inicio del día' })).toHaveCount(0);
  await expect(goals.getByRole('radiogroup', { name: 'Objetivo de salud' })).toBeVisible();
});
