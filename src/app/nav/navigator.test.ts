import { beforeEach, describe, expect, it } from 'vitest';
import { destinationPoint } from '../../domain/nav/geo';
import { positionAlong } from '../../domain/nav/guidance';
import { CapturingCuer } from '../../domain/nav/guidance.test-support';
import { buildSyntheticCity } from '../../domain/nav/synthetic-city';
import { boxAround } from '../../domain/nav/zones';
import { liveFix, liveWorkout } from '../state';
import type { LiveWorkoutState } from '../workout-controller';
import { backToSearch, chooseDestination, chooseOnMap, closeNavigation, navData, navState, openNavigation, setNavDepsForTests, setQuery, startNavigation, toggleMute, warmNavigation, type NavDeps } from './navigator';
import { loadSyntheticCity, type NavData } from './pack-loader';

const city = buildSyntheticCity();
let cuer: CapturingCuer;
let nowMs = 1_000_000;

/** Las dependencias de siempre (la ciudad de prueba, sin saber la posición), con lo que se quiera cambiar. */
const deps = (change: Partial<NavDeps> = {}): NavDeps => ({ load: () => loadSyntheticCity(), needsPosition: () => false, makeCuer: () => cuer, now: () => nowMs, ...change });

beforeEach(() => {
  cuer = new CapturingCuer();
  nowMs = 1_000_000;
  liveWorkout.value = { sport: 'walk' } as unknown as LiveWorkoutState;
  setNavDepsForTests(deps());
  liveFix.value = { lat: city.at('g_0_1').lat, lon: city.at('g_0_1').lon, accuracyM: 5, speedMs: 0, tsMs: nowMs, receivedMs: nowMs };
});

async function toPreview(): Promise<void> {
  expect(await openNavigation('walk')).toBe(true);
  expect(navState.value.phase).toBe('search');
  const to = city.at('g_3_2');
  chooseDestination({ name: 'Calle de Génova', subtitle: 'Barrio Centro', lat: to.lat, lon: to.lon });
}

describe('abrir el navegador', () => {
  it('solo los deportes con movilidad', async () => {
    expect(await openNavigation('swim')).toBe(false);
    expect(navState.value.phase).toBe('closed');
    expect(await openNavigation('gym')).toBe(false);
    for (const sport of ['walk', 'run', 'hike', 'cycle', 'bicimad']) {
      closeNavigation();
      liveWorkout.value = { sport } as unknown as LiveWorkoutState;
      expect(await openNavigation(sport)).toBe(true);
      expect(navState.value.phase).toBe('search');
    }
  });

  it('si el mapa no se puede abrir lo dice y no se queda cargando', async () => {
    setNavDepsForTests(deps({ load: async () => ({ ok: false, reason: 'offline', message: 'Sin conexión: hace falta internet una vez.' }) }));
    liveWorkout.value = { sport: 'walk' } as unknown as LiveWorkoutState;
    await openNavigation('walk');
    expect(navState.value.phase).toBe('unavailable');
    expect(navState.value.message).toMatch(/Sin conexión/);
  });

  it('tras un fallo se puede volver a abrir (reintentar) y entonces sale el buscador', async () => {
    let fail = true;
    setNavDepsForTests(deps({ load: async () => (fail ? { ok: false, reason: 'busy', message: 'Saturados.' } : loadSyntheticCity()) }));
    liveWorkout.value = { sport: 'walk' } as unknown as LiveWorkoutState;
    await openNavigation('walk');
    expect(navState.value.phase).toBe('unavailable');
    fail = false;
    await openNavigation('walk');
    expect(navState.value.phase).toBe('search');
    expect(navState.value.message).toBeNull();
  });

  it('si el entreno termina, la navegación se cierra', async () => {
    await openNavigation('walk');
    liveWorkout.value = null;
    expect(navState.value.phase).toBe('closed');
  });
});

describe('elegir el destino', () => {
  it('buscar por nombre, cerca de donde estás', async () => {
    await openNavigation('walk');
    setQuery('parque ciud');
    expect(navState.value.results[0]).toMatchObject({ name: 'Parque de la Ciudadela' });
    setQuery('a');
    expect(navState.value.results).toEqual([]);
  });

  it('la ruta se calcula y se enseña antes de empezar', async () => {
    await toPreview();
    const s = navState.value;
    expect(s.phase).toBe('preview');
    expect(s.route!.distanceM).toBeGreaterThan(380);
    expect(s.steps[0]!.type).toBe('depart');
    expect(s.steps.at(-1)!.type).toBe('arrive');
  });

  it('elegir en el mapa pone un destino sin nombre', async () => {
    await openNavigation('walk');
    const to = city.at('g_3_2');
    chooseOnMap(to.lat, to.lon);
    expect(navState.value.destination?.name).toBe('Punto elegido en el mapa');
    expect(navState.value.phase).toBe('preview');
  });

  it('sin GPS espera en vez de inventar un origen', async () => {
    liveFix.value = null;
    await openNavigation('walk');
    const to = city.at('g_3_2');
    chooseDestination({ name: 'X', subtitle: '', lat: to.lat, lon: to.lon });
    expect(navState.value.phase).toBe('search');
    expect(navState.value.message).toMatch(/Esperando la posición del GPS/);
  });

  it('un destino sin calles cerca lo dice', async () => {
    await openNavigation('walk');
    chooseDestination({ name: 'Lejos', subtitle: '', lat: city.center.lat + 0.2, lon: city.center.lon });
    expect(navState.value.phase).toBe('search');
    expect(navState.value.message).toBeTruthy();
    expect(navState.value.route).toBeNull();
  });

  it('un recinto cuyo sendero más cercano no tiene salida: ruta hasta la calle más cercana en vez de «no sé llegar»', async () => {
    await openNavigation('walk');
    const recinto = Array.from(city.input.placeName).findIndex((n) => city.input.names[n] === 'Recinto Ferial');
    expect(recinto).toBeGreaterThanOrEqual(0);
    chooseDestination({ name: 'Recinto Ferial', subtitle: '', lat: city.input.placeLat[recinto]! / 1e7, lon: city.input.placeLon[recinto]! / 1e7 });
    expect(navState.value.phase).toBe('preview');
    expect(navState.value.route).not.toBeNull();
    expect(navState.value.route!.destination.distM).toBeGreaterThan(100);
    expect(navState.value.steps.at(-1)!.text).toMatch(/Aquí acaba el camino/);
  });

  it('un fallo no deja nada bloqueado: sin ruta no queda destino a medias y el siguiente se puede elegir al momento', async () => {
    await openNavigation('walk');
    chooseDestination({ name: 'Lejos', subtitle: '', lat: city.center.lat + 0.2, lon: city.center.lon });
    expect(navState.value).toMatchObject({ phase: 'search', destination: null, routing: false });
    const to = city.at('g_3_2');
    chooseDestination({ name: 'Calle de Génova', subtitle: '', lat: to.lat, lon: to.lon });
    expect(navState.value.phase).toBe('preview');
    expect(navState.value.message).toBeNull();
  });

  it('si el cálculo revienta por lo que sea, lo cuenta y deja elegir otro destino', async () => {
    await openNavigation('walk');
    chooseDestination({ name: 'Raro', subtitle: '', lat: Number.NaN, lon: Number.NaN });
    expect(navState.value.phase).toBe('search');
    expect(navState.value.routing).toBe(false);
    expect(navState.value.message).toBeTruthy();
  });

  it('se puede volver al buscador', async () => {
    await toPreview();
    backToSearch();
    expect(navState.value).toMatchObject({ phase: 'search', route: null, destination: null });
  });

  it('al cambiar de destino desde la vista previa conserva lo escrito; al dejar una ruta, el buscador vuelve vacío y el mapa sigue abierto', async () => {
    await toPreview();
    setQuery('parque');
    const typed = navState.value.results.length;
    backToSearch();
    expect(navState.value.query).toBe('parque');
    expect(navState.value.results.length).toBe(typed);
    startNavigation();
    backToSearch({ clear: true });
    expect(navState.value).toMatchObject({ phase: 'search', query: '', results: [], route: null, destination: null, guidance: null, routing: false });
    expect(navData.value).not.toBeNull();
  });
});

describe('guiar', () => {
  /** Anda la ruta a `speed` m/s con una lectura por segundo hasta `toM`. */
  function walk(fromM: number, toM: number, speed = 1.4, lateral = 0): void {
    const route = navState.value.route!;
    for (let m = fromM; m <= toM; m += speed) {
      nowMs += 1000;
      const here = positionAlong(route, m).position;
      const p = lateral === 0 ? here : destinationPoint(here, 0, lateral);
      liveFix.value = { lat: p.lat, lon: p.lon, accuracyM: 5, speedMs: speed, tsMs: nowMs, receivedMs: nowMs };
    }
  }

  it('de punta a punta: avisa en los giros y acaba con el aviso de llegada', async () => {
    await toPreview();
    startNavigation();
    expect(navState.value.phase).toBe('navigating');
    expect(cuer.cues).toHaveLength(0); // al pulsar «Iniciar» no suena nada: solo hay tres avisos (girar, cambio de sentido y llegada)
    walk(0, navState.value.route!.distanceM + 5);
    expect(navState.value.phase).toBe('arrived');
    const kinds = cuer.cues.map((c) => c.cue.kind);
    expect(kinds.some((k) => k === 'turn')).toBe(true);
    expect(new Set(kinds).size).toBeLessThanOrEqual(3);
    expect(kinds.at(-1)).toBe('arrive');
    expect(kinds.filter((k) => k === 'arrive')).toHaveLength(1);
  });

  it('el estado trae lo que falta y la siguiente instrucción', async () => {
    await toPreview();
    startNavigation();
    walk(0, 150);
    const g = navState.value.guidance!;
    expect(g.status).toBe('navigating');
    expect(g.remainingM).toBeLessThan(navState.value.route!.distanceM - 100);
    expect(g.nextStep).not.toBeNull();
  });

  it('si te sales de la ruta calcula otra desde donde estás; si sigues hacia delante (un atajo) no suena nada', async () => {
    await toPreview();
    startNavigation();
    walk(0, 120);
    const before = navState.value.route;
    const turnsBefore = cuer.cues.length;
    walk(120, 135, 1.4, 60); // 60 m al norte de la ruta, en la misma dirección
    expect(navState.value.route).not.toBe(before);
    expect(cuer.cues.slice(turnsBefore).some((c) => c.cue.kind === 'reverse')).toBe(false); // ir por otro lado no es equivocarse
  });

  it('si vas en sentido contrario y la ruta nueva te manda dar la vuelta, suena el cambio de sentido (y no suena una vez por recálculo)', async () => {
    liveFix.value = { lat: city.at('g_2_1').lat, lon: city.at('g_2_1').lon, accuracyM: 5, speedMs: 0, tsMs: nowMs, receivedMs: nowMs };
    await toPreview();
    startNavigation();
    walk(0, 30);
    const start = positionAlong(navState.value.route!, 0).position;
    const before = navState.value.route;
    // Se da media vuelta y se anda hacia el oeste, alejándose de la ruta (que va hacia el este).
    for (let k = 0; k < 60; k++) {
      nowMs += 1000;
      const p = destinationPoint(start, 270, k * 1.4 - 30);
      liveFix.value = { lat: p.lat, lon: p.lon, accuracyM: 5, speedMs: 1.4, tsMs: nowMs, receivedMs: nowMs };
    }
    expect(navState.value.route).not.toBe(before);
    const reverses = cuer.cues.filter((c) => c.cue.kind === 'reverse');
    expect(reverses.length).toBeGreaterThanOrEqual(1);
    expect(reverses.length).toBeLessThanOrEqual(3); // 60 s yendo mal: como mucho un aviso cada ~25 s
    expect(cuer.cues.every((c) => ['turn', 'reverse', 'arrive'].includes(c.cue.kind))).toBe(true);
  });

  it('silenciar corta los tonos y no suena más', async () => {
    await toPreview();
    startNavigation();
    const played = cuer.cues.length;
    toggleMute();
    expect(cuer.stops).toBeGreaterThan(0);
    walk(0, 250);
    expect(cuer.cues.length).toBe(played);
    toggleMute();
    expect(navState.value.muted).toBe(false);
  });

  it('sin audio en el WebView avisa y sigue guiando por pantalla', async () => {
    setNavDepsForTests(deps({ makeCuer: () => null }));
    liveWorkout.value = { sport: 'walk' } as unknown as LiveWorkoutState;
    await toPreview();
    startNavigation();
    expect(navState.value.soundProblem).toMatch(/no puede reproducir los avisos sonoros/);
    walk(0, 100);
    expect(navState.value.guidance?.status).toBe('navigating');
  });

  it('cerrar suelta el audio y el mapa abierto se conserva para la próxima', async () => {
    await toPreview();
    startNavigation();
    closeNavigation();
    expect(navState.value.phase).toBe('closed');
    expect(cuer.stops).toBeGreaterThan(0);
    expect(navData.value).not.toBeNull();
  });

  it('las posiciones que llegan de golpe tras una pantalla apagada (medidas hace minutos) ponen al día la ruta SIN hacer sonar los giros ya pasados', async () => {
    await toPreview();
    liveFix.value = null; // la posición con la que se calculó la ruta es más nueva que lo atrasado que llega: se parte de cero
    startNavigation();
    const route = navState.value.route!;
    // Se midieron hace diez minutos, de una en una cada segundo, y llegan ahora todas juntas.
    const measuredFrom = nowMs - 600_000;
    let k = 0;
    for (let m = 0; m <= route.distanceM - 25; m += 1.4, k++) {
      const here = positionAlong(route, m).position;
      liveFix.value = { lat: here.lat, lon: here.lon, accuracyM: 5, speedMs: 1.4, tsMs: measuredFrom + k * 1000, receivedMs: nowMs };
    }
    expect(navState.value.guidance!.progressM).toBeGreaterThan(route.distanceM - 40); // la guía sabe por dónde va
    expect(cuer.cues).toHaveLength(0); // y no suena ningún giro de los que ya pasó
    // Con posiciones frescas vuelve a avisar del siguiente giro/llegada como siempre.
    walk(route.distanceM - 25, route.distanceM + 5);
    expect(cuer.cues.some((c) => c.cue.kind === 'arrive')).toBe(true);
  });

  it('una posición atrasada que parece fuera de la ruta no recalcula (ya no se está ahí); una fresca sí', async () => {
    await toPreview();
    startNavigation();
    walk(0, 60);
    const before = navState.value.route;
    for (let k = 0; k < 8; k++) {
      const p = destinationPoint(positionAlong(before!, 60).position, 0, 80);
      liveFix.value = { lat: p.lat, lon: p.lon, accuracyM: 5, speedMs: 1.4, tsMs: nowMs - 300_000 + k * 1000, receivedMs: nowMs };
    }
    expect(navState.value.route).toBe(before);
    walk(60, 75, 1.4, 80);
    expect(navState.value.route).not.toBe(before);
  });

  it('una posición vieja no mueve la guía', async () => {
    await toPreview();
    startNavigation();
    walk(0, 100);
    const progress = navState.value.guidance!.progressM;
    liveFix.value = { lat: city.at('g_3_2').lat, lon: city.at('g_3_2').lon, accuracyM: 5, speedMs: 1.4, tsMs: nowMs - 60_000, receivedMs: nowMs - 60_000 };
    expect(navState.value.guidance!.progressM).toBe(progress);
  });
});

describe('el mapa de donde estás', () => {
  const here = (lat: number, lon: number, at = nowMs): void => {
    liveFix.value = { lat, lon, accuracyM: 5, speedMs: 0, tsMs: at, receivedMs: at };
  };

  it('espera al GPS antes de pedir el mapa y lo pide para esa posición', async () => {
    liveFix.value = null;
    const asked: Array<{ lat: number; lon: number } | null> = [];
    setNavDepsForTests(deps({ needsPosition: () => true, load: async (position) => (asked.push(position), loadSyntheticCity()) }));
    const opening = openNavigation('walk');
    await Promise.resolve();
    expect(navState.value.phase).toBe('locating');
    expect(asked).toEqual([]);
    const p = city.at('g_2_2');
    here(p.lat, p.lon);
    await opening;
    expect(asked).toEqual([{ lat: p.lat, lon: p.lon }]);
    expect(navState.value.phase).toBe('search');
  });

  it('una posición vieja no vale: sigue esperando a una nueva', async () => {
    here(city.center.lat, city.center.lon, nowMs - 120_000);
    setNavDepsForTests(deps({ needsPosition: () => true }));
    const opening = openNavigation('walk');
    await Promise.resolve();
    expect(navState.value.phase).toBe('locating');
    here(city.center.lat, city.center.lon);
    await opening;
    expect(navState.value.phase).toBe('search');
  });

  it('mientras baja el mapa enseña cuánto lleva; al acabar sale el buscador', async () => {
    here(city.center.lat, city.center.lon);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setNavDepsForTests(
      deps({
        needsPosition: () => true,
        load: async (_position, onProgress) => {
          onProgress({ stage: 'download', bytes: 2_500_000 });
          await gate;
          onProgress({ stage: 'build' });
          return loadSyntheticCity();
        },
      }),
    );
    const opening = openNavigation('walk');
    await Promise.resolve();
    await Promise.resolve();
    expect(navState.value).toMatchObject({ phase: 'downloading', download: { stage: 'download', bytes: 2_500_000 } });
    release();
    await opening;
    expect(navState.value).toMatchObject({ phase: 'search', download: null });
  });

  it('si se cierra mientras baja, lo que llega después no reabre nada', async () => {
    here(city.center.lat, city.center.lon);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setNavDepsForTests(deps({ needsPosition: () => true, load: async () => (await gate, loadSyntheticCity()) }));
    const opening = openNavigation('walk');
    await Promise.resolve();
    closeNavigation();
    release();
    await opening;
    expect(navState.value.phase).toBe('closed');
  });

  it('si se cierra esperando al GPS no se queda nada colgado', async () => {
    liveFix.value = null;
    setNavDepsForTests(deps({ needsPosition: () => true }));
    const opening = openNavigation('walk');
    await Promise.resolve();
    closeNavigation();
    await opening;
    here(city.center.lat, city.center.lon);
    await Promise.resolve();
    expect(navState.value.phase).toBe('closed');
  });

  it('al salir de la zona (eligiendo destino) baja el mapa de la nueva y empieza el buscador de cero', async () => {
    const start = city.at('g_4_4');
    here(start.lat, start.lon);
    const loads: Array<{ lat: number; lon: number } | null> = [];
    setNavDepsForTests(deps({ needsPosition: () => true, load: async (position) => (loads.push(position), loadSyntheticCity()) }));
    await openNavigation('walk');
    setQuery('parque ciud');
    expect(navState.value.results.length).toBeGreaterThan(0);
    // Un paseo dentro de la zona no cambia nada.
    nowMs += 120_000;
    here(start.lat + 0.001, start.lon);
    await Promise.resolve();
    expect(loads).toHaveLength(1);
    // Fuera del cuadrado: baja otro mapa.
    nowMs += 120_000;
    here(navData.value!.box.maxLat + 0.01, start.lon);
    await new Promise((r) => setTimeout(r, 0));
    expect(loads).toHaveLength(2);
    expect(navState.value).toMatchObject({ phase: 'search', query: '', results: [], message: null });
  });

  it('no insiste cada segundo si la nueva zona no se puede bajar', async () => {
    const start = city.at('g_4_4');
    here(start.lat, start.lon);
    let calls = 0;
    let ok = true;
    setNavDepsForTests(
      deps({
        needsPosition: () => true,
        load: async () => {
          calls++;
          return ok ? loadSyntheticCity() : { ok: false, reason: 'offline', message: 'Sin conexión.' };
        },
      }),
    );
    await openNavigation('walk');
    ok = false;
    nowMs += 120_000;
    const far = navData.value!.box.maxLat + 0.01;
    here(far, start.lon);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(navState.value.message).toBe('Sin conexión.');
    for (let k = 0; k < 5; k++) {
      nowMs += 5_000;
      here(far + k * 1e-5, start.lon);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(calls).toBe(2);
    nowMs += 120_000;
    here(far, start.lon);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(3);
  });

  it('si cada intento de cambiar de zona falla, la espera entre intentos se duplica (menos peticiones a un servidor que ya dijo que no)', async () => {
    const start = city.at('g_4_4');
    here(start.lat, start.lon);
    let calls = 0;
    let ok = true;
    setNavDepsForTests(deps({ needsPosition: () => true, load: async () => (calls++, ok ? loadSyntheticCity() : { ok: false, reason: 'busy', message: 'Saturado.' }) }));
    await openNavigation('walk');
    ok = false;
    const far = navData.value!.box.maxLat + 0.01;
    const tryAfter = async (waitMs: number): Promise<number> => {
      nowMs += waitMs;
      here(far, start.lon);
      await new Promise((r) => setTimeout(r, 0));
      return calls;
    };
    expect(await tryAfter(61_000)).toBe(2); // 1.er fallo → espera de 2 min
    expect(await tryAfter(61_000)).toBe(2); // a 1 min aún no
    expect(await tryAfter(61_000)).toBe(3); // a 2 min sí → 2.º fallo → espera de 4 min
    expect(await tryAfter(180_000)).toBe(3);
    expect(await tryAfter(61_000)).toBe(4);
    ok = true;
    expect(await tryAfter(10 * 60_000)).toBe(5); // un acierto lo deja como nuevo
    expect(navState.value.message).toBeNull();
  });

  describe('el mapa provisional, antes de tener posición', () => {
    // Una zona guardada de verdad es un cuadrado de 8 km (la ciudad de prueba es más pequeña que el margen de 1 km al borde).
    const recent = async (): Promise<NavData | null> => {
      const loaded = await loadSyntheticCity();
      return loaded.ok ? { ...loaded.data, box: boxAround(city.center.lat, city.center.lon, 4000), zoneId: 'z-prueba' } : null;
    };

    it('si hay un mapa guardado se enseña enseguida, sin esperar al GPS, y la primera posición lo confirma sin pedir nada más', async () => {
      liveFix.value = null;
      const asked: unknown[] = [];
      setNavDepsForTests(deps({ needsPosition: () => true, loadRecent: recent, load: async (position) => (asked.push(position), loadSyntheticCity()) }));
      await openNavigation('walk');
      expect(navState.value.phase).toBe('search'); // ya se puede escribir el destino
      expect(navData.value).not.toBeNull();
      here(city.center.lat, city.center.lon); // la primera posición cae dentro del mapa
      await new Promise((r) => setTimeout(r, 0));
      expect(asked).toEqual([]);
      expect(navState.value).toMatchObject({ phase: 'search', message: null });
    });

    it('si la primera posición cae fuera (o muy cerca del borde), se busca el mapa de donde estás de verdad', async () => {
      liveFix.value = null;
      const asked: Array<{ lat: number; lon: number } | null> = [];
      setNavDepsForTests(deps({ needsPosition: () => true, loadRecent: recent, load: async (position) => (asked.push(position), loadSyntheticCity()) }));
      await openNavigation('walk');
      const box = navData.value!.box;
      here(box.maxLat + 0.05, city.center.lon); // otra ciudad
      await new Promise((r) => setTimeout(r, 0));
      expect(asked).toHaveLength(1);
      expect(asked[0]!.lat).toBeCloseTo(box.maxLat + 0.05, 5);
      expect(navState.value.phase).toBe('search');
    });

    it('si no se puede tener el mapa de aquí, no se deja buscar sobre el de otra zona: se dice y se puede reintentar', async () => {
      liveFix.value = null;
      setNavDepsForTests(deps({ needsPosition: () => true, loadRecent: recent, load: async () => ({ ok: false, reason: 'offline', message: 'Sin conexión: hace falta internet una vez.' }) }));
      await openNavigation('walk');
      here(navData.value!.box.maxLat + 0.05, city.center.lon);
      await new Promise((r) => setTimeout(r, 0));
      expect(navState.value).toMatchObject({ phase: 'unavailable', message: 'Sin conexión: hace falta internet una vez.' });
      expect(navData.value).toBeNull();
    });

    it('sin ningún mapa guardado todo sigue como antes: se espera al GPS', async () => {
      liveFix.value = null;
      setNavDepsForTests(deps({ needsPosition: () => true, loadRecent: async () => null }));
      const opening = openNavigation('walk');
      await new Promise((r) => setTimeout(r, 0));
      expect(navState.value.phase).toBe('locating');
      here(city.center.lat, city.center.lon);
      await opening;
      expect(navState.value.phase).toBe('search');
    });

    it('con la posición ya conocida no se usa el provisional (se abre el de esa posición)', async () => {
      let provisionalReads = 0;
      setNavDepsForTests(deps({ needsPosition: () => true, loadRecent: async () => (provisionalReads++, recent()) }));
      await openNavigation('walk');
      expect(provisionalReads).toBe(0);
    });

    it('al empezar el entreno guiado se va leyendo ya (warmNavigation) y al abrir el mapa se usa lo leído, sin leerlo otra vez', async () => {
      liveFix.value = null;
      let reads = 0;
      setNavDepsForTests(deps({ needsPosition: () => true, loadRecent: async () => (reads++, recent()) }));
      warmNavigation();
      warmNavigation(); // pedirlo dos veces no lo lee dos veces
      await openNavigation('walk');
      expect(reads).toBe(1);
      expect(navState.value.phase).toBe('search');
    });

    it('lo leído por adelantado caduca (3 min) y no se usa viejo', async () => {
      liveFix.value = null;
      let reads = 0;
      setNavDepsForTests(deps({ needsPosition: () => true, loadRecent: async () => (reads++, recent()) }));
      warmNavigation();
      nowMs += 4 * 60_000;
      await openNavigation('walk');
      expect(reads).toBe(2);
    });
  });

  it('con una ruta calculada o navegando el mapa no se cambia', async () => {
    const start = city.at('g_0_1');
    here(start.lat, start.lon);
    let calls = 0;
    setNavDepsForTests(deps({ needsPosition: () => true, load: async () => (calls++, loadSyntheticCity()) }));
    await openNavigation('walk');
    const to = city.at('g_3_2');
    chooseDestination({ name: 'X', subtitle: '', lat: to.lat, lon: to.lon });
    expect(navState.value.phase).toBe('preview');
    nowMs += 120_000;
    here(navData.value!.box.maxLat + 0.05, start.lon);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
  });
});
