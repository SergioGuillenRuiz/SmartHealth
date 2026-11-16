import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isNative: vi.fn(() => true), saveToDownloads: vi.fn() }));
vi.mock('./native', () => ({ isNative: mocks.isNative, NativeTools: { saveToDownloads: mocks.saveToDownloads } }));

import { saveTextFile } from './files';

beforeEach(() => {
  mocks.isNative.mockReturnValue(true);
  mocks.saveToDownloads.mockReset();
});

describe('saveTextFile en la app de Android', () => {
  it('guarda en Descargas con el plugin propio y devuelve dónde ha quedado (no hace una descarga que el WebView ignoraría)', async () => {
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/21', location: 'Download/smarthealth-copia-2026-10-13.json' });
    const saved = await saveTextFile('smarthealth-copia-2026-10-13.json', '{"format":"smartring-backup"}', 'application/json');
    expect(mocks.saveToDownloads).toHaveBeenCalledWith({ filename: 'smarthealth-copia-2026-10-13.json', text: '{"format":"smartring-backup"}', mime: 'application/json' });
    expect(saved).toEqual({ uri: 'content://media/external/downloads/21', location: 'Download/smarthealth-copia-2026-10-13.json' });
  });

  it('si Android no deja guardar, el error llega a quien exporta: no se da por hecha una copia que no existe', async () => {
    mocks.saveToDownloads.mockRejectedValueOnce(new Error('Esta versión de Android no permite guardar en Descargas sin permisos.'));
    await expect(saveTextFile('x.json', '{}', 'application/json')).rejects.toThrow('no permite guardar');
  });
});

describe('saveTextFile en el navegador', () => {
  const anchor = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() };
  const globals = globalThis as unknown as { document?: unknown };

  beforeEach(() => {
    mocks.isNative.mockReturnValue(false);
    anchor.click.mockReset();
    anchor.remove.mockReset();
    globals.document = { createElement: vi.fn(() => anchor), body: { append: vi.fn() } };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:copia');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete globals.document;
    vi.restoreAllMocks();
  });

  it('descarga el fichero con su nombre y no usa el plugin nativo', async () => {
    const saved = await saveTextFile('smarthealth-copia-2026-10-13.json', '{}', 'application/json');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe('smarthealth-copia-2026-10-13.json');
    expect(anchor.href).toBe('blob:copia');
    expect(saved).toEqual({ uri: null, location: 'Descargas del navegador/smarthealth-copia-2026-10-13.json' });
    expect(mocks.saveToDownloads).not.toHaveBeenCalled();
  });
});
