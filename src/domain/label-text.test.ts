import { describe, expect, it } from 'vitest';
import { OCR_SAMPLES } from './label-ocr-samples';
import { draftFromReading, isConfidentReading, joinNameAndValueBlocks, mergeReadings, readingScore, readLabelText } from './label-text';

const read = (text: string, withName = false) => readLabelText(text, { withName });

describe('lo dictado o escrito con palabras', () => {
  it('cifras tal como las escribe el teclado de dictado, con el número antes del nutriente', () => {
    const r = read('480 calorías, 6 gramos de proteínas, 70 gramos de hidratos, 20 gramos de grasas, 3 de fibra, 30 de azúcares y 0,5 de sal');
    expect(r).toMatchObject({ kcal: 480, proteinG: 6, carbsG: 70, fatG: 20, fiberG: 3, sugarsG: 30, saltG: 0.5, found: 7 });
  });

  it('con el nutriente antes de la cifra', () => {
    const r = read('calorías 480, proteínas 6, hidratos 70, grasas 20, fibra 3, azúcares 30, sal 0,5');
    expect(r).toMatchObject({ kcal: 480, proteinG: 6, carbsG: 70, fatG: 20, fiberG: 3, sugarsG: 30, saltG: 0.5 });
  });

  it('sin comas ni puntos (el dictado a veces no las pone)', () => {
    const r = read('proteínas 6 gramos hidratos 70 gramos grasas 20 gramos 480 kilocalorías');
    expect(r).toMatchObject({ kcal: 480, proteinG: 6, carbsG: 70, fatG: 20 });
  });

  it('con los números dichos en palabras', () => {
    const r = read('cuatrocientas ochenta calorías, seis gramos de proteínas, setenta de hidratos, veinte de grasas y cero coma cinco de sal');
    expect(r).toMatchObject({ kcal: 480, proteinG: 6, carbsG: 70, fatG: 20, saltG: 0.5 });
    expect(read('treinta y cinco de azúcares, tres coma dos de fibra, cero coma cero cinco de sal')).toMatchObject({ sugarsG: 35, fiberG: 3.2, saltG: 0.05 });
    expect(read('mil cuarenta y seis kilojulios')).toMatchObject({ kcal: 250 });
  });

  it('el nombre es lo primero que se dice, si no es una cifra ni un nutriente', () => {
    expect(read('Galletas de la abuela: 480 kcal, 6 g de proteínas, 70 g de hidratos, 20 g de grasas', true).name).toBe('Galletas de la abuela');
    expect(read('Nombre: crema de cacahuete, 600 calorías, 25 de proteínas', true)).toMatchObject({ name: 'Crema de cacahuete', kcal: 600, proteinG: 25 });
    expect(read('Una barrita de avena, 400 kcal', true).name).toBe('Una barrita de avena');
    expect(read('480 calorías, 6 de proteínas', true).name).toBeNull();
    expect(read('tiene 480 calorías y 6 de proteínas', true).name).toBeNull();
    expect(read('Galletas, 480 kcal').name).toBeNull(); // el nombre solo se busca si se pide
  });

  it('lo que no se dice queda sin dato, no a cero', () => {
    const r = read('250 kcal, 10 de proteínas');
    expect(r).toMatchObject({ kcal: 250, proteinG: 10, carbsG: null, fatG: null, fiberG: null, sugarsG: null, saltG: null, found: 2 });
  });

  it('un texto sin ninguna cifra de nutrientes no encuentra nada', () => {
    expect(read('unas galletas muy ricas').found).toBe(0);
    expect(read('').found).toBe(0);
  });

  it('las grasas saturadas no sustituyen a las grasas; los azúcares no son los hidratos', () => {
    const r = read('grasas 12 g, de las cuales saturadas 3 g, hidratos 70 g, de los cuales azúcares 30 g');
    expect(r).toMatchObject({ fatG: 12, carbsG: 70, sugarsG: 30 });
  });

  it('el sodio se pasa a sal (× 2,5); si hay sal, manda la sal', () => {
    expect(read('sodio 200 mg').saltG).toBe(0.5);
    expect(read('sodio 0,2 g').saltG).toBe(0.5);
    expect(read('sal 1,2 g, sodio 0,4 g').saltG).toBe(1.2);
  });

  it('una cifra en miligramos pasa a gramos', () => {
    expect(read('fibra 500 mg').fiberG).toBe(0.5);
  });
});

describe('texto leído de la foto de una etiqueta', () => {
  it('una tabla española típica, por 100 g', () => {
    const r = read(`INFORMACIÓN NUTRICIONAL
Valores medios por 100 g
Valor energético 1046 kJ / 250 kcal
Grasas 12 g
 de las cuales saturadas 3,1 g
Hidratos de carbono 28 g
 de los cuales azúcares 9,5 g
Fibra alimentaria 2,1 g
Proteínas 6,0 g
Sal 0,52 g`);
    expect(r).toMatchObject({ kcal: 250, fatG: 12, carbsG: 28, sugarsG: 9.5, fiberG: 2.1, proteinG: 6, saltG: 0.52, basis: 'per100', found: 7 });
  });

  it('sin las kcal, solo kJ: se pasan', () => {
    const r = read('Energía 1046 kJ\nGrasas 12 g\nProteínas 6 g');
    expect(r.kcal).toBe(250);
  });

  it('la energía sin unidad: más de 900 es kJ, menos kcal', () => {
    expect(read('Energía 1046\nGrasas 12 g').kcal).toBe(250);
    expect(read('Calorías 250\nGrasas 12 g').kcal).toBe(250);
  });

  it('dos columnas, por 100 g y por ración: manda la de 100 g', () => {
    const r = read(`Por 100 g | Por ración (30 g)
Energía 1046 kJ / 250 kcal 314 kJ / 75 kcal
Grasas 12 g 3,6 g
Hidratos de carbono 28 g 8,4 g
Proteínas 6,0 g 1,8 g
Sal 0,52 g 0,16 g`);
    expect(r).toMatchObject({ kcal: 250, fatG: 12, carbsG: 28, proteinG: 6, saltG: 0.52, basis: 'per100' });
  });

  it('dos columnas con la de la ración primero: se coge la segunda (la de 100 g)', () => {
    const r = read(`Por ración (30 g) | Por 100 g
Energía 75 kcal 250 kcal
Grasas 3,6 g 12 g
Proteínas 1,8 g 6,0 g`);
    expect(r).toMatchObject({ kcal: 250, fatG: 12, proteinG: 6, basis: 'per100' });
  });

  it('solo por ración, con la ración conocida: se pasa a 100 g', () => {
    const r = read(`Por ración (ración de 25 g)
Energía 100 kcal
Grasas 5 g
Hidratos de carbono 12 g
Proteínas 2 g
Sal 0,1 g`);
    expect(r).toMatchObject({ basis: 'serving', servingG: 25 });
    const { draft, scaled } = draftFromReading(r, '8410000000016');
    expect(scaled).toBe(true);
    expect(draft).toMatchObject({ kcal: 400, fatG: 20, carbsG: 48, proteinG: 8, saltG: 0.4, servingG: 25 });
  });

  it('los porcentajes de lo recomendado no se toman por cifras', () => {
    const r = read('Grasas 12 g 17%\nProteínas 6 g 12%\nSal 0,5 g 8%');
    expect(r).toMatchObject({ fatG: 12, proteinG: 6, saltG: 0.5 });
  });

  it('un cero mal leído como letra «o» entre cifras se corrige', () => {
    expect(read('Energía 2o0 kcal').kcal).toBe(200);
  });

  it('lo que se parece a una tabla pero trae basura alrededor se lee igual', () => {
    const r = read(`~ ¡ NUTRICIÓN ::
 Valor energético  : 1.046 kJ / 250 kcal |
   Grasas  | 12 g ¦ 17 %
 - saturadas  3,1 g
 Hidratos de carbono: 28 g`);
    expect(r).toMatchObject({ kcal: 250, fatG: 12, carbsG: 28 });
  });
});

describe('draftFromReading', () => {
  it('pasa lo leído al formulario y no inventa lo que falta', () => {
    const { draft, scaled } = draftFromReading(read('Galletas, 480 kcal, 6 de proteínas', true), '8410000000016');
    expect(scaled).toBe(false);
    expect(draft).toEqual({ barcode: '8410000000016', name: 'Galletas', kcal: 480, proteinG: 6, carbsG: null, fatG: null, fiberG: null, sugarsG: null, saltG: null, servingG: null });
  });

  it('lleva el nombre dictado', () => {
    expect(draftFromReading(read('Galletas de la abuela: 480 kcal', true), '8410000000016').draft.name).toBe('Galletas de la abuela');
  });

  it('por ración sin saber cuánto pesa: no se convierte (se deja tal cual para revisarlo)', () => {
    const r = read('Por ración\nEnergía 100 kcal');
    expect(r.basis).toBe('serving');
    expect(draftFromReading(r, '8410000000016')).toMatchObject({ scaled: false, draft: { kcal: 100 } });
  });
});

describe('lo que sale de un OCR de verdad (modo `ocr`)', () => {
  it.each(OCR_SAMPLES.map((sample) => [sample.name, sample] as const))('%s: lee las siete cifras de la columna de 100 g tal como las lee el OCR, con sus fallos', (_name, sample) => {
    const reading = readLabelText(sample.text, { ocr: true });
    expect(reading).toMatchObject({ ...sample.expected, found: 7 });
    expect(isConfidentReading(reading)).toBe(true);
  });

  it('sin el modo OCR esas mismas lecturas se leen mal (la «g» como «9» y los nombres separados de las cifras): es lo que había antes', () => {
    const exact = OCR_SAMPLES.filter((sample) => {
      const reading = readLabelText(sample.text);
      return (Object.keys(sample.expected) as Array<keyof typeof sample.expected>).every((key) => reading[key] === sample.expected[key]);
    });
    expect(exact.length).toBeLessThan(OCR_SAMPLES.length / 3);
  });

  it('la «g» pegada y leída como «9»: «13,29» es «13,2 g», y lo que cuadra con la energía manda', () => {
    const r = readLabelText('Valor energético 1276 kJ / 305 kcal\nGrasas 13,29\nHidratos de carbono 11,6 g\nProteínas 30,39\nFibra 5,39\nSal 1,96 g', { ocr: true });
    expect(r).toMatchObject({ kcal: 305, fatG: 13.2, carbsG: 11.6, proteinG: 30.3, fiberG: 5.3, saltG: 1.96 });
  });

  it('un entero con la «g» leída como «9» («21 g» → «219») se corrige solo si la energía no cuadra con él', () => {
    const base = 'Valor energético 1100 kJ / 263 kcal\nGrasas 10 g\nHidratos de carbono 20 g\n';
    // 9·10 + 4·20 + 4·21 = 254 ≈ 263: «21» es lo que cuadra aunque se lea «219».
    expect(readLabelText(`${base}Proteínas 219`, { ocr: true }).proteinG).toBe(21);
    // Y una cifra que de verdad es de dos cifras y cuadra, no se toca.
    expect(readLabelText(`${base}Proteínas 21 g`, { ocr: true }).proteinG).toBe(21);
  });

  it('la coma perdida («2,9 g» leído «29») se vuelve a poner cuando la cifra leída es imposible', () => {
    const r = readLabelText('Valor energético 1135 kJ / 271 kcal\nGrasas 5,4 g\nHidratos de carbono 47,9 g\nde los cuales azúcares 88\nFibra alimentaria 29\nProteínas 6,3 g', { ocr: true });
    expect(r.sugarsG).toBe(8.8); // más que los hidratos no puede ser el azúcar… 88 g sobre 47,9
    expect(r.fiberG).toBe(2.9);
  });

  it('si la «g» sale como «9» en varias cifras de la etiqueta, también en la sal, que la energía no vigila («1,29» es «1,2 g»)', () => {
    const photo = 'Valor energético 1850 kJ / 440 kcal\nGrasas 189\nHidratos de carbono 529\nde los cuales azúcares 12g\nFibra alimentaria 4,59\nProteínas 9,09\nSal 1,29';
    expect(readLabelText(photo, { ocr: true })).toMatchObject({ fatG: 18, carbsG: 52, fiberG: 4.5, proteinG: 9, saltG: 1.2 });
    // Sin ese rastro en el resto de la etiqueta, una sal de dos decimales que acaba en 9 se deja como está.
    const clean = 'Valor energético 1850 kJ / 440 kcal\nGrasas 18 g\nHidratos de carbono 52 g\nde los cuales azúcares 12 g\nFibra alimentaria 4,5 g\nProteínas 9 g\nSal 1,29';
    expect(readLabelText(clean, { ocr: true }).saltG).toBe(1.29);
  });

  it('una cifra con un solo decimal que acaba en 9 y un resto de letras («1,9E8») es un 1,9 de verdad, aunque en el resto de la etiqueta la «g» salga como «9»', () => {
    const r = readLabelText('Valor energético 1850 kJ / 440 kcal\nGrasas 189\nHidratos de carbono 529\nde los cuales azúcares 1,9E8\nProteínas 9,09\nSal 0,07 g', { ocr: true });
    expect(r.sugarsG).toBe(1.9);
  });

  it('una sal de «12» sin coma ni unidad claras es «1,2»: ningún alimento corriente lleva 12 g de sal por 100 g', () => {
    expect(readLabelText('Valor energético 1850 kJ / 440 kcal\nGrasas 18 g\nHidratos de carbono 52 g\nProteínas 9 g\nSal 129', { ocr: true }).saltG).toBe(1.2);
  });

  it('nombres con una letra mal leída («hidratcs», «protelnas») se siguen reconociendo', () => {
    const r = readLabelText('Hidratcs de carbono 28 g\nProtelnas 6 g\nGrasas 12 g', { ocr: true });
    expect(r).toMatchObject({ carbsG: 28, proteinG: 6, fatG: 12 });
  });

  it('una nota al pie con la energía de referencia («8400 kJ / 2000 kcal») no es la energía del producto', () => {
    const r = readLabelText('Energía 1025kJ/245kcal 1281kJ/306kcal\nGrasas 5,1g\n*Valor de referencia de un adulto medio (8400 kJ / 2000 kcal)', { ocr: true });
    expect(r.kcal).toBe(245);
  });

  it('la columna de 100 g se elige aunque el OCR lea «100 9» en vez de «100 g»', () => {
    const r = readLabelText('por ración (30 g) por 1009\nGrasas 5,4 g 18 g\nProteínas 2,7 g 9 g', { ocr: true });
    expect(r).toMatchObject({ fatG: 18, proteinG: 9 });
  });

  it('sin salto de línea entre nombre y cifra, o con ambos en la misma línea, no se toca nada', () => {
    const text = 'Valor energético 1046 kJ / 250 kcal\nGrasas 12 g\nProteínas 6 g';
    expect(joinNameAndValueBlocks(text.toLowerCase())).toBe(text.toLowerCase());
  });

  it('los nombres por un lado y las cifras por otro se juntan por orden, con una columna o con dos', () => {
    const oneColumn = ['valor energetico', 'grasas', 'proteinas', 'sal', '', '1046 kj / 250 kcal', '12 g', '6 g', '0.52 g'].join('\n');
    expect(joinNameAndValueBlocks(oneColumn)).toContain('grasas 12 g');
    expect(joinNameAndValueBlocks(oneColumn)).toContain('sal 0.52 g');
    const twoColumns = ['valor energetico', 'grasas', 'proteinas', 'sal', '1046 kj / 250 kcal', '12 g', '6 g', '0.52 g', '523 kj / 125 kcal', '6 g', '3 g', '0.26 g'].join('\n');
    expect(joinNameAndValueBlocks(twoColumns)).toContain('grasas 12 g 6 g');
    // Si no salen tantas cifras como nombres (o un múltiplo), no se adivina.
    const lost = ['grasas', 'proteinas', 'sal', 'hidratos', '12 g', '6 g'].join('\n');
    expect(joinNameAndValueBlocks(lost)).toBe(lost);
  });
});

describe('juntar y puntuar lecturas de varias pasadas', () => {
  const partial = readLabelText('Valor energético 1046 kJ / 250 kcal\nGrasas 12 g', { ocr: true });
  const rest = readLabelText('Hidratos de carbono 28 g\nde los cuales azúcares 4,0 g\nFibra alimentaria 2,5 g\nProteínas 6,0 g\nSal 0,52 g', { ocr: true });

  it('una lectura parcial no es de fiar; la suma de las dos, completa y coherente, sí', () => {
    expect(isConfidentReading(partial)).toBe(false);
    expect(isConfidentReading(rest)).toBe(false);
    const merged = mergeReadings([partial, rest]);
    expect(merged).toMatchObject({ kcal: 250, fatG: 12, carbsG: 28, sugarsG: 4, fiberG: 2.5, proteinG: 6, saltG: 0.52, found: 7 });
    expect(isConfidentReading(merged)).toBe(true);
  });

  it('no se añade una cifra de otra pasada si con ella lo leído deja de cuadrar', () => {
    const wrong = readLabelText('Proteínas 80 g', { ocr: true }); // con 12 g de grasas y 250 kcal, 80 g de proteínas es imposible
    const merged = mergeReadings([partial, wrong]);
    expect(merged.proteinG).toBeNull();
    expect(merged.found).toBe(2);
  });

  it('la puntuación sube con las cifras y baja con lo que no cuadra', () => {
    expect(readingScore(rest)).toBeGreaterThan(readingScore(partial));
    const absurd = readLabelText('Valor energético 100 kcal\nGrasas 50 g\nProteínas 40 g', { ocr: true });
    expect(readingScore(absurd)).toBeLessThan(absurd.found * 2 - 3);
  });

  it('sin lecturas útiles devuelve una vacía', () => {
    const empty = readLabelText('nada que ver', { ocr: true });
    expect(mergeReadings([empty, empty])).toMatchObject({ found: 0, kcal: null });
  });
});

// ───────────────────────────── ronda 46: lo que sale de leer fotos de envases de verdad ─────────────────────────────
// Los textos son salidas reales de Tesseract sobre fotos de envases dibujadas (tabla torcida, con brillo, grano y desenfoque); la verdad de cada una está al lado.

describe('lo que sale de un OCR sobre una foto de un envase (ronda 46)', () => {
  it('la energía se saca de la razón kJ/kcal aunque el OCR lea mal las unidades y pegue cifras sueltas', () => {
    // Verdad: 2088 kJ / 499 kcal por 100 g y 940 kJ / 225 kcal por ración.
    const r = readLabelText('INFORMACIÓN NUTRICIONAL     par 1008 — per ración (45 e)\nValor energético          2088 1)/ 499 heal 940 17 225 heal      :', { ocr: true });
    expect(r.kcal).toBe(499);
    // También con la columna de la ración primero.
    expect(readLabelText('Valor energético por ración 940 kJ / 225 kcal  por 100 g 2088 kJ / 499 kcal', { ocr: true }).kcal).toBe(499);
    // Y con una sola cifra de kJ y otra de kcal sin unidades legibles.
    expect(readLabelText('Energía 2163KJ/S17kcal', { ocr: true }).kcal).toBe(517);
  });

  it('«kcal» leído como «heal», «hcal» o «kal» sigue siendo una unidad de energía', () => {
    for (const unit of ['heal', 'hcal', 'kal', 'kcai']) expect(readLabelText(`Valor energético 1310 kj / 313 ${unit}`, { ocr: true }).kcal).toBe(313);
  });

  it('la sal sin coma y con la «g» pegada («2529») es 2,52: ninguna etiqueta lleva 25 g de sal por 100 g', () => {
    const r = readLabelText('Valor energético 1310 kJ / 313 kcal\nGrasas 25 g\nHidratos de carbono 3,4 g\nProteínas 19,9 g\nSal 2529', { ocr: true });
    expect(r.saltG).toBe(2.52);
  });

  it('con dos columnas y la ración conocida, la cifra por ración decide dónde iba la coma que el OCR perdió', () => {
    // Verdad por 100 g: grasas 25, hidratos 3,4, azúcares 2,4, fibra 1,5, proteínas 19,9, sal 2,52 (ración de 30 g).
    const text = [
      'INFORMACIÓN NUTRICIONAL               por 100g por ración (30 9)',
      'Valor energético            1310k)/313kcal — 393KkJ/94 kcal',
      'Grasas                                                259                759',
      '- de las cuales saturadas                5.69          179',
      'Hidratos de carbono                  349           19',
      '- de los cuales azúcares                 249          079',
      'Fibra alimentaria                                                159                     059',
      'Proteinas                                           1999                  do',
      'Sal                                                  2529              0,76 9',
    ].join('\n');
    const r = readLabelText(text, { ocr: true });
    expect(r).toMatchObject({ kcal: 313, fatG: 25, carbsG: 3.4, sugarsG: 2.4, fiberG: 1.5, proteinG: 19.9, saltG: 2.52 });
  });

  it('una fila cuyo nombre el OCR no leyó se sabe por el orden de la etiqueta (grasas entre la energía y las saturadas)', () => {
    // Verdad: kcal 517, grasas 18,8, hidratos 64,7, azúcares 42,6, fibra 8,1, proteínas 15,9, sal 2,24 (ración de 25 g).
    const text = [
      ' sermastón acticional      100g — Ración25g *%VAN* |',
      'Energia                              2163KJ/S17kcal  541k/129kcal            6%',
      'reses:                                               18,89                     4,79            Mm',
      'de las cuales saturadas                          39                     0.89            “"%',
      'Hidratos de carbono       64,79     1629 6% |',
      'de los cuales azúcares                   42,69                  1079 2% |',
      'Fibra alimentaria                              8,19                     29                         b',
      '—Proteñas              15,99        49 8% bosoa',
      'osa               2.249      0569 9% microon',
      ';    *Vaar de referencia de un aduño medio (8400 kJ / 2000 kai)               REA    E vez',
    ].join('\n');
    const r = readLabelText(text, { ocr: true });
    expect(r).toMatchObject({ kcal: 517, fatG: 18.8, carbsG: 64.7, sugarsG: 42.6, fiberG: 8.1, proteinG: 15.9, saltG: 2.24, servingG: 25 });
  });

  it('las filas sin nombre solo se rellenan si los huecos cuadran exactamente (ante la duda no se inventa nada)', () => {
    // Dos filas sin nombre y un solo hueco entre la energía y las saturadas: no se sabe cuál es de las grasas.
    const text = ['Valor energético 1850 kJ / 440 kcal', '  12,0 g', '  13,0 g', 'de las cuales saturadas 3,0 g', 'Hidratos de carbono 52 g', 'Proteínas 9 g'].join('\n');
    const r = readLabelText(text, { ocr: true });
    expect(r.fatG).toBeNull();
    expect(r.carbsG).toBe(52);
  });

  it('con las filas en otro orden que el de la etiqueta europea no se adivina ningún nombre', () => {
    const text = ['Proteínas 9 g', 'Valor energético 1850 kJ / 440 kcal', '  12,0 g', 'Hidratos de carbono 52 g'].join('\n');
    expect(readLabelText(text, { ocr: true }).fatG).toBeNull();
  });
});
