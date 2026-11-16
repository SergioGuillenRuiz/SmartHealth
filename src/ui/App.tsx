import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { applyUpdate } from '../app/pwa';
import { SelfTestMount } from '../selftest/SelfTestSheet';
import { activeTab, lastSync, nowMs, ring, ringSheetOpen, selectedDay, settings, socialProfile, syncUi, todayKey, updateReady, userMenuOpen, type TabIndex } from '../app/state';
import { Avatar } from './avatar';
import { hasRing } from '../app/devices';
import { backupOverdue } from '../domain/backup-reminder';
import { addDays } from '../domain/dates';
import { fmtDayShort, fmtDayTitle, fmtWeekday } from './format';
import { DevicesIcon, Icon } from './icons';
import { CalibrateSheet, ProfileSheet } from './user/ProfileSheets';
import { UserMenuSheet } from './user/UserMenu';
import { LiveWorkout } from './LiveWorkout';
import { MealDetailSheet } from './MealDetailSheet';
import { SuggestionsSheet } from './MealSuggestions';
import { MealSheet } from './MealSheet';
import { WaterSheet } from './WaterSheet';
import { MeasureSheet } from './MeasureSheet';
import { DevicesSheet } from './DevicesSheet';
import { ToastView } from './ToastView';
import { ManualWorkoutSheet, PendingWorkoutSheet, ReadySheet, WorkoutDetailSheet } from './WorkoutSheets';
import { HealthScreen } from './screens/Health';
import { SportsScreen } from './screens/Sports';
import { SummaryScreen } from './screens/Summary';

const TABS = [
  { label: 'Resumen', icon: 'House', title: 'Resumen diario' },
  { label: 'Deportes', icon: 'SportShoe', title: 'Deportes' },
  { label: 'Salud', icon: 'HeartPulse', title: 'Salud y evolución' },
] as const;

export function App(): JSX.Element {
  return (
    <>
      <TopBar />
      <UpdateBar />
      <Pager />
      <nav class="nav" aria-label="Secciones">
        {TABS.map((tab, i) => (
          <button type="button" key={tab.label} aria-current={activeTab.value === i ? 'page' : undefined} onClick={() => (activeTab.value = i as TabIndex)}>
            <Icon name={tab.icon} size={22} />
            {tab.label}
          </button>
        ))}
      </nav>
      <DevicesSheet />
      <SelfTestMount />
      <MeasureSheet />
      <MealSheet />
      <MealDetailSheet />
      <SuggestionsSheet />
      <WaterSheet />
      <ReadySheet />
      <ManualWorkoutSheet />
      <WorkoutDetailSheet />
      <UserMenuSheet />
      <ProfileSheet />
      <CalibrateSheet />
      <LiveWorkout />
      <PendingWorkoutSheet />
      <ToastView inApp />
    </>
  );
}

// ───────────────────────────── barra superior ─────────────────────────────

function ringStatus(): 'none' | 'ok' | 'warn' | 'danger' | 'busy' {
  const sync = syncUi.value;
  if (sync.status === 'running') return 'busy';
  if (sync.status === 'error') return 'danger';
  const last = lastSync.value;
  if (!ring.value || !last) return 'none';
  return nowMs.value - last.tsMs > 6 * 3_600_000 ? 'warn' : 'ok';
}

const STATUS_LABEL = {
  none: 'Anillo sin vincular',
  ok: 'Anillo sincronizado',
  warn: 'Sincronización antigua',
  danger: 'Error de sincronización',
  busy: 'Sincronizando',
} as const;

function TopBar(): JSX.Element {
  const tab = activeTab.value;
  const status = ringStatus();
  // Con datos que perder (ya se sincronizó) y sin una copia reciente, el botón de perfil lo recuerda con un punto.
  const backupDue = lastSync.value !== null && backupOverdue(settings.value.lastBackupMs, nowMs.value);
  return (
    <header class="topbar">
      <button
        type="button"
        class="topbtn topbtn--user"
        aria-label={backupDue ? 'Mi perfil: falta hacer una copia de seguridad' : 'Mi perfil'}
        onClick={() => (userMenuOpen.value = true)}
      >
        {socialProfile.value?.photo !== undefined ? <Avatar profile={socialProfile.value} size={30} /> : <Icon name="user-circle" size={28} />}
        {backupDue && <span class="topbtn__dot" aria-hidden="true" />}
      </button>
      {tab === 0 ? <DayNav /> : <h1 class="topbar__title">{TABS[tab]?.title}</h1>}
      <button type="button" class="topbtn ringbtn" aria-label={`Dispositivos: ${hasRing.value ? STATUS_LABEL[status] : 'sin anillo'}`} onClick={() => (ringSheetOpen.value = true)}>
        <DevicesIcon size={28} />
        {hasRing.value && <span class={`ringbtn__dot${status === 'none' ? '' : ` ringbtn__dot--${status}`}`} aria-hidden="true" />}
      </button>
    </header>
  );
}

function DayNav(): JSX.Element {
  const day = selectedDay.value;
  // El «hoy» del Resumen: el día empieza a la hora de los ajustes (las 08:00), no a medianoche.
  const today = todayKey.value;
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div class="daynav" role="group" aria-label="Día">
      <button type="button" class="icon-btn" aria-label="Día anterior" onClick={() => (selectedDay.value = addDays(day, -1))}>
        <Icon name="ChevronLeft" size={22} />
      </button>
      <button
        type="button"
        class="daynav__label"
        aria-label={`${fmtDayTitle(day, today)}, ${fmtWeekday(day)} ${fmtDayShort(day)}. Elegir otra fecha`}
        onClick={() => picker.current?.showPicker?.()}
      >
        <strong>{fmtDayTitle(day, today).replace(/^./, (c) => c.toUpperCase()).split(',')[0]}</strong>
        <small>
          {fmtWeekday(day)} {fmtDayShort(day)}
        </small>
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={day}
        max={today}
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (value && value <= today) selectedDay.value = value;
        }}
      />
      <button type="button" class="icon-btn" aria-label="Día siguiente" disabled={day >= today} onClick={() => (selectedDay.value = addDays(day, 1))}>
        <Icon name="ChevronRight" size={22} />
      </button>
    </div>
  );
}

// ───────────────────────────── páginas deslizables ─────────────────────────────

function Pager(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const tab = activeTab.value;

  // La pestaña activa manda: si cambia desde la barra inferior, el carrusel salta a su página. Es un salto y no
  // una animación a propósito: con una animación, las posiciones intermedias del desplazamiento llegaban como
  // eventos de scroll y podían reescribir la pestaña activa (y el navegador, al recolocar el ajuste tras un
  // cambio de diseño, devolvía el carrusel a una página vecina).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const left = tab * el.clientWidth;
    if (Math.abs(el.scrollLeft - left) > 2) el.scrollTo({ left, behavior: 'instant' });
  }, [tab]);

  // Al girar la pantalla o cambiar el ancho, se mantiene alineado con la pestaña activa.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const left = activeTab.peek() * el.clientWidth;
      if (Math.abs(el.scrollLeft - left) > 2) el.scrollTo({ left, behavior: 'instant' });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <main
      ref={ref}
      class="pager"
      onScroll={(e) => {
        // Deslizar con el dedo: la página que queda más a la vista pasa a ser la activa.
        const el = e.currentTarget;
        const index = Math.round(el.scrollLeft / Math.max(1, el.clientWidth)) as TabIndex;
        if (index !== activeTab.value && index >= 0 && index <= 2) activeTab.value = index;
      }}
    >
      <section class="page" aria-label={TABS[0].title} inert={tab !== 0}>
        <SummaryScreen />
      </section>
      <section class="page" aria-label={TABS[1].title} inert={tab !== 1}>
        <SportsScreen />
      </section>
      <section class="page" aria-label={TABS[2].title} inert={tab !== 2}>
        <HealthScreen />
      </section>
    </main>
  );
}

function UpdateBar(): JSX.Element | null {
  if (!updateReady.value) return null;
  return (
    <div class="updatebar" role="status">
      <span>Hay una versión nueva de la app.</span>
      <button type="button" class="linkish" onClick={applyUpdate}>
        Actualizar
      </button>
    </div>
  );
}
