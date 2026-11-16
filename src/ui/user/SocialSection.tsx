import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { avatarFromBlob } from '../../app/photo-capture';
import { saveSocial } from '../../app/social';
import { showToast, socialProfile } from '../../app/state';
import { handleOf, MAX_STATUS, MAX_USERNAME, normalizeUsername, tagOf, usernameProblem } from '../../domain/social-profile';
import { Avatar } from '../avatar';
import { Icon } from '../icons';
import { Banner } from '../primitives';

/** La primera mitad de «Perfil y datos»: la foto, el nombre de usuario y un estado corto, lo que algún día verán otras personas. Nada de salud: ver `domain/social-profile.ts`. */
export function SocialSection(): JSX.Element {
  const profile = socialProfile.value;
  const [username, setUsername] = useState(profile?.username ?? '');
  const [status, setStatus] = useState(profile?.status ?? '');
  const [photo, setPhoto] = useState<string | null | undefined>(undefined); // undefined = sin tocar; null = quitada
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  if (profile === null) return <Banner tone="warn">No se pudo crear tu perfil en este dispositivo.</Banner>;

  const shownPhoto = photo === undefined ? profile.photo : (photo ?? undefined);
  const normalized = normalizeUsername(username);
  const usernameError = normalized === '' ? null : usernameProblem(normalized);
  const changed = normalized !== profile.username || status.trim() !== profile.status || photo !== undefined;
  const fullHandle = normalized === '' ? null : handleOf({ uid: profile.uid, username: normalized });

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setProblem(null);
    try {
      setPhoto(await avatarFromBlob(file));
    } catch {
      setProblem('No se pudo leer esa imagen. Prueba con otra foto.');
    } finally {
      if (gallery.current) gallery.current.value = '';
      if (camera.current) camera.current.value = '';
    }
  };

  const save = async (): Promise<void> => {
    if (usernameError !== null) return;
    setSaving(true);
    setProblem(null);
    const result = await saveSocial({ username, status, ...(photo !== undefined ? { photo } : {}) });
    setSaving(false);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    showToast('Perfil guardado');
    setPhoto(undefined);
  };

  return (
    <form
      class="social"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div class="social__photo">
        <Avatar profile={{ username: normalized, ...(shownPhoto !== undefined ? { photo: shownPhoto } : {}) }} size={96} />
        <div class="social__photo-actions">
          <button type="button" class="btn" onClick={() => gallery.current?.click()}>
            <Icon name="ImagePlus" size={18} />
            Elegir foto
          </button>
          <button type="button" class="btn" onClick={() => camera.current?.click()}>
            <Icon name="Camera" size={18} />
            Hacer foto
          </button>
          {shownPhoto !== undefined && (
            <button type="button" class="linkish" onClick={() => setPhoto(null)}>
              Quitar foto
            </button>
          )}
        </div>
        <input ref={gallery} type="file" accept="image/*" class="sr-only" tabIndex={-1} aria-label="Elegir una foto de la galería" onChange={(e) => void pick(e.currentTarget.files?.[0])} />
        <input ref={camera} type="file" accept="image/*" capture="user" class="sr-only" tabIndex={-1} aria-label="Hacer una foto con la cámara" onChange={(e) => void pick(e.currentTarget.files?.[0])} />
      </div>

      <div class="field">
        <label for="social-username">Nombre de usuario</label>
        <div class="social__handle">
          <span aria-hidden="true">@</span>
          <input
            id="social-username"
            class="input"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            maxLength={MAX_USERNAME + 1}
            placeholder="tu.nombre"
            value={username}
            aria-invalid={usernameError !== null}
            aria-describedby="social-username-hint"
            onInput={(e) => setUsername(e.currentTarget.value)}
          />
        </div>
        <p id="social-username-hint" class={`field__hint${usernameError !== null ? ' is-warn' : ''}`}>
          {usernameError ?? (fullHandle !== null ? `Tu identificador: ${fullHandle}. La etiqueta #${tagOf(profile.uid)} es solo tuya.` : 'Letras, números, punto y guion bajo. Lo verán las personas que añadas.')}
        </p>
      </div>

      <div class="field">
        <label for="social-status">Estado</label>
        <input id="social-status" class="input" autocomplete="off" maxLength={MAX_STATUS} placeholder="Una frase corta" value={status} onInput={(e) => setStatus(e.currentTarget.value)} />
        <p class="field__hint social__count">
          {status.length} / {MAX_STATUS}
        </p>
      </div>

      {problem !== null && <Banner tone="danger">{problem}</Banner>}
      <button type="submit" class="btn btn--primary btn--block" disabled={!changed || usernameError !== null || saving}>
        <Icon name="Check" size={18} />
        Guardar
      </button>
    </form>
  );
}
