import type { PhoneDiag } from '../app/phone-activity';
import { fmtAgo, plural } from './format';

/**
 * Lo que dice la hoja del sueño de la lectura del uso del móvil, para que la persona vea que funciona (o por qué no). Solo fechas y cifras: nunca qué apps ni qué se hizo.
 * `null` si aún no se ha leído nada.
 */
export function describePhoneDiag(diag: PhoneDiag | null, nowMs: number): string {
  if (diag === null) return 'Todavía no se ha hecho ninguna lectura.';
  if (diag.firstMs <= 0) return 'Android no tiene guardado ningún evento de uso de este móvil: no hay con qué estimar el sueño.';
  const days = Math.max(1, Math.round((nowMs - diag.firstMs) / 86_400_000));
  const parts = [`Registro de ${plural(days, 'día', 'días')}`, plural(diag.uses, 'uso del móvil', 'usos del móvil')];
  if (diag.lastEventMs > 0) parts.push(`último movimiento ${fmtAgo(diag.lastEventMs, nowMs)}`);
  const text = `${parts.join(' · ')}.`;
  // Un móvil que no da la pantalla encendida y apagada (algunas capas de Android) obliga a fiarse de las apps y los desbloqueos: menos preciso.
  return diag.screenEvents === 0 ? `${text} Este móvil no da la pantalla encendida y apagada: se usan las apps y los desbloqueos (menos preciso).` : text;
}
