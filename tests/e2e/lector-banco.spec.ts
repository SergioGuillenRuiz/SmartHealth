import type { Locator, Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { activePage, expect, goTab, openDemo, test } from './fixtures';
import { ean13, mockProducts, YOGUR } from './products';

// BANCO de medida del lector de la tabla nutricional por foto (ronda 49). NO es parte de la suite normal: solo corre con `LABEL_BENCH=1`. Genera «fotos de móvil» de una tabla (envase de color
// con otros textos, un código de barras, la tabla girada, con grano, desenfoque y brillo) en tres diseños y tres niveles de dificultad, las lee con la app tal cual (elegir una foto de la galería en
// «Enseñarle este producto») y cuenta cuántas de las siete cifras salen bien (kcal, grasas, hidratos, azúcares, fibra, proteínas y sal). Las cifras se imprimen y se guardan en `LABEL_BENCH_OUT`
// (por omisión /tmp/lector-banco.json). Es sintético: tipografías del sistema, sin curvatura de envase: la cifra de verdad será más baja y sirve para COMPARAR cambios, no como nota.
// Variables: LABEL_BENCH_SEEDS (por omisión 2), LABEL_BENCH_ONLY (un nivel —facil, media, dura— o un diseño, para medir solo eso).

const RUN = process.env.LABEL_BENCH === '1';
const SEEDS = Number(process.env.LABEL_BENCH_SEEDS ?? 2);
const OUT = process.env.LABEL_BENCH_OUT ?? '/tmp/lector-banco.json';
const ONLY = process.env.LABEL_BENCH_ONLY ?? '';

type Level = 'facil' | 'media' | 'dura';
type Design = 'dos-columnas' | 'una-columna' | 'con-vrn';
const LEVELS: Level[] = ['facil', 'media', 'dura'];
const DESIGNS: Design[] = ['dos-columnas', 'una-columna', 'con-vrn'];

interface Truth {
  kcal: number;
  fat: number;
  carbs: number;
  sugars: number;
  fiber: number;
  protein: number;
  salt: number;
}

const FIELDS: Array<[keyof Truth, string, boolean]> = [
  ['kcal', 'Calorías por 100 g (kcal)', false],
  ['fat', 'Grasas (g)', false],
  ['carbs', 'Hidratos (g)', false],
  ['sugars', 'Azúcares (g)', false],
  ['fiber', 'Fibra (g)', false],
  ['protein', 'Proteínas (g)', false],
  ['salt', 'Sal (g)', true],
];

/** Cifras coherentes (la energía sale de los nutrientes) a partir de una semilla. */
function truthOf(seed: number): Truth {
  let s = (seed * 2654435761) >>> 0;
  const rand = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  const fat = round1(2 + rand() * 28);
  const carbs = round1(8 + rand() * 60);
  const protein = round1(1 + rand() * 20);
  const fiber = round1(rand() * 8);
  const sugars = round1(Math.min(carbs, rand() * carbs * 0.7));
  const salt = Math.round((0.05 + rand() * 1.9) * 100) / 100;
  const kcal = Math.round(9 * fat + 4 * carbs + 4 * protein + 2 * fiber);
  return { kcal, fat, carbs, sugars, fiber, protein, salt };
}

const sheet = (page: Page): Locator => page.locator('dialog.sheet[open]');
const nutrition = (page: Page): Locator => activePage(page).getByRole('region', { name: 'Nutrición', exact: true });

async function toTeach(page: Page): Promise<Locator> {
  await mockProducts(page, [YOGUR]);
  await goTab(page, 'Resumen');
  await nutrition(page).getByRole('button', { name: 'He comido algo' }).click();
  const dialog = sheet(page);
  await dialog.getByRole('button', { name: /Escanear un código de barras/ }).click();
  await dialog.getByLabel('O teclea el código').fill(ean13('841000000003'));
  await dialog.getByRole('button', { name: 'Buscar' }).click();
  await dialog.getByRole('button', { name: 'Enseñarle este producto' }).click();
  return dialog;
}

/** La «foto»: un envase de color de 1920 × 1080 con la tabla (en uno de los tres diseños) puesta encima, girada, borrosa, con grano y brillo. */
async function bench(page: Page, args: { design: Design; level: Level; seed: number; truth: Truth }): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ design, level, seed, truth }) => {
    let state = (seed * 7919 + 13) >>> 0;
    const rand = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
    const comma = (n: number): string => String(n).replace('.', ',');
    const font = { facil: 32, media: 21, dura: 15 }[level];
    const blur = { facil: 0.3, media: 0.7, dura: 1.1 }[level];
    const noise = { facil: 3, media: 6, dura: 10 }[level];

    // 1) La tabla a su tamaño natural.
    const kj = (kcal: number): number => Math.round(kcal * 4.184);
    const per = (value: number, factor: number, decimals = 1): number => Math.round(value * factor * 10 ** decimals) / 10 ** decimals;
    const rows: Array<[string, string, string, string]> = [
      ['Valor energético', `${kj(truth.kcal)} kJ / ${truth.kcal} kcal`, `${kj(per(truth.kcal, 0.3, 0))} kJ / ${per(truth.kcal, 0.3, 0)} kcal`, '12 %'],
      ['Grasas', `${comma(truth.fat)} g`, `${comma(per(truth.fat, 0.3))} g`, '8 %'],
      ['de las cuales saturadas', `${comma(Math.round(truth.fat * 0.3 * 10) / 10)} g`, `${comma(per(truth.fat * 0.3, 0.3))} g`, '6 %'],
      ['Hidratos de carbono', `${comma(truth.carbs)} g`, `${comma(per(truth.carbs, 0.3))} g`, '5 %'],
      ['de los cuales azúcares', `${comma(truth.sugars)} g`, `${comma(per(truth.sugars, 0.3))} g`, '7 %'],
      ['Fibra alimentaria', `${comma(truth.fiber)} g`, `${comma(per(truth.fiber, 0.3))} g`, '4 %'],
      ['Proteínas', `${comma(truth.protein)} g`, `${comma(per(truth.protein, 0.3))} g`, '9 %'],
      ['Sal', `${comma(truth.salt)} g`, `${comma(per(truth.salt, 0.3, 2))} g`, '6 %'],
    ];
    const pad = Math.round(font * 0.9);
    const rowH = Math.round(font * 1.75);
    const tw = Math.round(font * { 'dos-columnas': 24, 'una-columna': 17.5, 'con-vrn': 30 }[design]);
    const th = pad * 2 + font * 3 + rows.length * rowH;
    const table = document.createElement('canvas');
    table.width = tw;
    table.height = th;
    const t = table.getContext('2d') as CanvasRenderingContext2D;
    t.fillStyle = '#fbf8ee';
    t.fillRect(0, 0, tw, th);
    t.strokeStyle = '#1a1a1a';
    t.fillStyle = '#1a1a1a';
    t.lineWidth = Math.max(1, font / 14);
    t.strokeRect(pad / 2, pad / 2, tw - pad, th - pad);
    t.font = `bold ${font}px Arial, sans-serif`;
    t.fillText(design === 'una-columna' ? 'INFORMACIÓN NUTRICIONAL' : 'Información nutricional', pad, pad + font);
    const col1 = Math.round(tw * (design === 'una-columna' ? 0.96 : design === 'con-vrn' ? 0.5 : 0.62));
    const col2 = Math.round(tw * (design === 'con-vrn' ? 0.8 : 0.96));
    const col3 = tw - pad * 1.5;
    t.textAlign = 'right';
    if (design !== 'una-columna') {
      t.fillText('por 100 g', col1, pad + font * 2.1);
      t.fillText('por ración', col2, pad + font * 2.1);
      if (design === 'con-vrn') t.fillText('%VRN*', col3, pad + font * 2.1);
    } else {
      t.fillText('Valores por 100 g', col1, pad + font * 2.1);
    }
    t.textAlign = 'left';
    t.font = `${font}px Arial, sans-serif`;
    rows.forEach(([name, a, b, c], i) => {
      const y = pad + font * 3.4 + i * rowH;
      t.lineWidth = Math.max(1, font / 18);
      t.beginPath();
      t.moveTo(pad / 2, y - font * 1.05);
      t.lineTo(tw - pad / 2, y - font * 1.05);
      t.stroke();
      t.fillText(name, name.startsWith('de ') ? pad * 1.7 : pad, y);
      t.textAlign = 'right';
      t.fillText(a, col1, y);
      if (design !== 'una-columna') t.fillText(b, col2, y);
      if (design === 'con-vrn') t.fillText(c, col3, y);
      t.textAlign = 'left';
    });

    // 2) El envase: fondo de color, otros textos, un código de barras y un sello.
    const W = 1920;
    const H = 1080;
    const photo = document.createElement('canvas');
    photo.width = W;
    photo.height = H;
    const p = photo.getContext('2d') as CanvasRenderingContext2D;
    const hue = ([150, 210, 20, 340, 45] as number[])[Math.floor(rand() * 5)] as number;
    const g = p.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${hue} 55% 22%)`);
    g.addColorStop(1, `hsl(${hue + 20} 50% 34%)`);
    p.fillStyle = g;
    p.fillRect(0, 0, W, H);
    p.fillStyle = 'rgba(255,255,255,.88)';
    p.font = 'bold 54px Arial, sans-serif';
    p.fillText('GALLETAS INTEGRALES', 90, 120);
    p.font = '28px Arial, sans-serif';
    ['Ingredientes: harina de trigo integral (55 %), aceite de girasol, azúcar,', 'sal, levadura, extracto de malta. Puede contener trazas de frutos secos.', 'Conservar en un lugar fresco y seco. Consumir preferentemente antes del:', 'Lote L2450 · Envasado en atmósfera protectora · 300 g e'].forEach((line, i) => p.fillText(line, 90, 190 + i * 40));
    p.fillStyle = '#fff';
    p.fillRect(W - 420, H - 260, 330, 190);
    p.fillStyle = '#000';
    for (let x = W - 400; x < W - 110; x += 5) p.fillRect(x, H - 240, 2 + Math.floor(rand() * 3), 140);
    p.font = '22px monospace';
    p.fillText('8 410000 000030', W - 400, H - 85);
    p.beginPath();
    p.arc(W - 200, 180, 70, 0, Math.PI * 2);
    p.fillStyle = '#e8c547';
    p.fill();

    // 3) La tabla puesta encima: girada, desenfocada.
    const angle = (((rand() * 2 - 1) * (level === 'facil' ? 3 : level === 'media' ? 5 : 7)) * Math.PI) / 180;
    const cx = 700 + rand() * 360;
    const cy = 560 + rand() * 120;
    p.save();
    p.translate(cx, cy);
    p.rotate(angle);
    p.shadowColor = 'rgba(0,0,0,.35)';
    p.shadowBlur = 24;
    p.filter = `blur(${blur}px)`;
    p.drawImage(table, -tw / 2, -th / 2);
    p.restore();
    p.filter = 'none';

    // 4) Brillo y grano.
    const glare = p.createRadialGradient(cx + 150, cy - 120, 20, cx + 150, cy - 120, 520);
    glare.addColorStop(0, `rgba(255,255,255,${level === 'dura' ? 0.34 : level === 'media' ? 0.22 : 0.1})`);
    glare.addColorStop(1, 'rgba(255,255,255,0)');
    p.fillStyle = glare;
    p.fillRect(0, 0, W, H);
    const data = p.getImageData(0, 0, W, H);
    for (let i = 0; i < data.data.length; i += 4) {
      const n = (rand() - 0.5) * 2 * noise;
      data.data[i] = Math.max(0, Math.min(255, (data.data[i] as number) + n));
      data.data[i + 1] = Math.max(0, Math.min(255, (data.data[i + 1] as number) + n));
      data.data[i + 2] = Math.max(0, Math.min(255, (data.data[i + 2] as number) + n));
    }
    p.putImageData(data, 0, 0);
    const blob = await new Promise<Blob>((resolve) => photo.toBlob((b) => resolve(b as Blob), 'image/jpeg', 0.82));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }, args);
  return Buffer.from(base64, 'base64');
}

interface Result {
  design: Design;
  level: Level;
  seed: number;
  ms: number;
  ok: number;
  of: number;
  got: Record<string, string>;
  truth: Truth;
  texts: string[];
  boxes: unknown;
}

const results: Result[] = [];

// Sin `LABEL_BENCH=1` ni se registra: no aparece como pruebas saltadas en la suite normal.
if (RUN) test.describe('banco del lector de la tabla nutricional', () => {
  test.use({ allowedConsoleErrors: [/Estimating resolution as \d+|Detected \d+ diacritics|Image too small to scale|Line cannot be recognized/] });
  test.describe.configure({ mode: 'serial' });

  for (const design of DESIGNS) {
    for (const level of LEVELS) {
      if (ONLY !== '' && ONLY !== level && ONLY !== design) continue;
      for (let seed = 1; seed <= SEEDS; seed++) {
        test(`${design} · ${level} · ${seed}`, async ({ page }) => {
          test.setTimeout(240_000);
          await page.addInitScript(() => {
            navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('sin cámara', 'NotFoundError'));
          });
          await openDemo(page);
          const truth = truthOf(seed * 31 + design.length * 7 + level.length);
          const dialog = await toTeach(page);
          await dialog.getByRole('button', { name: /Hacer una foto a la tabla/ }).click();
          const buffer = await bench(page, { design, level, seed, truth });
          const started = Date.now();
          await dialog.getByLabel('Foto de la tabla nutricional').setInputFiles({ name: 'foto.jpg', mimeType: 'image/jpeg', buffer });
          await expect(dialog.getByLabel('Calorías por 100 g (kcal)').or(dialog.getByText(/no he podido|no se ha podido|no he encontrado|no he leído/i).first())).toBeVisible({ timeout: 200_000 });
          const ms = Date.now() - started;
          const got: Record<string, string> = {};
          let ok = 0;
          for (const [key, label, exact] of FIELDS) {
            const field = dialog.getByLabel(label, { exact });
            const value = (await field.count()) > 0 ? await field.inputValue() : '';
            got[key] = value;
            const parsed = Number(value.replace(',', '.'));
            if (value !== '' && Math.abs(parsed - truth[key]) <= (key === 'kcal' ? 1 : key === 'salt' ? 0.011 : 0.051)) ok++;
          }
          const probe = await page.evaluate(() => (window as unknown as { __smartringLabel?: { reads: Array<{ texts: string[]; boxes: unknown }> } }).__smartringLabel?.reads.at(-1));
          results.push({ design, level, seed, ms, ok, of: FIELDS.length, got, truth, texts: probe?.texts ?? [], boxes: probe?.boxes ?? [] });
          console.log(`BANCO ${design} ${level} ${seed}: ${ok}/${FIELDS.length} en ${(ms / 1000).toFixed(1)} s · verdad ${JSON.stringify(truth)} · leído ${JSON.stringify(got)}`);
        });
      }
    }
  }

  test.afterAll(() => {
    const summary: Record<string, { ok: number; of: number; ms: number; n: number }> = {};
    for (const r of results) {
      for (const key of ['todo', r.level, r.design]) {
        const entry = (summary[key] ??= { ok: 0, of: 0, ms: 0, n: 0 });
        entry.ok += r.ok;
        entry.of += r.of;
        entry.ms += r.ms;
        entry.n += 1;
      }
    }
    const lines = Object.entries(summary).map(([key, v]) => `${key}: ${((100 * v.ok) / v.of).toFixed(0)} % (${v.ok}/${v.of}) · ${(v.ms / v.n / 1000).toFixed(1)} s por foto`);
    console.log(`BANCO RESUMEN\n${lines.join('\n')}`);
    writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
  });
});
