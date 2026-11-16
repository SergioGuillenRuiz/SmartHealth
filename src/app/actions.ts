import { RingError } from '../ble/errors';
import { dayKeyOf, dayOfMs, type DayKey } from '../domain/dates';
import { creditField, mealDay, movedDay } from '../domain/day-credit';
import type { SavedDish } from '../domain/dishes';
import { hasMergedIngredient, migrateMergedDishes } from './dish-split';
import { MAX_WATER_ML, MIN_WATER_ML, type WaterEntry } from '../domain/hydration';
import type { MealEntry } from '../domain/nutrition';
import type { UserProduct } from '../domain/user-products';
import { upsertProfileEntry, type ProfileEntry } from '../domain/profile';
import type { Settings } from '../data/types';
import { YcbtSession } from '../ble/session';
import { runSync, SyncFailure } from '../sync/run-sync';
import { svc } from './services';
import { autoHoldsRing, bumpData, claimRing, lastSync, measureUi, nowMs, profileHistory, ring, savedDishes, savedProducts, selectedDay, settings, showToast, socialProfile, syncUi, yieldRingToUser } from './state';
import { newSocialProfile, type SocialProfile } from '../domain/social-profile';

/** La primera vez (y tras «Borrar todo») no hay perfil social: se crea uno nuevo, con su identificador único. Si no se pudiera (un móvil sin generador de números aleatorios seguros), la app sigue sin él. */
async function createSocial(): Promise<SocialProfile | null> {
  try {
    const profile = newSocialProfile(svc().now());
    await svc().store.setSocial(profile);
    return profile;
  } catch {
    return null;
  }
}

/** Carga del almacén a las señales: se llama al arrancar y tras cualquier cambio de perfil/ajustes/anillo. */
export async function reloadAll(): Promise<void> {
  const { store } = svc();
  const [history, config, saved, last, social] = await Promise.all([
    store.getProfileHistory(),
    store.getSettings(),
    store.getRing(),
    store.lastSuccessfulSync(),
    store.getSocial().catch(() => null),
  ]);
  profileHistory.value = history;
  applySettings(config);
  ring.value = saved;
  lastSync.value = last;
  socialProfile.value = social ?? (await createSocial());
  // Los platos guardados (con sus fotos) también: la lista de comidas del día enseña la foto del plato con el que se anotó una comida.
  await refreshDishes();
}

/**
 * Guarda los ajustes en la señal. Si el día que se mira era «hoy» con la hora de inicio de antes, sigue siéndolo con la de ahora:
 * cambiarla a las 3 de la madrugada mueve el «hoy» (que empieza a esa hora) al día anterior o al siguiente.
 */
function applySettings(next: Settings): void {
  settings.value = next;
}

/**
 * Sincroniza con el anillo. Debe llamarse desde un gesto del usuario (en web el selector de Bluetooth lo
 * exige). Nunca se solapa con otra sincronización, con una medida ni con un entrenamiento que tengan el anillo en uso.
 */
export async function startSync(options: { forcePick?: boolean; showAll?: boolean } = {}): Promise<void> {
  // Sin anillo (el interruptor del menú de dispositivos) no hay nada que sincronizar.
  if (!settings.peek().hasRing) return;
  // Si la actualización automática tiene el anillo, lo que se pide a mano va antes: se le hace soltarlo (unos segundos como
  // mucho) y mientras tanto se ve que ya se está en ello.
  const takingFromAuto = autoHoldsRing();
  if (takingFromAuto) {
    syncUi.value = { status: 'running', progress: { stage: 'connecting', message: 'Buscando el anillo…', fraction: 0.02 } };
    await yieldRingToUser();
  }
  const release = claimRing('sync');
  if (!release) {
    if (takingFromAuto) syncUi.value = { status: 'idle' };
    return;
  }
  const { store, transport, now } = svc();
  syncUi.value = { status: 'running', progress: { stage: 'connecting', message: 'Buscando el anillo…', fraction: 0.02 } };
  try {
    const report = await runSync(
      { transport, store, now, onProgress: (progress) => (syncUi.value = { status: 'running', progress }) },
      options,
    );
    syncUi.value = { status: 'done', report };
    await reloadAll();
    bumpData();
  } catch (error) {
    if (error instanceof RingError && error.code === 'no-device') {
      syncUi.value = { status: 'idle' }; // cerrar el selector no es un error
    } else if (error instanceof SyncFailure) {
      syncUi.value = { status: 'error', message: error.message, code: error.code };
      await reloadAll();
    } else if (error instanceof RingError) {
      syncUi.value = { status: 'error', message: error.message, code: error.code };
    } else {
      syncUi.value = { status: 'error', message: error instanceof Error ? error.message : 'Error desconocido.', code: 'unknown' };
    }
  } finally {
    release();
  }
}

/**
 * Borra todos los datos (y el anillo vinculado). Antes pide a la actualización automática que suelte el anillo: lo que estuviera
 * leyendo no debe escribirse sobre lo que se acaba de borrar.
 */
export async function wipeAllData(): Promise<void> {
  await yieldRingToUser();
  await svc().store.wipe();
  await reloadAll();
  bumpData();
}

export async function forgetRing(): Promise<void> {
  // Una lectura automática en curso no debe devolver el anillo que se está olvidando (guarda el anillo al abrir la conexión).
  await yieldRingToUser();
  await svc().store.setRing(null);
  await reloadAll();
  syncUi.value = { status: 'idle' };
}

export async function saveProfileEntry(entry: ProfileEntry): Promise<void> {
  await svc().store.putProfileEntry(entry);
  profileHistory.value = upsertProfileEntry(profileHistory.value, entry);
  bumpData();
}

/** Anota una comida y avisa a las pantallas que dependen de lo guardado (el resumen del día y la evolución). */
export async function saveMeal(meal: MealEntry): Promise<void> {
  await svc().store.putMeal(meal);
  bumpData();
}

/**
 * Pasa una comida al día anterior (`-1`) o al siguiente (`1`) a aquel para el que cuenta ahora, sin tocar su hora. No se pasa a un día futuro ni a más de unos pocos
 * días del día en que se comió. Devuelve el día al que cuenta ahora, o `null` si no se pudo (y avisa).
 */
export async function moveMealDay(meal: MealEntry, direction: -1 | 1): Promise<DayKey | null> {
  const real = dayKeyOf(meal.tsMs);
  const target = movedDay(real, mealDay(meal), direction, dayOfMs(svc().now()));
  if (target === null) {
    showToast(direction < 0 ? 'No se puede pasar más atrás esta comida.' : 'No se puede pasar a un día que aún no ha llegado.', 'error');
    return null;
  }
  const { day: _previous, ...rest } = meal;
  try {
    await svc().store.putMeal({ ...rest, ...creditField(real, target) });
  } catch (error) {
    showToast(`No se pudo mover la comida${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
    return null;
  }
  bumpData();
  return target;
}

const newWaterId = (): string => `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Anota que se han bebido `ml` ml de agua ahora. Devuelve `false` (y avisa) si la cantidad no vale o no se pudo guardar. */
export async function addWater(ml: number): Promise<boolean> {
  if (!Number.isFinite(ml) || ml < MIN_WATER_ML || ml > MAX_WATER_ML) {
    showToast(`Escribe una cantidad entre ${MIN_WATER_ML} y ${MAX_WATER_ML} ml.`, 'error');
    return false;
  }
  try {
    await svc().store.putWater({ id: newWaterId(), tsMs: svc().now(), ml: Math.round(ml) });
  } catch (error) {
    showToast(`No se pudo anotar el agua${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
    return false;
  }
  bumpData();
  return true;
}

export async function removeWater(entry: Pick<WaterEntry, 'id' | 'tsMs'>): Promise<void> {
  await svc().store.deleteWater(entry);
  bumpData();
}

/** Vuelve a leer los platos guardados (la barra de «He comido algo»). Si no se pueden leer, la barra se queda como estaba. */
export async function refreshDishes(): Promise<void> {
  try {
    const dishes = await svc().store.listDishes();
    savedDishes.value = dishes;
    // Los platos de antes de la ronda 46 llevan lo calculado con palabras juntado en UN ingrediente: se reparte en sus alimentos (si cuadra) y se guarda, sin hacer esperar a la barra.
    if (dishes.some(hasMergedIngredient)) {
      void migrateMergedDishes(dishes).then((changed) => {
        if (changed.length === 0) return;
        const byId = new Map(changed.map((dish) => [dish.id, dish]));
        savedDishes.value = savedDishes.value.map((dish) => byId.get(dish.id) ?? dish);
      });
    }
  } catch {
    /* sin platos que enseñar: el resto de la hoja sigue funcionando */
  }
}

/** Guarda un plato nuevo o los cambios de uno que ya existía. Devuelve `false` (y avisa) si no se pudo. */
export async function saveDish(dish: SavedDish): Promise<boolean> {
  try {
    await svc().store.putDish(dish);
  } catch (error) {
    showToast(`No se pudo guardar el plato${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
    return false;
  }
  await refreshDishes();
  return true;
}

export async function removeDish(id: string): Promise<boolean> {
  try {
    await svc().store.deleteDish(id);
  } catch {
    showToast('No se pudo borrar el plato.', 'error');
    return false;
  }
  await refreshDishes();
  return true;
}

/** Vuelve a leer los productos que la persona ha enseñado («Mis productos»). Si no se pueden leer, la lista se queda como estaba. */
export async function refreshProducts(): Promise<void> {
  try {
    savedProducts.value = await svc().store.listProducts();
  } catch {
    /* la pantalla «Mis productos» sigue con lo último que leyó */
  }
}

/** Guarda un producto que la persona enseñó con su etiqueta (o su corrección). Devuelve `false` (y avisa) si no se pudo. */
export async function saveUserProduct(product: UserProduct): Promise<boolean> {
  try {
    await svc().store.putProduct(product);
  } catch (error) {
    showToast(`No se pudo guardar el producto${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
    return false;
  }
  await refreshProducts();
  return true;
}

/** Olvida un producto que la persona había enseñado. */
export async function removeUserProduct(barcode: string): Promise<boolean> {
  try {
    await svc().store.deleteProduct(barcode);
  } catch {
    showToast('No se pudo olvidar el producto.', 'error');
    return false;
  }
  await refreshProducts();
  return true;
}

export async function removeMeal(meal: Pick<MealEntry, 'id' | 'tsMs'>): Promise<void> {
  await svc().store.deleteMeal(meal);
  bumpData();
}

export async function saveSettings(partial: Partial<Settings>): Promise<void> {
  // Los ajustes ya son una señal: lo que los lee se repinta solo. No se relanzan las cargas de datos (con cuatro meses
  // de historial, cada toque en un contador de objetivo recalculaba todas las pantallas, también las ocultas).
  try {
    applySettings(await svc().store.setSettings(partial));
  } catch (error) {
    showToast(`No se pudo guardar el ajuste${error instanceof Error && error.message ? `: ${error.message}` : ''}.`, 'error');
  }
}

/**
 * Mantiene vivo el "ahora" de la app y mueve el día seleccionado si cambia la fecha con la app abierta.
 * No trabaja con la página oculta (no hay nada que repintar) y se pone al día en cuanto vuelve a verse.
 */
export function startClock(): () => void {
  const { now } = svc();
  let lastToday = dayOfMs(now());
  const tick = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const current = now();
    nowMs.value = current;
    const today = dayOfMs(current);
    if (today !== lastToday) {
      if (selectedDay.value === lastToday) selectedDay.value = today;
      lastToday = today;
      bumpData();
    }
  };
  const timer = setInterval(tick, 30_000);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') tick();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}

let measureAbort: AbortController | null = null;

/** Cancela la medida puntual en curso (si la hay): apaga el sensor y suelta la conexión. */
export function cancelMeasure(): void {
  if (!measureAbort || measureAbort.signal.aborted) return;
  measureAbort.abort();
  // Mientras aún conecta, soltar el anillo puede tardar hasta que acabe ese intento: que se vea que se está cancelando.
  measureUi.value = { status: 'cancelling' };
}

/**
 * Medida puntual de pulso: conecta, mide (~20-45 s), guarda la lectura y DESCONECTA. Como la sincronización,
 * debe lanzarse desde un gesto del usuario. Se puede cancelar en cualquier momento (`cancelMeasure`).
 */
export async function measureHeartRateNow(): Promise<void> {
  const abort = new AbortController();
  const takingFromAuto = autoHoldsRing();
  if (takingFromAuto) {
    // Mientras la automática suelta el anillo ya se puede cancelar (cerrar la hoja o «Cancelar»): la medida no llega a empezar.
    measureAbort = abort;
    measureUi.value = { status: 'connecting' };
    await yieldRingToUser();
    if (abort.signal.aborted) {
      if (measureAbort === abort) measureAbort = null;
      measureUi.value = { status: 'idle' };
      return;
    }
  }
  const release = claimRing('measure');
  if (!release) {
    if (takingFromAuto) {
      if (measureAbort === abort) measureAbort = null;
      measureUi.value = { status: 'idle' };
    }
    return;
  }
  const { store, transport, now } = svc();
  measureAbort = abort;
  measureUi.value = { status: 'connecting' };
  let session: YcbtSession | null = null;
  const cancelled = (): boolean => abort.signal.aborted;
  try {
    const saved = await store.getRing();
    let link = saved ? await transport.reconnect(saved) : null;
    if (!link) {
      // Cancelado mientras se reconectaba (y sin éxito): no se abre el selector del sistema para una medida que ya no existe.
      if (cancelled()) return;
      link = await transport.pickAndConnect();
    }
    session = new YcbtSession(link, svc().hrTiming ?? {});
    // Cancelar suelta el enlace al instante, también en mitad del apretón de manos.
    const opened = session;
    abort.signal.addEventListener('abort', () => void opened.close().catch(() => undefined), { once: true });
    if (cancelled()) return;
    await session.open(new Date(now()));
    if (cancelled()) return;
    await store.setRing({ id: link.id, name: link.name });
    measureUi.value = { status: 'measuring', live: null };
    const bpm = await session.measureHeartRate({
      signal: abort.signal,
      onSample: (value) => {
        if (!cancelled()) measureUi.value = { status: 'measuring', live: value };
      },
    });
    if (cancelled()) return;
    if (bpm === null) {
      measureUi.value = { status: 'error', message: 'El anillo no obtuvo una lectura. Ajústalo bien al dedo y vuelve a intentarlo.' };
      return;
    }
    await store.ingest({ buckets: [], counters: [], heart: [{ tsMs: now(), bpm, source: 'ring-spot' }], spo2: [], sleep: [], dropped: {} });
    measureUi.value = { status: 'done', bpm };
    bumpData();
  } catch (error) {
    if (cancelled() || (error instanceof RingError && error.code === 'no-device')) measureUi.value = { status: 'idle' };
    else measureUi.value = { status: 'error', message: error instanceof Error ? error.message : 'No se pudo medir.' };
  } finally {
    // Una medida cancelada deja la hoja en reposo (la hoja puede estar ya cerrada).
    if (cancelled()) measureUi.value = { status: 'idle' };
    await session?.close().catch(() => undefined);
    if (measureAbort === abort) measureAbort = null;
    release();
  }
}
