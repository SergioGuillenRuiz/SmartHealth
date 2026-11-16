import { MAX_DISH_PHOTO_CHARS, PHOTO_PREFIX } from '../domain/dishes';
import { AVATAR_SIDE, isAvatar } from '../domain/social-profile';
import { sharpnessOf } from './label-image';

// La foto de un plato: se abre la cámara trasera en un `<video>` (la misma que usa el escáner de códigos: el permiso ya está en la app y no hace falta código nativo), se captura un
// fotograma y se reduce a un JPEG pequeño en texto (`data:`), que viaja dentro del plato (la política de contenido ya admite imágenes `data:`). La foto no sale del móvil.

/** El lado más largo de la foto guardada (px) y la calidad del JPEG: una foto reconocible en una tarjeta pequeña, de unos 25–45 KB. */
export const PHOTO_MAX_SIDE = 480;
const PHOTO_QUALITY_STEPS = [0.72, 0.6, 0.5, 0.4] as const;

/** Cuántos fotogramas seguidos se miran al capturar una etiqueta y cada cuánto (ms): se queda el más nítido. */
const BURST_FRAMES = 5;
const BURST_GAP_MS = 90;
/** La foto del propio móvil: el ancho que se pide (px), el lado más largo al que se deja para leerla y lo que se espera a que la dé (ms) antes de usar un fotograma. */
const STILL_WIDTH = 3200;
export const STILL_MAX_SIDE = 2600;
const STILL_TIMEOUT_MS = 5000;

export type PhotoFailure = 'denied' | 'no-camera' | 'unsupported' | 'failed';

export function describePhotoFailure(failure: PhotoFailure): string {
  switch (failure) {
    case 'denied':
      return 'No hay permiso para usar la cámara. Actívalo en los ajustes de Android; el plato se puede guardar sin foto.';
    case 'no-camera':
      return 'Este móvil no tiene una cámara que se pueda usar. El plato se puede guardar sin foto.';
    case 'unsupported':
      return 'La cámara no está disponible aquí. El plato se puede guardar sin foto.';
    default:
      return 'No se pudo abrir la cámara. El plato se puede guardar sin foto.';
  }
}

export class PhotoError extends Error {
  constructor(readonly failure: PhotoFailure) {
    super(describePhotoFailure(failure));
    this.name = 'PhotoError';
  }
}

export interface CameraHandle {
  /** Para la cámara. Se puede llamar varias veces. */
  stop(): void;
  /** Captura lo que enseña el visor ahora mismo (el mismo recorte) como un JPEG en texto, o `null` si aún no hay imagen. */
  capture(): string | null;
  /** Captura lo que enseña el visor a su tamaño real (sin reducir), para leerlo con el OCR; `null` si aún no hay imagen. */
  captureFull(): Promise<Blob | null>;
}

export interface CameraOptions {
  /** Pide la resolución más alta que dé la cámara (hasta 1080p): para leer letra pequeña, como la de una etiqueta. */
  hiRes?: boolean;
}

/** El tamaño al que se reduce una imagen de `width` × `height` para que su lado más largo no pase de `maxSide` (nunca se agranda). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * La parte del fotograma que el visor enseña de verdad. El `<video>` se pinta con `object-fit: cover` en un marco de otra forma (4:3), así que la imagen que ve la persona es un recorte del
 * centro del fotograma; la foto tiene que ser ese mismo recorte (antes se guardaba el fotograma entero: más ancho que el visor y con otro encuadre). Sin medidas del marco (oculto, o sin
 * diseño en las pruebas), el fotograma entero.
 */
export function coverCrop(videoWidth: number, videoHeight: number, boxWidth: number, boxHeight: number): { sx: number; sy: number; sw: number; sh: number } {
  const whole = { sx: 0, sy: 0, sw: videoWidth, sh: videoHeight };
  if (!(videoWidth > 0 && videoHeight > 0 && boxWidth > 0 && boxHeight > 0)) return whole;
  const videoRatio = videoWidth / videoHeight;
  const boxRatio = boxWidth / boxHeight;
  if (Math.abs(videoRatio - boxRatio) < 0.005) return whole;
  if (videoRatio > boxRatio) {
    // El fotograma es más ancho que el marco: se recortan los lados.
    const sw = Math.max(1, Math.round(videoHeight * boxRatio));
    return { sx: Math.floor((videoWidth - sw) / 2), sy: 0, sw, sh: videoHeight };
  }
  // Más alto que el marco: se recortan arriba y abajo.
  const sh = Math.max(1, Math.round(videoWidth / boxRatio));
  return { sx: 0, sy: Math.floor((videoHeight - sh) / 2), sw: videoWidth, sh };
}

/** Abre la cámara trasera en `video`. Lanza `PhotoError` si no se puede. */
export async function openCamera(video: HTMLVideoElement, options: CameraOptions = {}): Promise<CameraHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new PhotoError('unsupported');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: options.hiRes === true ? 1920 : 1280 },
        height: { ideal: options.hiRes === true ? 1080 : 720 },
        // Para leer una etiqueta de cerca hace falta enfoque continuo; si la cámara no lo da, se ignora.
        ...(options.hiRes === true ? { advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] } : {}),
      },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new PhotoError('denied');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new PhotoError('no-camera');
    throw new PhotoError('failed');
  }
  const stop = (): void => {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  try {
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    await video.play();
  } catch {
    stop();
    throw new PhotoError('failed');
  }
  const capture = (): string | null => {
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    const { sx, sy, sw, sh } = coverCrop(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight);
    const { width, height } = fitWithin(sw, sh, PHOTO_MAX_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
    // Si por algún motivo pesa de más (una escena muy detallada), se baja la calidad hasta que quepa.
    for (const quality of PHOTO_QUALITY_STEPS) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.startsWith(PHOTO_PREFIX) && url.length <= MAX_DISH_PHOTO_CHARS) return url;
    }
    return null;
  };
  /** Un fotograma del visor, con el mismo recorte, como imagen sin comprimir y su nitidez. */
  const grabFrame = (): { canvas: HTMLCanvasElement; sharpness: number } | null => {
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    const { sx, sy, sw, sh } = coverCrop(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight);
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    // La nitidez se mide en una copia pequeña (rápido): lo que importa es comparar unos fotogramas con otros.
    const probe = document.createElement('canvas');
    const scale = Math.min(1, 480 / sw);
    probe.width = Math.max(8, Math.round(sw * scale));
    probe.height = Math.max(8, Math.round(sh * scale));
    const probeContext = probe.getContext('2d', { willReadFrequently: true });
    if (!probeContext) return { canvas, sharpness: 0 };
    probeContext.drawImage(canvas, 0, 0, probe.width, probe.height);
    return { canvas, sharpness: sharpnessOf(probeContext.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height) };
  };
  const toBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92));
  /** El mejor (el menos borroso) de unos cuantos fotogramas seguidos: con el móvil en la mano casi todos salen algo movidos. */
  const captureSharpestFrame = async (): Promise<Blob | null> => {
    let best: { canvas: HTMLCanvasElement; sharpness: number } | null = null;
    for (let i = 0; i < BURST_FRAMES; i++) {
      const frame = grabFrame();
      if (frame !== null && (best === null || frame.sharpness > best.sharpness)) best = frame;
      if (i < BURST_FRAMES - 1) await new Promise((resolve) => setTimeout(resolve, BURST_GAP_MS));
    }
    return best === null ? null : toBlob(best.canvas);
  };
  // La foto del propio móvil (con su enfoque, su exposición y toda su resolución) lee la letra pequeña de una etiqueta mucho mejor que un fotograma de vídeo de 1080p. No todos los
  // WebView la dan: si no hay `ImageCapture`, o falla o tarda, se usa el mejor de varios fotogramas.
  const track = stream.getVideoTracks()[0];
  const imageCapture: ImageCapture | null = options.hiRes === true && typeof ImageCapture !== 'undefined' && track !== undefined ? new ImageCapture(track) : null;
  const captureStill = async (): Promise<Blob | null> => {
    if (imageCapture === null) return null;
    try {
      const capabilities = await imageCapture.getPhotoCapabilities().catch(() => null);
      const range = capabilities?.imageWidth;
      const settings: PhotoSettings = range?.max !== undefined && range.max > 0 ? { imageWidth: Math.max(range.min ?? 0, Math.min(STILL_WIDTH, range.max)) } : {};
      const still = await Promise.race([imageCapture.takePhoto(settings), new Promise<null>((resolve) => setTimeout(() => resolve(null), STILL_TIMEOUT_MS))]);
      if (still === null || still.size === 0) return null;
      const bitmap = await createImageBitmap(still);
      // El mismo recorte que enseña el visor (el visor es un marco de otra forma que la foto) y, si es enorme, reducida a lo que el lector admite.
      const { sx, sy, sw, sh } = coverCrop(bitmap.width, bitmap.height, video.clientWidth, video.clientHeight);
      const { width, height } = fitWithin(sw, sh, STILL_MAX_SIDE);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
      bitmap.close();
      return await toBlob(canvas);
    } catch {
      return null;
    }
  };
  const captureFull = async (): Promise<Blob | null> => (await captureStill()) ?? (await captureSharpestFrame());
  return { stop, capture, captureFull };
}

/** El cuadrado central de una imagen de `width` × `height` (el recorte de la foto de perfil). */
export function centerSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.max(1, Math.min(width, height));
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/** Lo más que se acepta de una imagen elegida de la galería. */
export const MAX_PICKED_IMAGE_BYTES = 40 * 1024 * 1024;

const AVATAR_QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4] as const;

/**
 * La foto de perfil a partir de una imagen elegida o hecha con la cámara: el cuadrado central reducido a 256 × 256 y guardado como un JPEG pequeño en texto (`data:`).
 * Lanza `PhotoError('failed')` si el archivo no es una imagen que el WebView sepa leer.
 */
export async function avatarFromBlob(blob: Blob): Promise<string> {
  if (typeof createImageBitmap !== 'function') throw new PhotoError('unsupported');
  // Una «foto» de decenas de MB no es una foto de perfil: se rechaza antes de pedirle al WebView que la decodifique entera.
  if (blob.size > MAX_PICKED_IMAGE_BYTES) throw new PhotoError('failed');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new PhotoError('failed');
  }
  try {
    const { sx, sy, side } = centerSquare(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const context = canvas.getContext('2d');
    if (!context) throw new PhotoError('failed');
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    for (const quality of AVATAR_QUALITY_STEPS) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (isAvatar(url)) return url;
    }
    throw new PhotoError('failed');
  } finally {
    bitmap.close();
  }
}
