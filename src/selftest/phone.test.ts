import { beforeEach, describe, expect, it, vi } from 'vitest';

const device = vi.hoisted(() => ({ getInfo: vi.fn(), getBatteryInfo: vi.fn() }));
vi.mock('@capacitor/device', () => ({ Device: device }));

import { collectPhoneInfo } from './phone';

beforeEach(() => {
  device.getInfo.mockReset();
  device.getBatteryInfo.mockReset();
});

describe('collectPhoneInfo', () => {
  it('recoge el móvil (modelo, Android, WebView), la batería y la zona horaria', async () => {
    device.getInfo.mockResolvedValue({
      platform: 'android',
      manufacturer: 'Google',
      model: 'Pixel 8',
      osVersion: '15',
      androidSDKVersion: 35,
      webViewVersion: '130.0.6723.58',
      isVirtual: false,
      name: 'El móvil de Ana', // un nombre personal que NO debe ir al informe
      operatingSystem: 'android',
    });
    device.getBatteryInfo.mockResolvedValue({ batteryLevel: 0.4231, isCharging: true });

    const info = await collectPhoneInfo();
    expect(info.device).toEqual({ platform: 'android', manufacturer: 'Google', model: 'Pixel 8', osVersion: '15', androidSDKVersion: 35, webViewVersion: '130.0.6723.58', isVirtual: false });
    expect(JSON.stringify(info)).not.toContain('Ana');
    expect(info.phoneBattery).toEqual({ percent: 42, charging: true });
    expect(info.timezone).toBe('Europe/Madrid');
    expect(typeof info.timezoneOffsetMin).toBe('number');
  });

  it('lo que no se puede leer falta, pero nada lanza', async () => {
    device.getInfo.mockRejectedValue(new Error('Device no disponible'));
    device.getBatteryInfo.mockRejectedValue(new Error('sin batería'));
    const info = await collectPhoneInfo();
    expect(info.deviceError).toBe('Device no disponible');
    expect(info.device).toBeUndefined();
    expect(info.phoneBattery).toBeUndefined();
    expect(info.timezone).toBeDefined();
  });

  it('una batería sin nivel se apunta como desconocida, no como 0 %', async () => {
    device.getInfo.mockResolvedValue({ platform: 'web' });
    device.getBatteryInfo.mockResolvedValue({ isCharging: false });
    expect((await collectPhoneInfo()).phoneBattery).toEqual({ percent: null, charging: false });
  });
});
