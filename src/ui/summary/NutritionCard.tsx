import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { removeMeal, saveSettings } from "../../app/actions";
import {
  detailMeal,
  foodFace,
  mealSheetOpen,
  settings,
  showToast,
} from "../../app/state";
import { dayKeyOf, type DayKey } from "../../domain/dates";
import { hydrationStatus, type WaterEntry } from "../../domain/hydration";
import {
  intakeOf,
  type MealEntry,
  type NutritionTargets,
} from "../../domain/nutrition";
import {
  MAX_PANEL_INDICATORS,
  PANEL_INDICATORS,
  panelIndicatorOf,
  panelTarget,
  panelValue,
  type PanelIndicatorId,
} from "../../domain/nutrition-panel";
import { DayShift, shiftMeal } from "../day-shift";
import { fmtClock, fmtDayShort, fmtInt, fmtUpTo1 } from "../format";
import { useArmed } from "../hooks";
import { Icon } from "../icons";
import { RemoveCross } from "../health/JointBlocks";
import { MealThumb } from "../meal-thumb";
import { CardHeader, TapCard } from "../primitives";
import { FoodRing } from "./FoodRing";
import { HydrationFace } from "./HydrationFace";
import { NutritionPicker } from "./NutritionPicker";

/**
 * Una comida de la lista: su miniatura, el nombre y la hora (con el día en que se comió si cuenta para otro), los botones para pasarla al día anterior o al
 * siguiente y borrarla (dos toques: el segundo confirma). Pulsarla en cualquier otro sitio abre sus detalles.
 */
function MealRow({
  meal,
  day,
  today,
  confirming,
  onRemove,
  onBlur,
}: {
  meal: MealEntry;
  day: DayKey;
  today: DayKey;
  confirming: boolean;
  onRemove: () => void;
  onBlur: () => void;
}): JSX.Element {
  const real = dayKeyOf(meal.tsMs);
  return (
    <li>
      <button
        type="button"
        class="food-meals__open"
        aria-haspopup="dialog"
        onClick={() => (detailMeal.value = meal)}
      >
        <MealThumb
          name={meal.name}
          barcode={meal.barcode}
          dishId={meal.dishId}
        />
        <span class="food-meals__main">
          <strong>{meal.name}</strong>
          <small>
            {fmtClock(meal.tsMs)}
            {real !== day && ` · ${fmtDayShort(real)}`}
          </small>
        </span>
      </button>
      <DayShift
        what={`«${meal.name}»`}
        real={real}
        credited={day}
        today={today}
        onMove={(direction) => void shiftMeal(meal, direction, today)}
      />
      <button
        type="button"
        class={`food-meals__del${confirming ? " is-confirming" : ""}`}
        aria-label={
          confirming ? `Confirmar: borrar ${meal.name}` : `Borrar ${meal.name}`
        }
        onClick={onRemove}
        onBlur={onBlur}
      >
        <Icon name="Trash2" size={16} />
        {confirming && "Borrar"}
      </button>
    </li>
  );
}

/** Lo que dura cada mitad del giro de la tarjeta (sale de canto y vuelve a entrar con la otra cara). */
const FLIP_MS = 150;

/**
 * La tarjeta «Nutrición» tiene **dos caras** y da la vuelta al pulsarla (o con el botón de su cabecera, para teclado y lectores de pantalla):
 * - la **comida** del día: las calorías en un anillo grande, el botón de anotar una comida, los tres nutrientes en anillos pequeños y, abajo, la lista de lo comido
 *   (con los botones para pasar una comida al día anterior o al siguiente y una forma de borrar un error);
 * - la **hidratación** (`HydrationFace`): el agua bebida frente a su meta (que sube con el ejercicio), el nivel de hidratación y la forma de anotar lo que se bebe.
 * `canAdd` es falso en los días pasados: lo que se anota cuenta siempre para hoy. El ejercicio solo mueve la meta de agua.
 */
export function NutritionCard({
  day,
  today,
  meals,
  targets,
  water,
  waterGoalMl,
  waterExerciseMl,
  wakeMs,
  nowMs,
  canAdd,
}: {
  /** El día que enseña la tarjeta y el de hoy (de este depende hasta dónde se puede pasar una comida). */
  day: DayKey;
  today: DayKey;
  meals: readonly MealEntry[];
  targets: NutritionTargets;
  /** Las tomas de agua del día, su meta (ml) y cuándo se levantó la persona ese día si el anillo lo sabe. */
  water: readonly WaterEntry[];
  waterGoalMl: number;
  /** Lo que se suma a esa meta por los pasos y los entrenos del día (sudor y respiración). */
  waterExerciseMl: number;
  wakeMs: number | null;
  nowMs: number;
  canAdd: boolean;
}): JSX.Element {
  const face = foodFace.value;
  const intake = intakeOf(meals);
  const kcal = intake?.kcal ?? 0;
  const left = Math.round(targets.kcal - kcal);
  const ordered = [...meals].sort((a, b) => a.tsMs - b.tsMs);
  const status = hydrationStatus({
    entries: water,
    goalMl: waterGoalMl,
    exerciseMl: waterExerciseMl,
    nowMs,
    day,
    wakeMs,
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  // La edición de los indicadores: un borrador de la lista (`null`: no se edita) y el selector para añadir.
  const [draft, setDraft] = useState<PanelIndicatorId[] | null>(null);
  const [picking, setPicking] = useState(false);
  const editing = draft !== null;
  const waterMl = water.reduce((sum, entry) => sum + entry.ml, 0);
  const armed = useArmed(confirming !== null);
  // El giro: de canto (`out`), se cambia de cara y se vuelve a abrir (`in`). Con «reducir movimiento» se cambia sin más.
  const [phase, setPhase] = useState<"idle" | "out" | "in">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const swap = (): void => {
    foodFace.value = foodFace.value === "food" ? "water" : "food";
  };
  const flip = (): void => {
    if (phase !== "idle" || editing) return;
    if (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      swap();
      return;
    }
    setPhase("out");
    timer.current = setTimeout(() => {
      swap();
      setPhase("in");
      timer.current = setTimeout(() => setPhase("idle"), FLIP_MS);
    }, FLIP_MS);
  };
  // Un toque en la tarjeta la gira, salvo el que va a un botón suyo (anotar, borrar, abrir una comida); el botón de la cabecera (`data-flip`) también la gira.
  const onCardClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (target?.closest("button:not([data-flip]), a") || editing) return;
    flip();
  };

  const remove = (meal: MealEntry): void => {
    if (confirming !== meal.id) {
      setConfirming(meal.id);
      return;
    }
    if (!armed) return; // un doble toque no confirma
    setConfirming(null);
    void removeMeal(meal).then(
      () => showToast("Comida borrada"),
      () => showToast("No se pudo borrar la comida.", "error"),
    );
  };

  const shown = draft ?? settings.value.nutritionPanel;
  const finish = (apply: boolean): void => {
    setPicking(false);
    if (apply && draft !== null) {
      // Se sale de la edición cuando lo elegido ya está guardado: si no, el panel volvería un instante a los indicadores de antes.
      void saveSettings({ nutritionPanel: draft }).finally(() => setDraft(null));
      return;
    }
    setDraft(null);
  };
  const available = PANEL_INDICATORS.map((i) => i.id).filter(
    (id) => !shown.includes(id),
  );
  const onWater = face === "water";
  return (
    <>
      <TapCard
        label="Nutrición"
        class={`card--food${face === "water" ? " is-water" : ""}${phase === "out" ? " is-flip-out" : phase === "in" ? " is-flip-in" : ""}`}
        onOpen={onCardClick}
      >
        <CardHeader
          icon={onWater ? "Droplets" : "Utensils"}
          title={onWater ? "Hidratación" : "Nutrición"}
          color={onWater ? "var(--water)" : "var(--kcal)"}
          right={
            <button
              type="button"
              class="food-face"
              data-flip
              aria-label={
                onWater
                  ? "Estás viendo la hidratación. Pulsa para ver la comida"
                  : "Estás viendo la comida. Pulsa para ver la hidratación"
              }
              onClick={flip}
            >
              <Icon name="RefreshCw" size={16} />
            </button>
          }
        />

        {onWater ? (
          <HydrationFace entries={water} status={status} canAdd={canAdd} />
        ) : (
          <>
            <div role="group" aria-label="Comida del día">
              <div class="food-top">
                <FoodRing
                  value={kcal}
                  target={targets.kcal}
                  label="Calorías comidas"
                  unit="kcal"
                  color="var(--kcal)"
                  size={132}
                  stroke={13}
                >
                  <span class="food-top__value">{fmtInt(kcal)}</span>
                  <span class="food-top__unit">
                    de {fmtInt(targets.kcal)} kcal
                  </span>
                </FoodRing>
                <div class="food-top__side">
                  <p class="food-top__left">
                    {!intake ? (
                      canAdd ? (
                        "Aún no has anotado nada"
                      ) : (
                        "No anotaste nada este día"
                      )
                    ) : left >= 0 ? (
                      <>
                        Te quedan <strong>{fmtInt(left)} kcal</strong>
                      </>
                    ) : (
                      <>
                        Te pasas <strong>{fmtInt(-left)} kcal</strong>
                      </>
                    )}
                  </p>
                  {canAdd && (
                    <button
                      type="button"
                      class="food-add"
                      onClick={() => (mealSheetOpen.value = true)}
                    >
                      <Icon name="Plus" size={18} />
                      He comido algo
                    </button>
                  )}
                </div>
              </div>

              {(editing || shown.length > 0) && (
                <ul
                  class={`food-macros${editing ? " is-editing" : ""}`}
                  aria-label="Nutrientes del día"
                >
                  {shown.map((id, index) => {
                    const n = panelIndicatorOf(id);
                    const value = panelValue(id, intake, waterMl);
                    const target = panelTarget(id, targets, waterGoalMl);
                    const limit = n.kind === "limit";
                    return (
                      <li key={id} style={{ "--i": index }}>
                        <FoodRing
                          value={value}
                          target={target}
                          label={n.aria}
                          unit={n.unit}
                          color={n.color}
                          size={60}
                          stroke={7}
                          overLabel={
                            limit ? "por encima del máximo" : undefined
                          }
                        >
                          <span class="food-macros__value">
                            {n.decimals === 1 ? fmtUpTo1(value) : fmtInt(value)}
                          </span>
                        </FoodRing>
                        <span class="food-macros__name">{n.label}</span>
                        <span class="food-macros__goal">
                          {limit ? "máx." : "de"} {fmtInt(target)} {n.unit}
                        </span>
                        {editing && (
                          <RemoveCross
                            title={n.label}
                            onRemove={() =>
                              setDraft((current) =>
                                current === null
                                  ? current
                                  : current.filter((other) => other !== id),
                              )
                            }
                          />
                        )}
                      </li>
                    );
                  })}
                  {editing && shown.length < MAX_PANEL_INDICATORS && (
                    <li class="food-macros__add">
                      <button
                        type="button"
                        class="food-macros__plus"
                        aria-label="Añadir un indicador"
                        onClick={() => setPicking(true)}
                      >
                        <Icon name="Plus" size={22} />
                      </button>
                    </li>
                  )}
                </ul>
              )}
              {editing ? (
                <div class="food-editbar">
                  <button
                    type="button"
                    class="btn btn--primary"
                    onClick={() => finish(true)}
                  >
                    <Icon name="Check" size={18} />
                    Aplicar
                  </button>
                  <button
                    type="button"
                    class="btn"
                    onClick={() => finish(false)}
                  >
                    <Icon name="X" size={18} />
                    Descartar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  class="food-edit"
                  onClick={() => setDraft([...settings.value.nutritionPanel])}
                >
                  <Icon name="SlidersHorizontal" size={16} />
                  Elegir indicadores
                </button>
              )}
            </div>

            {ordered.length > 0 ? (
              <ul class="food-meals" aria-label="Comidas del día">
                {ordered.map((meal) => (
                  <MealRow
                    key={meal.id}
                    meal={meal}
                    day={day}
                    today={today}
                    confirming={confirming === meal.id}
                    onRemove={() => remove(meal)}
                    onBlur={() =>
                      setConfirming((current) =>
                        current === meal.id ? null : current,
                      )
                    }
                  />
                ))}
              </ul>
            ) : (
              canAdd && <p class="food-empty">Lo que comas hoy saldrá aquí.</p>
            )}
          </>
        )}
      </TapCard>
      <NutritionPicker
        open={picking}
        available={available}
        onPick={(id) => {
          setDraft((current) =>
            current === null ||
            current.includes(id) ||
            current.length >= MAX_PANEL_INDICATORS
              ? current
              : [...current, id],
          );
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </>
  );
}
