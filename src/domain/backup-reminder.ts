import { DAY_MS } from './dates';

/** Pasados estos días sin exportar una copia de seguridad, se recuerda. */
export const BACKUP_REMINDER_DAYS = 30;

/** ¿Toca recordar la copia de seguridad? Nunca se ha exportado una, o la última tiene más de `BACKUP_REMINDER_DAYS` días. */
export function backupOverdue(lastBackupMs: number | null, nowMs: number): boolean {
  return lastBackupMs === null || nowMs - lastBackupMs > BACKUP_REMINDER_DAYS * DAY_MS;
}
