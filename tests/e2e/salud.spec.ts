import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { activePage, expect, goTab, nav, openDemo, openUserSection, savedProfile, test } from './fixtures';

test.describe('Salud y evolución', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
    await goTab(page, 'Salud');
  });

  const evolution = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Evolución', exact: true });
  const jointChart = (page: Page): Locator => evolution(page).getByRole('img', { name: /^Evolución entre el/ });
  /** El gráfico conjunto entero: su dibujo y, si se desliza (más días de los que caben), la capa fija con sus títulos, sus referencias y los números del eje, que va a su lado. */
  const jointPlot = (page: Page): Locator => evolution(page).locator('.plot').filter({ has: page.getByRole('img', { name: /^Evolución entre el/ }) });
  /** La regleta del periodo: está fuera de los paneles, flotante, y vale para todos los gráficos de la pestaña. */
  const periodBar = (page: Page): Locator => activePage(page).getByRole('group', { name: 'Periodo de todos los gráficos' });
  /** Elige un periodo y espera a que el gráfico conjunto ya sea el de ese periodo (los datos llegan después de tocar). */
  const choosePeriod = async (page: Page, label: string): Promise<void> => {
    const before = await jointChart(page).getAttribute('aria-label');
    const button = periodBar(page).getByRole('button', { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => await jointChart(page).getAttribute('aria-label'), { message: `el gráfico pasa al periodo «${label}»` }).not.toBe(before);
  };

  test('la pestaña gira en torno a la evolución; debajo, el sueño, el pulso y el oxígeno, y no se repite lo que ya está en ella', async ({ page }) => {
    const salud = activePage(page);
    await expect(salud.locator('section[aria-label]')).toHaveCount(4); // los datos del periodo ya han llegado
    const labels = await salud.locator('section[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    expect(labels).toEqual(['Evolución', 'Sueño', 'Pulso', 'Oxígeno en sangre']);
    for (const name of ['Actividad', 'Peso', 'Frecuencia cardiaca', 'Comparar periodos']) {
      await expect(salud.getByRole('region', { name, exact: true })).toHaveCount(0);
    }
  });

  test('el periodo se elige en la regleta de arriba, que abre en «Todo», y rehace el gráfico: siempre por días, sea cual sea su longitud', async ({ page }) => {
    const hero = evolution(page);
    const bar = periodBar(page);
    await expect(bar.getByRole('button', { name: 'Todo', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const other of ['7 días', '30 días', '90 días', '1 año']) {
      await expect(bar.getByRole('button', { name: other, exact: true })).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(hero.getByRole('combobox')).toHaveCount(0);
    await expect(activePage(page).getByRole('combobox', { name: 'Agrupar por' })).toHaveCount(0);

    /** Lo que lee el cursor en el último periodo del gráfico: su cabecera es siempre un día («Mar 3 nov»), nunca una semana ni un mes acumulados. */
    const lastReading = async (): Promise<string> => {
      await jointChart(page).focus();
      await page.keyboard.press('ArrowLeft');
      const text = await hero.getByRole('status').innerText();
      await page.keyboard.press('Escape');
      return text;
    };

    // Las fechas que se esperan salen del reloj del propio navegador y de su `Intl` (el mismo que usa la app): la prueba no depende
    // del día en que se ejecute (con «14 oct» y «2025» escritos a mano fallaba al pasar la medianoche, y fallaría en noviembre).
    const today = await page.evaluate(() => {
      const now = new Date();
      const es = (options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat('es-ES', options).format(now);
      return {
        dayShort: es({ day: 'numeric', month: 'short' }), // «15 oct»
        monthLong: es({ month: 'long' }), // «octubre»
        year: now.getFullYear(),
        startYear: new Date(now.getTime() - 364 * 86_400_000).getFullYear(), // el año en que empieza el periodo de 1 año
      };
    });
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const names = [(await jointChart(page).getAttribute('aria-label')) ?? ''];
    const daily = new RegExp(`^\\S+ ${escape(today.dayShort)}`);
    expect(await lastReading(), 'Todo (la demostración tiene meses de datos)').toMatch(daily);
    for (const label of ['7 días', '30 días', '90 días', '1 año']) {
      await choosePeriod(page, label);
      names.push((await jointChart(page).getAttribute('aria-label')) ?? '');
      const reading = await lastReading();
      expect(reading, label).toMatch(daily);
      expect(reading, label).not.toMatch(/Semana del|^\w+ de \d{4}$/);
    }
    // El gráfico cambia con el horizonte: cada periodo tiene su propio rango de fechas en el nombre (con año si no es el actual).
    expect(new Set(names).size, names.join(' | ')).toBe(5);
    // El periodo de 1 año empieza el año anterior (salvo en los últimos días del año): ese año sale en su nombre.
    if (today.startYear !== today.year) expect(names[4]).toContain(String(today.startYear));
    await choosePeriod(page, 'Todo');
    await expect(jointChart(page)).toBeVisible();
  });

  test('con 90 días, 1 año o Todo entran TODOS los días de golpe en la pantalla (sin deslizar el gráfico) y la barra vertical se arrastra con el dedo por los días', async ({ page }) => {
    // Ningún periodo desliza el gráfico: el dibujo ocupa exactamente el ancho de la pantalla.
    for (const label of ['7 días', '30 días', '90 días', '1 año', 'Todo']) {
      await choosePeriod(page, label);
      await expect(evolution(page).locator('.plot__scroller, .plot__fixed')).toHaveCount(0);
      const m = await jointPlot(page).evaluate((el) => ({ box: el.clientWidth, svg: el.querySelector('svg')?.getBoundingClientRect().width ?? 0, scroll: el.scrollWidth }));
      expect(m.svg, `${label}: el gráfico ocupa el ancho visible`).toBeLessThanOrEqual(m.box + 1);
      expect(m.scroll, `${label}: nada que deslizar`).toBeLessThanOrEqual(m.box + 1);
    }

    // Con un año (365 días) se arrastra la barra con el dedo: la lectura cambia de día mientras el dedo se mueve y la página no cambia de pestaña.
    await choosePeriod(page, '1 año');
    const chart = jointChart(page);
    await chart.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = (await chart.boundingBox())!;
    const y = Math.round(Math.max(box.y, 0) + Math.min(box.height, 915 - Math.max(box.y, 0)) / 2);
    const reading = evolution(page).getByRole('status');
    const client = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number): Promise<unknown> =>
      client.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y }] });
    const pagerBefore = await page.locator('main.pager').evaluate((el) => el.scrollLeft);
    const left = box.x + 80;
    await touch('touchStart', left);
    await expect(reading).toContainText(/^\S+ \d+ \w+/);
    const first = (await reading.textContent()) ?? '';
    for (let x = left; x <= box.x + box.width - 30; x += 12) await touch('touchMove', x);
    const last = (await reading.textContent()) ?? '';
    await touch('touchEnd');
    expect(last, 'la barra pasó a otro día').not.toBe(first);
    await expect(nav(page).getByRole('button', { name: 'Salud' })).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('main.pager').evaluate((el) => el.scrollLeft), 'el carrusel no se movió').toBe(pagerBefore);
  });

  test('la regleta afecta a TODOS los gráficos de la pestaña: el sueño y el pulso también cambian de periodo', async ({ page }) => {
    const salud = activePage(page);
    const pulse = salud.locator('svg.plot__svg[aria-label^="Pulso mínimo y máximo"]');
    const periods = async (): Promise<number> => Number(/, (\d+) periodos? con datos/.exec((await pulse.getAttribute('aria-label')) ?? '')?.[1] ?? NaN);
    await expect(salud.getByText('Pulso por día')).toBeVisible(); // siempre por días (nunca «por semana» ni «por mes»)
    await expect(salud.getByText(/Últimas 31 noches/)).toBeVisible();
    const all = await periods();
    expect(all).toBeGreaterThan(30);
    await choosePeriod(page, '7 días');
    await expect(salud.getByText('Pulso por día')).toBeVisible();
    await expect(salud.getByText(/Últimas [1-7] noches/)).toBeVisible();
    await expect.poll(periods).toBeLessThanOrEqual(7);
    await expect(salud.getByText(/Pulso por (semana|mes)/)).toHaveCount(0);
  });

  test('la regleta está fuera de los paneles, encima del primero, y flota: se queda arriba al deslizar', async ({ page }) => {
    const bar = periodBar(page);
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((el) => el.closest('section.card, section.hero-card') === null), 'no es parte de ningún panel').toBe(true);
    const first = await evolution(page).boundingBox();
    const before = await bar.boundingBox();
    expect(before && first && before.y + before.height <= first.y + 1, 'va encima del primer panel').toBe(true);

    const pageBox = await activePage(page).boundingBox();
    const tops: number[] = [];
    for (const scroll of [700, 1600, 400]) {
      await activePage(page).evaluate((el, top) => {
        el.scrollTop = top;
      }, scroll);
      await expect(bar).toBeInViewport({ ratio: 1 });
      const now = await bar.boundingBox();
      tops.push((now?.y ?? 1e9) - (pageBox?.y ?? 0));
    }
    expect(Math.max(...tops), `pegada arriba con 700, 1600 y 400 px deslizados: ${tops.join(', ')}`).toBeLessThan(24);
    expect(Math.max(...tops) - Math.min(...tops), 'y no se mueve entre unos y otros').toBeLessThanOrEqual(1);
    // Y sigue funcionando desde ahí abajo: cambia el periodo de los gráficos.
    await bar.getByRole('button', { name: '7 días', exact: true }).click();
    await expect(bar.getByRole('button', { name: '7 días', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('el panel de evolución ya no lleva el texto del intervalo ni las cifras de pasos, calorías y peso: el sitio es del gráfico', async ({ page }) => {
    const hero = evolution(page);
    await expect(jointChart(page)).toBeVisible();
    await expect(hero.getByRole('list', { name: 'Resumen del periodo' })).toHaveCount(0);
    await expect(hero.getByText(/^\d+ días$/)).toHaveCount(0);
    // El gráfico va justo bajo el título del panel, y el botón de peso debajo de él.
    const head = await hero.locator('.hero-card__head').boundingBox();
    const chart = await hero.locator('.hero-card__chart').boundingBox();
    expect(head && chart && chart.y - (head.y + head.height) < 30, 'el gráfico sube hasta el título').toBe(true);
  });

  /** Entra en el modo de edición del gráfico: bloques que se mueven, con «Aplicar» y «Descartar» donde estaba el botón de elegir. */
  async function startEditing(page: Page, options: { wiggle?: boolean } = {}): Promise<{ blocks: Locator; apply: Locator; discard: Locator }> {
    // El meneo continuo de los bloques impide que Playwright los vea «estables» para pulsarlos: salvo en la prueba del meneo, se pide «reducir movimiento».
    if (options.wiggle !== true) await page.emulateMedia({ reducedMotion: 'reduce' });
    const hero = evolution(page);
    await hero.getByRole('button', { name: 'Elegir qué datos ver' }).click();
    const blocks = hero.getByRole('list', { name: 'Gráficos que se ven, en este orden' });
    await expect(blocks).toBeVisible();
    return { blocks, apply: hero.getByRole('button', { name: 'Aplicar', exact: true }), discard: hero.getByRole('button', { name: 'Descartar', exact: true }) };
  }
  const blockTitles = async (blocks: Locator): Promise<string[]> => (await blocks.locator(':scope > li strong').allTextContents()).map((t) => t.trim());
  /** Quita un bloque con su cruz: el primer toque la prepara y el segundo, que no vale al instante, lo quita. */
  async function removeBlock(page: Page, blocks: Locator, title: string): Promise<void> {
    await blocks.getByRole('button', { name: `Quitar ${title}`, exact: true }).click();
    const confirm = blocks.getByRole('button', { name: `Confirmar: quitar ${title}`, exact: true });
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(600); // un doble toque no confirma
    await confirm.click();
  }

  test('«Elegir qué datos ver» pone el gráfico en edición: bloques que se mueven, «Aplicar» y «Descartar» donde estaba el botón', async ({ page }) => {
    const hero = evolution(page);
    const { blocks, apply, discard } = await startEditing(page, { wiggle: true });
    await expect(hero.getByRole('button', { name: 'Elegir qué datos ver' })).toHaveCount(0);
    await expect(apply).toBeVisible();
    await expect(discard).toBeVisible();
    expect(await blockTitles(blocks)).toEqual(['Pasos al día', 'Calorías al día', 'Agua al día', 'Peso (kg)']);
    // Los bloques se mueven sutilmente para avisar de que se pueden mover.
    const animation = await blocks.locator(':scope > li').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe('jb-wiggle');
    // Cada uno lleva su cruz arriba a la derecha, y debajo del último hay un bloque «+».
    const block = blocks.locator(':scope > li').first();
    const box = (await block.boundingBox())!;
    const cross = (await block.getByRole('button', { name: /^Quitar/ }).boundingBox())!;
    expect(cross.x + cross.width > box.x + box.width - 16 && cross.y < box.y + 16, 'la cruz está en la esquina superior derecha').toBe(true);
    const add = hero.getByRole('button', { name: 'Añadir un gráfico' });
    const last = (await blocks.locator(':scope > li').last().boundingBox())!;
    expect(((await add.boundingBox())?.y ?? 0) > last.y + last.height - 2, 'el «+» va debajo del último bloque').toBe(true);
    await discard.click();
    await expect(hero.getByRole('button', { name: 'Elegir qué datos ver' })).toBeVisible();
    await expect(blocks).toHaveCount(0);
  });

  test('los bloques se ordenan arrastrándolos (ratón) o con las flechas, y se aplican; descartar deja todo como estaba', async ({ page }) => {
    const titles = async (): Promise<string[]> => (await jointPlot(page).locator('text.jc__title').allTextContents()).map((t) => t.split(' · ')[0] ?? '');
    const { blocks, apply, discard } = await startEditing(page);

    // Arrastrar: se levanta «Calorías al día» por su asa y se suelta por debajo de «Agua al día».
    const grip = blocks.getByRole('button', { name: /^Mover Calorías al día/ });
    const from = (await grip.boundingBox())!;
    const water = (await blocks.locator(':scope > li').nth(2).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 30, { steps: 5 });
    await expect(blocks.locator(':scope > li.is-lifted')).toHaveCount(1);
    await page.mouse.move(from.x + from.width / 2, water.y + water.height * 0.85, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => blockTitles(blocks)).toEqual(['Pasos al día', 'Agua al día', 'Calorías al día', 'Peso (kg)']);

    // Con el teclado: el asa del peso sube hasta lo más alto con las flechas.
    await blocks.getByRole('button', { name: /^Mover Peso \(kg\)/ }).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await expect.poll(() => blockTitles(blocks)).toEqual(['Peso (kg)', 'Pasos al día', 'Agua al día', 'Calorías al día']);
    await expect(blocks.getByRole('button', { name: /^Mover Peso \(kg\)/ })).toBeFocused(); // el foco sigue en el asa

    // Nada se guarda hasta «Aplicar».
    await discard.click();
    expect(await titles()).toEqual(['Pasos al día', 'Calorías al día', 'Agua al día', 'Peso (kg)']);
    await evolution(page).getByRole('button', { name: 'Elegir qué datos ver' }).click();
    await blocks.getByRole('button', { name: /^Mover Peso \(kg\)/ }).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await apply.click();
    await expect.poll(titles).toEqual(['Peso (kg)', 'Pasos al día', 'Calorías al día', 'Agua al día']);
    // Y se recuerda al volver a la pestaña.
    await goTab(page, 'Resumen');
    await goTab(page, 'Salud');
    await expect.poll(titles).toEqual(['Peso (kg)', 'Pasos al día', 'Calorías al día', 'Agua al día']);
  });

  test('con el dedo, un bloque se levanta con una pulsación larga y se arrastra; deslizar sin pulsar solo recorre la página', async ({ page }) => {
    const { blocks, apply } = await startEditing(page);
    const cdp = await page.context().newCDPSession(page);
    const scroller = activePage(page);
    const items = blocks.locator(':scope > li');
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number, id: number): Promise<unknown> =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id }] });

    // Pulsación larga sobre el primer bloque y arrastre hasta debajo del tercero.
    const first = (await items.nth(0).boundingBox())!;
    const third = (await items.nth(2).boundingBox())!;
    const x = first.x + first.width / 2;
    const y = first.y + first.height * 0.55;
    const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
    await touch('touchStart', x, y, 1);
    await expect(items.nth(0)).toHaveClass(/is-lifted/);
    for (let i = 1; i <= 14; i++) {
      await touch('touchMove', x, y + ((third.y + third.height * 0.8 - y) * i) / 14, 1);
      await page.waitForTimeout(16);
    }
    await touch('touchEnd', x, 0, 1);
    await expect.poll(() => blockTitles(blocks)).toEqual(['Calorías al día', 'Agua al día', 'Pasos al día', 'Peso (kg)']);
    expect(await scroller.evaluate((el) => el.scrollTop), 'arrastrar un bloque no desplaza la página').toBe(scrollBefore);

    // Deslizar el dedo sin pulsación larga no levanta nada: recorre la página.
    const second = (await items.nth(1).boundingBox())!;
    const x2 = second.x + second.width / 2;
    const y2 = second.y + second.height * 0.55;
    await touch('touchStart', x2, y2, 2);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', x2, y2 - i * 12, 2);
      await page.waitForTimeout(16);
    }
    await touch('touchEnd', x2, 0, 2);
    await expect(blocks.locator(':scope > li.is-lifted')).toHaveCount(0);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrollBefore);
    expect(await blockTitles(blocks)).toEqual(['Calorías al día', 'Agua al día', 'Pasos al día', 'Peso (kg)']);
    // Tras deslizar, la página sigue un rato por inercia: se espera a que se pare antes de pulsar (con el botón aún en movimiento, Playwright no lo daba por estable y la prueba salía intermitente).
    await expect
      .poll(async () => {
        const before = await scroller.evaluate((el) => el.scrollTop);
        await page.waitForTimeout(250);
        return before === (await scroller.evaluate((el) => el.scrollTop));
      })
      .toBe(true);
    await apply.click();
  });

  test('la cruz de un bloque lo quita con un segundo toque (como borrar una comida) y el «+» abre un selector gráfico para añadir otro', async ({ page }) => {
    const hero = evolution(page);
    const { blocks, apply } = await startEditing(page);
    await removeBlock(page, blocks, 'Agua al día');
    expect(await blockTitles(blocks)).toEqual(['Pasos al día', 'Calorías al día', 'Peso (kg)']);

    await hero.getByRole('button', { name: 'Añadir un gráfico' }).click();
    const picker = page.getByRole('dialog', { name: 'Añadir un gráfico', exact: true });
    await expect(picker).toBeVisible();
    // Solo se ofrece lo que no está y que tiene sentido aquí: el sueño, el pulso y el oxígeno tienen su propio gráfico.
    await expect(picker.getByRole('button', { name: 'Añadir Agua al día' })).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Añadir Pasos al día' })).toHaveCount(0);
    for (const gone of ['Sueño', 'Pulso', 'Oxígeno']) await expect(picker.getByRole('button', { name: new RegExp(gone) })).toHaveCount(0);
    await picker.getByRole('button', { name: 'Añadir Distancia al día (km)' }).click();
    await expect(picker).toBeHidden();
    expect(await blockTitles(blocks)).toEqual(['Pasos al día', 'Calorías al día', 'Peso (kg)', 'Distancia al día (km)']);
    await apply.click();
    await expect.poll(async () => (await jointPlot(page).locator('text.jc__title').allTextContents()).map((t) => t.split(' · ')[0])).toEqual(['Pasos al día', 'Calorías al día', 'Peso (kg)', 'Distancia al día (km)']);
  });

  test('se pueden añadir todos los datos que ofrece el gráfico, sin límite; entonces el «+» desaparece', async ({ page }) => {
    const hero = evolution(page);
    const chart = jointChart(page);
    const { blocks, apply } = await startEditing(page);
    for (let i = 0; i < 9; i++) {
      await hero.getByRole('button', { name: 'Añadir un gráfico' }).click();
      await page.getByRole('dialog', { name: 'Añadir un gráfico', exact: true }).getByRole('button', { name: /^Añadir / }).first().click();
    }
    await expect(blocks.locator(':scope > li')).toHaveCount(13);
    await expect(hero.getByRole('button', { name: 'Añadir un gráfico' })).toHaveCount(0);
    await apply.click();
    await expect.poll(async () => (await jointPlot(page).locator('text.jc__title').allTextContents()).length).toBe(13);
    const box = await chart.boundingBox();
    expect((box?.height ?? 0) > 2000, 'el gráfico crece con las bandas').toBe(true);
  });

  test('sin ningún dato elegido el gráfico lo dice', async ({ page }) => {
    const hero = evolution(page);
    const { blocks, apply } = await startEditing(page);
    for (const name of ['Pasos al día', 'Calorías al día', 'Agua al día', 'Peso (kg)']) await removeBlock(page, blocks, name);
    await expect(blocks.locator(':scope > li')).toHaveCount(0);
    await apply.click();
    await expect(hero).toContainText('Ningún dato elegido');
    await expect(jointChart(page)).toHaveCount(0);
  });

  test('el gráfico conjunto lleva los pasos, las calorías comidas, el agua y el peso, cada uno en su banda y con un solo cursor', async ({ page }) => {
    await choosePeriod(page, '30 días'); // un punto por día: las flechas recorren 30 días distintos
    const chart = jointChart(page);
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAccessibleName(/pasos, media de [\d.]+ al día; calorías comidas, media de [\d.]+ al día frente a [\d.]+ propuestas; agua, media de [\d.]+ ml al día frente a una meta de [\d.]+; peso, de [\d,]+ a [\d,]+ kg/);
    // Cada banda dice qué mide y de dónde sale la cifra (medida por el anillo, estimada o escrita a mano).
    for (const title of ['Pasos al día · medido', 'Calorías al día · anotado', 'Agua al día · anotado', 'Peso (kg) · manual']) {
      await expect(jointPlot(page).getByText(title, { exact: true })).toBeVisible();
    }
    // Y arriba a la derecha de cada una, la referencia o lo que cambió en el periodo.
    const notes = await jointPlot(page).locator('text.jc__ref').allTextContents();
    expect(notes[0]).toMatch(/^Objetivo \d+$/); // los pasos
    expect(notes[1]).toMatch(/^Objetivo \d+$/); // las calorías
    expect(notes[2]).toMatch(/^Meta \d+$/); // el agua: la meta media de los días con agua anotada (cada día lleva la suya, que sube con el ejercicio)
    expect(notes.slice(3).every((t) => /^([−+]\d+,\d kg|sin cambio)$/.test(t)), notes.join(' | ')).toBe(true);
    expect(notes).toHaveLength(4);
    // La banda del agua va justo bajo la de las calorías (y encima del peso).
    const titles = await jointPlot(page).locator('text.jc__title').allTextContents();
    expect(titles.map((t) => t.split(' · ')[0])).toEqual(['Pasos al día', 'Calorías al día', 'Agua al día', 'Peso (kg)']);

    // Con las flechas el cursor recorre los días (de hoy hacia atrás) y lee las tres medidas del MISMO día. En la demostración
    // hoy aún no tiene pasos y el peso solo está en los días de pesada: por eso se recorre todo el periodo.
    await chart.focus();
    const reading = evolution(page).getByRole('status');
    const readings: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowLeft');
      await expect(reading).toBeVisible();
      readings.push(await reading.innerText());
    }
    expect(new Set(readings).size, 'el cursor avanza un día con cada flecha').toBe(30);
    expect(readings.some((r) => /pasos/.test(r) && /kcal comidas/.test(r)), 'un día lee pasos y calorías a la vez').toBe(true);
    expect(readings.some((r) => /pasos/.test(r) && /kcal comidas/.test(r) && /kg de peso/.test(r)), 'un día de pesada lee las tres medidas').toBe(true);
    expect(readings.some((r) => /ml de agua/.test(r) && /meta de agua/.test(r)), 'un día con agua anotada lee lo bebido y su meta').toBe(true);
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);

    // Tocando también: el cursor va al punto tocado.
    // El gráfico es casi tan alto como la pantalla y bajo la cabecera y la regleta de periodo flotante quedan pocos píxeles: se centra y se toca por la mitad.
    await chart.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await chart.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) * 0.5, (box?.y ?? 0) + (box?.height ?? 0) * 0.5);
    await expect(reading).toBeVisible();
  });

  test('el gráfico conjunto es grande: cada medida tiene su banda alta y el panel se lee sin entornar los ojos', async ({ page }) => {
    const chart = jointChart(page);
    await expect(chart).toBeVisible();
    const box = await chart.boundingBox();
    expect(box).not.toBeNull();
    // Antes medía unos 300 px de alto (tres bandas de 76 + 56 + 56 px) y hace poco 530: con el espacio que dejaron las cifras y el texto
    // del intervalo, las bandas son de 210 + 150 + 150 + 150 px (con la del agua). Es lo principal de la pestaña.
    expect(box?.height ?? 0, 'el gráfico conjunto es alto').toBeGreaterThanOrEqual(620);
    // Y casi tan ancho como la tarjeta que lo lleva (sin márgenes de más a los lados).
    const card = await evolution(page).boundingBox();
    expect((box?.width ?? 0) / (card?.width ?? 1), 'el gráfico aprovecha el ancho de la tarjeta').toBeGreaterThan(0.9);
    // El sueño y el oxígeno quedan debajo, tras el panel de evolución.
    const sleep = await activePage(page).getByRole('region', { name: 'Sueño', exact: true }).boundingBox();
    expect(sleep?.y ?? 0).toBeGreaterThan((card?.y ?? 0) + (card?.height ?? 0) - 1);
  });

  test('los gráficos con cursor se alcanzan con el teclado: llevan tabindex (en minúsculas, el único que entienden todos los motores en un SVG)', async ({ page }) => {
    await expect(jointChart(page)).toBeVisible();
    const charts = activePage(page).locator('svg.plot__svg[aria-label]');
    await expect(charts).not.toHaveCount(0);
    for (const chart of await charts.all()) await expect(chart, (await chart.getAttribute('aria-label')) ?? '').toHaveAttribute('tabindex', '0');
    // Con Tab se llega al primero y las flechas mueven el cursor, sin haberlo tocado antes.
    await jointChart(page).focus();
    await expect(jointChart(page)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(evolution(page).getByRole('status')).toBeVisible();
  });

  test('mover el dedo por el gráfico no crea un observador de tamaño nuevo por movimiento (batería: ni mediciones forzadas del diseño)', async ({ page }) => {
    const chart = jointChart(page);
    await expect(chart).toBeVisible();
    // Se cuentan los ResizeObserver que se crean desde ahora.
    await page.evaluate(() => {
      const w = window as unknown as { __observers: number; ResizeObserver: typeof ResizeObserver };
      w.__observers = 0;
      const Original = w.ResizeObserver;
      w.ResizeObserver = class extends Original {
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          w.__observers++;
        }
      };
    });
    const box = await chart.boundingBox();
    expect(box).not.toBeNull();
    for (let i = 0; i < 30; i++) {
      await page.mouse.move((box?.x ?? 0) + 20 + (i * ((box?.width ?? 300) - 40)) / 30, (box?.y ?? 0) + 60);
    }
    await expect(evolution(page).getByRole('status')).toBeVisible(); // el cursor sí se movió (hubo renderizados)
    const created = await page.evaluate(() => (window as unknown as { __observers: number }).__observers);
    expect(created, 'observadores creados durante 30 movimientos').toBeLessThanOrEqual(2);
  });

  test('«Actualizar peso» está en el panel: abre el formulario y el peso nuevo sale en el gráfico', async ({ page }) => {
    const hero = evolution(page);
    await hero.getByRole('button', { name: 'Actualizar peso' }).click();
    const sheet = page.getByRole('dialog', { name: 'Actualizar mis datos' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Peso (kg)').fill('81,5');
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Datos guardados' })).toBeVisible();

    await expect(jointChart(page)).toHaveAccessibleName(/peso, de [\d,]+ a 81,5 kg/);
  });

  test('sueño y oxígeno siguen como estaban: medias, objetivo, horas dormidas, regularidad y oxígeno medio', async ({ page }) => {
    const sleep = activePage(page).getByRole('region', { name: 'Sueño', exact: true });
    await expect(sleep).toContainText('Media por noche');
    await expect(sleep).toContainText('Horas dormidas');
    await expect(sleep).toContainText('Regularidad');
    await expect(sleep.getByRole('img', { name: /Horas dormidas/ })).toBeVisible();
    await expect(sleep.getByRole('img', { name: /Hora de acostarse y de despertar/ })).toBeVisible();

    const spo2 = activePage(page).getByRole('region', { name: 'Oxígeno en sangre', exact: true });
    await expect(spo2).toContainText('SpO₂ media diaria');
    await expect(spo2.getByRole('img', { name: /Oxígeno en sangre medio/ })).toBeVisible();
  });

  test('el pulso tiene su tarjeta justo bajo la del sueño, con la misma forma: cifras arriba y una barra por día del pulso más bajo al más alto', async ({ page }) => {
    await choosePeriod(page, '30 días'); // por días (con «Todo» las barras son semanas)
    const salud = activePage(page);
    const sleep = salud.getByRole('region', { name: 'Sueño', exact: true });
    const pulse = salud.getByRole('region', { name: 'Pulso', exact: true });
    await expect(pulse).toBeVisible();
    for (const label of ['Media', 'Reposo', 'Máximo']) await expect(pulse.locator('dt', { hasText: label })).toHaveCount(1);
    await expect(pulse).toContainText('Pulso por día');
    const chart = pulse.getByRole('img', { name: /^Pulso mínimo y máximo, \d+ periodos con datos: de \d+ a \d+ lpm/ });
    await expect(chart).toBeVisible();
    await expect(pulse.getByRole('table')).toHaveCount(0);
    // Justo debajo del sueño (y antes del oxígeno), a todo el ancho de la tarjeta.
    const a = await sleep.boundingBox();
    const b = await pulse.boundingBox();
    const c = await salud.getByRole('region', { name: 'Oxígeno en sangre', exact: true }).boundingBox();
    expect(a && b && b.y >= a.y + a.height - 1 && b.y - (a.y + a.height) < 40, 'el pulso queda pegado bajo el sueño').toBe(true);
    expect(b && c && c.y >= b.y + b.height - 1, 'y el oxígeno, después').toBe(true);
    // Se lee con el teclado, igual que los demás.
    await chart.focus();
    await page.keyboard.press('ArrowRight');
    await expect(pulse.locator('.tip')).toContainText(/Máximo.*lpm/s);
  });

  test('ya no hay un apartado de «qué es medido y qué es estimado», y los datos personales ya no están aquí', async ({ page }) => {
    const salud = activePage(page);
    await expect(salud.getByText('Qué es medido y qué es estimado')).toHaveCount(0);
    await expect(salud.getByText('Cómo se calculan los datos')).toHaveCount(0);
    // Mis datos, objetivos y copias de seguridad viven en el menú de perfil.
    for (const name of ['Mis datos', 'Objetivos y medición', 'Mis datos guardados']) {
      await expect(salud.getByRole('region', { name, exact: true })).toHaveCount(0);
    }
  });
});

test.describe('apartados del menú de perfil', () => {
  test.beforeEach(async ({ page }) => {
    await openDemo(page);
  });

  test('actualizar el peso añade una entrada con su fecha y la refleja en los datos', async ({ page }) => {
    const data = await openUserSection(page, 'Mis datos');
    const before = (await savedProfile(page)).length;
    expect(before, 'la demostración trae un historial de perfil').toBeGreaterThan(1);

    await data.getByRole('button', { name: 'Actualizar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Actualizar mis datos' });
    await sheet.getByLabel('Peso (kg)').fill('81,5');
    await sheet.getByRole('button', { name: 'Guardar' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Datos guardados' })).toBeVisible();
    await expect(data).toContainText('81,5 kg');
    expect(await savedProfile(page), 'una entrada más, con su fecha').toHaveLength(before + 1);
  });

  test('un dato fuera de rango no se guarda y explica por qué', async ({ page }) => {
    const data = await openUserSection(page, 'Mis datos');
    await data.getByRole('button', { name: 'Actualizar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Actualizar mis datos' });
    await sheet.getByLabel('Peso (kg)').fill('5');
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(sheet.getByRole('alert')).toContainText('El peso debe estar entre 25 y 300 kg.');
  });

  test('una zancada que no es un número («abc», «75 pasos») se avisa en vez de tirarse como si estuviera vacía, y «75 cm» vale', async ({ page }) => {
    const data = await openUserSection(page, 'Mis datos');
    await data.getByRole('button', { name: 'Actualizar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Actualizar mis datos' });
    for (const typed of ['abc', '75 pasos']) {
      await sheet.getByLabel('Longitud de zancada (cm) — opcional').fill(typed);
      await sheet.getByRole('button', { name: 'Guardar' }).click();
      await expect(sheet.getByRole('alert')).toContainText('La zancada debe ser un número en centímetros');
    }
    await sheet.getByLabel('Longitud de zancada (cm) — opcional').fill('75 cm');
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Datos guardados' })).toBeVisible();
  });

  test('calibrar la zancada: la guía explica el paseo con GPS, «Empezar» no abre la pantalla de entreno y la medida a mano sigue disponible', async ({ page }) => {
    const data = await openUserSection(page, 'Mis datos');
    await data.getByRole('button', { name: 'Calibrar zancada' }).click();
    const sheet = page.getByRole('dialog', { name: 'Calibrar la zancada' });
    await expect(sheet).toContainText('Camina unos 300 m');
    await expect(sheet.getByRole('button', { name: 'Empezar' })).toBeVisible();

    // Empezar arranca el paseo (con el anillo simulado) en la propia hoja: sin la pantalla de «Entrenamiento en curso».
    await sheet.getByRole('button', { name: 'Empezar' }).click();
    await expect(sheet.getByRole('progressbar', { name: 'Avance del paseo de calibración' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('dialog', { name: 'Entrenamiento en curso' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Terminar' })).toBeDisabled(); // hasta los 150 m
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet.getByRole('button', { name: 'Empezar' })).toBeVisible();

    // La medida a mano sigue ahí, para cuando no hay GPS.
    await sheet.getByRole('button', { name: 'Prefiero escribir los datos a mano' }).click();
    await sheet.getByLabel('Distancia recorrida (m)').fill('100');
    await sheet.getByLabel('Pasos contados').fill('140');
    await expect(sheet).toContainText('71,4 cm');
    await sheet.getByRole('button', { name: 'Usar esta zancada desde hoy' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Zancada fijada en 71,4 cm' })).toBeVisible();
    await expect(data).toContainText('71,4 cm');
  });

  test('los objetivos y el intervalo de medición se pueden ajustar', async ({ page }) => {
    const goals = await openUserSection(page, 'Objetivos y medición');
    await expect(goals).toContainText('8000');
    await expect(goals.getByRole('radiogroup', { name: 'Objetivo de salud' })).toBeVisible();
    await goals.getByRole('button', { name: 'Subir pasos al día' }).click();
    await expect(goals.getByText('8500')).toBeVisible();
    await goals.getByRole('button', { name: 'Bajar sueño (horas)' }).click();
    await expect(goals.getByText('7,5')).toBeVisible();
    await goals.getByRole('button', { name: '2 h' }).click();
    await expect(goals.getByRole('button', { name: '2 h' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('recuerda hacer copia de seguridad y deja de avisar cuando se exporta', async ({ page }) => {
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    const lastCopy = backup.locator('.data-grid > div').filter({ has: page.locator('dt', { hasText: 'Última copia' }) });
    await expect(lastCopy).toContainText('Ninguna todavía');
    await expect(backup.getByText('No tienes ninguna copia de seguridad.')).toBeVisible();

    await Promise.all([page.waitForEvent('download'), backup.getByRole('button', { name: 'Exportar copia' }).click()]);
    await expect(lastCopy).toContainText(/ahora mismo|hace \d+ min/);
    await expect(backup.getByText('No tienes ninguna copia de seguridad.')).toHaveCount(0);
  });

  test('«Datos y copias de seguridad» no lleva textos explicativos en letra pequeña: solo cifras, avisos y botones', async ({ page }) => {
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    await expect(backup.locator('.field__hint, .card__lead')).toHaveCount(0);
    for (const text of ['no hay cuenta ni servidor', 'de vez en cuando', 'conserva estos datos', 'se pierde el histórico']) {
      await expect(backup.getByText(text)).toHaveCount(0);
    }
    // Tampoco el bloque de cifras «Datos del anillo» (rango de fechas y cuántas lecturas, noches, entrenos…): solo queda la última copia.
    for (const label of ['Datos del anillo', 'Lecturas de pulso', 'Lecturas de oxígeno', 'Noches de sueño', 'Entrenamientos', 'Sincronizaciones', 'Entradas de perfil']) {
      await expect(backup.locator('dt', { hasText: label })).toHaveCount(0);
    }
    await expect(backup.locator('dt')).toHaveText(['Última copia']);
    await expect(backup.getByRole('button', { name: 'Diagnóstico del anillo' })).toBeVisible();
  });

  test('exportar genera una copia válida que se puede importar combinándola', async ({ page }) => {
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    const [download] = await Promise.all([page.waitForEvent('download'), backup.getByRole('button', { name: 'Exportar copia' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^smarthealth-copia-\d{4}-\d{2}-\d{2}\.json$/);
    const path = await download.path();
    const file = JSON.parse(readFileSync(path, 'utf8')) as { format: string; data: { profile: unknown[]; sleep: unknown[]; settings: { lastBackupMs: number | null } } };
    expect(file.format).toBe('smartring-backup');
    expect(file.data.profile.length).toBe(12);
    expect(file.data.sleep.length).toBeGreaterThan(100);
    // La copia lleva la fecha de ESTA copia: restaurándola, la app no debe creer que nunca se ha hecho ninguna.
    const now = await page.evaluate(() => Date.now()); // el reloj del navegador (con FAKE_NOW no es el del proceso)
    expect(file.data.settings.lastBackupMs, 'la copia lleva su propia fecha').toBeGreaterThan(now - 60_000);

    await page.getByLabel('Archivo de copia de seguridad').setInputFiles(path);
    const sheet = page.getByRole('dialog', { name: 'Importar copia' });
    await expect(sheet).toContainText('noches de sueño');
    await sheet.getByRole('button', { name: 'Combinar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copia combinada con tus datos' })).toBeVisible();
  });

  test('la vista previa de importar dice «1 entrenamiento» (no «1 entrenamientos») y avisa de los registros con fecha imposible, que no entran', async ({ page }) => {
    await openUserSection(page, 'Datos y copias de seguridad');
    const tenDaysAgo = (await page.evaluate(() => Date.now())) - 10 * 86_400_000; // las fechas son posibles según el reloj del navegador
    const backup = {
      format: 'smartring-backup',
      version: 1,
      data: {
        profile: [],
        workouts: [{ id: 'w1', sport: 'run', startMs: tenDaysAgo, endMs: tenDaysAgo + 3_600_000, pausedMs: 0, source: 'manual' }],
        buckets: [],
        counters: [],
        heart: [
          { tsMs: tenDaysAgo, bpm: 70, source: 'ring-auto' },
          { tsMs: 1e300, bpm: 71, source: 'ring-auto' },
          { tsMs: 0, bpm: 72, source: 'ring-auto' },
        ],
        spo2: [],
        sleep: [],
      },
    };
    await page.getByLabel('Archivo de copia de seguridad').setInputFiles({ name: 'rara.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    const sheet = page.getByRole('dialog', { name: 'Importar copia' });
    await expect(sheet).toContainText('1 entrenamiento');
    await expect(sheet).not.toContainText('1 entrenamientos');
    await expect(sheet).toContainText('1 lectura de pulso'); // las otras dos tienen una fecha imposible
    await expect(sheet).toContainText('2 registros tienen una fecha imposible y no se importarán.');
    await sheet.getByRole('button', { name: 'Combinar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copia combinada con tus datos' })).toBeVisible();
  });

  test('«Reemplazar todo» pide una segunda confirmación y «Volver» no borra nada; un archivo enorme se rechaza sin leerlo', async ({ page }) => {
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    const [download] = await Promise.all([page.waitForEvent('download'), backup.getByRole('button', { name: 'Exportar copia' }).click()]);
    const path = await download.path();
    await page.getByLabel('Archivo de copia de seguridad').setInputFiles(path);
    const sheet = page.getByRole('dialog', { name: 'Importar copia' });
    await sheet.getByRole('button', { name: 'Reemplazar todo' }).click();
    await expect(sheet).toContainText('¿Reemplazar todo?');
    await expect(sheet).toContainText('No se puede deshacer');
    await sheet.getByRole('button', { name: 'Volver' }).click();
    await expect(sheet.getByRole('button', { name: 'Combinar' })).toBeVisible(); // seguimos en la elección, sin haber tocado nada
    await sheet.getByRole('button', { name: 'Reemplazar todo' }).click();
    await sheet.getByRole('button', { name: 'Sí, reemplazar todo' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copia restaurada' })).toBeVisible();
    // Un archivo de 65 MB no es una copia: se rechaza por su tamaño, sin leerlo. Se fabrica en el propio navegador (pasarlo
    // por Playwright tardaría más que la prueba) y se entrega al selector de archivos como si la persona lo hubiera elegido.
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('no hay selector de archivos');
      const files = new DataTransfer();
      files.items.add(new File([new ArrayBuffer(65 * 1024 * 1024)], 'enorme.json', { type: 'application/json' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.getByRole('alert').filter({ hasText: 'demasiado grande' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Importar copia' })).toBeHidden(); // no llegó a leerse: no hay nada que importar
  });

  test('tras exportar la copia, el botón de perfil deja de recordarla', async ({ page }) => {
    const user = page.getByRole('button', { name: /^Mi perfil/ });
    await expect(user).toHaveAccessibleName('Mi perfil: falta hacer una copia de seguridad');
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    await Promise.all([page.waitForEvent('download'), backup.getByRole('button', { name: 'Exportar copia' }).click()]);
    await expect(backup.locator('.data-grid > div').filter({ has: page.locator('dt', { hasText: 'Última copia' }) })).toContainText(/ahora mismo|hace \d+ min/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(user).toHaveAccessibleName('Mi perfil');
  });

  test('con el menú, un apartado y el formulario apilados, el aviso sale una sola vez (en la hoja de arriba)', async ({ page }) => {
    const data = await openUserSection(page, 'Mis datos');
    await data.getByRole('button', { name: 'Actualizar' }).click();
    const form = page.getByRole('dialog', { name: 'Actualizar mis datos' });
    await form.getByLabel('Peso (kg)').fill('80,5');
    await form.getByRole('button', { name: 'Guardar' }).click();
    await expect(form).toBeHidden();
    // El texto está en un solo aviso entre todas las hojas abiertas; los demás contenedores existen pero vacíos.
    await expect(page.locator('dialog[open] .toast').filter({ hasText: 'Datos guardados' })).toHaveCount(1);
    await expect(page.locator('dialog[open] .toast')).toHaveCount(2); // el menú y el apartado
  });

  test('Esc en una confirmación anidada cierra solo la confirmación, no el apartado', async ({ page }) => {
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    await backup.getByRole('button', { name: 'Borrar todo' }).click();
    const confirm = page.getByRole('dialog', { name: '¿Borrar todos los datos?' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(backup).toBeVisible();
  });

  test('un archivo que no es una copia se rechaza sin tocar los datos', async ({ page }) => {
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    const input = page.getByLabel('Archivo de copia de seguridad');
    await input.setInputFiles({ name: 'otra-cosa.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"otra-cosa"}') });
    await expect(page.getByRole('alert').filter({ hasText: 'no es una copia de seguridad de SmartHealth' })).toBeVisible();

    await input.setInputFiles({ name: 'roto.json', mimeType: 'application/json', buffer: Buffer.from('esto no es json') });
    await expect(page.getByRole('alert').filter({ hasText: 'no es un JSON válido' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(backup).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Mi perfil', exact: true })).toContainText('79,8 kg');
  });

  test('borrar todo pide confirmación y deja la app como recién instalada', async ({ page }) => {
    const backup = await openUserSection(page, 'Datos y copias de seguridad');
    await expect(backup.getByText('No tienes ninguna copia de seguridad.')).toBeVisible(); // hay datos de la demostración y ninguna copia
    await backup.getByRole('button', { name: 'Borrar todo' }).click();
    await page.getByRole('dialog', { name: '¿Borrar todos los datos?' }).getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('dialog', { name: '¿Borrar todos los datos?' })).toBeHidden();

    await backup.getByRole('button', { name: 'Borrar todo' }).click();
    await page.getByRole('dialog', { name: '¿Borrar todos los datos?' }).getByRole('button', { name: 'Sí, borrar todo' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Datos borrados' })).toBeVisible();
    await expect(backup.getByText('No tienes ninguna copia de seguridad.')).toHaveCount(0); // sin datos no hay nada que copiar

    // El perfil también se ha ido: «Mis datos» pide completarlo.
    await page.keyboard.press('Escape');
    await expect(backup).toBeHidden();
    await page.getByRole('dialog', { name: 'Mi perfil', exact: true }).locator('.profile-card').click();
    await expect(page.getByRole('dialog', { name: 'Perfil y datos', exact: true }).getByText('Completa tu perfil', { exact: true })).toBeVisible();
  });
});
