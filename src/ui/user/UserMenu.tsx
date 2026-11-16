import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { refreshProducts } from '../../app/actions';
import { lastSync, nowMs, profileHistory, savedProducts, settings, socialProfile, userMenuOpen, userSection, type UserSection } from '../../app/state';
import { backupOverdue } from '../../domain/backup-reminder';
import { dayKeyOf } from '../../domain/dates';
import { HEALTH_GOALS } from '../../domain/nutrition';
import { ageAt, profileAt } from '../../domain/profile';
import { handleOf } from '../../domain/social-profile';
import { Avatar } from '../avatar';
import { fmt1, fmtAgo, fmtInt, fmtUpTo1, NBSP } from '../format';
import { Icon } from '../icons';
import { Sheet } from '../Sheet';
import { BackupSection } from './BackupSection';
import { GoalsSection, ProfileSection } from './ProfileSection';
import { ProductsSection } from './ProductsSection';
import { SocialSection } from './SocialSection';

interface Row {
  section: UserSection;
  icon: string;
  color: string;
  title: string;
  /** Lo más útil de ese apartado, para no tener que abrirlo. */
  summary: string;
  /** Pide atención (p. ej. falta la copia de seguridad). */
  warn?: boolean;
}

/**
 * El menú de la persona (el botón de usuario, arriba a la izquierda): su perfil con sus datos personales (foto, nombre, altura, peso…) en una sola tarjeta, los objetivos y la
 * medición, los productos que ha enseñado a la app y los datos guardados con sus copias de seguridad. Cada apartado se abre encima del menú, así «atrás» vuelve a él.
 */
export function UserMenuSheet(): JSX.Element {
  const open = userMenuOpen.value;
  const section = userSection.value;
  const close = (): void => {
    userSection.value = null;
  };
  return (
    <>
      <Sheet open={open} onClose={() => (userMenuOpen.value = false)} title="Mi perfil">
        {open && <Menu />}
      </Sheet>
      <Sheet open={section === 'profile'} onClose={close} title="Perfil y datos">
        {section === 'profile' && (
          <>
            <SocialSection />
            <h3 class="profile-data__title">Datos personales</h3>
            <ProfileSection />
          </>
        )}
      </Sheet>
      <Sheet open={section === 'goals'} onClose={close} title="Objetivos y medición">
        {section === 'goals' && <GoalsSection />}
      </Sheet>
      <Sheet open={section === 'products'} onClose={close} title="Mis productos">
        {section === 'products' && <ProductsSection />}
      </Sheet>
      <Sheet open={section === 'backup'} onClose={close} title="Datos y copias de seguridad">
        {section === 'backup' && <BackupSection />}
      </Sheet>
    </>
  );
}

function Menu(): JSX.Element {
  const cfg = settings.value;
  const productCount = savedProducts.value?.length ?? null;
  // El resumen de «Mis productos» necesita saber cuántos hay: se leen al abrir el menú.
  useEffect(() => {
    void refreshProducts();
  }, []);
  const rows: Row[] = [
    {
      section: 'goals',
      icon: 'Target',
      color: 'var(--brand)',
      title: 'Objetivos y medición',
      summary: `${fmtInt(cfg.stepGoal)} pasos · ${fmt1(cfg.sleepGoalH)} h de sueño · ${HEALTH_GOALS[cfg.healthGoal].label}${cfg.targetWeightKg !== null ? ` · ${fmtUpTo1(cfg.targetWeightKg)}${NBSP}kg` : ''}`,
    },
    {
      section: 'products',
      icon: 'ScanBarcode',
      color: 'var(--kcal)',
      title: 'Mis productos',
      summary: productCount === null ? 'Los que le has enseñado con su etiqueta' : productCount === 0 ? 'Ninguno todavía' : `${fmtInt(productCount)} ${productCount === 1 ? 'producto' : 'productos'}`,
    },
    {
      section: 'backup',
      icon: 'database',
      color: 'var(--distance)',
      title: 'Datos y copias de seguridad',
      summary: cfg.lastBackupMs === null ? 'Aún no has exportado ninguna copia' : `Última copia ${fmtAgo(cfg.lastBackupMs, nowMs.value)}`,
      warn: backupOverdue(cfg.lastBackupMs, nowMs.value) && lastSync.value !== null,
    },
  ];
  return (
    <>
      <ProfileCard />
      <ul class="menu">
        {rows.map((row) => (
          <li key={row.section}>
            <button type="button" class="menu-row" onClick={() => (userSection.value = row.section)}>
              <span class="menu-row__icon" style={{ color: row.color }}>
                <Icon name={row.icon} size={20} />
              </span>
              <span class="menu-row__main">
                <strong>{row.title}</strong>
                <small class={row.warn ? 'is-warn' : undefined}>{row.summary}</small>
              </span>
              <Icon name="ChevronRight" size={18} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Quién eres, arriba del menú: la foto, el nombre de usuario, el estado y, debajo, tus datos personales (altura, peso, edad). Un toque abre «Perfil y datos», donde van juntos el perfil
 * (foto, nombre, estado) y los datos personales.
 */
function ProfileCard(): JSX.Element {
  const profile = socialProfile.value;
  const today = dayKeyOf(nowMs.value);
  const current = profileAt(profileHistory.value, today);
  const handle = profile !== null ? handleOf(profile) : null;
  const data = current ? `${fmtUpTo1(current.heightCm)} cm · ${fmtUpTo1(current.weightKg)} kg · ${ageAt(current.birthDate, today)} años` : 'Completa tus datos personales';
  return (
    <button type="button" class="profile-card" onClick={() => (userSection.value = 'profile')}>
      <Avatar profile={profile ?? { username: '' }} size={56} />
      <span class="profile-card__main">
        <strong>{profile === null ? 'Tu perfil' : handle !== null ? `@${profile.username}` : 'Elige tu nombre de usuario'}</strong>
        <small>{profile !== null && profile.status !== '' ? profile.status : handle !== null && profile !== null ? `#${profile.uid.slice(0, 4)} · Añade un estado` : 'Con foto y un estado'}</small>
        <small class="profile-card__data">{data}</small>
      </span>
      <Icon name="ChevronRight" size={18} />
    </button>
  );
}
