// Lecturas REALES de Tesseract (el mismo motor y el mismo idioma que lleva la app) sobre etiquetas nutricionales dibujadas con distintos diseños —una y dos columnas, con %VRN, en dos
// idiomas, con las cifras separadas de los nombres, con sodio en vez de sal—, tal como salieron, con sus fallos típicos: la «g» leída como «9» («13,29» por «13,2 g»), la coma perdida,
// los nombres todos primero y las cifras después. Cada una con lo que dice la etiqueta de verdad. Sirven para vigilar que el lector (`readLabelText(texto, { ocr: true })`) no empeora:
// `label-text.test.ts`. Se obtuvieron con el banco de pruebas de la ronda 39 (docs/estimaciones.md → «Leer la tabla nutricional de una foto»).

export interface OcrSample {
  name: string;
  /** Lo que devolvió el OCR, sin tocar. */
  text: string;
  /** Lo que pone en la etiqueta (por 100 g). */
  expected: { kcal: number; proteinG: number; carbsG: number; fatG: number; fiberG: number; sugarsG: number; saltG: number };
}

export const OCR_SAMPLES: readonly OcrSample[] = [
  {
    name: "twoCol (bloque, b/n, limpia)",
    text: "INFORMACIÓN NUTRICIONAL                 por 100g por ración (40 g)\nValor energético                    1607 kJ / 384 kcal 643 kJ / 154 kcal\nGrasas                                                   18,39                    73g\n\n- de las cuales saturadas                             389                     15g\nHidratos de carbono                               3269                    13g\n\n- de los cuales azúcares                              369                    149\nFibra alimentaria                                  10,29                  41g\nProteínas                                            15,39                   6,19\nSal                                                     2,589                 1,039\n",
    expected: { kcal: 384, proteinG: 15.3, carbsG: 32.6, fatG: 18.3, fiberG: 10.2, sugarsG: 3.6, saltG: 2.58 },
  },
  {
    name: "twoCol (bloque, grises, limpia)",
    text: "INFORMACIÓN NUTRICIONAL             por 100g por ración (200 g)\nValor energético                        1385 kJ / 331 kcal 2770 kJ/ 662 kcal\nGrasas                                                         1849                      36,89\n\n- de las cuales saturadas                              10,89                     21,69\nHidratos de carbono                                     18,19                     36,29\n\n- de los cuales azúcares                                 5,79                     11,49\nFibra alimentaria                                          6,59                        139\nProteínas                                                      22,39                      44,69\nSal                                                               0,029                      0,04 g\n",
    expected: { kcal: 331, proteinG: 22.3, carbsG: 18.1, fatG: 18.4, fiberG: 6.5, sugarsG: 5.7, saltG: 0.02 },
  },
  {
    name: "twoCol (auto, grises, limpia)",
    text: "INFORMACIÓN NUTRICIONAL\nValor energético\nGrasas\n\n- de las cuales saturadas\nHidratos de carbono\n\n- de los cuales azúcares\nFibra alimentaria\nProteínas\n\nSal\n\npor 100g por ración (45 g)\n\n1280 kJ / 306 kcal\n18,5E\n\n6,8E\n\n3,68\n\n1,98\n\n2,98\n\n29,38\n\n0,07 €\n\n576 kJ / 138 kcal\n8,38\n3,1e\n1,68\n0,9g8\n1,38\n\n13,2g8\n0,03 E\n\n",
    expected: { kcal: 306, proteinG: 29.3, carbsG: 3.6, fatG: 18.5, fiberG: 2.9, sugarsG: 1.9, saltG: 0.07 },
  },
  {
    name: "oneCol (auto, grises, limpia)",
    text: "Valores medios por 100 g\n\nValor energético                           1607 kJ\n384 kcal\n\nGrasas                                       18,39\nde las cuales saturadas                    389\nHidratos de carbono                       32,69\nde los cuales azúcares                       3,69\nFibra                                         10,29\nProteínas                                    15,39\n\nSal                                           2,589\n",
    expected: { kcal: 384, proteinG: 15.3, carbsG: 32.6, fatG: 18.3, fiberG: 10.2, sugarsG: 3.6, saltG: 2.58 },
  },
  {
    name: "oneCol (bloque, b/n, limpia)",
    text: "Valores medios por 100 g\nValor energético                                  1385 kJ\n331 kcal\nGrasas                                                           1849\nde las cuales saturadas                              10,8g\nHidratos de carbono                               18,19\nde los cuales azúcares                                 5,79\nFibra                                                                 6,59\nProteinas                                                   22,39\nSal                                                                  0,029\n",
    expected: { kcal: 331, proteinG: 22.3, carbsG: 18.1, fatG: 18.4, fiberG: 6.5, sugarsG: 5.7, saltG: 0.02 },
  },
  {
    name: "oneCol (bloque, grises, limpia)",
    text: "Valores medios por 100 g\nValor energético                                            1280 kJ\n306 kcal\nGrasas                                                      18,58\nde las cuales saturadas                                    6,8g8\nHidratos de carbono                                     3,68\nde los cuales azúcares                                     1,9E8\nFibra                                                          2,9E8\nProteínas                                                      29,3g8\nSal                                                               0,07 g\n",
    expected: { kcal: 306, proteinG: 29.3, carbsG: 3.6, fatG: 18.5, fiberG: 2.9, sugarsG: 1.9, saltG: 0.07 },
  },
  {
    name: "vrn (bloque, b/n, limpia)",
    text: "Información nutricional              100g Ración 125g %VRN*\nEnergía                                 799KJ/191kcal  999kJ/239kcal         12%\nGrasas                                                 13,98                   17,4g         25%\n\nde las cuales saturadas                     1,18                    1,48           7%\nHidratos de carbono                        3,78                  4,68          2%\n\nde los cuales azúcares                      0,1g                   0,18          0%\nFibra alimentaria                          10,9g                13,68\nProteínas                                              5,98                     7,48         15%\nSal                                                        1,778                  2,218         37%\n*Valor de referencia de un adulto medio (8400 kJ / 2000 kcal)\n",
    expected: { kcal: 191, proteinG: 5.9, carbsG: 3.7, fatG: 13.9, fiberG: 10.9, sugarsG: 0.1, saltG: 1.77 },
  },
  {
    name: "vrn (bloque, grises, limpia)",
    text: "Información nutricional           100g Ración 30 9 %VRN*\nEnergía                        1770kj)/423kcal 531k)/127kcal        6%\nGrasas                                         14g              4,29        6%\nde las cuales saturadas                   6,59              1,99      10%\nHidratos de carbono                    59,39            17,89        7%\nde los cuales azúcares                  13,8g              4,19        5%\nFibra alimentaria                        7,29             2,29\nProteínas                                    12,99              3,99        8%\nSal                                            1,81g             0,549        9%\n*Valor de referencia de un adulto medio (8400 kj / 2000 kcal)\n",
    expected: { kcal: 423, proteinG: 12.9, carbsG: 59.3, fatG: 14, fiberG: 7.2, sugarsG: 13.8, saltG: 1.81 },
  },
  {
    name: "vrn (auto, grises, limpia)",
    text: "Información nutricional              100g 4Ración200g %VRN*\n\nEnergía                          1674kJ/400kcal 3348kJ/B800kcal       40%\nGrasas                                         14,19                 28,29       40%\nde las cuales saturadas                     3,49                   6,89        34%\nHidratos de carbono                     44,89                89,69       34%\nde los cuales azúcares                   19,79                 39,49       44%\nFibra alimentaria                              3,59                     70\nProteínas                                      19,99                 39,89       80%\nSal                                               1,869                 3,729       62%\n\n*Valor de referencia de un adulto medio (8400 kJ / 2000 kcal)\n",
    expected: { kcal: 400, proteinG: 19.9, carbsG: 44.8, fatG: 14.1, fiberG: 3.5, sugarsG: 19.7, saltG: 1.86 },
  },
  {
    name: "bilingual (bloque, b/n, limpia)",
    text: "Información nutricional / Nutrition facts\n\nPor 100 g / Per 100 g\n\nValor energético / Energy                        1653 kJ / 395 kcal\n\nGrasas / Fat                                                          22,89\nde las cuales saturadas / of which saturates                      269\n\nHidratos de carbono / Carbohydrate                              47 g\nde los cuales azúcares / of which sugars                        18,89\n\nFibra / Fibre                                                                5,99\n\nProteínas / Protein                                                       1,79\n\nSal / Salt                                                              0,83 g\n",
    expected: { kcal: 395, proteinG: 1.7, carbsG: 47, fatG: 22.8, fiberG: 5.9, sugarsG: 18.8, saltG: 0.83 },
  },
  {
    name: "bilingual (bloque, b/n, media)",
    text: "Información nutricional / Nutrition facts\n\nPor 100 g / Per 100\n\nValor energético / Energy                          1653 kJ / 395 kcal\n\nGrasas / Fat                                                                  22.89\n\nde las cuales saturadas / of which saturates                       269\n\n Hidratos de carbono / Carbohydrate                                47 g\n— de los cuales azúcares / of which sugars          18,89\n\nFibra / Fibre                                                                    5.99\n\nProteínas / Protein                                                          1.79\n\nSal / Salt                                                                       0,83 g\n",
    expected: { kcal: 395, proteinG: 1.7, carbsG: 47, fatG: 22.8, fiberG: 5.9, sugarsG: 18.8, saltG: 0.83 },
  },
  {
    name: "bilingual (auto, b/n, media)",
    text: " información nutricional / Nutrition facts\n\nPor 100 g/ Per 100 g\n\nValor energético / Energy                           1561 kJ / 373 kcal\n\nGrasas / Fat                                                            22,9g\nde las cuales saturadas / of which saturates    11.3g\n\nHidratos de carbono / Carbohydrate                             32,59\nde los cuales azúcares / of which sugars                        19,8 g\n\nFibra / Fibre                                                          229\n\nProteínas / Protein  8,79\n\n_Sal / Salt                                               0,87 9\n",
    expected: { kcal: 373, proteinG: 8.7, carbsG: 32.5, fatG: 22.9, fiberG: 2.2, sugarsG: 19.8, saltG: 0.87 },
  },
  {
    name: "wideGap (bloque, b/n, limpia)",
    text: "VALORES NUTRICIONALES MEDIOS POR 100 g\nValor energético                                    2013 kJ / 481 kcal\nGrasas                                                                    19,8 g\nde las cuales saturadas                                            4,9g\nHidratos de carbono                                                65,6 9\nde los cuales azúcares                                                449\nFibra alimentaria                                                          6,39\nProteínas                                                                            8,49\nSal                                                                               0,25 9\n",
    expected: { kcal: 481, proteinG: 8.4, carbsG: 65.6, fatG: 19.8, fiberG: 6.3, sugarsG: 44, saltG: 0.25 },
  },
  {
    name: "wideGap (bloque, grises, limpia)",
    text: "VALORES NUTRICIONALES MEDIOS POR 100 g\nValor energético                      1925 kJ / 460 kcal\nGrasas                                               19,9g\nde las cuales saturadas                            0,6 g\nHidratos de carbono                                 51,1g\nde los cuales azúcares                                4g\nFibra alimentaria                                     2,79\nProteínas                                              15,4g\nSal                                                   0,29g\n",
    expected: { kcal: 460, proteinG: 15.4, carbsG: 51.1, fatG: 19.9, fiberG: 2.7, sugarsG: 4, saltG: 0.29 },
  },
  {
    name: "wideGap (bloque, b/n, media)",
    text: "VALORES NUTRICIONALES MEDIOS POR 100 g\nValor energético                                        2013 kJ / 481 kcal\nGrasas                                                                       19,89\nde las cuales saturadas                                              4,9g\nHidratos de carbono                                                   65,6 g\nde los cuales azúcares                                                449\nFibra alimentaria                                                             6,39\nProteínas                                                                                  8,49\nSal                                                                             0,259\n",
    expected: { kcal: 481, proteinG: 8.4, carbsG: 65.6, fatG: 19.8, fiberG: 6.3, sugarsG: 44, saltG: 0.25 },
  },
  {
    name: "sodium (bloque, b/n, limpia)",
    text: "DECLARACIÓN NUTRICIONAL\n\nCantidad por 100 g\n\nCalorías                                      384 kcal\n\nGrasa total                                       18,39\nGrasa saturada                                38g\n\nCarbohidratos                                 32,69\nAzúcares                                        3,69\n\nFibra dietética                                10,2 g\n\nProteínas                                        15,39\n\nSodio                                       1032 mg\n",
    expected: { kcal: 384, proteinG: 15.3, carbsG: 32.6, fatG: 18.3, fiberG: 10.2, sugarsG: 3.6, saltG: 2.58 },
  },
  {
    name: "sodium (bloque, grises, limpia)",
    text: "DECLARACIÓN NUTRICIONAL\n\nCantidad por 100 g\n\nCalorías                                            331 kcal\n\nGrasa total                                               1849\nGrasa saturada                                       10,89\n\nCarbohidratos                                       18.19\nAzúcares                                                 5,79\n\nFibra dietética                                           6,59\n\nProteinas                                             22.39\n\nSodio                                               8 mg\n",
    expected: { kcal: 331, proteinG: 22.3, carbsG: 18.1, fatG: 18.4, fiberG: 6.5, sugarsG: 5.7, saltG: 0.02 },
  },
  {
    name: "sodium (bloque, b/n, media)",
    text: "DECLARACIÓN NUTRICIONAL\n\nCantidad por 100 g\n\nCalorías                                      384 kcal\n\nGrasa total                                          18,39\nGrasa saturada                                 389\n\nCarbohidratos                                 32,69\nAzúcares                                          3,69\n\nFibra dietética                                10,29\n\nProteinas                                        15,3 g\n\nSodio                                         1032 mg\n",
    expected: { kcal: 384, proteinG: 15.3, carbsG: 32.6, fatG: 18.3, fiberG: 10.2, sugarsG: 3.6, saltG: 2.58 },
  },
];
