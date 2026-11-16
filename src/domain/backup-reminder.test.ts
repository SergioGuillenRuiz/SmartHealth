import { describe, expect, it } from 'vitest';
import { backupOverdue, BACKUP_REMINDER_DAYS } from './backup-reminder';
import { DAY_MS } from './dates';

const NOW = new Date(2026, 9, 13, 12).getTime();

describe('backupOverdue', () => {
  it('sin ninguna copia, toca recordarla', () => {
    expect(backupOverdue(null, NOW)).toBe(true);
  });

  it('una copia reciente no se recuerda; pasados los 30 días, sí', () => {
    expect(backupOverdue(NOW - DAY_MS, NOW)).toBe(false);
    expect(backupOverdue(NOW - BACKUP_REMINDER_DAYS * DAY_MS, NOW)).toBe(false); // justo 30 días: aún no
    expect(backupOverdue(NOW - BACKUP_REMINDER_DAYS * DAY_MS - 1, NOW)).toBe(true);
  });
});
