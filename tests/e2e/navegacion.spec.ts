import { activePage, expect, goTab, goToDayWithWorkouts, nav, openDemo, test } from './fixtures';

test('las tres pestañas se alcanzan con la barra inferior', async ({ page }) => {
  await openDemo(page);
  await expect(nav(page).getByRole('button', { name: 'Resumen' })).toHaveAttribute('aria-current', 'page');

  await goTab(page, 'Deportes');
  await expect(page.getByRole('heading', { name: 'Deportes', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Elige una actividad' })).toBeVisible();

  await goTab(page, 'Salud');
  await expect(page.getByRole('heading', { name: 'Salud y evolución', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Evolución', exact: true })).toBeVisible();

  await goTab(page, 'Resumen');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
});

test('también se cambia de pestaña deslizando el dedo lateralmente', async ({ page }) => {
  await openDemo(page);
  const client = await page.context().newCDPSession(page);
  const swipe = (xDistance: number, y = 420): Promise<unknown> =>
    // Gesto de desplazamiento real: pasa por el compositor y por el ajuste de scroll-snap, no es un scrollTo
    // programático. (Chromium sin interfaz no sintetiza bien el origen «touch»; este recorre el mismo camino.)
    client.send('Input.synthesizeScrollGesture', { x: 300, y, xDistance, speed: 800 });

  await swipe(-300);
  await expect(nav(page).getByRole('button', { name: 'Deportes' })).toHaveAttribute('aria-current', 'page');
  await swipe(-300);
  await expect(nav(page).getByRole('button', { name: 'Salud' })).toHaveAttribute('aria-current', 'page');
  // Se vuelve deslizando desde la cabecera de la pestaña: un deslizamiento lateral que empieza sobre un gráfico de Salud es del gráfico (arrastra su barra de lectura por los días;
  // `salud.spec.ts` lo comprueba con el dedo), no del carrusel.
  await swipe(300, 140);
  await expect(nav(page).getByRole('button', { name: 'Deportes' })).toHaveAttribute('aria-current', 'page');
  // Y queda encajada exactamente en su página, no a medias.
  await expect.poll(() => page.locator('main.pager').evaluate((el) => el.scrollLeft)).toBe(412);
});

test('las pestañas ocultas no reciben foco ni lectores de pantalla', async ({ page }) => {
  await openDemo(page);
  // Solo la página activa es alcanzable: el resto está `inert`.
  await expect(page.locator('main.pager > section.page[inert]')).toHaveCount(2);
  await goTab(page, 'Salud');
  await expect(page.locator('main.pager > section.page[inert]')).toHaveCount(2);
  await expect(page.locator('main.pager > section.page:not([inert])')).toHaveAttribute('aria-label', 'Salud y evolución');
});

test('se navega por los días sin pasar de hoy', async ({ page }) => {
  await openDemo(page);
  const next = page.getByRole('button', { name: 'Día siguiente' });
  await expect(next).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Hoy,/ })).toBeVisible();

  await page.getByRole('button', { name: 'Día anterior' }).click();
  await expect(page.getByRole('button', { name: /^Ayer,/ })).toBeVisible();
  await expect(next).toBeEnabled();

  await next.click();
  await expect(page.getByRole('button', { name: /^Hoy,/ })).toBeVisible();
});

for (const width of [412, 360]) {
  test(`ninguna pestaña desborda en horizontal con ${width} px (si no, el móvil encoge la página)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await openDemo(page);
    for (const tab of ['Resumen', 'Deportes', 'Salud'] as const) {
      await goTab(page, tab);
      const m = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(m.scroll, `${tab}: el documento no debe ser más ancho que la pantalla`).toBeLessThanOrEqual(m.client);
      expect(m.inner, `${tab}: el viewport de maquetación debe ser el de la pantalla`).toBe(m.client);
    }
  });
}

test('el botón de perfil, arriba a la izquierda, abre el menú con la tarjeta del perfil y sus tres apartados desde cualquier pestaña', async ({ page }) => {
  await openDemo(page);
  for (const tab of ['Resumen', 'Deportes', 'Salud'] as const) {
    await goTab(page, tab);
    await page.getByRole('button', { name: 'Mi perfil' }).click();
    const menu = page.getByRole('dialog', { name: 'Mi perfil', exact: true });
    await expect(menu.locator('.profile-card')).toBeVisible();
    for (const name of ['Objetivos y medición', 'Mis productos', 'Datos y copias de seguridad']) {
      await expect(menu.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(menu.getByRole('button', { name: /^Mis datos/ })).toHaveCount(0); // los datos personales van dentro del perfil
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
  // Está a la izquierda del todo y el del anillo a la derecha.
  const user = await page.getByRole('button', { name: 'Mi perfil' }).boundingBox();
  const ring = await page.getByRole('button', { name: /^Dispositivos:/ }).boundingBox();
  expect(user && ring && user.x < ring.x).toBe(true);
});

test('los apartados del menú se abren encima y, al cerrarlos, vuelve el menú', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Mi perfil' }).click();
  const menu = page.getByRole('dialog', { name: 'Mi perfil', exact: true });
  await menu.locator('.profile-card').click();
  const data = page.getByRole('dialog', { name: 'Perfil y datos', exact: true });
  await expect(data).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(data).toBeHidden();
  await expect(menu).toBeVisible();
  // El menú enseña lo más útil de cada apartado sin abrirlo.
  await expect(menu).toContainText('79,8 kg');
  await expect(menu).toContainText('8000 pasos');
  await expect(menu).toContainText('Perder peso'); // el objetivo de salud de la demostración
  await expect(menu).toContainText('Aún no has exportado ninguna copia');
});

test('con 360 px, el desglose del Resumen y el historial de Deportes con datos no desbordan', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openDemo(page);
  await goToDayWithWorkouts(page);
  const overflow = (): Promise<number> => activePage(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await overflow(), 'Resumen con el desglose').toBeLessThanOrEqual(0);

  await goTab(page, 'Deportes');
  const card = activePage(page).getByRole('region', { name: 'Entrenamientos' });
  for (const period of ['Mes', 'Todos']) {
    await card.getByRole('button', { name: period, exact: true }).click();
    // A primeros de mes (o de semana) el periodo puede no tener aún ningún entreno: sale el aviso de vacío, que tampoco debe desbordar.
    await expect(card.locator('ul.wk-list > li').first().or(card.getByText('Sin entrenamientos'))).toBeVisible();
    expect(await overflow(), `Deportes, ${period}`).toBeLessThanOrEqual(0);
  }
});
