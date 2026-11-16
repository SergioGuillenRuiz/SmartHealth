# Atribuciones y licencias

## Protocolo del anillo

El protocolo **YCBT** (Yucheng) que habla el R99 se ha reconstruido a partir de la documentación del proyecto
**PulseLoop** ([iOS](https://github.com/saksham2001/PulseLoopiOS) y Android), publicado bajo
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0), que a su vez documenta el
SDK del fabricante (`com.yucheng.ycbtsdk`). Los vectores de prueba reales de `src/ble/fixtures.ts` (registros de
pulso, constantes y una noche de sueño) proceden de las capturas de ese proyecto, hechas sobre un anillo TK5 con la
app oficial Smart Health. Se han adaptado y se usan solo como datos de prueba del decodificador.

Esta app es un proyecto independiente: no está afiliada a Yucheng, a Smart Health ni a PulseLoop.

## Métodos y fórmulas (referencias científicas)

- Ainsworth BE et al. *2011 Compendium of Physical Activities*. Med Sci Sports Exerc 43(8):1575–81 — MET de caminar,
  correr y ciclismo, y valores generales por deporte.
- Mifflin MD et al. 1990, *A new predictive equation for resting energy expenditure*. Am J Clin Nutr 51:241–7 —
  metabolismo basal.
- Keytel LR et al. 2005, *Prediction of energy expenditure from heart rate monitoring during submaximal exercise*.
  J Sports Sci 23(3):289–97 — gasto energético a partir del pulso.
- Tanaka H, Monahan KD, Seals DR. 2001, *Age-predicted maximal heart rate revisited*. J Am Coll Cardiol 37:153–6 —
  pulso máximo teórico.
- Herrmann SD et al. *2024 Adult Compendium of Physical Activities* (J Sport Health Sci 2024) — MET de la bici eléctrica
  según la asistencia (códigos 01080, 01084 y 01088; valores tomados de fuentes secundarias, por confirmar en la tabla
  original) para BiciMAD.

## Alimentación

- **[Open Food Facts](https://world.openfoodfacts.org)**: los datos de los productos que se buscan por su código de barras (nombre, marca, valores por 100 g, ración) vienen de esta base de datos abierta y
  colaborativa, bajo la licencia [ODbL](https://opendatacommons.org/licenses/odbl/1-0/) (los datos de cada producto, bajo su licencia de contenidos). La app lleva dentro un **recorte** de la base (los
  productos de España, solo con esos campos; `src/data/foods/productos-es.bin`, con su fecha en `productos-es.json`) y no consulta nada por internet. Es una base derivada de la de Open Food Facts: quien la
  redistribuyera tendría que mantener esta atribución y la misma licencia. La información la sube la gente y puede tener errores. Los mismos datos sirven para buscar un producto por su **nombre** al contar una comida
  con palabras («pizza de trufa»); el nombre, la marca y las cifras que se usan son los de la base, sin cambios.
- **[Tesseract](https://github.com/tesseract-ocr/tesseract)** (Apache-2.0), compilado a WebAssembly con **[tesseract.js](https://github.com/naptha/tesseract.js)** (Apache-2.0), con los datos de idioma español de `tessdata_fast` (Apache-2.0): leen la tabla nutricional de una foto, en el propio móvil.
- **[ZXing-C++](https://github.com/zxing-cpp/zxing-cpp)** (Apache-2.0), compilado a WebAssembly con **[zxing-wasm](https://github.com/Sec-ant/zxing-wasm)** (MIT): lee los códigos de barras con la cámara, dentro del móvil.
- **Tabla de alimentos** (`src/data/foods/alimentos.txt`): valores medios por 100 g, redondeados y escritos a mano a partir de las tablas de composición de alimentos habituales (por ejemplo, [USDA FoodData Central](https://fdc.nal.usda.gov),
  de dominio público) y de etiquetas típicas; no se ha copiado ninguna base de datos. Son una orientación, no los valores de una marca concreta.
- **Cadenas de restaurantes** (`src/data/foods/alimentos-cadenas.txt`) y **platos con ingredientes** (`alimentos-compuestos.txt`): las cifras de los productos de cadena (McDonald's, Burger King, KFC, Subway, Starbucks, Five Guys y algunas pizzerías a domicilio) son las
  raciones y calorías que esas cadenas publican en sus tablas nutricionales, **recordadas y redondeadas a mano**, no copiadas de ninguna tabla ni contrastadas con las vigentes; los nombres de marcas y productos son de sus titulares y se usan solo para
  reconocer lo que la persona escribe. Las piezas de los platos (cuánto pan, carne o salsa lleva un kebab) son medias estimadas por quien mantiene la app.
- Las recomendaciones de calorías y proteína por objetivo siguen las pautas habituales de nutrición deportiva (por ejemplo, Jäger R et al. 2017, *International Society of Sports Nutrition Position Stand: protein and
  exercise*, J Int Soc Sports Nutr 14:20; Helms ER et al. 2014, *Evidence-based recommendations for natural bodybuilding contest preparation*, J Int Soc Sports Nutr 11:20) y son una orientación, no una pauta médica.

## Iconos

Los iconos de los deportes y de las cifras (andar, correr, bici, senderismo, natación, pesas, yoga, balones, llama, bandera,
chincheta…) son de **[Tabler Icons](https://tabler.io/icons)** 3.49.0, licencia **MIT** © codecalm. No se instala el paquete
(declara `preact@^10` como dependencia y el proyecto usa Preact 11): `scripts/vendor-icons.mjs` copia al proyecto, en
`src/ui/icon-set.ts`, solo los dibujos que se usan. El resto de iconos (pestañas, actividad, sueño, ritmo, flechas, cerrar…)
son de lucide. Los iconos de la comida (quesos, panes, pescados, bebidas…, ver `src/ui/meal-icon.ts`) salen de las dos
familias (lucide y los que copia el mismo script de Tabler) y de unos pocos dibujados para la app (tomate, patata, brócoli, fresa,
sandía, piña, patatas fritas, kebab, wrap, pasta y arroz). La pala de pádel y el icono de BiciMAD (la bici con un rayo) están dibujados para la app
(`src/ui/icon-custom.ts`), igual que el **anillo** (`RingIcon`, en `src/ui/icons.tsx`: una banda gruesa en perspectiva con su
sensor) y el icono de la aplicación (`public/icon.svg`: una manzana con una línea de pulso, de donde salen los PNG de la PWA y los de Android, también el monocromo, con
`npm run icons` y `node scripts/make-android-icons.mjs`; el icono anterior, el del anillo, está archivado en `branding/anillo/`).

## Dependencias

| Paquete | Licencia |
|---|---|
| Preact, @preact/signals, @preact/preset-vite | MIT |
| idb | ISC |
| lucide-preact (iconos) | ISC |
| Tabler Icons (iconos copiados, no instalados) | MIT |
| Vite, Vitest | MIT |
| Playwright | Apache-2.0 |
| @axe-core/playwright, axe-core | MPL-2.0 |
| fake-indexeddb | Apache-2.0 |
| zxing-wasm | MIT (ZXing-C++: Apache-2.0) |
| TypeScript | Apache-2.0 |

## Imágenes de las comidas

- **[Fluent UI Emoji](https://github.com/microsoft/fluentui-emoji)** de Microsoft (licencia MIT, copia en `src/ui/food-photos/LICENSE.txt`): las ilustraciones en 3D de la lista de comidas y de su hoja de detalles
  (`src/ui/food-photos/*.webp`, versiones reducidas a 160 px de los PNG «3D»). No son fotos de los productos: cada una sirve para todo un tipo de comida (la hamburguesa para cualquier hamburguesa); lo que se
  reconoce como qué comida es lo decide `src/ui/meal-icon.ts` y la tabla de `src/ui/meal-photo.ts` dice qué imagen le toca. Van dentro de la app: no se pide ninguna imagen por internet.

## Fuentes de las metas de agua y de la nota de cada comida

No se copia ningún código ni dato de estas fuentes: son las referencias de las cifras que usa `domain/hydration.ts` y `domain/meal-fit.ts` (detalle en [estimaciones](estimaciones.md#hidratación)).

- **EFSA** (Autoridad Europea de Seguridad Alimentaria), *Scientific Opinion on Dietary Reference Values for water*, EFSA Journal 2010;8(3):1459: ingesta adecuada de agua total de 2,0 l (mujeres) y 2,5 l (hombres), con en torno al 20 % procedente de los alimentos.
- **IOM** (Institute of Medicine, EE. UU.), *Dietary Reference Intakes for Water, Potassium, Sodium, Chloride, and Sulfate*, National Academies Press, 2004: 2,7 l y 3,7 l.
- **ESPEN** (Sociedad Europea de Nutrición Clínica y Metabolismo), guía de nutrición e hidratación en geriatría, 2019: 30–35 ml/kg al día.
- **Morton y cols.**, *Br J Sports Med* 2018, y **Helms y cols.**, 2014: proteína en déficit y para ganar músculo. **Schoenfeld y Aragon**, *J Int Soc Sports Nutr* 2018: dosis por comida que estimulan la síntesis de proteína muscular.
- **WCRF/AICR** (Fondo Mundial de Investigación del Cáncer): densidad energética de los alimentos (el umbral de 125 y 225 kcal/100 g).

## Miniaturas de las comidas

- Las **ilustraciones 3D** de los tipos de comida son de los «Fluent Emoji» de Microsoft ([repositorio](https://github.com/microsoft/fluentui-emoji), licencia MIT; copia de la licencia en `src/ui/food-photos/LICENSE.txt`). Las generales van
  en el repositorio y las finas las baja y reduce el CI (`tools/build-food-icons.ts`) del mismo repositorio.
- La **foto del producto** de las comidas anotadas con código de barras se pide, con conexión, a [Open Food Facts](https://world.openfoodfacts.org) (imágenes bajo la licencia CC BY-SA de la base; la app solo las enseña, no las guarda). Solo se
  envía el código del producto. Sin conexión o sin foto, se usa la ilustración.

## Mapa del navegador

- Los **datos del mapa** (calles, sendas, parques, agua y nombres de lugares) son de **OpenStreetMap** (© colaboradores de OpenStreetMap, licencia ODbL 1.0, <https://www.openstreetmap.org/copyright>). La app baja de [Overpass](https://overpass-api.de) (servicio público de consulta de OpenStreetMap; de respaldo, `overpass.kumi.systems`) solo la zona en que está la persona y la convierte en un archivo propio (`src/domain/nav/pack-builder.ts`) que guarda en el móvil. El mapa en pantalla lleva «© OpenStreetMap» en una esquina. Todo lo derivado (la zona guardada) conserva la licencia ODbL.
