import type { JSX } from 'preact';
import { initialOf, type SocialProfile } from '../domain/social-profile';
import { Icon } from './icons';

/** La foto de perfil en un círculo; sin foto, la inicial del nombre de usuario o, si aún no hay, la silueta de siempre. Decorativa: el nombre ya va escrito al lado. */
export function Avatar({ profile, size }: { profile: Pick<SocialProfile, 'username' | 'photo'> | null; size: number }): JSX.Element {
  const photo = profile?.photo;
  const initial = profile === null ? null : initialOf(profile);
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }} aria-hidden="true">
      {photo !== undefined ? <img src={photo} alt="" width={size} height={size} draggable={false} /> : initial !== null ? initial : <Icon name="user" size={Math.round(size * 0.5)} />}
    </span>
  );
}
