import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isNative: vi.fn(() => true), saveToDownloads: vi.fn(), share: vi.fn() }));
vi.mock('../app/native', () => ({ isNative: mocks.isNative, NativeTools: { saveToDownloads: mocks.saveToDownloads, share: mocks.share } }));

import { createReportSaver } from './save';

beforeEach(() => {
  mocks.isNative.mockReturnValue(true);
  mocks.saveToDownloads.mockReset();
  mocks.share.mockReset();
});

describe('guardar el informe en Android', () => {
  it('el primer guardado crea el fichero y los siguientes lo reescriben (por su dirección)', async () => {
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/7', location: 'Download/SmartHealth-prueba-x.txt' });
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/7', location: 'Download/SmartHealth-prueba-x.txt' });
    const saver = createReportSaver('SmartHealth-prueba-x.txt');

    const first = await saver.save('uno', { final: false });
    expect(mocks.saveToDownloads).toHaveBeenNthCalledWith(1, { filename: 'SmartHealth-prueba-x.txt', text: 'uno', mime: 'text/plain' });
    expect(first).toEqual({ uri: 'content://media/external/downloads/7', location: 'Download/SmartHealth-prueba-x.txt' });

    await saver.save('dos', { final: true });
    expect(mocks.saveToDownloads).toHaveBeenNthCalledWith(2, { filename: 'SmartHealth-prueba-x.txt', text: 'dos', mime: 'text/plain', uri: 'content://media/external/downloads/7' });
  });

  it('si el sistema renombra el fichero («(1)»), los guardados siguientes usan la nueva dirección', async () => {
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/8', location: 'Download/SmartHealth-prueba-x (1).txt' });
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/9', location: 'Download/SmartHealth-prueba-x (2).txt' }); // el anterior ya no existía
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/9', location: 'Download/SmartHealth-prueba-x (2).txt' });
    const saver = createReportSaver('SmartHealth-prueba-x.txt');
    await saver.save('a', { final: false });
    await saver.save('b', { final: false });
    await saver.save('c', { final: true });
    expect(mocks.saveToDownloads.mock.calls[1]?.[0]).toMatchObject({ uri: 'content://media/external/downloads/8' });
    expect(mocks.saveToDownloads.mock.calls[2]?.[0]).toMatchObject({ uri: 'content://media/external/downloads/9' });
  });

  it('si Android no deja guardar, el error llega a quien guarda', async () => {
    mocks.saveToDownloads.mockRejectedValueOnce(new Error('Esta versión de Android no permite guardar en Descargas sin permisos.'));
    await expect(createReportSaver('x.txt').save('texto', { final: true })).rejects.toThrow('no permite guardar');
  });

  it('si el guardado final falla y solo queda un parcial, se comparte el texto entero (no el fichero a medias)', async () => {
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/7', location: 'Download/x.txt' });
    mocks.saveToDownloads.mockRejectedValueOnce(new Error('Sin espacio'));
    const saver = createReportSaver('x.txt');
    await saver.save('parcial', { final: false });
    await expect(saver.save('completo', { final: true })).rejects.toThrow('Sin espacio');
    await saver.share('el informe entero');
    expect(mocks.share).toHaveBeenLastCalledWith({ title: 'Informe de la prueba de SmartHealth', mime: 'text/plain', text: 'el informe entero' });
  });

  it('compartir usa el fichero guardado y, si aún no hay, el texto', async () => {
    mocks.saveToDownloads.mockResolvedValueOnce({ uri: 'content://media/external/downloads/7', location: 'Download/x.txt' });
    const saver = createReportSaver('x.txt');
    expect(saver.canShare()).toBe(true);

    await saver.share('el texto');
    expect(mocks.share).toHaveBeenLastCalledWith({ title: 'Informe de la prueba de SmartHealth', mime: 'text/plain', text: 'el texto' });

    await saver.save('contenido', { final: true });
    await saver.share('el texto');
    expect(mocks.share).toHaveBeenLastCalledWith({ title: 'Informe de la prueba de SmartHealth', mime: 'text/plain', uri: 'content://media/external/downloads/7' });
  });
});

describe('guardar el informe en el navegador', () => {
  const anchor = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() };
  const globals = globalThis as unknown as { document?: unknown };

  beforeEach(() => {
    mocks.isNative.mockReturnValue(false);
    anchor.click.mockReset();
    anchor.remove.mockReset();
    globals.document = { createElement: vi.fn(() => anchor), body: { append: vi.fn() } };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:informe');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete globals.document;
    vi.restoreAllMocks();
  });

  it('a mitad de la prueba no descarga nada; al final, una descarga con el nombre del informe', async () => {
    const saver = createReportSaver('SmartHealth-prueba-x.txt');
    expect(await saver.save('parcial', { final: false })).toBeNull();
    expect(anchor.click).not.toHaveBeenCalled();

    const saved = await saver.save('completo', { final: true });
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe('SmartHealth-prueba-x.txt');
    expect(anchor.href).toBe('blob:informe');
    expect(saved).toEqual({ uri: null, location: 'Descargas del navegador/SmartHealth-prueba-x.txt' });
    expect(mocks.saveToDownloads).not.toHaveBeenCalled();
  });

  it('solo se ofrece compartir si el navegador lo permite', () => {
    const saver = createReportSaver('x.txt');
    const nav = globalThis.navigator as unknown as { share?: unknown };
    const had = 'share' in nav;
    expect(saver.canShare()).toBe(had && typeof nav.share === 'function');
  });
});
