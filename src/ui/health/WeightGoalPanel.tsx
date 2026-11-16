import type { JSX } from 'preact';
import { settings } from '../../app/state';
import { isTargetWeight } from '../../domain/weight-goal';
import { fmtUpTo1, NBSP } from '../format';
import { Icon, type IconName } from '../icons';
import { weightGoalVisualNow } from '../weight-goal-view';
import type { GoalScenario } from './weight-goal-visual';

const kg = (value: number): string => `${fmtUpTo1(value)}${NBSP}kg`;

const SCENARIO_ICON: Record<GoalScenario['key'], IconName> = { plan: 'Calculator', eaten: 'Utensils', real: 'Scale' };

/**
 * El peso objetivo en Salud, donde se mira el peso, dibujado: cuánto falta, un camino con lo recorrido y tres tarjetas con cuándo se llegaría (con el plan que se propone, con lo
 * que se come de verdad y con el ritmo real del peso). Aquí solo se LEE: el peso objetivo (y el objetivo de salud) se cambian en el menú de perfil → «Objetivos y medición».
 */
export function WeightGoalPanel(): JSX.Element {
  const cfg = settings.value;
  const target = cfg.targetWeightKg;

  if (target === null || !isTargetWeight(target)) {
    return (
      <div class="hero-goal" role="group" aria-label="Objetivo de peso">
        <h3 class="hero-goal__title">
          <Icon name="Target" size={16} />
          Objetivo de peso
        </h3>
        <p class="hero-goal__text">Fija tu peso objetivo en el perfil (Objetivos y medición) y verás aquí si lo conseguirás, y cuándo.</p>
      </div>
    );
  }

  const visual = weightGoalVisualNow(cfg.healthGoal, target);
  if (visual === null) {
    return (
      <div class="hero-goal" role="group" aria-label="Objetivo de peso">
        <h3 class="hero-goal__title">
          <Icon name="Target" size={16} />
          Objetivo de peso
          <span class="hero-goal__target">{kg(target)}</span>
        </h3>
        <p class="hero-goal__text">Completa «Mis datos» en el perfil para ver cuánto te falta.</p>
      </div>
    );
  }

  const reached = visual.needs === 'reached';
  const percent = Math.round(visual.progress * 100);
  const verb = visual.needs === 'lose' ? 'por bajar' : 'por subir';
  return (
    <div class="hero-goal" role="group" aria-label="Objetivo de peso">
      <h3 class="hero-goal__title">
        <Icon name="Target" size={16} />
        Objetivo de peso
        <span class="hero-goal__target">{kg(visual.targetKg)}</span>
      </h3>

      <p class="wg-missing">
        {reached ? (
          <strong class="wg-missing__done">
            <Icon name="Check" size={20} strokeWidth={2.6} /> Objetivo alcanzado
          </strong>
        ) : (
          <>
            <strong>{kg(visual.missingKg)}</strong> <span>{verb}</span>
          </>
        )}
        <small>ahora {kg(visual.currentKg)}</small>
      </p>

      <div class="wg-track" role="progressbar" aria-label="Camino hacia el peso objetivo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={reached ? 'Alcanzado' : `${percent} % recorrido`}>
        <span class="wg-track__fill" style={{ width: `${percent}%` }} />
        <span class="wg-track__dot" style={{ left: `${percent}%` }} />
      </div>
      <div class="wg-ends" aria-hidden="true">
        <span>{kg(visual.startKg)}</span>
        <span class="wg-ends__percent">{percent} %</span>
        <span>{kg(visual.targetKg)}</span>
      </div>

      {visual.scenarios.length > 0 && (
        <ul class="wg-cards" aria-label="Cuándo llegarías">
          {visual.scenarios.map((scenario) => (
            <li key={scenario.key} class={`wg-card wg-card--${scenario.tone}`}>
              <span class="wg-card__label">
                <Icon name={SCENARIO_ICON[scenario.key]} size={13} />
                {scenario.label}
              </span>
              <strong class="wg-card__headline">{scenario.headline}</strong>
              {scenario.detail.map((line) => (
                <small key={line}>{line}</small>
              ))}
            </li>
          ))}
        </ul>
      )}

      {visual.warns.map((warn) => (
        <p class="wg-warn" key={warn}>
          <Icon name="TriangleAlert" size={15} />
          {warn}
        </p>
      ))}
    </div>
  );
}
