import { activePage, expect, openDemo, test } from './fixtures';

/** Se ve la pantalla de recuperación en lugar de la app. */
const fatal = (page: import('@playwright/test').Page) => page.getByRole('heading', { name: 'La app no puede seguir' });

test('si una pantalla falla al pintarse no deja la app a medias: hay pantalla de recuperación, y se puede empezar de cero', async ({ page, consoleErrors }) => {
  await openDemo(page);
  await page.goto('/?demo=keep'); // se conservan los datos de la demostración y, al empezar de cero, no se vuelven a sembrar
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await page.getByRole('button', { name: 'Mi perfil' }).click();
  const misDatos = page.getByRole('dialog', { name: 'Mi perfil', exact: true }).locator('.profile-card');
  await expect(misDatos).toBeVisible();
  // Con la app ya en marcha, el formateo de números empieza a fallar (algo que se rompe al pintar una pantalla), pero solo a partir
  // del toque en la tarjeta del perfil: así nada se repinta y se rompe antes. Se usa el formateo de números y no el de fechas porque, con el
  // reloj simulado de las pruebas, el de fechas no es el del navegador.
  await page.evaluate(() => {
    document.addEventListener(
      'click',
      () => {
        Object.defineProperty(Intl.NumberFormat.prototype, 'format', {
          configurable: true,
          get: () => () => {
            throw new RangeError('Invalid number format');
          },
        });
      },
      { capture: true, once: true },
    );
  });

  // «Perfil y datos» pinta el peso y la altura con ese formateo y no puede.
  await misDatos.click();
  await expect(fatal(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Volver a intentarlo' })).toBeVisible();
  await expect(page.getByText('Tus datos siguen guardados en este móvil')).toBeVisible();
  // Los detalles técnicos están a mano (para mandarlos a quien lo arregle).
  await page.getByText('Detalles técnicos').click();
  await expect(page.locator('.fatal__details pre')).not.toBeEmpty();

  // Empezar de cero pide confirmación y, al hacerlo, la app arranca de nuevo, ya sin el dato roto ni lo demás.
  await page.getByRole('button', { name: 'Borrar los datos de la app y empezar de cero' }).click();
  await expect(page.getByText('No se puede deshacer')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar' }).click(); // cancelar no borra nada
  await expect(page.getByRole('button', { name: 'Borrar los datos de la app y empezar de cero' })).toBeVisible();
  await page.getByRole('button', { name: 'Borrar los datos de la app y empezar de cero' }).click();
  await page.getByRole('button', { name: 'Sí, borrar todo' }).click();
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await expect(page.getByText('Sin sueño registrado')).toBeVisible(); // la demostración no se ha vuelto a sembrar: está vacía
  await expect(fatal(page)).toHaveCount(0);

  // Esto de aquí no es un fallo de la app: se ha provocado a propósito (la pantalla de recuperación no escribe en la consola).
  expect(consoleErrors).toEqual([]);
});

test('si la app no puede ni arrancar (la base de datos no se abre), sale la pantalla de recuperación y se arranca tras empezar de cero', async ({ page }) => {
  // El almacén del navegador se niega a abrirse mientras no se quite la marca (como una base de datos de una versión más nueva).
  await page.addInitScript(() => {
    if (sessionStorage.getItem('romper-almacen') === null) sessionStorage.setItem('romper-almacen', '1');
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((name: string, version?: number) => {
      if (name === 'smartring-demo' && sessionStorage.getItem('romper-almacen') === '1') throw new DOMException('El almacén no se puede abrir', 'VersionError');
      return open(name, version);
    }) as typeof indexedDB.open;
  });
  await page.goto('/?demo=1');
  await expect(fatal(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Volver a intentarlo' }).click(); // sigue fallando: vuelve a salir
  await expect(fatal(page)).toBeVisible();

  // Se arregla el almacén (la marca) y, al empezar de cero, la app arranca.
  await page.evaluate(() => sessionStorage.setItem('romper-almacen', '0'));
  await page.getByRole('button', { name: 'Borrar los datos de la app y empezar de cero' }).click();
  await page.getByRole('button', { name: 'Sí, borrar todo' }).click();
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await expect(activePage(page)).toBeVisible();
});
