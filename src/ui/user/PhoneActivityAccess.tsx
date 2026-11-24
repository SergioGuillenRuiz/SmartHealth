import type { JSX } from 'preact';
import { openPhoneAccessSettings, phoneAccess, phoneDiag } from '../../app/phone-activity';
import { svc } from '../../app/services';
import { Icon } from '../icons';
import { describePhoneDiag } from '../phone-diag';

/**
 * El acceso al uso del móvil para estimar el sueño de las noches sin anillo (ver `app/phone-activity.ts`). Solo existe en la app de Android: en la web no sale nada. Dice qué se lee y qué no (solo
 * HORAS de uso, nunca qué apps ni qué se hace, y nada sale del móvil) y lleva a los ajustes de Android, donde se da con un interruptor.
 */
export function PhoneActivityAccess({ compact }: { compact?: boolean }): JSX.Element | null {
  const access = phoneAccess.value;
  if (!access.checked || !access.supported) return null;
  if (access.granted) {
    return (
      <p class="phone-access phone-access--on" role="status">
        <Icon name="Check" size={16} />
        <span>
          Se lee a qué horas usas el móvil (solo horas, nunca qué apps) para afinar el sueño que se estima.
          <small class="phone-access__diag">{describePhoneDiag(phoneDiag.value, svc().now())}</small>
        </span>
      </p>
    );
  }
  return (
    <section class={`phone-access${compact ? ' phone-access--compact' : ''}`} aria-label="Afinar el sueño con el uso del móvil">
      <h3 class="phone-access__title">
        <Icon name="Moon" size={18} />
        Afinar el sueño con el uso del móvil
      </h3>
      <p>
        Sin el anillo de noche, la app solo puede suponer cuándo dormiste. Si le dejas leer <strong>a qué horas usas el móvil</strong> (cuándo se enciende la pantalla: solo horas, nunca qué apps ni qué haces, y nada sale del móvil), la hora a la que te acuestas y te levantas sale mucho más precisa.
      </p>
      <button type="button" class="btn btn--block" onClick={() => void openPhoneAccessSettings()}>
        <Icon name="settings" size={18} />
        Dar acceso en los ajustes de Android
      </button>
      <small class="field__hint">En la pantalla que se abre, activa «Permitir el acceso a datos de uso» para SmartHealth y vuelve.</small>
    </section>
  );
}
