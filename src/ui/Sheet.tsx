import { signal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { recoverLostFocus } from './focus';
import { Icon } from './icons';
import { ToastView } from './ToastView';

/**
 * Las hojas abiertas, de la primera a la última. Pueden apilarse (el menú de perfil, uno de sus apartados y el formulario
 * de editar): solo la de arriba lleva el aviso temporal, para que no se anuncie una vez por cada hoja.
 */
const openSheets = signal<number[]>([]);
let nextSheetId = 0;
/** Cuántas veces se ha abierto una hoja: se anota en `data-opened` para que «atrás» cierre la última abierta (ver `back-button.ts`). */
let openings = 0;

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ComponentChildren;
  /** Ocupa casi toda la altura (formularios largos, sesión deportiva). */
  tall?: boolean;
  /** Si es `false`, no se cierra con el fondo, Esc ni "atrás": solo con los botones de su contenido. */
  dismissible?: boolean;
}

/**
 * Hoja inferior sobre `<dialog>` nativo: el navegador se encarga del foco atrapado, de Esc y, en Android,
 * de que el botón "atrás" la cierre. El contenido solo se monta mientras está abierta.
 */
export function Sheet({ open, onClose, title, children, tall, dismissible = true }: SheetProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = ++nextSheetId;

  useEffect(() => {
    if (!open) return undefined;
    const id = idRef.current;
    openSheets.value = [...openSheets.value, id];
    return () => {
      openSheets.value = openSheets.value.filter((other) => other !== id);
    };
  }, [open]);
  const onTop = openSheets.value[openSheets.value.length - 1] === idRef.current;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.dataset.opened = String(++openings);
      dialog.showModal();
    }
    else if (!open && dialog.open) {
      dialog.close();
      recoverLostFocus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      class={`sheet${tall ? ' sheet--tall' : ''}`}
      aria-label={title}
      onCancel={(event) => {
        if (!dismissible) event.preventDefault();
      }}
      onClose={() => {
        if (!open) return;
        // Si se cerró a la fuerza (p. ej. el sistema) un diálogo no cerrable, se vuelve a abrir.
        if (!dismissible) ref.current?.showModal();
        else onClose();
      }}
      onClick={(event) => {
        if (dismissible && event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div class="sheet__panel">
          <div class="sheet__grab" aria-hidden="true" />
          <header class="sheet__head">
            <h2>{title}</h2>
            {dismissible && (
              <button type="button" class="icon-btn" aria-label="Cerrar" onClick={onClose}>
                <Icon name="X" />
              </button>
            )}
          </header>
          <div class="sheet__body">{children}</div>
          <ToastView muted={!onTop} />
        </div>
      )}
    </dialog>
  );
}
