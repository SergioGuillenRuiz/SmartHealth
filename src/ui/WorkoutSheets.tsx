import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { hasRing } from '../app/devices';
import { estimateWithin, loadWorkoutDay } from '../app/queries';
import { saveWorkout, beginWorkout, discardPendingWorkout, removeWorkout, updateWorkout } from '../app/workout-actions';
import { svc } from '../app/services';
import { detailWorkoutId, manualWorkoutOpen, nowMs, pendingRecovered, pendingWorkout, profileHistory, readySport, recoveredCause, ring, ringCapabilities } from '../app/state';
import { dayKeyOf, dayOfMs } from '../domain/dates';
import { profileForSport } from '../domain/nav/profiles';
import { SPORTS, sportById, sportSupport, type SportId } from '../domain/sports';
import type { WorkoutEstimate, WorkoutRecord } from '../domain/workout';
import { fmtDateFull, fmtClock } from './format';
import { useArmed, useAsync } from './hooks';
import { Icon } from './icons';
import { parseDecimal, parseWhole, UNITS } from './parse';
import { Banner } from './primitives';
import { Sheet } from './Sheet';
import { sportBackground } from './sport-style';
import { WorkoutEditor } from './WorkoutEditor';
import { correctionProblems } from './workout-corrections';
import { WorkoutFigures, WorkoutHrChart, WorkoutRouteMap } from './WorkoutFigures';

// ───────────────────────────── elegir y empezar ─────────────────────────────

export function ReadySheet(): JSX.Element {
  const id = readySport.value;
  return (
    <Sheet open={id !== null} onClose={() => (readySport.value = null)} title="Nuevo entrenamiento">
      {id && <ReadyPanel sportId={id} />}
    </Sheet>
  );
}

/**
 * El interruptor de la navegación guiada (solo en los deportes con movilidad): encendido, el entreno lleva el mapa de la zona, la ruta hasta un destino y los avisos sonoros; apagado, es el entreno
 * de siempre. El GPS no se pregunta: va siempre puesto y, donde no llegue o no sea fiable, la distancia sale de los pasos del anillo.
 */
function GuidedSwitch({ guided, onChange }: { guided: boolean; onChange: (guided: boolean) => void }): JSX.Element {
  return (
    <label class="switch">
      <input type="checkbox" checked={guided} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="switch__track" aria-hidden="true" />
      <span class="switch__text">
        Navegación guiada
        <small>Mapa y ruta hasta un destino. Avisa con dos zumbidos unos 5 s antes de cada giro, en el oído del lado al que hay que girar.</small>
      </span>
    </label>
  );
}

/** Andar sin anillo: una versión simple del entreno, medida solo con el móvil (GPS y reloj), sin pulso ni pasos del anillo. */
function PhoneOnlyPanel({ sportId }: { sportId: SportId }): JSX.Element {
  const sport = sportById(sportId);
  const [guided, setGuided] = useState(false);
  return (
    <div class="ready">
      <span class="ready__icon" style={{ background: sportBackground(sport.id) }}>
        <Icon name={sport.icon} size={38} />
      </span>
      <h3 class="ready__name">{sport.name}</h3>
      <ul class="ready__list">
        <li>
          <Icon name="route" size={18} />
          <span>Distancia y ritmo con el GPS del móvil</span>
        </li>
        <li>
          <Icon name="flame" size={18} />
          <span>Calorías estimadas con tu peso y tu velocidad (sin pulso, así que menos precisas que con el anillo)</span>
        </li>
        <li>
          <Icon name="HeartPulse" size={18} />
          <span>Sin pulso ni pasos: eso solo lo da el anillo</span>
        </li>
      </ul>
      <GuidedSwitch
        guided={guided}
        onChange={setGuided}
      />
      <p class="field__hint" style={{ margin: '4px 0 14px' }}>
        Se te pedirá permiso de ubicación y la pantalla se mantendrá encendida mientras andas.
      </p>
      <button
        type="button"
        class="btn btn--primary btn--block btn--big"
        onClick={() => {
          readySport.value = null;
          void beginWorkout(sportId, guided, 'workout', false);
        }}
      >
        <Icon name="Play" size={20} />
        Iniciar
      </button>
    </div>
  );
}

function ReadyPanel({ sportId }: { sportId: SportId }): JSX.Element {
  // Sin anillo solo se anda, y se hace con el móvil.
  if (!hasRing.value) return <PhoneOnlyPanel sportId={sportId} />;
  const sport = sportById(sportId);
  const { transport } = svc();
  const [guided, setGuided] = useState(false);
  const saved = ring.value;
  const support = sportSupport(sport, ringCapabilities.value);

  return (
    <div class="ready">
      <span class="ready__icon" style={{ background: sportBackground(sport.id) }}>
        <Icon name={sport.icon} size={38} />
      </span>
      <h3 class="ready__name">{sport.name}</h3>
      <ul class="ready__list">
        <li>
          <Icon name="HeartPulse" size={18} />
          <span>{support.heartRate ? 'Pulso en directo con el anillo' : 'Sin pulso: tu anillo no lo ofrece'}</span>
        </li>
        {sport.kind === 'ambulatory' && support.steps && (
          <li>
            <Icon name="Footprints" size={18} />
            <span>Pasos del anillo y distancia (estimada con tu zancada{sport.gpsUseful ? ' o con el GPS' : ''})</span>
          </li>
        )}
        {sport.kind === 'ambulatory' && !support.steps && (
          <li>
            <Icon name="route" size={18} />
            <span>Sin pasos del anillo: la distancia saldrá del GPS o la escribirás al terminar</span>
          </li>
        )}
        {sport.kind === 'cycling' && (
          <li>
            <Icon name="route" size={18} />
            <span>Los pasos del anillo no valen en bici: la distancia sale del GPS o la escribes al terminar</span>
          </li>
        )}
        {sportId === 'bicimad' && (
          <li>
            <Icon name="bolt" size={18} />
            <span>
              {support.heartRate
                ? 'Bici eléctrica: el motor pone parte del esfuerzo, así que las calorías salen de tu pulso y no de la velocidad'
                : 'Bici eléctrica: el motor pone parte del esfuerzo; sin pulso, las calorías salen de un valor medio de asistencia alta'}
            </span>
          </li>
        )}
        <li>
          <Icon name="flame" size={18} />
          <span>Calorías estimadas con tu peso y el esfuerzo (se suman a tu día sin duplicar pasos)</span>
        </li>
      </ul>

      {profileForSport(sportId) !== null && (
        <GuidedSwitch
          guided={guided}
          onChange={setGuided}
        />
      )}
      {sport.gpsUseful && <p class="field__hint">La distancia se mide con el GPS del móvil (se te pedirá permiso de ubicación y la pantalla se mantendrá encendida); donde no llegue o no sea fiable, con los pasos del anillo.</p>}

      {!transport.available && <Banner tone="danger">{transport.unavailableReason}</Banner>}
      <p class="field__hint" style={{ margin: '4px 0 14px' }}>
        {saved ? `Se conectará con ${saved.name}.` : 'Se te pedirá elegir el anillo.'} Se mantiene la conexión solo durante el entrenamiento.
      </p>

      <button
        type="button"
        class="btn btn--primary btn--block btn--big"
        disabled={!transport.available}
        onClick={() => {
          readySport.value = null;
          void beginWorkout(sportId, guided && profileForSport(sportId) !== null);
        }}
      >
        <Icon name="Play" size={20} />
        Iniciar
      </button>
    </div>
  );
}

// ───────────────────────────── revisar y guardar ─────────────────────────────

/**
 * Estimación del entreno con las mismas reglas que el resumen del día (reparto de los pasos del anillo entre los entrenos
 * de ese día). `null` mientras se leen los datos del día. Solo depende de lo que no cambia al corregir distancia o
 * calorías, así que escribir en el editor no vuelve a leer nada.
 */
function useWorkoutEstimate(record: WorkoutRecord | null): WorkoutEstimate | null {
  const history = profileHistory.value;
  // El entreno se estima dentro del día del Resumen que lo contiene, para que sus cifras sean las mismas.
  const startMs = record?.startMs;
  const { data: day } = useAsync(() => (startMs === undefined ? Promise.resolve(null) : loadWorkoutDay(dayOfMs(startMs))), [startMs]);
  return useMemo(() => (record && day ? estimateWithin(record, day, history) : null), [record, day, history]);
}

export function PendingWorkoutSheet(): JSX.Element {
  const record = pendingWorkout.value;
  return (
    <Sheet open={record !== null} onClose={() => undefined} dismissible={false} title="Entrenamiento terminado">
      {record && <PendingPanel initial={record} />}
    </Sheet>
  );
}

function PendingPanel({ initial }: { initial: WorkoutRecord }): JSX.Element {
  const [record, setRecord] = useState(initial);
  const [editorValid, setEditorValid] = useState(true);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const discardArmed = useArmed(confirmDiscard);
  const sport = sportById(record.sport);
  const estimate = useWorkoutEstimate(record);
  if (!estimate) return <p class="sync-note">Cargando…</p>;

  return (
    <div>
      <p class="wk-head">
        <Icon name={sport.icon} size={20} />
        <strong>{sport.name}</strong> · {fmtDateFull(estimate.day)} a las {fmtClock(record.startMs)}
      </p>
      {pendingRecovered.value && (
        <Banner tone="warn" live="status">
          La app se cerró durante este entrenamiento. Se ha recuperado hasta las {fmtClock(record.endMs)}: puedes guardarlo así o descartarlo. Si seguiste después, añade el resto a mano desde Deportes. Si se cerró con la pantalla apagada, lo cerró el móvil: en Xiaomi/Poco activa «Inicio automático» para SmartHealth, ponle «Sin restricciones» en el ahorro de batería y bloquéala en Recientes.{recoveredCause.value ? ` ${recoveredCause.value}` : ''}
        </Banner>
      )}
      {sport.kind === 'cycling' && record.distanceM === undefined && (
        <Banner>No hay distancia (sin GPS). Puedes escribirla abajo: las calorías la usarán para ajustarse a tu velocidad.</Banner>
      )}
      <WorkoutFigures estimate={estimate} />
      <WorkoutRouteMap record={record} />
      <WorkoutHrChart record={record} />
      <WorkoutEditor
        key={record.id}
        record={record}
        onChange={(next, valid) => {
          setRecord(next);
          setEditorValid(valid);
        }}
      />
      <div class="btn-row" style={{ marginTop: '16px' }}>
        <button type="button" class="btn btn--primary" disabled={!editorValid} onClick={() => void saveWorkout(record)}>
          <Icon name="Check" size={18} />
          Guardar
        </button>
        {confirmDiscard ? (
          <button
            type="button"
            class="btn btn--danger"
            disabled={!discardArmed}
            onClick={() => void discardPendingWorkout()}
          >
            Confirmar: descartar
          </button>
        ) : (
          <button type="button" class="btn btn--ghost" onClick={() => setConfirmDiscard(true)}>
            Descartar
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── añadir a mano ─────────────────────────────

export function ManualWorkoutSheet(): JSX.Element {
  const open = manualWorkoutOpen.value;
  return (
    <Sheet open={open} onClose={() => (manualWorkoutOpen.value = false)} title="Añadir entrenamiento">
      {open && <ManualPanel />}
    </Sheet>
  );
}

const pad = (n: number): string => String(n).padStart(2, '0');

function ManualPanel(): JSX.Element {
  const now = new Date(nowMs.value);
  const today = dayKeyOf(now.getTime());
  const [sport, setSport] = useState<SportId>('run');
  const [date, setDate] = useState(today);
  const [time, setTime] = useState(`${pad(Math.max(0, now.getHours() - 1))}:00`);
  const [minutes, setMinutes] = useState('45');
  const [km, setKm] = useState('');
  const [kcal, setKcal] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const spec = sportById(sport);

  const submit = (): void => {
    const problems: string[] = [];
    const [h, m] = time.split(':').map(Number);
    const [y, mo, d] = date.split('-').map(Number);
    const startMs = new Date(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, m ?? 0).getTime();
    const duration = parseWhole(minutes, UNITS.min);
    const distance = parseDecimal(km, UNITS.km);
    const energy = parseWhole(kcal, UNITS.kcal);
    if (!date || Number.isNaN(startMs)) problems.push('Indica la fecha y la hora de inicio.');
    else if (startMs > nowMs.value) problems.push('El entrenamiento no puede empezar en el futuro.');
    if (duration === null || duration < 1 || duration > 1440) problems.push('La duración debe estar entre 1 y 1440 minutos. Para 1 h 30 min, escribe 90.');
    else if (!Number.isInteger(duration)) problems.push('Escribe la duración en minutos enteros. Para 1 h 30 min, escribe 90.');
    const typed = correctionProblems(spec.kind === 'other' ? '' : km, kcal, { sport, activeMinutes: duration });
    if (typed.km) problems.push(typed.km);
    if (typed.kcal) problems.push(typed.kcal);
    setErrors(problems);
    if (problems.length > 0 || duration === null) return;

    const record: WorkoutRecord = {
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sport,
      startMs,
      endMs: startMs + Math.round(duration * 60_000),
      pausedMs: 0,
      source: 'manual',
    };
    if (distance !== null && distance > 0 && spec.kind !== 'other') {
      record.distanceM = Math.round(distance * 1000);
      record.distanceSource = 'manual';
    }
    if (energy !== null) record.kcalManual = Math.round(energy);
    void saveWorkout(record).then((saved) => {
      if (saved) manualWorkoutOpen.value = false;
    });
  };

  return (
    <div>
      {errors.length > 0 && (
        <ul class="errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div class="field">
        <label for="m-sport">Actividad</label>
        <select id="m-sport" class="input" value={sport} onChange={(e) => setSport(e.currentTarget.value as SportId)}>
          {SPORTS.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="m-date">Fecha</label>
          <input id="m-date" class="input" type="date" max={today} value={date} onInput={(e) => setDate(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="m-time">Hora de inicio</label>
          <input id="m-time" class="input" type="time" value={time} onInput={(e) => setTime(e.currentTarget.value)} />
        </div>
      </div>
      <div class="field">
        <label for="m-min">Duración (minutos)</label>
        <input id="m-min" class="input" inputMode="numeric" value={minutes} onInput={(e) => setMinutes(e.currentTarget.value)} />
      </div>
      <div class="field-row">
        {spec.kind !== 'other' && (
          <div class="field">
            <label for="m-km">Distancia (km)</label>
            <input id="m-km" class="input" inputMode="decimal" placeholder="Opcional" value={km} onInput={(e) => setKm(e.currentTarget.value)} />
          </div>
        )}
        <div class="field">
          <label for="m-kcal">Calorías (kcal)</label>
          <input id="m-kcal" class="input" inputMode="numeric" placeholder="Opcional" value={kcal} onInput={(e) => setKcal(e.currentTarget.value)} />
        </div>
      </div>
      <p class="field__hint" style={{ marginBottom: '14px' }}>
        Si dejas las calorías vacías se estiman con tu peso de ese día y la intensidad media de la actividad. Lo que escribas se marca como manual.
      </p>
      <button type="button" class="btn btn--primary btn--block" onClick={submit}>
        <Icon name="Check" size={18} />
        Guardar entrenamiento
      </button>
    </div>
  );
}

// ───────────────────────────── detalle ─────────────────────────────

export function WorkoutDetailSheet(): JSX.Element {
  const id = detailWorkoutId.value;
  return (
    <Sheet open={id !== null} onClose={() => (detailWorkoutId.value = null)} title="Entrenamiento">
      {id && <DetailPanel id={id} />}
    </Sheet>
  );
}

function DetailPanel({ id }: { id: string }): JSX.Element {
  const { data: stored } = useAsync(() => svc().store.getWorkout(id), [id]);
  const [edited, setEdited] = useState<WorkoutRecord | null>(null);
  const [editorValid, setEditorValid] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteArmed = useArmed(confirmDelete);
  const estimate = useWorkoutEstimate(edited ?? stored ?? null);

  useEffect(() => {
    setEdited(null);
    setEditorValid(true);
  }, [id]);
  if (stored === undefined) return <p class="sync-note">Cargando…</p>;
  if (stored === null) return <Banner tone="warn">Este entrenamiento ya no existe.</Banner>;
  if (!estimate) return <p class="sync-note">Cargando…</p>;

  const record = edited ?? stored;
  const sport = sportById(record.sport);
  const changed = edited !== null;

  return (
    <div>
      <p class="wk-head">
        <Icon name={sport.icon} size={20} />
        <strong>{sport.name}</strong> · {fmtDateFull(estimate.day)} a las {fmtClock(record.startMs)}
      </p>
      <WorkoutFigures estimate={estimate} />
      <WorkoutRouteMap record={record} />
      <WorkoutHrChart record={record} />
      <WorkoutEditor
        key={record.id}
        record={record}
        onChange={(next, valid) => {
          setEdited(next);
          setEditorValid(valid);
        }}
      />
      <div class="btn-row" style={{ marginTop: '16px' }}>
        {changed && (
          <button
            type="button"
            class="btn btn--primary"
            disabled={!editorValid}
            onClick={() =>
              void updateWorkout(edited).then((saved) => {
                if (saved) detailWorkoutId.value = null;
              })
            }
          >
            Guardar cambios
          </button>
        )}
        {confirmDelete ? (
          <button
            type="button"
            class="btn btn--danger"
            disabled={!deleteArmed}
            onClick={() => {
              void removeWorkout(record.id).then((removed) => {
                if (removed) detailWorkoutId.value = null;
              });
            }}
          >
            Confirmar: eliminar
          </button>
        ) : (
          <button type="button" class="btn btn--ghost" onClick={() => setConfirmDelete(true)}>
            <Icon name="Trash2" size={16} />
            Eliminar
          </button>
        )}
      </div>
    </div>
  );
}
