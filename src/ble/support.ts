import { u8 } from './bytes';

/**
 * Respuesta de `02 01` (SupportFunction): un mapa de bits (bit 7 de cada byte primero) en el que el
 * firmware declara lo que implementa. Es lo que distingue dos modelos que comparten protocolo.
 *
 * Solo se mapean los bits cuyo significado está fijado por un llamador real de la app oficial.
 * `minLength` replica las comprobaciones de longitud del SDK: un bitmap de 16 bytes tiene un byte 15
 * físico, pero el SDK no lo lee por debajo de 18, así que el anillo puede dejar basura ahí.
 */
export type Capability =
  | 'steps'
  | 'sleep'
  | 'heartRate'
  | 'bloodPressure'
  | 'spo2'
  | 'hrv'
  | 'temperature'
  | 'bloodSugar'
  | 'stress'
  | 'findDevice'
  | 'manualHeartRate'
  | 'manualBloodPressure'
  | 'manualSpo2'
  | 'manualHrv';

interface Bit {
  byte: number;
  bit: number;
  minLength: number;
  capability: Capability;
}

const BITS: readonly Bit[] = [
  { byte: 0, bit: 7, minLength: 14, capability: 'steps' },
  { byte: 0, bit: 6, minLength: 14, capability: 'sleep' },
  { byte: 0, bit: 3, minLength: 14, capability: 'heartRate' },
  { byte: 0, bit: 0, minLength: 14, capability: 'bloodPressure' },
  { byte: 1, bit: 3, minLength: 14, capability: 'spo2' },
  { byte: 1, bit: 1, minLength: 14, capability: 'hrv' },
  { byte: 8, bit: 0, minLength: 14, capability: 'temperature' },
  { byte: 17, bit: 3, minLength: 18, capability: 'bloodSugar' },
  { byte: 22, bit: 6, minLength: 23, capability: 'stress' },
  { byte: 6, bit: 4, minLength: 14, capability: 'findDevice' },
  { byte: 15, bit: 1, minLength: 18, capability: 'manualHeartRate' },
  { byte: 15, bit: 2, minLength: 18, capability: 'manualBloodPressure' },
  { byte: 15, bit: 3, minLength: 18, capability: 'manualSpo2' },
  { byte: 23, bit: 0, minLength: 24, capability: 'manualHrv' },
];

/** Capacidades que el anillo declara. Una respuesta truncada produce el conjunto vacío: "sin opinión", no "no tengo". */
export function parseSupportFunction(payload: ArrayLike<number>): Set<Capability> {
  const out = new Set<Capability>();
  for (const b of BITS) {
    if (payload.length >= b.minLength && b.byte < payload.length && (u8(payload, b.byte) >> b.bit) & 1) {
      out.add(b.capability);
    }
  }
  return out;
}

/**
 * Funciones básicas que se dan por hechas en todo anillo de la familia YCBT aunque el bitmap no las marque.
 * El proyecto PulseLoop, que usa estos anillos a diario, no se fía del bitmap para ellas (solo para las opcionales:
 * temperatura, presión, HRV…): un bit mal puesto no debe dejar sin sueño o sin pulso a quien sí los tiene. Lo que un
 * anillo no implementa se descubre al pedírselo: contesta 0xFB/0xFC y esa petición queda descartada.
 */
export const BASELINE_CAPABILITIES: readonly Capability[] = ['steps', 'sleep', 'heartRate', 'spo2'];

export const withBaseline = (declared: ReadonlySet<Capability> = new Set()): Set<Capability> =>
  new Set<Capability>([...BASELINE_CAPABILITIES, ...declared]);
