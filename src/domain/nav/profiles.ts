import { FLAG, HW } from './pack';

// Qué ruta es «la más adecuada» según el entreno: cada perfil dice por qué tramos se puede ir (a pie, en bici), cuánto «cuesta» cada metro según la clase de vía (se prefieren sendas y
// calles tranquilas a las vías con tráfico) y a qué velocidad se suele ir (solo para estimar el tiempo). El A* minimiza el coste, no la distancia.

export type ProfileId = 'walk' | 'run' | 'hike' | 'bike';

export interface Profile {
  id: ProfileId;
  label: string;
  /** El menor factor que aplica: el A* lo usa para que su estimación nunca se pase del coste real. */
  minFactor: number;
  /** Coste de recorrer `lenM` metros del tramo en el sentido `dir` (0: de a a b; 1: de b a a), o `Infinity` si por ahí no se puede ir. */
  cost(cls: number, flags: number, dir: 0 | 1, lenM: number): number;
  /** Velocidad habitual (m/s) por ese tramo, para el tiempo estimado. */
  speed(cls: number, flags: number): number;
}

const has = (flags: number, bit: number): boolean => (flags & bit) !== 0;

/** ¿Se puede recorrer en ese sentido para un vehículo (bici)? Respeta el sentido único, salvo las bicis con permiso a contrasentido. */
function vehicleDirectionOk(flags: number, dir: 0 | 1): boolean {
  if (dir === 0 && has(flags, FLAG.ONEWAY_BWD) && !has(flags, FLAG.BIKE_CONTRAFLOW)) return false;
  if (dir === 1 && has(flags, FLAG.ONEWAY_FWD) && !has(flags, FLAG.BIKE_CONTRAFLOW)) return false;
  return true;
}

const walkFactor: Record<number, number> = {
  [HW.PEDESTRIAN]: 0.8,
  [HW.FOOTWAY]: 0.85,
  [HW.PATH]: 0.9,
  [HW.CYCLEWAY]: 1.1,
  [HW.LIVING_STREET]: 0.9,
  [HW.RESIDENTIAL]: 1,
  [HW.SERVICE]: 1.25,
  [HW.UNCLASSIFIED]: 1.15,
  [HW.TERTIARY]: 1.15,
  [HW.SECONDARY]: 1.5,
  [HW.PRIMARY]: 2.2,
  [HW.TRUNK]: 4,
  [HW.TRACK]: 1.1,
  [HW.STEPS]: 1.6,
};

const runFactor: Record<number, number> = {
  [HW.PEDESTRIAN]: 0.8,
  [HW.FOOTWAY]: 0.85,
  [HW.PATH]: 0.78,
  [HW.CYCLEWAY]: 0.9,
  [HW.LIVING_STREET]: 0.95,
  [HW.RESIDENTIAL]: 1,
  [HW.SERVICE]: 1.3,
  [HW.UNCLASSIFIED]: 1.2,
  [HW.TERTIARY]: 1.3,
  [HW.SECONDARY]: 2,
  [HW.PRIMARY]: 3,
  [HW.TRUNK]: 5,
  [HW.TRACK]: 0.85,
  [HW.STEPS]: 4,
};

const hikeFactor: Record<number, number> = {
  [HW.PEDESTRIAN]: 1,
  [HW.FOOTWAY]: 0.85,
  [HW.PATH]: 0.7,
  [HW.CYCLEWAY]: 1,
  [HW.LIVING_STREET]: 1.2,
  [HW.RESIDENTIAL]: 1.3,
  [HW.SERVICE]: 1.4,
  [HW.UNCLASSIFIED]: 1.4,
  [HW.TERTIARY]: 1.6,
  [HW.SECONDARY]: 2.5,
  [HW.PRIMARY]: 4,
  [HW.TRUNK]: 6,
  [HW.TRACK]: 0.7,
  [HW.STEPS]: 1.3,
};

const bikeFactor: Record<number, number> = {
  [HW.CYCLEWAY]: 0.7,
  [HW.LIVING_STREET]: 0.9,
  [HW.RESIDENTIAL]: 1,
  [HW.UNCLASSIFIED]: 1,
  [HW.SERVICE]: 1.2,
  [HW.TERTIARY]: 1.1,
  [HW.SECONDARY]: 1.4,
  [HW.PRIMARY]: 2.2,
  [HW.TRUNK]: 4,
  [HW.TRACK]: 1.3,
  [HW.PATH]: 1.2,
  [HW.FOOTWAY]: 1.6,
  [HW.PEDESTRIAN]: 1.6,
};

/** Un perfil a pie: el mismo esqueleto con otra tabla de preferencias. */
function footProfile(id: ProfileId, label: string, table: Record<number, number>, stepsAllowed: boolean, baseSpeed: number): Profile {
  const minFactor = Math.min(...Object.values(table));
  return {
    id,
    label,
    minFactor,
    cost(cls, flags, _dir, lenM) {
      if (has(flags, FLAG.FOOT_NO) || cls === HW.MOTORWAY) return Infinity;
      if (cls === HW.STEPS && !stepsAllowed) return Infinity;
      let factor = table[cls] ?? 1.3;
      // Las vías con tráfico sin acera pesan más: andar por el arcén no es agradable ni seguro.
      if ((cls === HW.TERTIARY || cls === HW.SECONDARY || cls === HW.PRIMARY || cls === HW.UNCLASSIFIED) && !has(flags, FLAG.SIDEWALK)) factor += 0.4;
      if (has(flags, FLAG.UNPAVED)) factor *= id === 'run' ? 0.95 : id === 'hike' ? 0.95 : 1.05;
      return lenM * Math.max(factor, minFactor);
    },
    speed(cls, flags) {
      if (cls === HW.STEPS) return baseSpeed * 0.5;
      return has(flags, FLAG.UNPAVED) ? baseSpeed * 0.9 : baseSpeed;
    },
  };
}

const bike: Profile = {
  id: 'bike',
  label: 'Bici',
  minFactor: 0.7 * 0.85,
  cost(cls, flags, dir, lenM) {
    if (has(flags, FLAG.BIKE_NO) || cls === HW.MOTORWAY || cls === HW.STEPS) return Infinity;
    // Las vías peatonales solo valen con permiso para bicis; ahí se va despacio por respeto a los peatones.
    if ((cls === HW.FOOTWAY || cls === HW.PEDESTRIAN || cls === HW.PATH) && !has(flags, FLAG.BIKE_YES)) return Infinity;
    if (!vehicleDirectionOk(flags, dir)) return Infinity;
    let factor = bikeFactor[cls] ?? 1.3;
    if (has(flags, FLAG.CYCLE_LANE)) factor *= cls === HW.TERTIARY ? 0.85 : cls === HW.SECONDARY ? 0.75 : cls === HW.PRIMARY ? 0.65 : 0.9;
    if (has(flags, FLAG.UNPAVED)) factor *= 1.25;
    return lenM * Math.max(factor, 0.7 * 0.85);
  },
  speed(cls, flags) {
    if (cls === HW.FOOTWAY || cls === HW.PEDESTRIAN) return 2;
    if (cls === HW.PATH || cls === HW.TRACK || has(flags, FLAG.UNPAVED)) return 3;
    if (cls === HW.CYCLEWAY) return 5;
    if (cls === HW.PRIMARY || cls === HW.SECONDARY) return 5.5;
    return 4.5;
  },
};

/** Cuánto pesa ir en contra de un sentido único en bici (se prefiere cualquier alternativa que no sea mucho más larga) y llevar la bici a pie por una vía peatonal sin permiso. */
const CONTRAFLOW_FACTOR = 1.6;
const PUSH_BIKE_FACTOR = 2.2;

/**
 * El mismo perfil, pero para CORREGIR a quien se ha salido de la ruta (ronda 45). Las rutas que se proponen respetan las normas (el sentido único, que la bici no vaya por una acera…), y está
 * bien: es lo que se espera de «la ruta más adecuada». Pero quien va a pie, corriendo o en bici no sigue una ruta al pie de la letra: corta por una calle contigua, se salta un sentido único, empuja la
 * bici por una acera o por un parque. Si al desviarse se le recalcula con las normas de un coche, la ruta nueva le manda a dar la vuelta a la manzana (o cuatro) para no ir en contra de un sentido
 * único que ya está recorriendo. Así que aquí se admiten esos tramos, con un coste mayor (se sigue prefiriendo lo legal si no es mucho más largo). A pie no cambia nada: ya no hay normas de coche
 * que relajar. Se sigue sin ir por las autopistas ni por donde la bici tiene prohibido (`BIKE_NO`).
 */
export function relaxedProfile(base: Profile): Profile {
  if (base.id !== 'bike') return base;
  return {
    ...base,
    cost(cls, flags, dir, lenM) {
      const strict = base.cost(cls, flags, dir, lenM);
      if (strict < Infinity) return strict;
      if (has(flags, FLAG.BIKE_NO) || cls === HW.MOTORWAY || cls === HW.STEPS) return Infinity;
      // Primero, el sentido único: se va en contra con un recargo.
      const noOneway = flags & ~(FLAG.ONEWAY_FWD | FLAG.ONEWAY_BWD);
      const contraflow = base.cost(cls, noOneway, dir, lenM);
      if (contraflow < Infinity) return contraflow * CONTRAFLOW_FACTOR;
      // Después, una vía peatonal sin permiso para bicis: se empuja la bici (y si además era de sentido único, los dos recargos).
      const pushed = base.cost(cls, noOneway | FLAG.BIKE_YES, dir, lenM);
      return pushed < Infinity ? pushed * PUSH_BIKE_FACTOR * (flags !== noOneway ? CONTRAFLOW_FACTOR : 1) : Infinity;
    },
  };
}

export const PROFILES: Record<ProfileId, Profile> = {
  walk: footProfile('walk', 'A pie', walkFactor, true, 1.35),
  run: footProfile('run', 'Corriendo', runFactor, true, 2.8),
  hike: footProfile('hike', 'Senderismo', hikeFactor, true, 1.1),
  bike,
};

/** El perfil de ruta de un deporte del catálogo, o `null` si no tiene movilidad (natación, pesas…). */
export function profileForSport(sportId: string): Profile | null {
  switch (sportId) {
    case 'walk':
      return PROFILES.walk;
    case 'run':
      return PROFILES.run;
    case 'hike':
      return PROFILES.hike;
    case 'cycle':
    case 'bicimad':
      return PROFILES.bike;
    default:
      return null;
  }
}
