import { activePage, expect, goToDayWithWorkouts, goTab, openDemo, openPanel, openUserSection, stepDayBack, test } from './fixtures';

/** «1.044 kcal», «7193 pasos», «28,44 km» → 1044, 7193, 28.44 */
const num = (text: string): number => Number(/[\d.,]+/.exec(text)?.[0]?.replace(/\./g, '').replace(',', '.') ?? 'NaN');

test('el resumen diario muestra lo básico de la actividad, el sueño y el pulso', async ({ page }) => {
  await openDemo(page);
  // Ayer: el día completo más reciente de la demostración, con sueño de la noche anterior.
  await stepDayBack(page);

  // La tarjeta principal: pasos en el anillo y, debajo, calorías, objetivo y distancia.
  const activity = activePage(page).getByRole('region', { name: 'Actividad diaria' });
  await expect(activity.getByRole('img', { name: /pasos de un objetivo de 8000/ })).toBeVisible();
  await expect(activity).toContainText('Pasos');
  await expect(activity).toContainText('kcal');
  await expect(activity).toContainText('km');
  await expect(activity).toContainText('8000');

  // Sueño y pulso, solo con lo esencial: el detalle (fases, mínimos, curva…) está en su hoja.
  const sleep = activePage(page).getByRole('region', { name: 'Sueño' });
  await expect(sleep).toContainText('del objetivo de');
  await expect(sleep).not.toContainText('Profundo');
  const heart = activePage(page).getByRole('region', { name: 'Ritmo cardiaco' });
  await expect(heart).toContainText(/\d+\s*lpm/);
  await expect(heart).not.toContainText('Máximo');
  await expect(heart.getByRole('button', { name: 'Medir ahora' })).toHaveCount(0);
});

test('sin explicaciones de cálculo ni etiquetas de «estimado» en el resumen', async ({ page }) => {
  await openDemo(page);
  await goToDayWithWorkouts(page);
  const resumen = activePage(page);
  for (const text of ['Cómo se calcula', 'Estimado', 'es una estimación', 'aproximada', 'zancada']) {
    await expect(resumen.getByText(text)).toHaveCount(0);
  }
});

test('el Resumen son cuatro tarjetas —actividad, nutrición, pulso y sueño—: ya no hay una de pasos por hora', async ({ page }) => {
  await openDemo(page);
  await stepDayBack(page);
  const resumen = activePage(page);
  await expect(resumen.getByRole('region', { name: 'Pasos por hora' })).toHaveCount(0);
  await expect(resumen.getByRole('button', { name: /pasos por hora/i })).toHaveCount(0);
  await expect(resumen.getByText('Pasos por hora')).toHaveCount(0);
});

test('en el Resumen el orden de lectura es actividad, nutrición, pulso y sueño', async ({ page }) => {
  await openDemo(page);
  await stepDayBack(page);
  const resumen = activePage(page);
  const labels = await resumen.locator('section[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(labels.filter((l) => ['Actividad diaria', 'Nutrición', 'Pasos por hora', 'Ritmo cardiaco', 'Sueño'].includes(l ?? ''))).toEqual(['Actividad diaria', 'Nutrición', 'Ritmo cardiaco', 'Sueño']);

  const heart = await resumen.getByRole('region', { name: 'Ritmo cardiaco' }).boundingBox();
  const sleep = await resumen.getByRole('region', { name: 'Sueño' }).boundingBox();
  expect(heart !== null && sleep !== null && heart.y < sleep.y, 'el pulso se ve encima del sueño').toBe(true);
});

// La tarjeta de actividad ya no cede altura a las de abajo: el anillo de pasos se ve siempre a su tamaño completo (la nutrición es más grande
// y el pulso y el sueño bajan: hay que deslizar para verlos).
for (const [width, height] of [
  [412, 839],
  [360, 740],
] as const) {
  test(`el anillo de pasos mantiene su tamaño en ${width}×${height} y el pulso queda debajo de la nutrición`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openDemo(page);
    await stepDayBack(page);
    const resumen = activePage(page);
    const ring = await resumen.getByRole('img', { name: /pasos de un objetivo/ }).boundingBox();
    expect(ring !== null && ring.width >= 190, 'el anillo no se encoge').toBe(true);
    const food = await resumen.getByRole('region', { name: 'Nutrición', exact: true }).boundingBox();
    const heart = await resumen.getByRole('region', { name: 'Ritmo cardiaco' }).boundingBox();
    expect(food !== null && heart !== null && heart.y >= food.y + food.height - 1, 'el pulso va debajo de la nutrición').toBe(true);
  });
}

test.describe('al tocar un panel se abre su detalle', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
    await stepDayBack(page);
  });

  test('el sueño: las fases de la noche como en Smart Health, con su tiempo y su porcentaje, la duración, los despertares y el análisis', async ({ page }) => {
    // Tocando la tarjeta en cualquier punto.
    await activePage(page).getByRole('region', { name: 'Sueño' }).click();
    const sheet = page.getByRole('dialog', { name: 'Sueño', exact: true });
    await expect(sheet.getByRole('img', { name: /^Fases del sueño de \d\d:\d\d a \d\d:\d\d: profundo .+, ligero .+, REM .+$/ })).toBeVisible();

    // Qué parte de la noche fue profundo, ligero o REM: cada fase con su tiempo y su porcentaje, y entre todas suman la noche.
    const stages = sheet.getByRole('list', { name: 'Fases de la noche' }).getByRole('listitem');
    await expect(stages).toContainText([/Profundo/, /Ligero/, /REM/]);
    for (const name of ['Profundo', 'Ligero', 'REM']) {
      const row = stages.filter({ hasText: name });
      await expect(row).toContainText(/\d+\s*(h|min)/);
      await expect(row).toContainText(/\d+\s*%/);
    }
    const shares = (await stages.locator('.stage-total__pct').allInnerTexts()).map((t) => Number.parseInt(t, 10));
    expect(shares).toHaveLength(3);
    expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 100), 'los porcentajes de las fases suman la noche').toBeLessThanOrEqual(shares.length);
    // El carril «despierto» solo existe si el anillo marca tramos despierto, y entonces lleva su leyenda (el gris del gráfico).
    const hasAwake = (await sheet.locator('svg.plot__svg rect[fill="var(--sleep-awake)"]').count()) > 0;
    await expect(sheet.locator('.stage-awake')).toHaveCount(hasAwake ? 1 : 0);

    // La duración y los despertares, en grande, y una frase sobre cómo fue la noche.
    await expect(sheet.locator('dt', { hasText: 'duración del sueño' })).toHaveCount(1);
    await expect(sheet.locator('dt', { hasText: 'Número de despertares' })).toHaveCount(1);
    await expect(sheet.getByRole('progressbar', { name: /Sueño frente al objetivo/ })).toBeVisible();
    await expect(sheet.getByRole('region', { name: 'Análisis del sueño' })).toContainText(/^Análisis del sueño\s*(Dormiste|Noche corta)/);

    // La hoja es corta: ya no lleva «Durante la noche» ni la curva del pulso de la noche, y las fases van tras el análisis.
    for (const gone of ['Durante la noche', 'Evolución del pulso']) await expect(sheet.getByRole('heading', { name: gone })).toHaveCount(0);
    for (const label of ['Pulso más bajo', 'Pulso medio', 'Oxígeno medio', 'Oxígeno mínimo', 'Tardó en dormirse']) await expect(sheet.locator('dt', { hasText: label })).toHaveCount(0);
    await expect(sheet.getByRole('img', { name: /^Pulso durante la noche/ })).toHaveCount(0);
    await expect(sheet.getByRole('table')).toHaveCount(0);
    const analysisBox = await sheet.getByRole('region', { name: 'Análisis del sueño' }).boundingBox();
    const phasesBox = await sheet.getByRole('region', { name: 'Fases del sueño' }).boundingBox();
    expect(analysisBox && phasesBox && phasesBox.y > analysisBox.y, 'las fases van debajo del análisis').toBe(true);
    // El hipnograma se lee con el teclado (la hoja es larga: con ella desplazable, axe lo exige).
    await expect(sheet.locator('svg.plot__svg[tabindex="0"]')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('el sueño: al tocar el gráfico de fases sale una línea vertical con la hora y la fase del tramo, y se recorre con las flechas', async ({ page }) => {
    const sheet = await openPanel(page, 'Sueño');
    const chart = sheet.getByRole('img', { name: /^Fases del sueño de/ });
    const reading = sheet.locator('.tip');
    const cursor = chart.locator('line.plot__cross');
    await expect(reading).toHaveCount(0);
    await expect(cursor).toHaveCount(0);

    // Solo la hora de acostarse y la de despertar en el eje: lo demás lo dice la lectura al tocar.
    await expect(chart.locator('text.plot__tick')).toHaveCount(2);

    // Al tocar: «08:59 – 09:21», lo que duró y de qué fase era; y la línea del cursor donde se tocó.
    const box = await chart.boundingBox();
    if (!box) throw new Error('el gráfico de fases no tiene caja');
    await chart.click({ position: { x: box.width * 0.3, y: box.height / 2 } });
    await expect(reading).toContainText(/\d\d:\d\d – \d\d:\d\d/);
    await expect(reading).toContainText(/(Profundo|Ligero|REM|Despierto)/);
    await expect(reading).toContainText(/\d+\s*(h|min)/);
    await expect(cursor).toHaveCount(1);
    const first = await reading.innerText();

    // Con las flechas se pasa al tramo siguiente y vuelve; con Escape se quita la lectura sin cerrar la hoja.
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => reading.innerText()).not.toBe(first);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => reading.innerText()).toBe(first);
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await expect(sheet).toBeVisible();
    // Sin lectura que quitar, Esc es de la hoja: la cierra aunque el gráfico siga con el foco.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('el sueño sin fases (el anillo solo da la duración): lo dice y sigue dando el resto de la noche', async ({ page }) => {
    // La misma demostración, pero con cada noche como un único tramo «ligero»: es lo que pasa si el anillo no distingue fases.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smartring-demo');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sleep', 'readwrite');
        const sleep = tx.objectStore('sleep');
        const rows = sleep.getAll();
        rows.onsuccess = () => {
          for (const row of rows.result) sleep.put({ ...row, segments: [{ stage: 'light', startMs: row.startMs, durationSec: Math.round((row.endMs - row.startMs) / 1000) }] });
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.goto('/?demo=keep');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await stepDayBack(page);

    const sheet = await openPanel(page, 'Sueño');
    await expect(sheet).toContainText('no las fases del sueño');
    await expect(sheet.getByRole('list', { name: 'Fases de la noche' })).toHaveCount(0);
    await expect(sheet.getByRole('img', { name: /^Fases del sueño/ })).toHaveCount(0);
    // Pero no se queda vacía: la duración frente al objetivo. Sin gráficos de la noche.
    await expect(sheet.locator('dt', { hasText: 'duración del sueño' })).toHaveCount(1);
    await expect(sheet.getByRole('progressbar', { name: /Sueño frente al objetivo/ })).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Durante la noche', exact: true })).toHaveCount(0);
    await expect(sheet.locator('svg.plot__svg')).toHaveCount(0);
    // Sin fases no se pueden contar los despertares ni analizarlas.
    await expect(sheet.locator('dt', { hasText: 'despertares' })).toHaveCount(0);
    await expect(sheet.getByRole('region', { name: 'Análisis del sueño' })).toHaveCount(0);
  });

  test('el pulso: mínimo, máximo, curva del día y «Medir ahora»', async ({ page }) => {
    const sheet = await openPanel(page, 'Ritmo cardiaco');
    await expect(sheet).toContainText('Mínimo');
    await expect(sheet).toContainText('Máximo');
    await expect(sheet).toContainText('Evolución del día');
    await expect(sheet.getByRole('button', { name: 'Medir ahora' })).toBeVisible();
  });

  test('con el teclado: el botón de la esquina de cada tarjeta abre su detalle', async ({ page }) => {
    for (const [button, dialog] of [
      ['Ver el detalle del sueño', 'Sueño'],
      ['Ver el detalle del ritmo cardiaco', 'Ritmo cardiaco'],
    ] as const) {
      await activePage(page).getByRole('button', { name: button }).focus();
      await page.keyboard.press('Enter');
      const sheet = page.getByRole('dialog', { name: dialog, exact: true });
      await expect(sheet).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }
  });
});

test('la tarjeta de actividad dice qué aporta cada deporte, con sus calorías y su distancia', async ({ page }) => {
  await openDemo(page);
  const parts = await goToDayWithWorkouts(page);
  const rows = await parts.locator('li').all();
  expect(rows.length).toBeGreaterThanOrEqual(2); // andar y, al menos, un deporte
  for (const row of rows) await expect(row).toContainText('kcal');
  // Los entrenos con distancia (carrera, bici…) la enseñan en kilómetros.
  await expect(parts).toContainText('km');
});

test('lo que aporta cada actividad suma las calorías del día y ninguna sale dos veces', async ({ page }) => {
  await openDemo(page);
  let seen = 0;
  for (let day = 0; day < 40 && seen < 3; day++) {
    await stepDayBack(page);
    const strip = page.getByRole('list', { name: 'Actividades del día' });
    if ((await strip.count()) === 0) continue;
    seen++;

    const heroKcal = num((await activePage(page).locator('.hero-stats li').first().innerText()).replace('Calorías activas:', ''));
    const names = (await strip.locator('.hero-sports__name').allInnerTexts()).map((n) => n.trim());
    expect(new Set(names).size, `día ${day + 1}: una actividad sale repetida (${names.join(', ')})`).toBe(names.length);
    // Cada fila se redondea sola, así que como mucho se separan una unidad por fila.
    const kcal = (await strip.locator('.hero-sports__kcal').allInnerTexts()).reduce((sum, t) => sum + num(t), 0);
    expect(Math.abs(kcal - heroKcal), `día ${day + 1}: ${heroKcal} kcal arriba, ${kcal} sumando las actividades`).toBeLessThanOrEqual(names.length);
  }
  expect(seen, 'la demostración tiene días con entrenos').toBeGreaterThan(0);
});

test('la tarjeta de actividad es para mirar: sin botón de detalle, y tocarla no abre ninguna hoja', async ({ page }) => {
  await openDemo(page);
  await goToDayWithWorkouts(page);
  const card = activePage(page).getByRole('region', { name: 'Actividad diaria' });
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(activePage(page).getByRole('button', { name: 'Ver el detalle de la actividad' })).toHaveCount(0);
  await card.click();
  await card.locator('.hero-sports li').first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('el objetivo de pasos solo se cambia desde el menú de perfil y la tarjeta lo refleja', async ({ page }) => {
  await openDemo(page);
  await stepDayBack(page);

  // La tarjeta de actividad es para mirar: ni selector ni barra del objetivo.
  const card = activePage(page).getByRole('region', { name: 'Actividad diaria' });
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(card.getByRole('progressbar')).toHaveCount(0);

  // El objetivo está en el menú de perfil y la tarjeta principal lo enseña al momento.
  const goals = await openUserSection(page, 'Objetivos y medición');
  await goals.getByRole('button', { name: 'Subir pasos al día' }).click();
  await page.keyboard.press('Escape'); // cierra el apartado
  await page.keyboard.press('Escape'); // cierra el menú
  await expect(activePage(page).getByRole('img', { name: /pasos de un objetivo de 8500/ })).toBeVisible();
  await expect(activePage(page).locator('.hero-stats li').nth(1)).toContainText('8500');
});

test('sin datos no se inventan cifras: avisa de que falta sincronizar y de que el perfil es genérico', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Vincula tu anillo para traer tus pasos, sueño y pulso.')).toBeVisible();
  await expect(page.getByText('Sin datos de actividad')).toBeVisible();
  await expect(page.getByText('Sin sueño registrado')).toBeVisible();
  await expect(page.getByText('Sin lecturas de pulso')).toBeVisible();

  // Los datos personales están en el menú de perfil.
  const data = await openUserSection(page, 'Mis datos');
  await expect(data.getByText('Completa tu perfil', { exact: true })).toBeVisible();
  await expect(data.getByRole('button', { name: 'Introducir mis datos' })).toBeVisible();
});

test('«Completar» el perfil desde el aviso del Resumen abre directamente el formulario', async ({ page }) => {
  // La demostración con el perfil borrado: hay actividad (y por tanto aviso de perfil genérico) pero ninguna entrada de perfil.
  await openDemo(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smartring-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('profile', 'readwrite');
      tx.objectStore('profile').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto('/?demo=keep');
  await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
  await expect(page.getByText('Completa tu perfil para afinar la distancia y las calorías.')).toBeVisible();
  await page.getByRole('button', { name: 'Completar' }).click();
  await expect(page.getByRole('dialog', { name: 'Actualizar mis datos' })).toBeVisible();
});

test('si hay entrenos que se solapan, la tarjeta principal lo avisa sin abrir el detalle', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');
  // Dos entrenos manuales idénticos (mismo momento y duración): uno está repetido.
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Añadir' }).click();
    const sheet = page.getByRole('dialog', { name: 'Añadir entrenamiento' });
    await sheet.getByLabel('Actividad').selectOption('yoga');
    await sheet.getByLabel('Duración (minutos)').fill('30');
    await sheet.getByRole('button', { name: 'Guardar entrenamiento' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();
    await expect(sheet).toBeHidden();
  }
  await goTab(page, 'Resumen');
  await expect(activePage(page).getByText(/Hay entrenamientos que se solapan/)).toBeVisible();
});
