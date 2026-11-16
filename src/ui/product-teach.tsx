import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { describeOcrFailure, LabelOcrError, readLabelFromImage, releaseLabelReader, warmLabelReader, type LabelStage } from '../app/label-ocr';
import { openCamera, PhotoError, type CameraHandle } from '../app/photo-capture';
import { draftFromReading, readLabelText } from '../domain/label-text';
import type { UserProduct, UserProductDraft } from '../domain/user-products';
import { inWayOrder, type WayId } from './add-ways';
import { Icon } from './icons';
import { Banner } from './primitives';
import { ProductForm } from './product-form';

// Enseñarle un producto nuevo a la app, de la forma más cómoda que haya: 1) una foto de la tabla nutricional (se lee en el móvil, sin internet), 2) contarlo con palabras (sirve el
// dictado por voz del teclado) y, como último recurso, 3) escribir las cifras a mano. Las dos primeras no guardan nada por sí solas: rellenan el formulario y la persona revisa
// las cifras antes de guardar (un OCR de una foto torcida o con reflejos se equivoca, y una frase dictada también).

type View = 'choose' | 'photo' | 'words' | 'reading' | 'review';

interface ProductTeachProps {
  /** El código del producto que se acaba de escanear y no estaba en la base. */
  barcode: string;
  onSaved: (product: UserProduct) => void;
  onCancel: () => void;
}

const BLANK = (barcode: string): UserProductDraft => ({ barcode, name: '', kcal: null, proteinG: null, carbsG: null, fatG: null, fiberG: null, sugarsG: null, saltG: null, servingG: null });

const PHOTO_PROBLEMS = {
  denied: 'No hay permiso para usar la cámara: actívalo en los ajustes de Android o elige una foto de la galería.',
  'no-camera': 'Este móvil no tiene una cámara que se pueda usar. Elige una foto de la galería.',
  unsupported: 'La cámara no está disponible aquí. Elige una foto de la galería.',
  failed: 'No se pudo abrir la cámara. Elige una foto de la galería.',
} as const;

/** Lo que se dice según el paso de la lectura. */
const STAGE_TEXT: Record<LabelStage, string> = {
  prepare: 'Preparando la foto…',
  load: 'Despertando el lector de fotos…',
  read: 'Leyendo la tabla…',
};
/** Pasados estos segundos de lectura se ofrece la salida de contarlo con palabras. */
const SLOW_AFTER_S = 20;

type TeachOption = { way: WayId; view: 'photo' | 'words' | 'manual'; icon: string; title: string; summary: string };

/** Las tres formas de darle los valores, en el orden de siempre (`add-ways.ts`): la foto (que lee), las palabras y, la última, a mano. */
const OPTIONS: ReadonlyArray<TeachOption> = inWayOrder<TeachOption>([
  { way: 'scan', view: 'photo', icon: 'Camera', title: 'Hacer una foto a la tabla nutricional', summary: 'La app lee las cifras por ti' },
  { way: 'words', view: 'words', icon: 'Mic', title: 'Contarlo con tus palabras', summary: 'Escrito o dictado por voz' },
  { way: 'manual', view: 'manual', icon: 'PenLine', title: 'Escribirlo a mano', summary: 'Si lo anterior no sirve' },
]);

export function ProductTeach({ barcode, onSaved, onCancel }: ProductTeachProps): JSX.Element {
  const [view, setView] = useState<View>('choose');
  const [problem, setProblem] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<LabelStage>('prepare');
  const [elapsed, setElapsed] = useState(0);
  const [review, setReview] = useState<{ draft: UserProductDraft; note: string }>({ draft: BLANK(barcode), note: '' });
  const abort = useRef<AbortController | null>(null);
  // Al salir se para lo que se esté leyendo y se suelta el motor de lectura (ocupa memoria).
  useEffect(
    () => () => {
      abort.current?.abort();
      releaseLabelReader();
    },
    [],
  );
  // Los segundos que lleva la lectura: sin ellos, una espera larga parece una pantalla colgada.
  useEffect(() => {
    if (view !== 'reading') return undefined;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [view]);

  const toChoose = (message: string | null): void => {
    setProblem(message);
    setView('choose');
  };

  const reviewReading = (draft: UserProductDraft, note: string): void => {
    setReview({ draft, note });
    setProblem(null);
    setView('review');
  };

  /** Lee una foto de la etiqueta (de la cámara o de la galería). */
  const readPhoto = (blob: Blob): void => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setProgress(0);
    setStage('prepare');
    setProblem(null);
    setView('reading');
    const onProgress = (fraction: number, at: LabelStage): void => {
      if (controller.signal.aborted) return;
      setProgress(fraction);
      setStage(at);
    };
    void readLabelFromImage(blob, onProgress, controller.signal).then(
      ({ reading }) => {
        if (controller.signal.aborted) return;
        if (reading.found === 0) {
          setView('photo');
          setProblem('No se ha podido leer ninguna cifra. Prueba más cerca, con más luz y sin reflejos, o cuéntalo con palabras.');
          return;
        }
        const { draft, scaled } = draftFromReading(reading, barcode);
        reviewReading(draft, `${scaled ? `Las cifras eran por ración de ${reading.servingG ?? ''} g y se han pasado a 100 g. ` : ''}Revisa lo que ha leído la foto antes de guardar.`);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        toChoose(error instanceof LabelOcrError ? describeOcrFailure(error.failure) : describeOcrFailure('failed'));
      },
    );
  };

  const readWords = (): void => {
    const reading = readLabelText(text, { withName: true });
    if (reading.found === 0) {
      setProblem('No he entendido ninguna cifra. Prueba así: «Galletas, 480 calorías, 6 de proteínas, 70 de hidratos, 20 de grasas».');
      return;
    }
    const { draft, scaled } = draftFromReading(reading, barcode);
    reviewReading(draft, `${scaled ? `Las cifras eran por ración de ${reading.servingG ?? ''} g y se han pasado a 100 g. ` : ''}Revisa lo que ha entendido antes de guardar.`);
  };

  if (view === 'review') {
    return (
      <div>
        {review.note !== '' && <Banner>{review.note}</Banner>}
        <ProductForm initial={review.draft} editing={false} onSaved={onSaved} onCancel={() => toChoose(null)} cancelLabel="Atrás" />
      </div>
    );
  }

  if (view === 'reading') {
    const slow = elapsed >= SLOW_AFTER_S;
    return (
      <div class="read">
        <p class="sync-note" role="status">
          <span class="spinner" aria-hidden="true" /> {STAGE_TEXT[stage]}
        </p>
        <div class="read__bar" role="progressbar" aria-label="Lectura de la foto" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} data-stage={stage}>
          <span class="read__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p class="read__meta" aria-hidden="true">
          {Math.round(progress * 100)} % · {elapsed} s
        </p>
        {slow && <p class="field__hint">Está tardando más de lo normal en este móvil. Puedes esperar, o contarlo con palabras.</p>}
        {slow && (
          <button
            type="button"
            class="btn btn--block"
            onClick={() => {
              abort.current?.abort();
              setProblem(null);
              setView('words');
            }}
          >
            <Icon name="Mic" size={18} />
            Contarlo con tus palabras
          </button>
        )}
        <button
          type="button"
          class="btn btn--ghost btn--block"
          onClick={() => {
            abort.current?.abort();
            toChoose(null);
          }}
        >
          Cancelar
        </button>
      </div>
    );
  }

  if (view === 'photo') return <PhotoStep problem={problem} onPhoto={readPhoto} onBack={() => toChoose(null)} />;

  if (view === 'words') {
    return (
      <form
        class="meal__form"
        onSubmit={(e) => {
          e.preventDefault();
          readWords();
        }}
      >
        <div class="field">
          <label for="teach-words">Cuéntalo con tus palabras</label>
          <textarea
            id="teach-words"
            class="input meal__textarea"
            autocomplete="off"
            placeholder="Galletas de la abuela, 480 calorías, 6 de proteínas, 70 de hidratos, 20 de grasas, 0,5 de sal"
            value={text}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setProblem(null);
            }}
          />
          <p class="field__hint">Vale el dictado por voz del teclado. Di las cifras por 100 g.</p>
        </div>
        {problem !== null && (
          <div class="errors errors--box" role="alert">
            {problem}
          </div>
        )}
        <button type="submit" class="btn btn--primary btn--block" disabled={text.trim() === ''}>
          <Icon name="Check" size={18} />
          Leer las cifras
        </button>
        <button type="button" class="btn btn--ghost btn--block" onClick={() => toChoose(null)}>
          Atrás
        </button>
      </form>
    );
  }

  return (
    <div>
      {problem !== null && <Banner tone="warn">{problem}</Banner>}
      <ul class="menu" aria-label="Cómo darle los valores">
        {OPTIONS.map((option) => (
          <li key={option.view}>
            <button
              type="button"
              class="menu-row"
              onClick={() => {
                setProblem(null);
                if (option.view === 'manual') reviewReading(BLANK(barcode), '');
                else setView(option.view);
              }}
            >
              <span class="menu-row__icon" style={{ color: 'var(--kcal)' }}>
                <Icon name={option.icon} size={20} />
              </span>
              <span class="menu-row__main">
                <strong>{option.title}</strong>
                <small>{option.summary}</small>
              </span>
              <Icon name="ChevronRight" size={18} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" class="btn btn--ghost btn--block" onClick={onCancel}>
        Cancelar
      </button>
    </div>
  );
}

/** La cámara (en alta resolución) para fotografiar la tabla, o una foto de la galería. La cámara solo está abierta mientras se enfoca. */
function PhotoStep({ problem, onPhoto, onBack }: { problem: string | null; onPhoto: (blob: Blob) => void; onBack: () => void }): JSX.Element {
  const [cameraProblem, setCameraProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<CameraHandle | null>(null);
  const gallery = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // El lector de fotos se arranca ya, mientras la persona encuadra y hace la foto: cuando haya foto, estará listo.
    warmLabelReader();
    const element = video.current;
    if (!element) return undefined;
    let cancelled = false;
    openCamera(element, { hiRes: true }).then(
      (handle) => {
        if (cancelled) handle.stop();
        else camera.current = handle;
      },
      (error: unknown) => {
        if (!cancelled) setCameraProblem(PHOTO_PROBLEMS[error instanceof PhotoError ? error.failure : 'failed']);
      },
    );
    return () => {
      cancelled = true;
      camera.current?.stop();
      camera.current = null;
    };
  }, []);

  const take = (): void => {
    setBusy(true);
    void (camera.current?.captureFull() ?? Promise.resolve(null)).then((blob) => {
      setBusy(false);
      if (blob === null) setCameraProblem('La cámara aún no tiene imagen: espera un momento y vuelve a intentarlo.');
      else onPhoto(blob);
    });
  };

  return (
    <div>
      <div class="scan" role="group" aria-label="Cámara para la tabla nutricional" hidden={cameraProblem !== null}>
        <video ref={video} class="scan__video" playsInline muted />
      </div>
      {problem !== null && <Banner tone="warn">{problem}</Banner>}
      {cameraProblem !== null && <Banner tone="warn">{cameraProblem}</Banner>}
      {cameraProblem === null && <p class="field__hint meal__hint">Encuadra la tabla de «por 100 g», con buena luz y sin reflejos.</p>}
      {cameraProblem === null && (
        <button type="button" class="btn btn--primary btn--block" disabled={busy} onClick={take}>
          <Icon name="Camera" size={18} />
          Sacar foto
        </button>
      )}
      <button type="button" class="btn btn--block" style={{ marginTop: '8px' }} onClick={() => gallery.current?.click()}>
        <Icon name="ImagePlus" size={18} />
        Elegir una foto de la galería
      </button>
      <input
        ref={gallery}
        type="file"
        accept="image/*"
        hidden
        aria-label="Foto de la tabla nutricional"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) onPhoto(file);
        }}
      />
      <button type="button" class="btn btn--ghost btn--block" style={{ marginTop: '8px' }} onClick={onBack}>
        Atrás
      </button>
    </div>
  );
}
