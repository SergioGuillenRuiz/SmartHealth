// Vectores reales para las pruebas del decodificador.
// Origen: capturas del proyecto PulseLoop (https://github.com/saksham2001/PulseLoopiOS, CC BY 4.0),
// hechas sobre un anillo TK5 (mismo protocolo YCBT que el R99) con la app oficial Smart Health.
// Son bytes reales del historial; sus autores los cotejaron con lo que mostraba la app (p. ej. los
// totales de sueño y la presión del último registro).

/** 8 registros de FC de 6 bytes (cada hora entre las 23:00 y las 06:00). */
export const CAPTURED_HEART_RECORDS_HEX =
  '1cf0de3100471afede310042260cdf31003f3b1adf31003e4328df3100425136df31003c6444df3100419852df31003a';

/** 8 registros "All" de 20 bytes (23:00–06:00). */
export const CAPTURED_ALL_RECORDS_HEX =
  '1cf0de31080d47734c620e3404000f00000033de1afede31000042704a610d2b02000f000000d24b260cdf3100003f7049610db106000f000000ce273b1adf3100003e6d49600c5f02000f00000077a54328df310000426f49610d2105000f000000474b5136df3100003c6f47600c2104000f00000024f66444df310000416e49610d3d05000f00000015769852df3100003a6a465f0c8002000f000000d89d';

/** Una noche completa: una sesión de 420 bytes (cabecera de 20 + 50 tramos de 8). */
export const CAPTURED_NIGHT_HEX =
  'affaa4019fe9de31bd58df31ffff971efb15733af29fe9de313c0500f1dceede312d0100f30af0de31d90100f2e4f1de31c90400f1aef6de31320100f3e1f7de31c10100f2a3f9de31b50400f159fede319b0100f3f5ffde31b00100f2a501df31660200f10b04df313d0500f34809df31ae0800f2f611df31cc0100f1c213df31170200f3d915df317d0100f25617df31ef0000f34518df31060100f24b19df31670200f1b21bdf31910000f2431cdf31030000f3461cdf314c0000f2921cdf31f70100f3891edf31720200f2fb20df31e00000f3db21df31590100f23423df310e0100f34224df31d30100f21526df317a0000f38f26df31c10000f25027df31be0400f10f2cdf312f0100f33f2ddf31aa0100f2ea2edf317a0500f16534df316b0100f3d135df319e0000f17036df319e0100f20e38df31450500f1543ddf318b0100f3e03edf31de0100f2bf40df31000500f1c045df315e0100f31f47df31730100f29348df31a00000f13449df319c0000f2d049df316d0500f13e4fdf31410100f38050df31d80100f25952df31050100f15f53df311e0100f27d54df31400400';


// ───────────────────────────── R99 real ─────────────────────────────
// Bytes del PRIMER contacto con un R99 real (firmware 2.32, internamente «R11M»), capturados por la prueba guiada de esta app
// el 2026-10-13 a las 05:02 (hora de Madrid, CEST). Son lo que la app mandó (`tx`) y lo que el anillo contestó (`rx`) en una
// sincronización completa. El anillo NO contesta a la consulta de oxígeno (`05 1a`): la sincronización acaba ahí.

export const R99_SYNC_EXCHANGE: ReadonlyArray<readonly ['tx' | 'rx', string]> = [
  ['tx', '020308004750ef20'],
  ['rx', '02030b005231314d00a6df'],
  ['tx', '01000e00ea070a0d05020601a389'],
  ['rx', '0100070000cd3e'],
  ['tx', '0200080047436fec'],
  ['rx', '02001e00a30020020064b2010003f83f0200000030cc0140584a623feace'],
  ['tx', '0201080047469b16'],
  ['rx', '02014200f909000000000cd8100401b2b600400f00145000000020000000000000000000000000000000000000000000000000000000000000000000000000002e69'],
  ['tx', '01030a00b4660117616b'],
  ['rx', '010307000011a5'],
  ['tx', '010c0800013cb681'],
  ['rx', '010c070000ff71'],
  ['tx', '01260800013caccf'],
  ['rx', '01260700001a2e'],
  ['tx', '03090900010002a0de'],
  ['rx', '03090700003989'],
  ['rx', '06000c000000000000003183'],
  ['tx', '0309090000000290e9'],
  ['rx', '03090700003989'],
  ['tx', '0502060043fc'],
  ['rx', '050210000100010000000e000000f418'],
  ['rx', '05111400f1226032f9296032e4044e035200bdc9'],
  ['rx', '05800c0001000e00d188205c'],
  ['tx', '0580070000f36a'],
  ['tx', '05040600e34e'],
  ['rx', '050408000000d441'],
  ['tx', '050606008320'],
  ['rx', '050610000200010000000c000000fe41'],
  ['rx', '05151200222a603200486b776032005039b0'],
  ['rx', '05800c0001000c00cd3d2800'],
  ['tx', '0580070000f36a'],
  ['tx', '05090600b20c'],
  ['rx', '0509100002000100000028000000137d'],
  ['rx', '05182e00222a60325431487a50620e2a05000f00000007d36b7760320000506c4862102d02000f000000a7d114a9'],
  ['rx', '05800c000100280032fbe247'],
  ['tx', '0580070000f36a'],
  ['tx', '051a06008116'],
];

/** Los tres buffers de historial reensamblados de esa sincronización (tramo de 23:00–23:30, pulso y constantes de dos instantes). */
export const R99_SPORT_HEX = 'f1226032f9296032e4044e035200';
export const R99_HEART_HEX = '222a603200486b7760320050';
export const R99_ALL_HEX = '222a60325431487a50620e2a05000f00000007d36b7760320000506c4862102d02000f000000a7d1';

/** Tramas en vivo del entreno de prueba (5:04): pasos a los 9 s de echar a andar y al final, pulso y fin de medida. */
export const R99_LIVE_FRAMES = {
  stepsFirstCounted: '06000c000b00070001008f22',
  stepsLast: '06000c00b8007b000c00d86c',
  heartRate76: '060107004ce5a6',
  measurementEndOk: '040e08000001fb52',
  /** Respuestas a órdenes que esta app nunca mandó en ese momento: otra app (Smart Health) hablando con el anillo a la vez. */
  strayTimeReply: '0100070000cd3e',
  strayUnknownReply: '021b0700042395',
} as const;


// ───────────────────────────── R99 real, segunda ronda (cotejada con Smart Health) ─────────────────────────────
// Misma app y mismo anillo, 13-oct-2026 08:07–08:11, con Smart Health mirando a las 08:13: «Pasos 1390 · 92 Kcal · 0.929 km»,
// «89 bpm», «109/72 mmHg», «97 %»; y, para el 12-oct, «12628 pasos totales». Todo coincide con lo que sigue.

/** Constantes de las 08:00:33 (medida automática): 1.118 pasos del día, pulso 96, presión 109/72, SpO₂ 97 %, respiración 20. */
export const R99_ALL_0800_HEX = 'a1a160325e04606d4861142904000f00000014df';
/** Seis registros de pulso: la medida automática de las 08:00:33 y una por cada ciclo del entreno (08:09:43 → 08:11:01). */
export const R99_HEART_0800_HEX = 'a1a160320060c7a360320065dba36032005aeda36032005a01a46032005715a460320059';
/** El único tramo de actividad que guardaba el anillo: 06:00–06:30 con 588 pasos, 393 m y 38 kcal. */
export const R99_SPORT_0600_HEX = '60856032688c60324c0289012600';
/** Pasos en directo al final de la prueba: 1.390 pasos, 929 m, 92 kcal (el contador DEL DÍA; Smart Health: 1390 · 0.929 km · 92 Kcal). */
export const R99_LIVE_STEPS_1390 = '06000c006e05a1035c009df1';

/**
 * La medida de pulso «Medir ahora» de esa ronda, con sus tiempos: `[ms desde que se pidió, trama 06 01 en hexadecimal]`. Primero
 * una meseta de 46-47 lpm (el sensor en frío), de golpe 86 y subiendo hasta 95; el anillo NO cerró la medida (no hay `04 0e`).
 */
export const R99_HEART_MEASURE_FRAMES: ReadonlyArray<readonly [number, string]> = [
  [23_720, '060107002e01ea'],
  [24_719, '060107002e01ea'],
  [25_716, '060107002f20fa'],
  [26_760, '060107002f20fa'],
  [27_798, '06010700569e15'],
  [28_800, '06010700569e15'],
  [29_796, '06010700569e15'],
  [32_835, '0601070057bf05'],
  [33_835, '0601070057bf05'],
  [34_835, '0601070057bf05'],
  [35_878, '060107005850f4'],
  [36_921, '060107005850f4'],
  [37_959, '060107005971e4'],
  [38_959, '060107005971e4'],
  [39_955, '060107005b33c4'],
  [40_958, '060107005cd4b4'],
  [41_960, '060107005df5a4'],
  [42_999, '060107005e9694'],
  [43_998, '060107005fb784'],
  [44_999, '060107005e9694'],
  [45_995, '060107005fb784'],
];
