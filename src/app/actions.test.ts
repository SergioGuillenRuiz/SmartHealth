import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedRing } from '../ble/sim/ring';
import { buildDemoDataset, type SimDataset } from '../ble/sim/dataset';
import type { RingLink, RingTransport } from '../ble/transport';
import { openIdbStore, type IdbStore } from '../data/idb-store';
import type { MealEntry } from '../domain/nutrition';
import { addWater, cancelMeasure, forgetRing, measureHeartRateNow, moveMealDay, removeMeal, removeWater, saveMeal, saveSettings, startSync, wipeAllData } from './actions';
import { installServices } from './services';
import { dataVersion, measureUi, nowMs, ringUse, setAutoYield, settings, syncUi, toast, todayKey } from './state';

const NOW = new Date(2026, 6, 10, 18, 0, 0).getTime();
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Transporte cuya conexión se queda esperando hasta que se abra `gate` (un anillo apagado o fuera de alcance). */
class GatedTransport implements RingTransport {
  readonly kind = 'simulator' as const;
  readonly available = true;
  readonly rings: SimulatedRing[] = [];
  gate: Promise<void> | null = null;
  /** Veces que se abrió el selector del sistema y si la reconexión por la dirección guardada «no encuentra» el anillo. */
  picks = 0;
  reconnectFindsNothing = false;
  /** Si se pone, la conexión falla con este error (Bluetooth apagado, anillo fuera de alcance…). */
  failWith: Error | null = null;
  constructor(private readonly dataset: SimDataset) {}
  private async make(): Promise<RingLink> {
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    // Lecturas lentas (una cada 60 ms) para poder cancelar a mitad de la medida.
    const ring = new SimulatedRing(this.dataset, { hrSamples: [75, 0, 0, 84], hrIntervalMs: 60, hrVerdict: 'success' });
    this.rings.push(ring);
    return ring;
  }
  pickAndConnect(): Promise<RingLink> {
    this.picks++;
    return this.make();
  }
  async reconnect(): Promise<RingLink | null> {
    if (this.reconnectFindsNothing) {
      if (this.gate) await this.gate;
      return null;
    }
    return this.make();
  }
}

let counter = 0;
let store: IdbStore;
let transport: GatedTransport;
beforeEach(async () => {
  store = await openIdbStore(`act-${++counter}`);
  transport = new GatedTransport(buildDemoDataset({ nowMs: NOW, days: 1, seed: 2 }));
  installServices({ store, transport, now: () => NOW, demo: false, hrTiming: { hrWarmupMs: 0, hrStreamAfterMs: 0 } });
  measureUi.value = { status: 'idle' };
  syncUi.value = { status: 'idle' };
  ringUse.value = null;
  toast.value = null;
});
afterEach(() => {
  ringUse.value = null;
  syncUi.value = { status: 'idle' };
  setAutoYield(null);
});

describe('medida puntual de pulso: cancelar', () => {
  it('cancelar mientras conecta se ve como «cancelando», mantiene la reserva hasta soltar el anillo y luego vuelve a reposo', async () => {
    let open!: () => void;
    transport.gate = new Promise<void>((resolve) => (open = resolve));
    const measuring = measureHeartRateNow();
    await wait(10);
    expect(measureUi.value).toEqual({ status: 'connecting' });

    cancelMeasure();
    expect(measureUi.value).toEqual({ status: 'cancelling' }); // antes no cambiaba nada hasta que acababa de conectar
    expect(ringUse.value).toBe('measure'); // la conexión en vuelo todavía puede llegar

    // Un segundo toque en «Cancelar» no hace nada más.
    cancelMeasure();
    expect(measureUi.value).toEqual({ status: 'cancelling' });

    transport.gate = null;
    open();
    await measuring;
    expect(measureUi.value).toEqual({ status: 'idle' });
    expect(ringUse.value).toBeNull();
    expect(transport.rings[0]?.connected).toBe(false); // el anillo que llegó tarde se soltó
    expect(transport.rings[0]?.state.measuring).toBeNull();
  });

  it('cancelar mientras se reconecta (y no se encuentra el anillo) no abre después el selector del sistema', async () => {
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    transport.reconnectFindsNothing = true;
    let open!: () => void;
    transport.gate = new Promise<void>((resolve) => (open = resolve));
    const measuring = measureHeartRateNow();
    await wait(20);
    cancelMeasure();
    open();
    await measuring;
    expect(transport.picks).toBe(0);
    expect(measureUi.value).toEqual({ status: 'idle' });
    expect(ringUse.value).toBeNull();
  });

  it('sin cancelar, si la reconexión no encuentra el anillo sí se abre el selector (como siempre)', async () => {
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    transport.reconnectFindsNothing = true;
    await measureHeartRateNow();
    expect(transport.picks).toBe(1);
    expect(measureUi.value).toMatchObject({ status: 'done' });
  });

  it('una lectura que llega después de cancelar no resucita la medida', async () => {
    const measuring = measureHeartRateNow();
    await wait(100); // ya midiendo: las lecturas llegan cada 60 ms y el veredicto, a la cuarta
    expect(measureUi.value.status).toBe('measuring');
    cancelMeasure();
    await measuring;
    await wait(150); // pasa el momento en que habría llegado el resto de las lecturas
    expect(transport.rings[0]?.state.measuring).toBeNull();
    expect(measureUi.value).toEqual({ status: 'idle' });
    expect(ringUse.value).toBeNull();
  });

  it('sin medida en curso, cancelar no hace nada', () => {
    cancelMeasure();
    expect(measureUi.value).toEqual({ status: 'idle' });
  });
});

describe('medida puntual de pulso: el final', () => {
  it('una medida completa acaba en «hecho» y suelta el anillo', async () => {
    await measureHeartRateNow();
    expect(measureUi.value.status).toBe('done');
    expect(ringUse.value).toBeNull();
  });

  it('si no llega ni a conectar, acaba en error con el motivo y suelta el anillo', async () => {
    transport.failWith = new Error('Bluetooth apagado');
    await measureHeartRateNow();
    expect(measureUi.value).toMatchObject({ status: 'error', message: 'Bluetooth apagado' });
    expect(ringUse.value).toBeNull();
  });
});

describe('lo que se pide a mano va antes que la actualización automática', () => {
  /** La automática tiene el anillo (una sincronización sin progreso en pantalla) y lo suelta cuando se le pide. */
  const autoHolds = (releaseAfterMs = 0): { yielded: () => number } => {
    ringUse.value = 'sync';
    let yielded = 0;
    setAutoYield(async () => {
      yielded++;
      await wait(releaseAfterMs);
      ringUse.value = null;
    });
    return { yielded: () => yielded };
  };

  it('«Sincronizar ahora» se ve en marcha al instante, hace soltar el anillo a la automática y sincroniza', async () => {
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const auto = autoHolds(30);
    const syncing = startSync();
    expect(syncUi.value.status).toBe('running'); // sin esperar a que la automática suelte
    await syncing;
    expect(auto.yielded()).toBe(1);
    expect(syncUi.value.status).toBe('done');
    expect(ringUse.value).toBeNull();
    expect(toast.value).toBeNull(); // sin avisos de «se está sincronizando»
  });

  it('«Medir ahora» también: se ve «conectando» al instante y la medida sale', async () => {
    const auto = autoHolds(30);
    const measuring = measureHeartRateNow();
    expect(measureUi.value).toEqual({ status: 'connecting' });
    await measuring;
    expect(auto.yielded()).toBe(1);
    expect(measureUi.value.status).toBe('done');
    expect(ringUse.value).toBeNull();
  });

  it('cancelar la medida mientras la automática suelta el anillo: la medida no llega a empezar ni a conectar', async () => {
    autoHolds(40);
    const measuring = measureHeartRateNow();
    expect(measureUi.value).toEqual({ status: 'connecting' });
    cancelMeasure(); // cerrar la hoja o «Cancelar» durante la espera
    expect(measureUi.value).toEqual({ status: 'cancelling' });
    await measuring;
    expect(measureUi.value).toEqual({ status: 'idle' });
    expect(transport.rings).toHaveLength(0); // nunca se abrió el enlace
    expect(ringUse.value).toBeNull();
  });

  it('«Olvidar anillo» pide antes a la automática que suelte el anillo (no debe devolver lo que se acaba de olvidar)', async () => {
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    const auto = autoHolds(30);
    await forgetRing();
    expect(auto.yielded()).toBe(1);
    expect(await store.getRing()).toBeNull();
  });

  it('«Borrar todo» también: la automática suelta el anillo antes de borrar, y después no quedan ni datos ni anillo', async () => {
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    await store.ingest({ buckets: [], counters: [{ tsMs: NOW - 60_000, steps: 1200 }], heart: [], spo2: [], sleep: [], dropped: {} });
    const auto = autoHolds(30);
    await wipeAllData();
    expect(auto.yielded()).toBe(1);
    expect(await store.getRing()).toBeNull();
    expect((await store.stats()).counts.counters ?? 0).toBe(0);
  });

  it('si la automática no suelta el anillo, se avisa como siempre y todo vuelve a reposo', async () => {
    ringUse.value = 'sync';
    setAutoYield(async () => undefined); // no lo suelta
    await startSync();
    expect(toast.value).toMatchObject({ tone: 'error', message: 'Se está sincronizando: espera a que termine antes de sincronizar.' });
    expect(syncUi.value).toEqual({ status: 'idle' });
    expect(ringUse.value).toBe('sync'); // sigue siendo de la automática

    measureUi.value = { status: 'idle' };
    await measureHeartRateNow();
    expect(measureUi.value).toEqual({ status: 'idle' });
    expect(toast.value?.message).toBe('Se está sincronizando: espera a que termine antes de medir el pulso.');
  });

  it('con el anillo libre no hay espera alguna: se reserva en el mismo instante, como siempre', () => {
    let yielded = 0;
    setAutoYield(async () => void yielded++);
    void startSync();
    expect(ringUse.value).toBe('sync'); // sin un solo `await` antes de reservar
    expect(yielded).toBe(0);
  });

  it('una sincronización a mano que ya está en marcha no se toma por la automática: no se cede nada', async () => {
    await store.setRing({ id: 'sim-r99-0001', name: 'R99 F265' });
    let yielded = 0;
    setAutoYield(async () => void yielded++);
    const first = startSync();
    void startSync(); // segundo toque mientras la primera sincroniza
    await first;
    expect(yielded).toBe(0);
    expect(toast.value?.message).toBe('Se está sincronizando: espera a que termine antes de sincronizar.');
  });
});

describe('agua', () => {
  const day = [NOW - 86_400_000, NOW + 86_400_000] as const;

  it('anotar agua la guarda con la hora de ahora y avisa a las pantallas', async () => {
    const before = dataVersion.value;
    expect(await addWater(250)).toBe(true);
    expect(dataVersion.value).toBe(before + 1);
    const saved = await store.listWater(...day);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ ml: 250, tsMs: NOW });
  });

  it('redondea los ml y rechaza una cantidad imposible sin guardar nada, avisando', async () => {
    expect(await addWater(333.4)).toBe(true);
    expect((await store.listWater(...day))[0]?.ml).toBe(333);
    for (const bad of [0, 5, 2001, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      toast.value = null;
      expect(await addWater(bad), String(bad)).toBe(false);
      expect(toast.value).toMatchObject({ tone: 'error' });
    }
    expect(await store.listWater(...day)).toHaveLength(1);
  });

  it('borrar una toma la quita y también avisa', async () => {
    await addWater(250);
    const [entry] = await store.listWater(...day);
    const before = dataVersion.value;
    await removeWater(entry!);
    expect(dataVersion.value).toBe(before + 1);
    expect(await store.listWater(...day)).toEqual([]);
  });

  it('si el almacén falla, no se pierde nada y se avisa', async () => {
    vi.spyOn(store, 'putWater').mockRejectedValueOnce(new Error('cuota agotada'));
    expect(await addWater(250)).toBe(false);
    expect(toast.value?.message).toMatch(/No se pudo anotar el agua: cuota agotada/);
  });
});

describe('comidas y objetivo de salud', () => {
  const meal = { id: 'c1', tsMs: NOW - 3_600_000, name: 'Arroz con pollo', kcal: 680, source: 'manual' as const };

  it('anotar una comida la guarda y avisa a las pantallas (el resumen y la evolución se recargan)', async () => {
    const before = dataVersion.value;
    await saveMeal(meal);
    expect(dataVersion.value).toBe(before + 1);
    expect(await store.listMeals(NOW - 86_400_000, NOW)).toEqual([meal]);
  });

  it('borrarla la quita y también avisa', async () => {
    await saveMeal(meal);
    const before = dataVersion.value;
    await removeMeal(meal);
    expect(dataVersion.value).toBe(before + 1);
    expect(await store.listMeals(NOW - 86_400_000, NOW)).toEqual([]);
  });

  it('el objetivo de salud se guarda como un ajuste más, sin recargar las pantallas de datos (las barras leen la señal)', async () => {
    const before = dataVersion.value;
    await saveSettings({ healthGoal: 'muscle' });
    expect(settings.value.healthGoal).toBe('muscle');
    expect((await store.getSettings()).healthGoal).toBe('muscle');
    expect(dataVersion.value).toBe(before);
  });

  it('«borrar todo» se lleva también las comidas', async () => {
    await saveMeal(meal);
    await wipeAllData();
    expect(await store.listMeals(NOW - 86_400_000, NOW)).toEqual([]);
  });
});

describe('pasar una comida al día anterior o al siguiente', () => {
  const meal = (over: Partial<MealEntry> = {}): MealEntry => ({ id: 'cena', tsMs: new Date(2026, 6, 10, 0, 40, 0).getTime(), name: 'Cena tardía', kcal: 600, source: 'manual', ...over });

  it('hacia atrás guarda el día al que cuenta, sin tocar la hora; hacia delante vuelve a su día y deja el registro sin `day`', async () => {
    await saveMeal(meal());
    expect(await moveMealDay(meal(), -1)).toBe('2026-07-09');
    expect((await store.listMealsByDay('2026-07-09', '2026-07-09')).map((m) => [m.id, m.tsMs])).toEqual([['cena', meal().tsMs]]);
    expect(await store.listMealsByDay('2026-07-10', '2026-07-10')).toEqual([]);
    const saved = (await store.listMeals(meal().tsMs - 1, meal().tsMs + 1))[0]!;
    expect(await moveMealDay(saved, 1)).toBe('2026-07-10');
    expect((await store.listMeals(meal().tsMs - 1, meal().tsMs + 1))[0]).not.toHaveProperty('day');
  });

  it('avisa el cambio a las pantallas', async () => {
    await saveMeal(meal());
    const before = dataVersion.value;
    await moveMealDay(meal(), -1);
    expect(dataVersion.value).toBeGreaterThan(before);
  });

  it('no pasa una comida a un día futuro ni a más de tres días del real, y avisa', async () => {
    const today = meal({ id: 'hoy', tsMs: NOW - 3_600_000 });
    await saveMeal(today);
    expect(await moveMealDay(today, 1)).toBeNull();
    expect(toast.value?.tone).toBe('error');
    let far = meal({ id: 'lejos' });
    await saveMeal(far);
    for (let n = 0; n < 3; n++) {
      const target = await moveMealDay(far, -1);
      expect(target).not.toBeNull();
      far = { ...far, day: target! };
    }
    expect(await moveMealDay(far, -1)).toBeNull();
  });
});

describe('el día del Resumen es el día de calendario', () => {
  it('a las 02:30 «hoy» ya es el día nuevo (lo de madrugada se puede pasar al día anterior desde su botón)', () => {
    nowMs.value = new Date(2026, 6, 10, 2, 30, 0).getTime();
    expect(todayKey.value).toBe('2026-07-10');
    nowMs.value = new Date(2026, 6, 9, 23, 59, 0).getTime();
    expect(todayKey.value).toBe('2026-07-09');
  });
});
