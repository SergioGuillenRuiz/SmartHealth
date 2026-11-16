import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { saveProfileEntry } from '../../app/actions';
import { cancelStrideCalibration, closeStrideCalibration, strideActive, strideOutcome, useMeasuredStride } from '../../app/stride-calibration';
import { calibrateOpen, nowMs, profileHistory, profileSheetOpen, showToast } from '../../app/state';
import { dayKeyOf, type DayKey } from '../../domain/dates';
import { baseStride, calibrateStrideCm } from '../../domain/estimation';
import { ageAt, profileAt, validateProfileEntry, type ProfileEntry, type Sex } from '../../domain/profile';
import { fmt1, fmtDateFull, fmtUpTo1 } from '../format';
import { useArmed } from '../hooks';
import { Icon } from '../icons';
import { parseDecimal, parseHeightCm, UNITS } from '../parse';
import { Banner, Segmented } from '../primitives';
import { Sheet } from '../Sheet';
import { StrideGuide } from './StrideGuide';

// ───────────────────────────── editar datos personales ─────────────────────────────

export function ProfileSheet(): JSX.Element {
  const open = profileSheetOpen.value;
  return (
    <Sheet open={open} onClose={() => (profileSheetOpen.value = false)} title="Actualizar mis datos">
      {open && <ProfileForm />}
    </Sheet>
  );
}

const asText = (n: number | undefined): string => (n === undefined ? '' : String(n).replace('.', ','));

function ProfileForm(): JSX.Element {
  const today = dayKeyOf(nowMs.value);
  const history = profileHistory.value;
  // Se parte de lo vigente hoy: normalmente solo cambia el peso.
  const base = profileAt(history, today);
  const [date, setDate] = useState<DayKey>(today);
  const [height, setHeight] = useState(asText(base?.heightCm));
  const [weight, setWeight] = useState(asText(base?.weightKg));
  // Sin sexo elegido de partida: con uno preseleccionado se guardaría sin que la persona se diera cuenta (y cambia el metabolismo basal en ±160 kcal).
  const [sex, setSex] = useState<Sex | null>(base?.sex ?? null);
  const [birth, setBirth] = useState(base?.birthDate ?? '');
  const [stride, setStride] = useState(asText(base?.strideCm));
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [saving, setSaving] = useState(false);
  const replaceArmed = useArmed(confirmReplace);

  const laterEntries = history.filter((e) => e.date > date);
  // Guardar sobre la fecha de OTRA entrada la sustituiría (con los datos de este formulario, que parten de los de hoy):
  // se avisa antes. No hay aviso al actualizar la entrada de la que parte el formulario, cuyos datos se ven y se retocan a propósito.
  const conflict = history.find((e) => e.date === date && e.date !== base?.date);
  useEffect(() => setConfirmReplace(false), [date]);

  const submit = (): void => {
    const strideValue = parseDecimal(stride, UNITS.cm);
    const weightValue = parseDecimal(weight, UNITS.kg);
    const heightValue = parseHeightCm(height);
    const entry: Partial<ProfileEntry> = {
      date,
      heightCm: heightValue ?? undefined,
      weightKg: weightValue ?? undefined,
      ...(sex !== null ? { sex } : {}),
      birthDate: birth,
      ...(strideValue !== null ? { strideCm: strideValue } : {}),
      // Si no se toca la zancada que ajustó la app, sigue siendo suya (y se reajusta con paseos nuevos); si se escribe otra, es la de la persona.
      ...(strideValue !== null && base?.strideAuto && base.strideCm !== undefined && Math.abs(strideValue - base.strideCm) < 0.05 ? { strideAuto: true } : {}),
    };
    const problems = validateProfileEntry(entry, today);
    // Una zancada que no es un número («75cm», «abc») no se tira en silencio como si estuviera vacía.
    if (stride.trim() !== '' && strideValue === null) problems.push('La zancada debe ser un número en centímetros, por ejemplo 75.');
    setErrors(problems);
    if (problems.length > 0) return;
    if (conflict) {
      if (!confirmReplace) {
        setConfirmReplace(true);
        return;
      }
      if (!replaceArmed) return; // un doble toque no confirma
    }
    setSaving(true);
    void (async () => {
      try {
        await saveProfileEntry(entry as ProfileEntry);
        profileSheetOpen.value = false;
        showToast('Datos guardados');
      } catch (error) {
        showToast(`No se pudieron guardar los datos${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
      } finally {
        setSaving(false);
      }
    })();
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
        <label for="p-date">Vigente desde</label>
        <input id="p-date" class="input" type="date" max={today} value={date} onInput={(e) => setDate(e.currentTarget.value)} />
        <span class="field__hint">
          Los días anteriores seguirán usando tus datos anteriores
          {laterEntries.length > 0 && laterEntries[0] ? ` y esta entrada solo regirá hasta el ${fmtDateFull(laterEntries[0].date)}` : ''}.
        </span>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="p-height">Altura (cm)</label>
          <input id="p-height" class="input" inputMode="decimal" value={height} onInput={(e) => setHeight(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="p-weight">Peso (kg)</label>
          <input id="p-weight" class="input" inputMode="decimal" value={weight} onInput={(e) => setWeight(e.currentTarget.value)} />
        </div>
      </div>
      <div class="field">
        <span class="field__label">Sexo</span>
        <Segmented<string>
          label="Sexo"
          value={sex ?? ''}
          onChange={(v) => setSex(v as Sex)}
          options={[
            { value: 'male', label: 'Hombre' },
            { value: 'female', label: 'Mujer' },
          ]}
        />
        <span class="field__hint">Se usa en las fórmulas de estimación (zancada y metabolismo basal).</span>
      </div>
      <div class="field">
        <label for="p-birth">Fecha de nacimiento</label>
        <input id="p-birth" class="input" type="date" max={today} value={birth} onInput={(e) => setBirth(e.currentTarget.value)} />
        {birth && <span class="field__hint">Edad: {ageAt(birth, today)} años</span>}
      </div>
      <div class="field">
        <label for="p-stride">Longitud de zancada (cm) — opcional</label>
        <input
          id="p-stride"
          class="input"
          inputMode="decimal"
          value={stride}
          placeholder={base ? `Calculada: ${fmt1(baseStride({ heightCm: parseHeightCm(height) ?? base.heightCm, sex: sex ?? base.sex }).meters * 100)}` : ''}
          onInput={(e) => setStride(e.currentTarget.value)}
        />
        <span class="field__hint">Si la dejas vacía se calcula con tu altura. Puedes medirla con «Calibrar zancada».</span>
      </div>
      {conflict && confirmReplace && (
        <Banner tone="warn" live="status">
          Ya tienes una entrada del {fmtDateFull(conflict.date)} ({fmtUpTo1(conflict.weightKg)} kg). Si guardas, se sustituirá por esta.
        </Banner>
      )}
      <div class="btn-row" style={{ marginTop: '6px' }}>
        <button
          type="button"
          class={`btn ${conflict && confirmReplace ? 'btn--danger' : 'btn--primary'}`}
          disabled={saving || (conflict !== undefined && confirmReplace && !replaceArmed)}
          onClick={submit}
        >
          <Icon name="Check" size={18} />
          {conflict && confirmReplace ? 'Sustituir y guardar' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────── calibrar la zancada ─────────────────────────────

export function CalibrateSheet(): JSX.Element {
  const open = calibrateOpen.value;
  // Mientras se camina la hoja no se cierra con un gesto suelto: se sale con «Cancelar» o «Terminar».
  const walking = strideActive.value && strideOutcome.value === null;
  return (
    <Sheet open={open} onClose={() => closeCalibration()} title="Calibrar la zancada" dismissible={!walking}>
      {open && <CalibrateBody />}
    </Sheet>
  );
}

/** Cierra la hoja de calibrar; si había un paseo en marcha, lo cancela. */
function closeCalibration(): void {
  calibrateOpen.value = false;
  void closeStrideCalibration();
}

function CalibrateBody(): JSX.Element {
  const [manual, setManual] = useState(false);
  if (manual) return <CalibrateForm onBack={() => setManual(false)} />;
  return <StrideGuide onManual={() => { void cancelStrideCalibration(); setManual(true); }} />;
}

/** La medida a mano: la distancia recorrida y los pasos que contó el anillo (para cuando no hay GPS o el anillo no cuenta pasos en directo). */
function CalibrateForm({ onBack }: { onBack: () => void }): JSX.Element {
  const today = dayKeyOf(nowMs.value);
  const history = profileHistory.value;
  const current = profileAt(history, today);
  const [meters, setMeters] = useState('100');
  const [steps, setSteps] = useState('');

  if (!current) return <Banner tone="warn">Primero introduce tus datos personales.</Banner>;

  const distance = parseDecimal(meters, UNITS.m);
  const count = parseDecimal(steps, UNITS.steps);
  const result = distance !== null && count !== null ? calibrateStrideCm(distance, count) : null;
  const currentCm = baseStride(current).meters * 100;

  return (
    <div>
      <p class="field__hint" style={{ marginBottom: '14px', fontSize: '13.5px' }}>
        La distancia que ves en la app es <strong>pasos × zancada</strong>, así que ajustar la zancada es lo que más mejora su precisión.
        Camina a tu ritmo normal una distancia que conozcas (una pista, 100 m medidos en el móvil…) con el anillo puesto, y apunta los pasos que cuenta:
        sincroniza antes y después y resta los pasos de hoy.
      </p>
      <div class="field-row">
        <div class="field">
          <label for="c-m">Distancia recorrida (m)</label>
          <input id="c-m" class="input" inputMode="decimal" value={meters} onInput={(e) => setMeters(e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="c-s">Pasos contados</label>
          <input id="c-s" class="input" inputMode="numeric" value={steps} onInput={(e) => setSteps(e.currentTarget.value)} />
        </div>
      </div>
      {result !== null ? (
        <Banner tone="info">
          Tu zancada medida es <strong>{fmt1(result)} cm</strong>. La que usa ahora la app es {fmt1(currentCm)} cm
          {Math.abs(result - currentCm) / currentCm > 0.15 ? ' (más de un 15\u00a0% de diferencia: repite la medida para confirmarla).' : '.'}
        </Banner>
      ) : (
        steps !== '' && <Banner tone="warn">Con esos datos no sale una zancada razonable (entre 30 y 150 cm). Revisa la distancia y los pasos.</Banner>
      )}
      <button
        type="button"
        class="btn btn--primary btn--block"
        disabled={result === null}
        onClick={() => {
          if (result === null) return;
          void useMeasuredStride(result)
            .then(() => {
              calibrateOpen.value = false;
              showToast(`Zancada fijada en ${fmt1(result)} cm`);
            })
            .catch(() => showToast('No se pudo guardar la zancada.', 'error'));
        }}
      >
        Usar esta zancada desde hoy
      </button>
      <button type="button" class="linkish stride-guide__manual" onClick={onBack}>
        Mejor medirla con el GPS
      </button>
    </div>
  );
}
