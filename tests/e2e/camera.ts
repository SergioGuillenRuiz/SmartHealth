import { fileURLToPath } from 'node:url';

/** El código que ve la cámara falsa de las pruebas (un EAN-13 válido) y el fichero Y4M donde se dibuja. */
export const FAKE_CAMERA_BARCODE = '8410000000016';
export const FAKE_CAMERA_FILE = fileURLToPath(new URL('./.camera/codigo.y4m', import.meta.url));
