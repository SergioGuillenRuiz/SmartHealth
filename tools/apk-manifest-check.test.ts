import { describe, expect, it } from 'vitest';
import { applicationAttribute, forbiddenPermissions, manifestProblems, parseComponents } from './apk-manifest-check';

// Salida de `aapt2 dump xmltree` (recortada) de un manifiesto unido: la actividad principal exportada, el servicio y el proveedor propios cerrados y, como en cualquier app con AndroidX, el receptor del
// instalador de perfiles: exportado, pero protegido con el permiso DUMP.
const GOOD = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: package="app.smartring" (Raw: "app.smartring")
    E: application (line=6)
      A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false
      A: http://schemas.android.com/apk/res/android:usesCleartextTraffic(0x010104ec)=false
      A: http://schemas.android.com/apk/res/android:networkSecurityConfig(0x01010527)=@xml/network_security_config
      E: activity (line=15)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="app.smartring.MainActivity" (Raw: "app.smartring.MainActivity")
        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
        E: intent-filter (line=22)
          E: action (line=23)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
      E: service (line=36)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="app.smartring.TrackingService" (Raw: "app.smartring.TrackingService")
        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=false
      E: provider (line=41)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="androidx.core.content.FileProvider" (Raw: "androidx.core.content.FileProvider")
        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=false
      E: receiver (line=60)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="androidx.profileinstaller.ProfileInstallReceiver" (Raw: "androidx.profileinstaller.ProfileInstallReceiver")
        A: http://schemas.android.com/apk/res/android:permission(0x01010006)="android.permission.DUMP" (Raw: "android.permission.DUMP")
        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
`;

describe('comprobaciones del manifiesto del APK', () => {
  it('lee los componentes con su nombre, si están exportados y el permiso que los protege', () => {
    const components = parseComponents(GOOD);
    expect(components.map((c) => c.kind)).toEqual(['activity', 'service', 'provider', 'receiver']);
    expect(components[0]).toMatchObject({ name: 'app.smartring.MainActivity', exported: true, permission: null });
    expect(components[3]).toMatchObject({ exported: true, permission: 'android.permission.DUMP' });
  });

  it('un manifiesto como el de la app no da ningún problema', () => {
    expect(manifestProblems(GOOD)).toEqual([]);
  });

  it('lee también el formato antiguo, de aapt, con los booleanos como número', () => {
    const old = GOOD.replaceAll('=true', '=(type 0x12)0xffffffff').replaceAll('=false', '=(type 0x12)0x0');
    expect(manifestProblems(old)).toEqual([]);
    expect(applicationAttribute(old, 'usesCleartextTraffic')).toBe('(type 0x12)0x0');
  });

  it('un servicio exportado sin permiso es un problema, y un componente sin «exported» también', () => {
    const open = GOOD.replace('TrackingService" (Raw: "app.smartring.TrackingService")\n        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=false', 'TrackingService" (Raw: "app.smartring.TrackingService")\n        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true');
    expect(manifestProblems(open).join('\n')).toContain('TrackingService');
    const implicit = GOOD.replace('\n        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=false\n      E: provider', '\n      E: provider');
    expect(manifestProblems(implicit).join('\n')).toContain('TrackingService');
  });

  it('exige no admitir tráfico sin cifrar, ni copias por adb, ni apps depurables', () => {
    expect(manifestProblems(GOOD.replace('usesCleartextTraffic(0x010104ec)=false', 'usesCleartextTraffic(0x010104ec)=true')).join('\n')).toContain('usesCleartextTraffic');
    expect(manifestProblems(GOOD.replace(/ *A: [^\n]*usesCleartextTraffic[^\n]*\n/, '')).join('\n')).toContain('usesCleartextTraffic');
    expect(manifestProblems(GOOD.replace('allowBackup(0x01010280)=false', 'allowBackup(0x01010280)=true')).join('\n')).toContain('allowBackup');
    expect(manifestProblems(GOOD.replace(/ *A: [^\n]*networkSecurityConfig[^\n]*\n/, '')).join('\n')).toContain('networkSecurityConfig');
    expect(manifestProblems(GOOD.replace('      E: activity', '      A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true\n      E: activity')).join('\n')).toContain('depurable');
  });

  it('si la salida no se lee como se espera, no se da nada por bueno', () => {
    expect(manifestProblems('')).toHaveLength(1);
    expect(manifestProblems(GOOD.replaceAll('MainActivity', 'Otra'))).toHaveLength(1);
  });

  it('señala los permisos prohibidos', () => {
    const dump = "package: app.smartring\nuses-permission: name='android.permission.INTERNET'\nuses-permission: name='android.permission.READ_EXTERNAL_STORAGE'\nuses-permission: name='android.permission.RECORD_AUDIO'\n";
    expect(forbiddenPermissions(dump)).toEqual(['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.RECORD_AUDIO']);
    expect(forbiddenPermissions("uses-permission: name='android.permission.CAMERA'")).toEqual([]);
  });
});
