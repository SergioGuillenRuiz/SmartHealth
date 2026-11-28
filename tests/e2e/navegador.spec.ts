import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { hudValueSize } from '../../src/ui/live-hud';
import { goTab, openDemo, test, expect } from './fixtures';

// La navegación guiada del entreno (rondas 37, 39 y 40): el interruptor «Navegación guiada» al empezar un deporte con movilidad; encendido, el entreno tiene dos pestañas (datos e indicaciones sin
// mapa / el mapa entero con indicadores y botones flotantes) y avisa con ZUMBIDOS (dos en el oído del lado del giro, unos 5 s antes), no con voz. Se prueba contra una ciudad de mentira (la demostración) y un
// GPS que se mueve por la ruta (`context.setGeolocation`). El audio se sustituye por uno que apunta cada zumbido (frecuencia y canal) para comprobar qué suena y por dónde.

type NavHook = { phase(): string; route(): Array<{ lat: number; lon: number }> | null; state(): { remainingM: number; status: string } | null };
type Tone = { hz: number; pan: number };
declare global {
  interface Window {
    __smartringNav?: NavHook;
    __tones?: Tone[];
  }
}

// La esquina suroeste de la ciudad de prueba (calle de Alcalá con calle de Serrano).
const START = { latitude: 40.4168 - 0.0045, longitude: -3.7038 - 0.0059 };

async function fakeAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__tones = [];
    let pending: { frequency: { value: number } } | null = null;
    class FakeContext {
      currentTime = 0;
      state = 'running';
      destination = {};
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
      createOscillator(): unknown {
        const osc = { type: 'sine', frequency: { value: 0 }, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} };
        pending = osc;
        return osc;
      }
      createGain(): unknown {
        return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
      }
      createStereoPanner(): unknown {
        const osc = pending;
        return { pan: { set value(v: number) { window.__tones?.push({ hz: osc?.frequency.value ?? 0, pan: v }); } }, connect() {} };
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  });
}

const tones = (page: Page): Promise<Tone[]> => page.evaluate(() => window.__tones ?? []);

async function startWorkout(page: Page, context: BrowserContext, sport: string, guided: boolean): Promise<Locator> {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ ...START, accuracy: 5 });
  await openDemo(page);
  await goTab(page, 'Deportes');
  await page.locator('.sports-grid').getByRole('button', { name: sport }).click();
  const ready = page.getByRole('dialog', { name: 'Nuevo entrenamiento' });
  // Se espera a que la hoja esté pintada ANTES de mirar si lleva el interruptor: contarlo nada más pulsar el deporte a veces llegaba antes que la hoja y el entreno empezaba sin guía (la intermitencia de esta zona).
  await expect(ready.getByRole('button', { name: 'Iniciar' })).toBeVisible();
  const box = ready.getByLabel('Navegación guiada');
  if (await box.count()) await box.setChecked(guided);
  await ready.getByRole('button', { name: 'Iniciar' }).click();
  const live = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
  await expect(live.getByText('En marcha')).toBeVisible({ timeout: 20_000 });
  return live;
}

const pane = (live: Locator, index: 0 | 1): Locator => live.locator('.live__pane').nth(index);
/** Toda la navegación (buscador, ruta, indicaciones) vive en la pestaña del mapa, la segunda; la de «Entreno» no sabe nada de ella. */
const guide = (live: Locator): Locator => pane(live, 1);

/** Elige «Parque de la Ciudadela», ve la vista previa y empieza. */
async function startRoute(live: Locator): Promise<void> {
  await guide(live).getByLabel('Destino').fill('parque ciud');
  await guide(live).getByRole('button', { name: /Parque de la Ciudadela/ }).click();
  await expect(guide(live).getByRole('button', { name: 'Iniciar', exact: true })).toBeVisible();
  await guide(live).getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect(guide(live).locator('.guide__banner')).toBeVisible();
}

/** Salir de una ruta (dejarla o cerrarla al llegar) NO cierra el mapa: vuelve el buscador de destino de siempre, vacío, con el mapa de la zona detrás. */
async function expectBackAtSearch(live: Locator): Promise<void> {
  await expect(guide(live).getByLabel('Destino')).toBeVisible();
  await expect(guide(live).getByLabel('Destino')).toHaveValue('');
  await expect(guide(live).locator('canvas').first()).toBeVisible(); // el mapa sigue ahí
  await expect(guide(live).getByRole('button', { name: /A dónde vamos/ })).toHaveCount(0);
  await expect(guide(live).locator('.guide__banner')).toHaveCount(0);
}

/** Anda la ruta (el GPS salta de 12 en 12 m). */
async function walkRoute(page: Page, context: BrowserContext): Promise<void> {
  const route = await page.evaluate(() => window.__smartringNav?.route() ?? null);
  expect(route && route.length).toBeGreaterThan(3);
  let last = route![0]!;
  for (const point of route!) {
    const steps = Math.max(1, Math.ceil(Math.hypot((point.lat - last.lat) * 111_195, (point.lon - last.lon) * 111_195 * Math.cos((40.4 * Math.PI) / 180)) / 12));
    for (let k = 1; k <= steps; k++) {
      await context.setGeolocation({ latitude: last.lat + ((point.lat - last.lat) * k) / steps, longitude: last.lon + ((point.lon - last.lon) * k) / steps, accuracy: 5 });
      await page.waitForTimeout(120);
    }
    last = point;
  }
}

test.describe('el interruptor «Navegación guiada»', () => {
  test.beforeEach(async ({ page }) => {
    await fakeAudio(page);
  });

  test('sale en los deportes con movilidad, ya no pregunta por el GPS y en los demás no sale', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await openDemo(page);
    await goTab(page, 'Deportes');
    await page.locator('.sports-grid').getByRole('button', { name: 'Caminar' }).click();
    const ready = page.getByRole('dialog', { name: 'Nuevo entrenamiento' });
    await expect(ready.getByLabel('Navegación guiada')).toBeVisible();
    await expect(ready.getByLabel('Medir la distancia con el GPS del móvil')).toHaveCount(0);
    await expect(ready).toContainText('La distancia se mide con el GPS del móvil');
    await page.keyboard.press('Escape');
    await page.locator('.sports-grid').getByRole('button', { name: 'Fuerza' }).click();
    await expect(page.getByRole('dialog', { name: 'Nuevo entrenamiento' }).getByLabel('Navegación guiada')).toHaveCount(0);
  });

  test('apagado: el entreno de siempre, sin pestañas ni navegación', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', false);
    await expect(live.getByRole('tablist')).toHaveCount(0);
    await expect(guide(live)).toHaveCount(0);
    await expect(live.locator('.live__grid')).toBeVisible();
    await expect(live.getByRole('button', { name: 'Pausa' })).toHaveCount(1);
    await expect(live.getByRole('button', { name: 'Terminar' })).toHaveCount(1);
  });

  test('un deporte sin movilidad (Fuerza) no lleva navegación', async ({ page, context }) => {
    const gym = await startWorkout(page, context, 'Fuerza', false);
    await expect(gym.getByRole('region', { name: 'Navegación' })).toHaveCount(0);
    await expect(gym.getByRole('tablist')).toHaveCount(0);
  });

  test('empieza siempre apagado, aunque la vez anterior se hubiera encendido', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await openDemo(page);
    await goTab(page, 'Deportes');
    const open = async (): Promise<Locator> => {
      await page.locator('.sports-grid').getByRole('button', { name: 'Caminar' }).click();
      return page.getByRole('dialog', { name: 'Nuevo entrenamiento' }).getByLabel('Navegación guiada');
    };
    const first = await open();
    await expect(first).not.toBeChecked(); // de serie, el entreno de siempre
    await first.setChecked(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Nuevo entrenamiento' })).toBeHidden();
    await expect(await open()).not.toBeChecked();
    // Ni siquiera se acuerda tras recargar la app.
    await page.goto('/?demo=1');
    await expect(page.getByRole('region', { name: 'Actividad diaria' })).toBeVisible();
    await goTab(page, 'Deportes');
    await expect(await open()).not.toBeChecked();
  });
});

test.describe('el entreno con navegación guiada: dos pestañas', () => {
  test.beforeEach(async ({ page }) => {
    await fakeAudio(page);
  });

  test('empieza en el mapa con el buscador abierto sola, y «Entreno» queda a un toque, sin mapa y sin navegación', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    // La navegación se abre sola (no hay que pulsar «¿A dónde vamos?») y se empieza en la pestaña donde se elige el destino.
    await expect(live.getByRole('tab', { name: 'Mapa' })).toHaveAttribute('aria-selected', 'true');
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    await live.getByRole('tab', { name: 'Entreno' }).click();
    await expect(live.getByRole('tab', { name: 'Entreno' })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(live, 0).locator('canvas')).toHaveCount(0);
    await expect(pane(live, 0).getByLabel('Destino')).toHaveCount(0);
    await expect(pane(live, 0).locator('.guide')).toHaveCount(0);
    await expect(pane(live, 0).getByRole('button', { name: 'Pausa' })).toBeVisible();
    await expect(pane(live, 0).getByRole('button', { name: 'Terminar' })).toBeVisible();
  });

  test('la pestaña «Entreno» es EXACTAMENTE la del entreno sin navegación guiada: mismas tarjetas, mismo orden', async ({ page, context }) => {
    const labelsOf = (root: Locator): Promise<string[]> => root.locator('.live__grid .metric__label').allTextContents();
    const plain = await startWorkout(page, context, 'Caminar', false);
    // «Pasos» sale cuando llega la primera lectura de pasos del anillo: se espera a ella en los dos entrenos para comparar lo mismo.
    await expect(plain.locator('.live__grid .metric__label', { hasText: 'Pasos' })).toBeVisible();
    const plainLabels = await labelsOf(plain);
    // Lo que hay entre la cabecera y el aviso de la pantalla: cronómetro, rejilla de tarjetas y botones.
    const body = (el: Element): string[] => [...el.children].map((c) => c.className.split(' ')[0]!).filter((c) => c !== 'live__head' && c !== 'toast');
    const plainFirst = await plain.locator('.live__panel').evaluate(body);
    expect(plainLabels).toContain('Pulso');
    expect(plainLabels).not.toContain('Último oxígeno (SpO₂)'); // ya no hay tarjeta de oxígeno (ronda 42)

    // Se acaba ese entreno y se empieza otro, ahora guiado.
    await plain.getByRole('button', { name: 'Terminar', exact: true }).click();
    await plain.getByRole('button', { name: 'Terminar y revisar' }).click();
    await page.getByRole('dialog', { name: 'Entrenamiento terminado' }).getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();
    const live = await startWorkout(page, context, 'Caminar', true);
    await live.getByRole('tab', { name: 'Entreno' }).click();
    await expect(pane(live, 0).locator('.live__grid .metric__label', { hasText: 'Pasos' })).toBeVisible();
    const guidedLabels = await labelsOf(pane(live, 0));
    // Las etiquetas pueden variar en un matiz según haya GPS («Distancia» / «Distancia (GPS)»): se compara lo que son.
    const norm = (labels: string[]): string[] => labels.map((l) => l.replace(/ \(GPS\)| ≈/g, ''));
    expect(norm(guidedLabels)).toEqual(norm(plainLabels));
    const guidedFirst = await pane(live, 0).evaluate(body);
    expect(guidedFirst).toEqual(plainFirst);
  });

  for (const size of [{ width: 412, height: 915 }, { width: 360, height: 640 }]) {
    test(`navegando, el mapa deja ver las indicaciones, lo que falta, los indicadores y los botones sin taparse (${size.width}×${size.height})`, async ({ page, context }) => {
      await page.setViewportSize(size);
      const live = await startWorkout(page, context, 'Caminar', true);
      await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
      await startRoute(live);
      for (const target of [live.locator('.hud'), guide(live).locator('.guide__banner'), guide(live).locator('.guide__bar'), guide(live).getByRole('button', { name: 'Pausa' }), guide(live).getByRole('button', { name: 'Terminar' })]) {
        await expect(target).toBeInViewport({ ratio: 1 });
      }
      // Entre lo de arriba y los botones de abajo queda mapa a la vista.
      const top = (await guide(live).locator('.maptab__top').boundingBox())!;
      const bottom = (await guide(live).locator('.maptab__bottom').boundingBox())!;
      expect(bottom.y - (top.y + top.height)).toBeGreaterThan(size.height === 640 ? 150 : 300);
    });
  }

  test('la pestaña del mapa: el mapa entero, los cuatro indicadores grandes en una fila y los botones de pausa y terminar flotando', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    await startRoute(live);
    await expect(live.getByRole('tab', { name: 'Mapa' })).toHaveAttribute('aria-selected', 'true');
    const map = live.getByRole('img', { name: 'Mapa de la ruta que estás siguiendo' });
    await expect(map).toBeVisible();
    // Los indicadores: tiempo, pulso, calorías y distancia, en una sola fila y cada uno de su color.
    const chips = live.locator('.hud__chip');
    await expect(chips).toHaveCount(4);
    const boxes = await chips.evaluateAll((els) => els.map((e) => ({ top: Math.round(e.getBoundingClientRect().top), color: getComputedStyle(e.querySelector('strong')!).color, size: parseFloat(getComputedStyle(e.querySelector('strong')!).fontSize) })));
    expect(new Set(boxes.map((b) => b.top)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.color)).size).toBe(4);
    // «Apenas se veían» (14 px): ahora el valor es grande.
    for (const b of boxes) expect(b.size).toBeGreaterThanOrEqual(20);
    // Las indicaciones van sobre el mapa y los botones, abajo del todo.
    await expect(pane(live, 1).locator('.guide__banner')).toBeVisible();
    const mapBox = (await map.boundingBox())!;
    const hud = (await live.locator('.hud').boundingBox())!;
    const bottom = (await pane(live, 1).locator('.maptab__bottom').boundingBox())!;
    expect(hud.y).toBeLessThan(mapBox.y + mapBox.height * 0.2);
    expect(bottom.y + bottom.height).toBeGreaterThan(mapBox.y + mapBox.height - 4);
    // Se puede pausar y terminar desde ahí.
    await pane(live, 1).getByRole('button', { name: 'Pausa' }).click();
    await expect(live.getByText('En pausa')).toBeVisible();
    await pane(live, 1).getByRole('button', { name: 'Reanudar' }).click();
    await expect(live.getByText('En marcha')).toBeVisible();
    await pane(live, 1).getByRole('button', { name: 'Terminar' }).click();
    await expect(pane(live, 1).getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
    await pane(live, 1).getByRole('button', { name: 'Seguir' }).click();
  });

  for (const size of [{ width: 360, height: 640 }, { width: 412, height: 915 }]) {
    test(`los cuatro indicadores caben en una fila con los valores más largos de un entreno normal (${size.width}×${size.height})`, async ({ page, context }) => {
      await page.setViewportSize(size);
      const live = await startWorkout(page, context, 'Caminar', true);
      await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
      // Los valores más anchos de un entreno normal (el cronómetro de más de 9 horas se achica: ver `live-hud.test.ts`).
      // Se les pone el tamaño que la app les daría (`hudValueSize`: 7 caracteres, 19 px) como al pintarlos de verdad.
      const values = ['9:59:59', '188', '12.345', '123,45'];
      await live.locator('.hud').evaluate(
        (el, shown) => {
          el.querySelectorAll<HTMLElement>('.hud__chip strong').forEach((strong, i) => {
            strong.textContent = shown[i]!.value;
            strong.style.fontSize = shown[i]!.px === null ? '' : `${shown[i]!.px}px`;
          });
        },
        values.map((value) => ({ value, px: hudValueSize(value) ?? null })),
      );
      const fit = await live.locator('.hud').evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [...el.querySelectorAll('.hud__chip')].map((chip) => {
          const r = chip.getBoundingClientRect();
          return { top: Math.round(r.top), inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, clipped: chip.scrollWidth > chip.clientWidth + 1 };
        });
      });
      expect(new Set(fit.map((f) => f.top)).size, 'una sola fila').toBe(1);
      expect(fit.every((f) => f.inside && !f.clipped), JSON.stringify(fit)).toBe(true);
    });
  }

  test('deslizar cambia de pestaña y la pestaña que no se ve no se puede tocar', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    const tabs = live.locator('.live__tabs');
    // Se empieza en el mapa.
    await expect(live.getByRole('tab', { name: 'Mapa' })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(live, 0)).toHaveAttribute('inert', '');
    await tabs.evaluate((el) => el.scrollTo({ left: 0, behavior: 'instant' }));
    await expect(live.getByRole('tab', { name: 'Entreno' })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(live, 1)).toHaveAttribute('inert', '');
    await tabs.evaluate((el) => el.scrollTo({ left: el.clientWidth, behavior: 'instant' }));
    await expect(live.getByRole('tab', { name: 'Mapa' })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(live, 0)).toHaveAttribute('inert', '');
  });

  test('en la pestaña del mapa se puede elegir el destino con una pulsación larga y el resumen de la ruta lleva «Iniciar»', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    // Ya se está en el mapa: no hace falta pasar de pestaña para elegir un punto.
    await expect(live.getByRole('tab', { name: 'Mapa' })).toHaveAttribute('aria-selected', 'true');
    await expect(live.getByText(/mantén pulsado un punto del mapa/i)).toBeVisible();
    const canvas = live.getByRole('img', { name: 'Mapa de tu zona' });
    const box = (await canvas.boundingBox())!;
    await canvas.hover({ position: { x: box.width * 0.5, y: box.height * 0.4 } });
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await expect(pane(live, 1).getByRole('button', { name: 'Iniciar', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(pane(live, 1)).toContainText(/\d+ min/);
  });
});

test.describe('los avisos suenan, no se hablan', () => {
  test.beforeEach(async ({ page }) => {
    await fakeAudio(page);
  });

  test('de punta a punta: no suena al empezar, un aviso por giro en el oído del giro y, al llegar, el timbre de tres notas', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    await guide(live).getByLabel('Destino').fill('parque ciud');
    await guide(live).getByRole('button', { name: /Parque de la Ciudadela/ }).click();
    await expect(guide(live)).toContainText(/llegada \d\d:\d\d/);
    await expect(guide(live)).toContainText('dos zumbidos unos 5 s antes de cada giro');
    await expect(page.getByRole('img', { name: 'Mapa con la ruta hasta el destino' })).toBeVisible();
    await guide(live).getByRole('button', { name: 'Iniciar', exact: true }).click();
    await expect(guide(live).locator('.guide__banner')).toBeVisible();
    // Al pulsar «Iniciar» no suena nada (ronda 45: solo hay tres avisos: giro, cambio de sentido o equivocación, y final de ruta).
    expect(await tones(page)).toEqual([]);

    await walkRoute(page, context);
    await expect(guide(live)).toContainText('Has llegado', { timeout: 10_000 });
    const all = await tones(page);
    const turns = all.slice(0, -3);
    // Cada giro suena UNA vez, siempre igual (dos zumbidos seguidos al mismo tono grave) y en el oído del lado: izquierdo (−1) o derecho (+1).
    const seen = JSON.stringify(turns);
    expect(turns.length, seen).toBeGreaterThanOrEqual(2);
    expect(turns.every((t) => t.hz === 190), seen).toBe(true);
    expect(turns.every((t) => t.pan === -1 || t.pan === 1), seen).toBe(true);
    expect(turns.some((t, i) => i > 0 && t.pan === turns[i - 1]!.pan), seen).toBe(true); // el doble zumbido de un giro normal
    // Al llegar: el timbre de tres notas limpias que suben (nada que ver con el zumbido), en los dos oídos.
    expect(all.slice(-3)).toEqual([{ hz: 660, pan: 0 }, { hz: 880, pan: 0 }, { hz: 1175, pan: 0 }]);
    await guide(live).getByRole('button', { name: 'Cerrar la ruta' }).click();
    await expectBackAtSearch(live);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`al terminar y revisar, además del pulso sale el mapa del recorrido hecho; guardado, vuelve a salir en el detalle (${scheme})`, async ({ page, context }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const live = await startWorkout(page, context, 'Caminar', true);
      await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
      await startRoute(live);
      await walkRoute(page, context);
      await expect(guide(live)).toContainText('Has llegado', { timeout: 10_000 });
      await pane(live, 1).getByRole('button', { name: 'Terminar', exact: true }).click();
      await pane(live, 1).getByRole('button', { name: 'Terminar y revisar' }).click();

      const review = page.getByRole('dialog', { name: 'Entrenamiento terminado' });
      const map = review.getByRole('img', { name: 'Recorrido de Caminar' });
      await expect(map).toBeVisible();
      await expect(review.getByText('Recorrido', { exact: true })).toBeVisible();
      // El dibujo no está vacío: lleva el trazo coral del recorrido y el punto verde de la salida (`trace` y `start` de `LIGHT`/`DARK` en `map-render.ts`).
      const want: { trace: [number, number, number]; start: [number, number, number] } = scheme === 'light' ? { trace: [255, 91, 58], start: [31, 157, 99] } : { trace: [255, 138, 101], start: [95, 212, 156] };
      const colors = async (): Promise<{ trace: number; start: number }> =>
        map.evaluate((el, want) => {
          const canvas = el as HTMLCanvasElement;
          const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
          let trace = 0;
          let start = 0;
          for (let i = 0; i < data.length; i += 4) {
            const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
            if (Math.abs(r - want.trace[0]) < 18 && Math.abs(g - want.trace[1]) < 22 && Math.abs(b - want.trace[2]) < 30) trace++;
            if (Math.abs(r - want.start[0]) < 14 && Math.abs(g - want.start[1]) < 14 && Math.abs(b - want.start[2]) < 14) start++;
          }
          return { trace, start };
        }, want);
      await expect.poll(async () => (await colors()).trace).toBeGreaterThan(300);
      expect((await colors()).start).toBeGreaterThan(20);
      // No es una caja que se sale de la hoja ni un cuadrado minúsculo.
      const box = (await map.boundingBox())!;
      expect(box.width).toBeGreaterThan(250);
      expect(box.height).toBeGreaterThan(150);

      const violations = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('dialog').analyze()).violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      expect(violations).toEqual([]);

      await review.getByRole('button', { name: 'Guardar' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();
      // Los entrenos de la demo son de otros días: el de hoy es el recién guardado.
      const today = (await page.evaluate(() => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date()))).replace('.', '');
      await page.locator('ul.wk-list > li').filter({ hasText: 'Caminar' }).filter({ hasText: today }).first().getByRole('button').click();
      const detail = page.getByRole('dialog', { name: 'Entrenamiento', exact: true });
      await expect(detail.getByRole('img', { name: 'Recorrido de Caminar' })).toBeVisible();
    });
  }

  test('con la navegación guiada apagada el mapa del recorrido sale igual al terminar (el GPS va siempre)', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', false);
    await expect(live.getByRole('tablist')).toHaveCount(0);
    // Unos 50 m hacia el norte, a ritmo de paseo (4 m cada segundo).
    for (let k = 1; k <= 12; k++) {
      await context.setGeolocation({ latitude: START.latitude + (k * 4) / 111_195, longitude: START.longitude, accuracy: 5 });
      await page.waitForTimeout(1000);
    }
    await live.getByRole('button', { name: 'Terminar', exact: true }).click();
    await live.getByRole('button', { name: 'Terminar y revisar' }).click();
    const review = page.getByRole('dialog', { name: 'Entrenamiento terminado' });
    await expect(review.getByRole('img', { name: 'Recorrido de Caminar' })).toBeVisible();
    await expect(review.getByText('Recorrido', { exact: true })).toBeVisible();
  });

  test('un entreno sin GPS (o sin distancia) no lleva mapa del recorrido', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await openDemo(page);
    await goTab(page, 'Deportes');
    await page.locator('.sports-grid').getByRole('button', { name: 'Fuerza' }).click();
    await page.getByRole('dialog', { name: 'Nuevo entrenamiento' }).getByRole('button', { name: 'Iniciar' }).click();
    const gym = page.getByRole('dialog', { name: 'Entrenamiento en curso' });
    await expect(gym.getByText('En marcha')).toBeVisible({ timeout: 15_000 });
    await gym.getByRole('button', { name: 'Terminar' }).click();
    await gym.getByRole('button', { name: 'Terminar y revisar' }).click();
    const review = page.getByRole('dialog', { name: 'Entrenamiento terminado' });
    await expect(review).toContainText('Fuerza');
    await expect(review.getByText('Recorrido', { exact: true })).toHaveCount(0);
  });

  test('silenciar corta los zumbidos y salir pide confirmar', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    await startRoute(live);
    const mute = guide(live).getByRole('button', { name: 'Silenciar los avisos sonoros' });
    await mute.click();
    await expect(guide(live).getByRole('button', { name: 'Activar los avisos sonoros' })).toHaveAttribute('aria-pressed', 'true');
    const before = (await tones(page)).length;
    await walkRoute(page, context);
    expect((await tones(page)).length).toBe(before);
    await guide(live).getByRole('button', { name: 'Cerrar la ruta' }).click();
    await expectBackAtSearch(live);
  });

  test('salir de la ruta pide confirmar', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    await startRoute(live);
    await guide(live).getByRole('button', { name: 'Salir' }).click();
    await expect(guide(live).getByRole('button', { name: 'Seguir' })).toBeVisible();
    await guide(live).getByRole('button', { name: 'Seguir' }).click();
    await expect(guide(live).locator('.guide__banner')).toBeVisible();
    await guide(live).getByRole('button', { name: 'Salir' }).click();
    await guide(live).getByRole('button', { name: 'Dejar la ruta' }).click();
    await expectBackAtSearch(live);
  });
});

test.describe('destinos sin camino hasta ellos', () => {
  test.beforeEach(async ({ page }) => {
    await fakeAudio(page);
  });

  test('un recinto cuyo sendero no sale a ninguna calle da ruta hasta la calle más cercana y lo dice, sin bloquearse', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    await guide(live).getByLabel('Destino').fill('recinto fer');
    await guide(live).getByRole('button', { name: /Recinto Ferial/ }).click();
    await expect(guide(live).getByRole('button', { name: 'Iniciar', exact: true })).toBeVisible();
    await expect(guide(live)).toContainText(/El camino acaba a \d+ m del destino/);
    await expect(guide(live)).not.toContainText('No encuentro un camino');
    // Y se puede elegir otro destino al momento.
    await guide(live).getByRole('button', { name: 'Cambiar de destino' }).click();
    await guide(live).getByLabel('Destino').fill('parque ciud');
    await guide(live).getByRole('button', { name: /Parque de la Ciudadela/ }).click();
    await expect(guide(live).getByRole('button', { name: 'Iniciar', exact: true })).toBeVisible();
  });

  test('en bici la ruta es de «Bici»', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Ciclismo', true);
    await expect(guide(live).getByRole('heading', { name: /Navegación · Bici/ })).toBeVisible({ timeout: 15_000 });
  });

  test('una búsqueda sin resultados lo dice', async ({ page, context }) => {
    const live = await startWorkout(page, context, 'Caminar', true);
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    await guide(live).getByLabel('Destino').fill('zzzzzz');
    await expect(guide(live)).toContainText('No encuentro nada con ese nombre en el mapa de tu zona.');
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accesibilidad (${scheme}): las dos pestañas, buscando, con la ruta y navegando`, async ({ page, context }) => {
    await fakeAudio(page);
    await page.emulateMedia({ colorScheme: scheme });
    const live = await startWorkout(page, context, 'Caminar', true);
    const axe = async (): Promise<string[]> => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include('dialog.live').analyze();
      return results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    };
    await expect(guide(live).getByLabel('Destino')).toBeVisible({ timeout: 15_000 });
    expect(await axe()).toEqual([]);
    await guide(live).getByLabel('Destino').fill('parque ciud');
    await expect(guide(live).getByRole('button', { name: /Parque de la Ciudadela/ })).toBeVisible();
    expect(await axe()).toEqual([]);
    await guide(live).getByRole('button', { name: /Parque de la Ciudadela/ }).click();
    await expect(guide(live).getByRole('button', { name: 'Iniciar', exact: true })).toBeVisible();
    expect(await axe()).toEqual([]);
    await guide(live).getByRole('button', { name: 'Iniciar', exact: true }).click();
    await expect(guide(live).locator('.guide__banner')).toBeVisible();
    expect(await axe()).toEqual([]);
    await expect(live.locator('.hud__chip')).toHaveCount(4);
    expect(await axe()).toEqual([]);
    // La pestaña «Entreno», sin tarjeta de oxígeno.
    await live.getByRole('tab', { name: 'Entreno' }).click();
    await expect(pane(live, 0).getByRole('group', { name: 'Oxígeno en sangre' })).toHaveCount(0);
    expect(await axe()).toEqual([]);
    await live.getByRole('tab', { name: 'Mapa' }).click();
    await expect(pane(live, 1).getByRole('button', { name: 'Terminar' })).toBeVisible();
    await pane(live, 1).getByRole('button', { name: 'Terminar' }).click();
    await expect(pane(live, 1).getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
    expect(await axe()).toEqual([]);
  });
}
