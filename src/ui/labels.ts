import type { KcalMethod } from '../domain/workout';

export const KCAL_METHOD_LABEL: Record<KcalMethod, string> = {
  manual: 'introducidas por ti',
  'speed-met': 'según tu velocidad',
  hr: 'según tu pulso',
  met: 'valor medio del deporte',
};
