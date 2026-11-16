import { nightFacts, type SleepNight } from '../../domain/sleep';
import { fmtDuration, NBSP } from '../format';

/** Una frase sobre cómo fue la noche, con un tono para pintarla (`good`: nada que destacar; `attention`: hay algo que mirar). */
export interface SleepAnalysis {
  tone: 'good' | 'attention';
  text: string;
}

/**
 * Orientativo, no un diagnóstico. Todo se compara con los porcentajes tal como se enseñan (redondeados): un «90 %» que se ve no
 * puede llamarse «algo corto». Dormir lo que uno se ha propuesto cuenta como suficiente desde el 90 % del objetivo; por debajo del
 * 75 % es una noche corta. Las fases solo se miran en una noche de al menos 3 h (en una más corta el reparto no dice nada) y se
 * señalan cuando quedan MUY por debajo de lo habitual en un adulto (profundo 13–23 %, REM 20–25 %): un 14 % de REM no es un
 * problema, y decirlo contradiría sin motivo a la app del fabricante. Una fase de la que el anillo no da NADA no se juzga (puede
 * ser que no la distinga, no que no la hubiera). Y los despertares solo llaman la atención desde 5: con 2 o 3 es lo normal.
 */
const ENOUGH_PCT = 90;
const SHORT_PCT = 75;
const DEEP_LOW_PCT = 10;
const REM_LOW_PCT = 12;
const MANY_WAKE_UPS = 5;
const MIN_SLEEP_FOR_SHARES_SEC = 3 * 3600;

const pct = (value: number): string => `${value}${NBSP}%`;

/** «a», «a y b», «a, b y c». */
const joinList = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`);

/**
 * El análisis de una noche con fases (`null` si el anillo solo dio la duración: sin fases no hay nada que analizar más allá de la
 * duración, que la hoja ya muestra frente al objetivo).
 */
export function analyzeSleep(night: SleepNight, goalH: number): SleepAnalysis | null {
  if (!night.hasStages || night.asleepSec <= 0 || goalH <= 0) return null;
  const facts = nightFacts(night);
  const goal = Math.round((night.asleepSec / (goalH * 3600)) * 100);
  const asleep = fmtDuration(night.asleepSec);
  const duration =
    goal >= ENOUGH_PCT
      ? `Dormiste ${asleep}, el ${pct(goal)} de tu objetivo.`
      : goal >= SHORT_PCT
        ? `Dormiste algo menos de lo que te habías propuesto: ${asleep}, el ${pct(goal)} de tu objetivo.`
        : `Noche corta: ${asleep}, el ${pct(goal)} de tu objetivo.`;

  const problems: string[] = [];
  if (night.asleepSec >= MIN_SLEEP_FOR_SHARES_SEC) {
    const share = (sec: number): number => Math.round((sec / night.asleepSec) * 100);
    if (night.deepSec > 0 && share(night.deepSec) < DEEP_LOW_PCT) problems.push(`el sueño profundo fue bajo (${pct(share(night.deepSec))})`);
    if (night.remSec > 0 && share(night.remSec) < REM_LOW_PCT) problems.push(`el REM fue bajo (${pct(share(night.remSec))})`);
  }
  if (facts && facts.wakeUps >= MANY_WAKE_UPS) problems.push(`te despertaste ${facts.wakeUps} veces`);

  const stages = problems.length > 0 ? `Ojo: ${joinList(problems)}.` : goal >= ENOUGH_PCT ? 'Fases y despertares sin nada que destacar: sigue así.' : 'Fases y despertares sin nada que destacar.';
  return { tone: goal >= ENOUGH_PCT && problems.length === 0 ? 'good' : 'attention', text: `${duration} ${stages}` };
}
