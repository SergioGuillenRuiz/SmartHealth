import type { JSX } from 'preact';
import { Evolution } from '../health/Evolution';

/**
 * Salud: gira en torno al panel de evolución (periodo, gráfico conjunto de pasos, pulso y peso, y su botón de actualizar el
 * peso), con el sueño y el oxígeno debajo. Tus datos y ajustes están en el menú de perfil.
 */
export function HealthScreen(): JSX.Element {
  return <Evolution />;
}
