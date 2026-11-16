// Genera los iconos PNG de la PWA a partir de public/icon.svg (se ejecuta a mano: `node scripts/make-icons.mjs`).
// Los PNG resultantes se guardan en el repositorio, así el build no depende de un navegador. (El icono anterior, el del anillo, está en branding/anillo.)
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
// Variante "maskable": a sangre (sin esquinas redondeadas); el sistema aplica su propia máscara. El fondo son dos rect
// (degradado y brillo), así que se cambian todas las esquinas, no solo la primera.
const maskableSvg = svg.replaceAll('rx="112"', 'rx="0"');

const targets = [
  { file: 'icon-192.png', size: 192, source: svg, transparent: true },
  { file: 'icon-512.png', size: 512, source: svg, transparent: true },
  { file: 'icon-maskable-512.png', size: 512, source: maskableSvg, transparent: false },
  { file: 'apple-touch-icon.png', size: 180, source: maskableSvg, transparent: false },
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const { file, size, source, transparent } of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
  const png = await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(new URL(`../public/icons/${file}`, import.meta.url), png);
  await page.close();
  console.log('ok', file, png.length, 'bytes');
}
await browser.close();
