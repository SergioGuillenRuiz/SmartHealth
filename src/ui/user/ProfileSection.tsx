import { hasRing } from '../../app/devices';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { saveSettings } from '../../app/actions';
import { adaptive, targetOptions } from '../../app/personal';
import { calibrateOpen, nowMs, profileHistory, profileSheetOpen, settings } from '../../app/state';
import { dayKeyOf } from '../../domain/dates';
import { baseStride } from '../../domain/estimation';
import { HEALTH_GOAL_IDS, HEALTH_GOALS, nutritionTargets, type HealthGoal } from '../../domain/nutrition';
import { ageAt, daysSinceLastEntry, profileAt } from '../../domain/profile';
import { resolveProfile } from '../../domain/summary';
import { isTargetWeight, MAX_TARGET_KG, MIN_TARGET_KG, startingTarget } from '../../domain/weight-goal';
import { fmt1, fmtDateFull, fmtInt, fmtUpTo1 } from '../format';
import { Icon } from '../icons';
import { Banner, EmptyState, Segmented } from '../primitives';
import { Stepper } from '../Stepper';
import { weightGoalMessageNow } from '../weight-goal-view';

/** «Mis datos»: altura, peso, sexo y edad (lo que afina distancia y calorías). Cada cambio se guarda con su fecha. */
export function ProfileSection(): JSX.Element {
  const history = profileHistory.value;
  const today = dayKeyOf(nowMs.value);
  const current = profileAt(history, today);

  if (!current) {
    return (
      <div>
        <EmptyState icon="Scale" title="Completa tu perfil">
          Con tu altura, peso, sexo y edad la app estima mejor la distancia y las calorías. Los cambios futuros se guardan con su fecha: el pasado no se recalcula con tus datos de hoy.
        </EmptyState>
        <button type="button" class="btn btn--primary btn--block" onClick={() => (profileSheetOpen.value = true)}>
          Introducir mis datos
        </button>
      </div>
    );
  }

  const stride = baseStride(current);
  const sinceLast = daysSinceLastEntry(history, today);

  return (
    <div>
      <dl class="kv kv--sheet">
        <div class="kv__row">
          <dt>Altura</dt>
          <dd>{fmtUpTo1(current.heightCm)} cm</dd>
        </div>
        <div class="kv__row">
          <dt>Peso</dt>
          <dd>{fmtUpTo1(current.weightKg)} kg</dd>
        </div>
        <div class="kv__row">
          <dt>Sexo</dt>
          <dd>{current.sex === 'male' ? 'Hombre' : 'Mujer'}</dd>
        </div>
        <div class="kv__row">
          <dt>Edad</dt>
          <dd>{ageAt(current.birthDate, today)} años</dd>
        </div>
        <div class="kv__row">
          <dt>Zancada</dt>
          <dd>{fmtUpTo1(stride.meters * 100)} cm</dd>
          <dd class="kv__note">
            {stride.source === 'manual'
              ? 'Fijada por ti.'
              : stride.source === 'learned'
                ? 'Ajustada con tus paseos con GPS. Puedes fijarla tú calibrándola.'
                : 'Calculada con tu altura. Calíbrala, o camina con GPS unas cuantas veces, para que la distancia sea más precisa.'}
          </dd>
        </div>
        <div class="kv__row">
          <dt>Vigente desde</dt>
          <dd>{fmtDateFull(current.date)}</dd>
        </div>
      </dl>
      {sinceLast !== null && sinceLast > 45 && (
        <p class="card__foot">
          <Icon name="Info" size={15} />
          <span>Llevas {sinceLast} días sin actualizar el peso. Mantenerlo al día afina las calorías y la gráfica de evolución.</span>
        </p>
      )}
      <div class="btn-row" style={{ marginTop: '14px' }}>
        <button type="button" class="btn btn--primary" onClick={() => (profileSheetOpen.value = true)}>
          <Icon name="Pencil" size={16} />
          Actualizar
        </button>
        <button type="button" class="btn" onClick={() => (calibrateOpen.value = true)}>
          <Icon name="Ruler" size={16} />
          Calibrar zancada
        </button>
      </div>
    </div>
  );
}

/** «Objetivos y medición»: los pasos y las horas de sueño del día, el objetivo de salud con el peso al que llegar y cada cuánto mide el anillo por su cuenta. */
export function GoalsSection(): JSX.Element {
  const cfg = settings.value;
  return (
    <div>
      <div class="field-row">
        <Stepper id="g-steps" label="Pasos al día" value={cfg.stepGoal} step={500} min={1000} max={40_000} format={(v) => fmtInt(v)} onChange={(v) => void saveSettings({ stepGoal: v })} />
        <Stepper id="g-sleep" label="Sueño (horas)" value={cfg.sleepGoalH} step={0.5} min={4} max={12} format={(v) => fmt1(v)} onChange={(v) => void saveSettings({ sleepGoalH: v })} />
      </div>
      <HealthGoalPicker goal={cfg.healthGoal} />
      <TargetWeightField goal={cfg.healthGoal} target={cfg.targetWeightKg} />
      <label class="switch">
        <input type="checkbox" checked={cfg.mealSuggestions} onChange={(e) => void saveSettings({ mealSuggestions: e.currentTarget.checked })} />
        <span class="switch__track" aria-hidden="true" />
        <span class="switch__text">
          Ideas para comer mejor
          <small>Si una misma comida poco adecuada se repite varias veces en la semana, la hoja de detalles lo avisa y propone recetas más sanas del mismo tipo, ajustadas a tu objetivo.</small>
        </span>
      </label>
      {hasRing.value && (
        <>
          <div class="field">
            <span class="field__label">El anillo mide el pulso y el oxígeno por su cuenta cada…</span>
            <Segmented
              label="Intervalo de medición automática"
              value={String(cfg.heartIntervalMin)}
              onChange={(v) => void saveSettings({ heartIntervalMin: Number(v), spo2IntervalMin: Number(v) })}
              options={[
                { value: '30', label: '30 min' },
                { value: '60', label: '60 min' },
                { value: '120', label: '2 h' },
              ]}
              block
            />
            <span class="field__hint">Se aplica en la próxima sincronización. Menos tiempo = curva de pulso más fina y algo más de batería gastada por el anillo.</span>
          </div>
          <label class="switch">
            <input type="checkbox" checked={cfg.autoSync} onChange={(e) => void saveSettings({ autoSync: e.currentTarget.checked })} />
            <span class="switch__track" aria-hidden="true" />
            <span class="switch__text">
              Actualizar automáticamente
              <small>Con la app abierta: los pasos cada minuto y el resto cada 10 min. Apagado, solo al pulsar «Sincronizar ahora».</small>
            </span>
          </label>
        </>
      )}
    </div>
  );
}

/**
 * El objetivo de salud: lo que busca la persona con lo que come. Cambia las calorías y la proteína que se le proponen (la barra
 * de comida del Resumen y el gráfico de calorías de Salud), y debajo se ve lo que sale para hoy.
 */
function HealthGoalPicker({ goal }: { goal: HealthGoal }): JSX.Element {
  const today = dayKeyOf(nowMs.value);
  const { profile, generic } = resolveProfile(profileHistory.value, today);
  const targets = nutritionTargets(profile, today, goal, targetOptions());
  const measured = adaptive.value;
  return (
    <div class="field">
      <span class="field__label" id="g-health-l">
        Objetivo de salud
      </span>
      <div class="choice" role="radiogroup" aria-labelledby="g-health-l">
        {HEALTH_GOAL_IDS.map((id) => (
          <button
            type="button"
            key={id}
            class={`choice__item${id === goal ? ' is-active' : ''}`}
            role="radio"
            aria-checked={id === goal}
            onClick={() => void saveSettings({ healthGoal: id })}
          >
            <span class="choice__dot" aria-hidden="true" />
            <span class="choice__text">
              <strong>{HEALTH_GOALS[id].label}</strong>
              <small>{HEALTH_GOALS[id].hint}</small>
            </span>
          </button>
        ))}
      </div>
      <span class="field__hint">
        Para ti, hoy: unas <strong>{fmtInt(targets.kcal)} kcal</strong> ({fmtInt(targets.proteinG)} g de proteínas, {fmtInt(targets.carbsG)} g de hidratos y {fmtInt(targets.fatG)} g de grasas).{' '}
        {generic
          ? 'Todavía no has completado tus datos: se usan valores genéricos. Complétalos en «Mis datos» para afinarlo.'
          : measured !== null && measured.source !== 'formula'
            ? `Ajustada a ti con tu peso y lo que has anotado en ${measured.loggedDays} días${measured.source === 'mixed' ? ' (a más días anotados, más se fía de ellos)' : ''}.`
            : 'Es una estimación a partir de tus datos. Con unas semanas de peso y comidas anotadas se ajusta sola a ti.'}
      </span>
    </div>
  );
}

/**
 * El peso objetivo: hasta dónde quiere llegar la persona. Complementa al objetivo de salud (que es el cómo come): aquí se dice el destino y debajo se ve cuánto falta,
 * si el objetivo de salud elegido lleva hasta allí y en cuánto tiempo se llegaría. No cambia las calorías por sí mismo: si el objetivo de salud no cuadra, ofrece cambiarlo.
 * Cada botón que cambia lo que se ve (fijar, quitar, cambiar el objetivo de salud) desaparece al pulsarlo: el foco pasa al sitio que sigue en lugar de perderse.
 */
function TargetWeightField({ goal, target }: { goal: HealthGoal; target: number | null }): JSX.Element {
  const history = profileHistory.value;
  const today = dayKeyOf(nowMs.value);
  const { profile, generic } = resolveProfile(history, today);
  const root = useRef<HTMLDivElement>(null);
  /** Adónde lleva el foco el siguiente cambio de pantalla (lo pide el botón pulsado antes de guardar). */
  const focusNext = useRef<'stepper' | 'set' | 'goal' | null>(null);
  const hasTarget = target !== null && isTargetWeight(target);
  useEffect(() => {
    const wanted = focusNext.current;
    if (wanted === null) return;
    focusNext.current = null;
    const element =
      wanted === 'stepper'
        ? root.current?.querySelector<HTMLElement>('.stepper button:not([disabled])')
        : wanted === 'set'
          ? root.current?.querySelector<HTMLElement>('button.btn')
          : document.querySelector<HTMLElement>('[role="radiogroup"][aria-labelledby="g-health-l"] [aria-checked="true"]');
    element?.focus();
  }, [hasTarget, goal]);

  if (!hasTarget) {
    return (
      <div ref={root}>
        <div class="field">
          <span class="field__label" id="g-target-l">
            Peso objetivo
          </span>
          <button
            type="button"
            class="btn"
            aria-describedby="g-target-h"
            onClick={() => {
              focusNext.current = 'stepper';
              void saveSettings({ targetWeightKg: startingTarget(generic ? null : profile.weightKg, goal) });
            }}
          >
            <Icon name="Target" size={16} />
            Fijar un peso objetivo
          </button>
          <span class="field__hint" id="g-target-h">
            El peso al que quieres llegar. El objetivo de salud es cómo comes; el peso objetivo, hasta dónde.
          </span>
        </div>
      </div>
    );
  }

  const message = generic ? null : weightGoalMessageNow(goal, target);
  return (
    <div ref={root}>
      <Stepper id="g-target" label="Peso objetivo" value={target} step={0.5} min={MIN_TARGET_KG} max={MAX_TARGET_KG} format={(v) => `${fmtUpTo1(v)} kg`} onChange={(v) => void saveSettings({ targetWeightKg: v })}>
        {message === null ? (
          <span class="field__hint">Completa tus datos en «Mis datos» para ver cuánto te falta y en cuánto tiempo llegarías.</span>
        ) : (
          message.notes.map((note) =>
            note.tone === 'warn' ? (
              <Banner tone="warn" key={note.text}>
                {note.text}
              </Banner>
            ) : (
              <span class="field__hint" key={note.text}>
                {note.text}
              </span>
            ),
          )
        )}
        {message?.suggestion && (
          <button
            type="button"
            class="btn"
            onClick={() => {
              focusNext.current = 'goal';
              void saveSettings({ healthGoal: message.suggestion?.goal ?? goal });
            }}
          >
            Cambiar el objetivo de salud a «{message.suggestion.label}»
          </button>
        )}
        <button
          type="button"
          class="linkish"
          onClick={() => {
            focusNext.current = 'set';
            void saveSettings({ targetWeightKg: null });
          }}
        >
          Quitar el peso objetivo
        </button>
      </Stepper>
    </div>
  );
}
