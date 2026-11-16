import { activePage, expect, goTab, openDemo, test } from './fixtures';

test('un entrenamiento con el anillo simulado se mide, se revisa y se guarda', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');

  await page.locator('.sports-grid').getByRole('button', { name: 'Caminar' }).click();
  const ready = page.getByRole('dialog', { name: 'Nuevo entrenamiento' });
  await expect(ready).toContainText('Pulso en directo con el anillo');
  await ready.getByRole('button', { name: 'Iniciar' }).click();

  const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
  await expect(live.getByText('En marcha')).toBeVisible({ timeout: 15_000 });
  await expect(live.getByText('Pulso medio')).toBeVisible();
  // El pulso llega del anillo simulado y se muestra como número, no como «—».
  await expect(live.locator('.metric--hero')).toContainText(/\d{2,3}\s*lpm/, { timeout: 10_000 });
  // Con ese pulso la barra de zonas marca una zona (no «Sin zona de pulso»): 110 lpm ya es la zona 1 con cualquier pulso máximo posible.
  const bpm = Number(((await live.locator('.metric--hero').textContent()) ?? '').match(/(\d{2,3})\s*lpm/)?.[1]);
  if (bpm >= 100) await expect(live.getByRole('img', { name: /Zona de pulso [1-5] de 5/ })).toBeVisible();

  // Pausa y reanuda: el cronómetro no avanza en pausa.
  await live.getByRole('button', { name: 'Pausa' }).click();
  await expect(live.getByText('En pausa')).toBeVisible();
  await live.getByRole('button', { name: 'Reanudar' }).click();
  await expect(live.getByText('En marcha')).toBeVisible();

  await live.getByRole('button', { name: 'Terminar' }).click();
  await live.getByRole('button', { name: 'Terminar y revisar' }).click();

  const review = page.getByRole('dialog', { name: 'Entrenamiento terminado' });
  await expect(review).toContainText('Caminar');
  await review.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();

  // El más reciente de la lista es el que acaba de guardarse (empezó hoy; los de la demo son anteriores).
  // La fecha de hoy es la del reloj y la zona del NAVEGADOR de la prueba, no las del proceso (un CI en UTC cruza la medianoche antes).
  const today = (await page.evaluate(() => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date()))).replace('.', '');
  const latest = page.locator('ul.wk-list > li').first();
  await expect(latest).toContainText('Caminar');
  await expect(latest).toContainText(today);
});

test('se puede descartar un entrenamiento sin guardar nada', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');
  await page.locator('.sports-grid').getByRole('button', { name: 'Yoga' }).click();
  await page.getByRole('dialog', { name: 'Nuevo entrenamiento' }).getByRole('button', { name: 'Iniciar' }).click();
  const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
  await expect(live.getByText('En marcha')).toBeVisible({ timeout: 15_000 });
  await live.getByRole('button', { name: 'Terminar' }).click();
  // Descartar es lo más destructivo: va aparte, pide su propia confirmación y no se activa con un toque rápido.
  await live.getByRole('button', { name: 'Descartar sin guardar' }).click();
  await expect(live).toContainText('Se perderán los datos de este entrenamiento');
  await live.getByRole('button', { name: 'Sí, descartar' }).click();
  await expect(live).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Entrenamiento terminado' })).toBeHidden();
  await expect(page.locator('.sports-grid').getByRole('button', { name: 'Yoga' })).toBeEnabled();
});

test('un doble toque en «Terminar» no termina ni descarta el entrenamiento', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');
  await page.locator('.sports-grid').getByRole('button', { name: 'Yoga' }).click();
  await page.getByRole('dialog', { name: 'Nuevo entrenamiento' }).getByRole('button', { name: 'Iniciar' }).click();
  const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
  await expect(live.getByText('En marcha')).toBeVisible({ timeout: 15_000 });

  // El segundo toque cae donde acaba de aparecer la confirmación (según la tipografía del equipo, sobre «Terminar y
  // revisar», sobre «Seguir» o sobre «Descartar sin guardar»). Ninguno de ellos puede terminar ni descartar el
  // entrenamiento: «Terminar y revisar» no se activa hasta pasado un instante y «Descartar» solo pide otra confirmación.
  await live.getByRole('button', { name: 'Terminar', exact: true }).dblclick();
  await page.waitForTimeout(900); // más que el instante de seguridad de las confirmaciones
  await expect(live).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Entrenamiento terminado' })).toBeHidden();
  await expect(live.getByText('En marcha')).toBeVisible();

  // Con calma sí: la confirmación está activa y termina el entrenamiento. Si el segundo toque cambió de pantalla,
  // se vuelve a la de terminar sin más.
  const finish = live.getByRole('button', { name: 'Terminar y revisar' });
  if (!(await finish.isVisible())) {
    const back = live.getByRole('button', { name: 'Volver' });
    if (await back.isVisible()) await back.click();
    else await live.getByRole('button', { name: 'Terminar', exact: true }).click();
  }
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(page.getByRole('dialog', { name: 'Entrenamiento terminado' })).toBeVisible();
});

test('un entrenamiento hecho sin el anillo se añade a mano con su estimación marcada', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');
  await page.getByRole('button', { name: 'Añadir' }).click();
  const sheet = page.getByRole('dialog', { name: 'Añadir entrenamiento' });
  await sheet.getByLabel('Actividad').selectOption('yoga');
  await sheet.getByLabel('Duración (minutos)').fill('30');
  await sheet.getByRole('button', { name: 'Guardar entrenamiento' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();

  const latest = page.locator('ul.wk-list > li').first();
  await expect(latest).toContainText('Yoga');
  await expect(latest).toContainText('30 min');
});

test('el editor de un entreno rechaza distancias y calorías imposibles, que una copia de seguridad no podría restaurar', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');
  await page.getByRole('button', { name: 'Añadir' }).click();
  const add = page.getByRole('dialog', { name: 'Añadir entrenamiento' });
  await add.getByLabel('Actividad').selectOption('cycle');
  await add.getByLabel('Duración (minutos)').fill('45');
  await add.getByRole('button', { name: 'Guardar entrenamiento' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();

  // Se espera a que la lista ya muestre el nuevo (si no, se pulsaría el que había antes en primer lugar).
  const latest = page.locator('ul.wk-list > li').first();
  await expect(latest).toContainText('45 min');
  await latest.getByRole('button').click();
  const detail = page.getByRole('dialog', { name: 'Entrenamiento' });
  await expect(detail).toContainText('45 min');
  await detail.getByText('Corregir distancia o calorías').click();
  const save = detail.getByRole('button', { name: 'Guardar cambios' });

  await detail.getByLabel('Distancia (km)').fill('5000');
  await expect(detail.getByRole('alert')).toContainText('La distancia debe estar entre 0 y 500 km.');
  await detail.getByLabel('Calorías (kcal)').fill('abc');
  await expect(detail.getByRole('alert')).toContainText('Escribe las calorías como un número');
  await expect(save).toBeDisabled(); // no deja guardar hasta corregirlo o vaciarlo

  await detail.getByLabel('Distancia (km)').fill('25');
  await detail.getByLabel('Calorías (kcal)').fill('600');
  await expect(detail.getByRole('alert')).toHaveCount(0);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Cambios guardados' })).toBeVisible();
  await expect(latest).toContainText('25,0 km');
  await expect(latest).toContainText('600 kcal');
});

test('la duración de un entrenamiento manual es obligatoria y razonable', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');
  await page.getByRole('button', { name: 'Añadir' }).click();
  const sheet = page.getByRole('dialog', { name: 'Añadir entrenamiento' });
  await sheet.getByLabel('Duración (minutos)').fill('0');
  await sheet.getByRole('button', { name: 'Guardar entrenamiento' }).click();
  await expect(sheet.getByRole('alert')).toContainText('La duración debe estar entre 1 y 1440 minutos.');
});

test.describe('los deportes y sus datos dependen de lo que ofrece el anillo', () => {
  test('un R99 completo ofrece todo sin avisos', async ({ page }) => {
    await openDemo(page);
    await goTab(page, 'Deportes');
    await expect(page.locator('.sports-grid .sport:enabled')).toHaveCount(12);
    await expect(activePage(page).getByText(/no ofrece/)).toHaveCount(0);
    // Una lista corta de deportes corrientes: con BiciMAD y Senderismo, sin los más raros.
    const grid = page.locator('.sports-grid');
    for (const name of ['Caminar', 'Correr', 'Senderismo', 'Ciclismo', 'BiciMAD', 'Natación', 'Fuerza', 'Yoga', 'Fútbol', 'Baloncesto', 'Tenis', 'Pádel']) {
      await expect(grid.getByRole('button', { name, exact: true })).toBeVisible();
    }
    for (const name of ['HIIT', 'Comba', 'Elíptica', 'Remo', 'Baile', 'Bádminton', 'Tenis de mesa']) {
      await expect(grid.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
  });

  test('antes de la primera sincronización se ofrece todo y se explica por qué', async ({ page }) => {
    await page.goto('/');
    await goTab(page, 'Deportes');
    await expect(activePage(page).getByText('Vincula tu anillo para ajustar los deportes a lo que mide.')).toBeVisible();
    await expect(page.locator('.sports-grid .sport:enabled')).toHaveCount(12);
  });

  test('sin pulso: avisa y el entreno en directo no muestra pulso ni zonas', async ({ page }) => {
    await page.goto('/?demo=1&ring=sin-pulso');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await goTab(page, 'Deportes');
    await expect(activePage(page).getByText(/no ofrece medida de pulso/).first()).toBeVisible();

    await page.locator('.sports-grid').getByRole('button', { name: 'Caminar' }).click();
    const ready = page.getByRole('dialog', { name: 'Nuevo entrenamiento' });
    await expect(ready).toContainText('Sin pulso: tu anillo no lo ofrece');
    await ready.getByRole('button', { name: 'Iniciar' }).click();

    const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
    await expect(live.getByText('En marcha')).toBeVisible({ timeout: 15_000 });
    await expect(live.getByText(/Tu anillo ha rechazado la medida de pulso/)).toBeVisible();
    await expect(live.getByText(/^Pulso/)).toHaveCount(0);
    await expect(live.getByRole('img', { name: /zona de pulso/i })).toHaveCount(0);
    // Pero siguen los pasos (a pie) y las calorías.
    await expect(live.getByText('Pasos', { exact: true })).toBeVisible();
    await expect(live.getByText('Calorías ≈')).toBeVisible();
    await live.getByRole('button', { name: 'Terminar' }).click();
    await live.getByRole('button', { name: 'Descartar' }).click();
  });

  test('sin pulso ni pasos: los deportes solo se pueden añadir a mano', async ({ page }) => {
    await page.goto('/?demo=1&ring=sin-nada');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await goTab(page, 'Deportes');
    await expect(activePage(page).getByText(/solo pueden añadirse a mano/)).toBeVisible();
    await expect(page.locator('.sports-grid .sport:enabled')).toHaveCount(0);

    // Lo manual sigue disponible.
    await page.getByRole('button', { name: 'Añadir' }).click();
    await expect(page.getByRole('dialog', { name: 'Añadir entrenamiento' })).toBeVisible();
  });
});

test.describe('historial de entrenamientos con filtro por día, semana, mes o todos', () => {
  const history = (page: import('@playwright/test').Page) => activePage(page).getByRole('region', { name: 'Entrenamientos' });
  const rows = (page: import('@playwright/test').Page) => history(page).locator('ul.wk-list > li');

  /** Añade un yoga de 30 minutos que empieza ahora (hoy), para tener un entreno de este día, esta semana y este mes. */
  async function addYogaToday(page: import('@playwright/test').Page): Promise<void> {
    await page.getByRole('button', { name: 'Añadir' }).click();
    const sheet = page.getByRole('dialog', { name: 'Añadir entrenamiento' });
    await sheet.getByLabel('Actividad').selectOption('yoga');
    await sheet.getByLabel('Duración (minutos)').fill('30');
    await sheet.getByRole('button', { name: 'Guardar entrenamiento' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();
    await expect(rows(page).first()).toContainText('Yoga');
  }

  test('por defecto salen todos, de más reciente a más antiguo, de veinte en veinte', async ({ page }) => {
    await openDemo(page);
    await goTab(page, 'Deportes');
    await expect(history(page).getByRole('button', { name: 'Todos', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows(page)).toHaveCount(20);
    await history(page).getByRole('button', { name: 'Ver más' }).click();
    await expect.poll(() => rows(page).count()).toBeGreaterThan(20);
    // La demostración tiene unos 34: tras la segunda tanda ya no quedan, el botón desaparece y el foco pasa al primer entreno
    // nuevo (si no, se perdería con el botón).
    await expect(history(page).getByRole('button', { name: 'Ver más' })).toHaveCount(0);
    await expect(rows(page).nth(20).getByRole('button')).toBeFocused();
    // Con «Todos» no hay flechas de periodo ni sumas parciales.
    await expect(history(page).getByRole('button', { name: 'Periodo anterior' })).toHaveCount(0);
    await expect(history(page).locator('.history-totals')).toHaveCount(0);
  });

  test('«Todos» va de más reciente a más antiguo: la primera fila es el último entreno guardado', async ({ page }) => {
    await openDemo(page);
    await goTab(page, 'Deportes');
    const latest = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smartring-demo');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const all = await new Promise<Array<{ startMs: number }>>((resolve, reject) => {
        const request = db.transaction('workouts').objectStore('workouts').getAll();
        request.onsuccess = () => resolve(request.result as Array<{ startMs: number }>);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const startMs = Math.max(...all.map((w) => w.startMs));
      const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' }).format(startMs).replace('.', '');
      const time = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Madrid' }).format(startMs);
      return { day, time };
    });
    const first = rows(page).first();
    await expect(first).toContainText(latest.day);
    await expect(first).toContainText(latest.time);
  });

  test('el día, la semana y el mes traen solo lo de ese periodo, con lo que suman', async ({ page }) => {
    await openDemo(page);
    await goTab(page, 'Deportes');
    await addYogaToday(page);

    const card = history(page);
    // Día: solo el de hoy (la demostración no tiene entrenos hoy), con su suma.
    await card.getByRole('button', { name: 'Día', exact: true }).click();
    await expect(card.getByText('Hoy', { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Yoga');
    await expect(card.locator('.history-totals')).toContainText('1');
    await expect(card.locator('.history-totals')).toContainText('30 min');
    await expect(card.getByRole('button', { name: 'Periodo siguiente' })).toBeDisabled();

    // Semana y mes: incluyen el de hoy y se llaman «esta semana» / «este mes».
    await card.getByRole('button', { name: 'Semana', exact: true }).click();
    await expect(card.getByText('Esta semana')).toBeVisible();
    await expect(rows(page).first()).toContainText('Yoga');
    await card.getByRole('button', { name: 'Mes', exact: true }).click();
    await expect(card.getByText('Este mes')).toBeVisible();
    await expect(rows(page).first()).toContainText('Yoga');

    // El mes anterior ya no lo tiene (la fecha de hoy lleva su mes, así que no puede ser un día parecido de otro mes).
    const today = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' }).format(new Date()).replace('.', '');
    await card.getByRole('button', { name: 'Periodo anterior' }).click();
    await expect(card.getByText('Este mes', { exact: true })).toHaveCount(0);
    await expect(card.locator('.history-totals')).toBeVisible();
    await expect(rows(page).filter({ hasText: today })).toHaveCount(0);
  });

  test('las flechas llevan al periodo anterior y de vuelta, y el día vacío lo dice', async ({ page }) => {
    await openDemo(page);
    await goTab(page, 'Deportes');
    const card = history(page);
    await card.getByRole('button', { name: 'Día', exact: true }).click();
    // En la demostración no hay entrenos hoy.
    await expect(card.getByText('No hay entrenamientos este día.')).toBeVisible();

    await card.getByRole('button', { name: 'Periodo anterior' }).click();
    await expect(card.getByText('Ayer', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Periodo siguiente' })).toBeEnabled();
    await card.getByRole('button', { name: 'Periodo siguiente' }).click();
    await expect(card.getByText('Hoy', { exact: true })).toBeVisible();

    // En un mes pasado hay entrenos (la demostración los reparte cada pocos días) y las flechas del mes saltan de mes en mes.
    await card.getByRole('button', { name: 'Mes', exact: true }).click();
    await card.getByRole('button', { name: 'Periodo anterior' }).click();
    await expect(card.getByText('Este mes', { exact: true })).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
    await expect(card.locator('.history-totals')).toBeVisible();
  });

  test('al cambiar de filtro se parte de hoy, y un entreno abre su detalle', async ({ page }) => {
    await openDemo(page);
    await goTab(page, 'Deportes');
    const card = history(page);
    await card.getByRole('button', { name: 'Semana', exact: true }).click();
    await card.getByRole('button', { name: 'Periodo anterior' }).click();
    await card.getByRole('button', { name: 'Día', exact: true }).click();
    await expect(card.getByText('Hoy', { exact: true })).toBeVisible();

    await card.getByRole('button', { name: 'Todos', exact: true }).click();
    await rows(page).first().getByRole('button').click();
    await expect(page.getByRole('dialog', { name: 'Entrenamiento', exact: true })).toBeVisible();
  });
});
