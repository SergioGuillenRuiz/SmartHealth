import { editSocialProfile, type SocialEdit, type SocialEditResult } from '../domain/social-profile';
import { reloadAll } from './actions';
import { svc } from './services';
import { socialProfile } from './state';

// El perfil de cara a los demás: se crea una sola vez al abrir la app (con su identificador único; ver `reloadAll`) y se edita desde el menú de perfil. Ver `domain/social-profile.ts`.

/** Guarda una edición del perfil. Si no vale (nombre con caracteres raros, estado larguísimo, foto que no es una imagen) devuelve por qué, sin guardar nada. */
export async function saveSocial(edit: SocialEdit): Promise<SocialEditResult> {
  if (socialProfile.peek() === null) await reloadAll();
  const current = socialProfile.peek();
  if (current === null) return { ok: false, field: 'username', error: 'No se pudo crear tu perfil en este dispositivo.' };
  const result = editSocialProfile(current, edit, svc().now());
  if (!result.ok || result.profile === current) return result;
  try {
    await svc().store.setSocial(result.profile);
  } catch (error) {
    return { ok: false, field: 'username', error: `No se pudo guardar${error instanceof Error && error.message ? `: ${error.message}` : ''}.` };
  }
  socialProfile.value = result.profile;
  return result;
}
