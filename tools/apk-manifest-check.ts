// Comprobaciones de seguridad del manifiesto de un APK (el ya unido con el de las librerías), a partir de la salida de `aapt2 dump xmltree --file AndroidManifest.xml`.
// El CI las pasa sobre el APK de release (`android.yml`); aquí solo hay lógica pura para poder probarla con texto de ejemplo.
// Uso: `aapt2 dump xmltree --file AndroidManifest.xml app-release.apk | node tools/apk-manifest-check.ts`

export interface Component {
  kind: string;
  name: string;
  exported: boolean | null;
  permission: string | null;
}

const KINDS = new Set(['activity', 'activity-alias', 'service', 'receiver', 'provider']);

/** Los componentes (actividades, servicios, receptores y proveedores) del manifiesto con lo que dicen de si se pueden llamar desde otra app. */
export function parseComponents(xmltree: string): Component[] {
  const components: Component[] = [];
  let current: { component: Component; indent: number } | null = null;
  for (const line of xmltree.split(/\r?\n/)) {
    const element = /^(\s*)E: ([\w.-]+)/.exec(line);
    if (element) {
      const indent = element[1]!.length;
      if (current && indent <= current.indent) current = null;
      if (KINDS.has(element[2]!)) {
        current = { component: { kind: element[2]!, name: '', exported: null, permission: null }, indent };
        components.push(current.component);
      }
      continue;
    }
    const attribute = /^(\s*)A: (?:[^\s(]*:)?([\w.-]+)\((0x[0-9a-fA-F]+)\)=(.*)$/.exec(line);
    if (attribute && current && attribute[1]!.length === current.indent + 2) {
      const [, , key, , raw] = attribute;
      if (key === 'name') current.component.name = /^"([^"]*)"/.exec(raw!)?.[1] ?? '';
      else if (key === 'exported') current.component.exported = /^(true|\(type 0x12\)0xffffffff)/.test(raw!) ? true : /^(false|\(type 0x12\)0x0)/.test(raw!) ? false : null;
      else if (key === 'permission') current.component.permission = /^"([^"]*)"/.exec(raw!)?.[1] ?? '';
    }
  }
  return components;
}

/** El valor de un atributo de `<application>` (o `null` si no sale). */
export function applicationAttribute(xmltree: string, key: string): string | null {
  let inApplication = false;
  let applicationIndent = 0;
  for (const line of xmltree.split(/\r?\n/)) {
    const element = /^(\s*)E: ([\w.-]+)/.exec(line);
    if (element) {
      if (element[2] === 'application') {
        inApplication = true;
        applicationIndent = element[1]!.length;
      } else if (inApplication && element[1]!.length <= applicationIndent) inApplication = false;
      continue;
    }
    const attribute = /^(\s*)A: (?:[^\s(]*:)?([\w.-]+)\((0x[0-9a-fA-F]+)\)=(.*)$/.exec(line);
    if (inApplication && attribute && attribute[1]!.length === applicationIndent + 2 && attribute[2] === key) return attribute[4]!.trim();
  }
  return null;
}

/** Lo que está mal en el manifiesto (vacío = todo en orden). */
export function manifestProblems(xmltree: string): string[] {
  const problems: string[] = [];
  const components = parseComponents(xmltree);
  // Control positivo: si la salida de la herramienta cambia de formato, no se puede dar nada por bueno.
  const main = components.find((c) => c.name.endsWith('.MainActivity'));
  if (!main || main.exported !== true) {
    return ['El manifiesto no se lee como se esperaba (no sale MainActivity como exportada): la salida de aapt2 ha cambiado de formato.'];
  }
  for (const c of components) {
    if (c === main) continue;
    // Un componente solo puede llamarse desde otra app si lo protege un permiso (p. ej. el receptor del instalador de perfiles de AndroidX, que exige DUMP).
    if (c.exported !== false && !c.permission) problems.push(`El componente ${c.kind} ${c.name} se puede llamar desde otras apps (exported=${String(c.exported)}) y no lo protege ningún permiso.`);
  }
  const cleartext = applicationAttribute(xmltree, 'usesCleartextTraffic');
  if (cleartext === null || !/^(false|\(type 0x12\)0x0)/.test(cleartext)) problems.push('La aplicación no prohíbe el tráfico sin cifrar (usesCleartextTraffic debe ser false).');
  const backup = applicationAttribute(xmltree, 'allowBackup');
  if (backup === null || !/^(false|\(type 0x12\)0x0)/.test(backup)) problems.push('La aplicación permite copias de seguridad por adb (allowBackup debe ser false).');
  if (applicationAttribute(xmltree, 'networkSecurityConfig') === null) problems.push('Falta la configuración de seguridad de red (networkSecurityConfig).');
  const debuggable = applicationAttribute(xmltree, 'debuggable');
  if (debuggable !== null && !/^(false|\(type 0x12\)0x0)/.test(debuggable)) problems.push('La aplicación es depurable.');
  return problems;
}

/** Permisos que esta app no necesita y que, si algún día aparecen (por una librería nueva, por ejemplo), hay que decidir a propósito. */
export const FORBIDDEN_PERMISSIONS: readonly string[] = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.RECORD_AUDIO',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_CALENDAR',
  'android.permission.WRITE_CALENDAR',
  'android.permission.READ_SMS',
  'android.permission.SEND_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.CALL_PHONE',
  'android.permission.READ_CALL_LOG',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.QUERY_ALL_PACKAGES',
  'android.permission.BIND_ACCESSIBILITY_SERVICE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
];

/** Los permisos prohibidos que declara un APK, a partir de la salida de `aapt2 dump permissions`. */
export function forbiddenPermissions(permissionsDump: string): string[] {
  const declared = new Set([...permissionsDump.matchAll(/name='([^']+)'/g)].map((m) => m[1]!));
  return FORBIDDEN_PERMISSIONS.filter((p) => declared.has(p));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8');
  // `permissions`: la salida de `aapt2 dump permissions`; sin argumento: la de `aapt2 dump xmltree` del manifiesto.
  const problems =
    process.argv[2] === 'permissions'
      ? forbiddenPermissions(input).map((p) => `El APK declara el permiso ${p}, que la app no necesita: si hace falta de verdad, se añade a propósito a la lista de permitidos.`)
      : manifestProblems(input);
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
