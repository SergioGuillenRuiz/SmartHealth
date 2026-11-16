import { Device } from '@capacitor/device';

/**
 * Datos del móvil para el informe: modelo y versión de Android (de ellos dependen los permisos de Bluetooth), versión del
 * WebView, batería del móvil, zona horaria y pantalla. Nunca falla: lo que no se pueda leer, falta.
 */
export async function collectPhoneInfo(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const info = await Device.getInfo();
    out.device = {
      platform: info.platform,
      manufacturer: info.manufacturer,
      model: info.model,
      osVersion: info.osVersion,
      androidSDKVersion: info.androidSDKVersion,
      webViewVersion: info.webViewVersion,
      isVirtual: info.isVirtual,
    };
  } catch (error) {
    out.deviceError = error instanceof Error ? error.message : String(error);
  }
  try {
    const battery = await Device.getBatteryInfo();
    out.phoneBattery = { percent: battery.batteryLevel === undefined ? null : Math.round(battery.batteryLevel * 100), charging: battery.isCharging ?? null };
  } catch {
    /* algunos WebView no lo dan */
  }
  const nav = typeof navigator === 'undefined' ? null : navigator;
  out.userAgent = nav?.userAgent ?? null;
  out.language = nav?.language ?? null;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.timezoneOffsetMin = new Date().getTimezoneOffset();
  if (typeof screen !== 'undefined' && typeof window !== 'undefined') out.screen = `${screen.width}x${screen.height} @${window.devicePixelRatio}`;
  return out;
}
