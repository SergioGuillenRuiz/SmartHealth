import type { CapacitorConfig } from '@capacitor/cli';

// La app es la misma web (carpeta `dist`) dentro de un contenedor nativo de Android: así el Bluetooth no depende de
// Web Bluetooth (que un WebView no tiene) y no hace falta publicarla en ningún sitio ni tener internet para usarla.
const config: CapacitorConfig = {
  appId: 'app.smartring',
  appName: 'SmartHealth',
  webDir: 'dist',
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Buscando…',
        cancel: 'Cancelar',
        availableDevices: 'Dispositivos disponibles',
        noDeviceFound: 'No se ha encontrado ningún dispositivo',
      },
    },
  },
};

export default config;
