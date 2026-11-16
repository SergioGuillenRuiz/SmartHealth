// Genera los iconos de lanzador de Android (android/app/src/main/res/mipmap-*), el icono monocromo de Android 13 y la pantalla de arranque
// (drawable*/splash.png) a partir de public/icon.svg. Se ejecuta a mano: `node scripts/make-android-icons.mjs`; los PNG se guardan en el repositorio.
// (El icono anterior, el del anillo, está guardado en branding/anillo: ver su README para volver a él.)
//
// Android 8+ usa iconos adaptativos: un fondo (el color de ic_launcher_background.xml) y un primer plano que el sistema
// recorta con la forma que elija el fabricante; el dibujo debe caber en la zona central. Los iconos «legacy» (Android 7) son
// el cuadrado con esquinas redondeadas completo.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
// Verde de la marca (el tono medio del degradado de icon.svg): el fondo liso del icono adaptativo.
const BRAND = '#177a58';

// Primer plano: el dibujo de icon.svg (lo que hay entre las marcas «glyph», con sus degradados y su sombra), sin el fondo.
const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)?.[0];
const glyph = svg.split('<!-- glyph -->')[1]?.split('<!-- /glyph -->')[0];
const mono = svg.split('<!-- mono -->')[1]?.split('<!-- /mono -->')[0];
if (!defs || !glyph || !mono) throw new Error('public/icon.svg ha perdido el bloque <defs> o las marcas glyph y mono que usa este script');
// Zona segura: un círculo de 66 dp en el lienzo de 108 dp (61 % del lado = radio de 156 px sobre 512). Lo más lejano del dibujo (la punta de la hoja)
// está a unos 175 px del centro del lienzo en icon.svg; con 0,85 queda en unos 149 px, dentro de la zona segura y con algo de aire
// respecto a la máscara circular. Solo la sombra, muy difusa, asoma por fuera. (Medido sobre el PNG: píxeles con alfa > 200.)
const SAFE = 0.85;
// El fondo adaptable solo admite un color liso, así que el primer plano lleva encima un velo con el degradado y el brillo del fondo de
// icon.svg (mismos colores): sobre BRAND el resultado es el mismo icono que el de la PWA. Desde el centro (BRAND) hacia la
// esquina superior izquierda aclara y hacia la inferior derecha oscurece, con transparencia creciente de un solo color por mitad.
const foregroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${defs}
  <defs>
    <linearGradient id="tone" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#26a37a"/>
      <stop offset=".55" stop-color="#26a37a" stop-opacity="0"/>
      <stop offset=".55" stop-color="#0c4a38" stop-opacity="0"/>
      <stop offset="1" stop-color="#0c4a38"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#tone)"/>
  <rect width="512" height="512" fill="url(#sheen)"/>
  <g transform="translate(256 256) scale(${SAFE}) translate(-256 -256)">${glyph}</g>
</svg>`;
// Variante redonda: el mismo icono recortado en círculo (los dos rect del fondo).
const roundSvg = svg.replaceAll('rx="112"', 'rx="256"');

// Icono monocromo (Android 13+, «iconos con tema»): solo importa la forma; el sistema la tiñe con el color del tema.
const monochromeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <g transform="translate(256 256) scale(${SAFE}) translate(-256 -256)">${mono}</g>
</svg>`;

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const targets = [];
for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = `../android/app/src/main/res/mipmap-${density}`;
  targets.push({ file: `${dir}/ic_launcher.png`, size: 48 * scale, source: svg });
  targets.push({ file: `${dir}/ic_launcher_round.png`, size: 48 * scale, source: roundSvg });
  targets.push({ file: `${dir}/ic_launcher_foreground.png`, size: 108 * scale, source: foregroundSvg });
  targets.push({ file: `${dir}/ic_launcher_monochrome.png`, size: 108 * scale, source: monochromeSvg });
}

// Pantalla de arranque (la de la plantilla de Capacitor era una cruz azul sobre blanco): el verde liso de la marca con el dibujo
// en el centro, a un 26 % del lado corto (la imagen se estira hasta llenar la pantalla de arranque, así que el dibujo es
// discreto; un fondo liso pesa casi nada, uno con degradado, más de un mega por imagen). Tamaños y carpetas de la plantilla
// de Capacitor.
const SPLASH = {
  'drawable': [480, 320],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
};
// La manzana de icon.svg mide unos 300 px de ancho sobre 512 (el anillo anterior medía 337).
const GLYPH_WIDTH = 300;
const splashSvg = (w, h) => {
  const k = (0.26 * Math.min(w, h)) / GLYPH_WIDTH;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">
  ${defs}
  <rect width="${w}" height="${h}" fill="${BRAND}"/>
  <g transform="translate(${w / 2} ${h / 2}) scale(${k}) translate(-256 -256)">${glyph}</g>
</svg>`;
};
for (const [dir, [w, h]] of Object.entries(SPLASH)) targets.push({ file: `../android/app/src/main/res/${dir}/splash.png`, width: w, height: h, source: splashSvg(w, h), opaque: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const { file, size, width = size, height = size, source, opaque } of targets) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${source}`);
  const png = await page.screenshot({ omitBackground: !opaque, clip: { x: 0, y: 0, width, height } });
  writeFileSync(new URL(file, import.meta.url), png);
  await page.close();
  console.log('ok', file.replace('../android/app/src/main/res/', ''), `${width}x${height}`, png.length, 'bytes');
}
await browser.close();

writeFileSync(
  new URL('../android/app/src/main/res/values/ic_launcher_background.xml', import.meta.url),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND}</color>\n</resources>\n`,
);
console.log('ok values/ic_launcher_background.xml', BRAND);

// Los iconos adaptables llevan también la capa monocromo (la ignoran los Android anteriores a 13).
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
for (const name of ['ic_launcher', 'ic_launcher_round']) writeFileSync(new URL(`../android/app/src/main/res/mipmap-anydpi-v26/${name}.xml`, import.meta.url), adaptive);
console.log('ok mipmap-anydpi-v26/ic_launcher(.round).xml con la capa monocromo');
