import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ean13Y4m } from '../../tools/ean13';
import { FAKE_CAMERA_BARCODE, FAKE_CAMERA_FILE } from './camera';

/** Genera el «vídeo» de la cámara falsa: un código de barras quieto delante del objetivo (ver `tests/e2e/camera.ts`). */
export default function globalSetup(): void {
  mkdirSync(dirname(FAKE_CAMERA_FILE), { recursive: true });
  writeFileSync(FAKE_CAMERA_FILE, ean13Y4m(FAKE_CAMERA_BARCODE));
}
