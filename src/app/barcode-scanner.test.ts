import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeScannerFailure, ScannerError, startScanner } from './barcode-scanner';

describe('describeScannerFailure', () => {
  it('cada fallo se explica en español y dice qué hacer (teclear el código)', () => {
    expect(describeScannerFailure('denied')).toMatch(/No hay permiso para usar la cámara/);
    expect(describeScannerFailure('no-camera')).toMatch(/no tiene una cámara/);
    expect(describeScannerFailure('unsupported')).toMatch(/no está disponible/);
    expect(describeScannerFailure('failed')).toMatch(/No se pudo abrir la cámara/);
    for (const failure of ['denied', 'no-camera', 'unsupported', 'failed'] as const) expect(describeScannerFailure(failure)).toMatch(/Teclea el código|teclea el código/);
  });

  it('ScannerError lleva el motivo y el mensaje', () => {
    const error = new ScannerError('denied');
    expect(error.failure).toBe('denied');
    expect(error.message).toBe(describeScannerFailure('denied'));
    expect(error).toBeInstanceOf(Error);
  });
});

describe('startScanner: no se abre la cámara y por qué', () => {
  afterEach(() => vi.unstubAllGlobals());
  const video = {} as HTMLVideoElement;

  const denyWith = (name: string): void => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(Object.assign(new DOMException('x', name))) } });
  };

  it('sin la API de cámara', async () => {
    vi.stubGlobal('navigator', {});
    await expect(startScanner(video, () => undefined)).rejects.toMatchObject({ failure: 'unsupported' });
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no-camera'],
    ['OverconstrainedError', 'no-camera'],
    ['AbortError', 'failed'],
    ['NotReadableError', 'failed'],
  ] as const)('el error %s del navegador es «%s»', async (name, failure) => {
    denyWith(name);
    await expect(startScanner(video, () => undefined)).rejects.toMatchObject({ failure });
  });
});
