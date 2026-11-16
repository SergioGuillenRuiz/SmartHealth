/**
 * El tamaño de letra de un valor de los indicadores que flotan sobre el mapa. Cada uno tiene la cuarta parte del ancho de la pantalla (≈ 80 px a 360 px de ancho). El tamaño normal es de 23 px
 * (hoja de estilos): caben hasta 6 caracteres («59:59», «123,45», «12.345»). Un cronómetro de una hora o más («1:02:34», hasta «9:59:59») tiene 7 y se pinta a 21 px, el tamaño que ya se había
 * comprobado que cabe; uno de más de 9 horas («12:34:56») se achica a 17 px en vez de cortarse. `undefined` = el tamaño normal.
 */
export const HUD_NORMAL_VALUE_CHARS = 6;
export const HUD_LONG_VALUE_CHARS = 7;
export const HUD_MEDIUM_VALUE_PX = 21;
export const HUD_LONG_VALUE_PX = 17;

export const hudValueSize = (value: string): number | undefined =>
  value.length > HUD_LONG_VALUE_CHARS ? HUD_LONG_VALUE_PX : value.length > HUD_NORMAL_VALUE_CHARS ? HUD_MEDIUM_VALUE_PX : undefined;
