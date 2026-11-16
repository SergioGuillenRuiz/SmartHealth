// Empaqueta la versión web para betatesters en UN ZIP listo para descomprimir y arrancar: la app compilada (`dist-beta/`, de `npm run build:beta`) más el servidor de Python y los arranques de `beta-web/` (Linux y Windows).
// Uso: node tools/pack-beta-web.mjs [versión]   → deja `out/smarthealth-beta-web-<versión>.zip`
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? 'local';
const app = join(root, 'dist-beta');
if (!existsSync(join(app, 'index.html'))) {
  console.error('Falta dist-beta/: ejecuta antes «npm run build:beta».');
  process.exit(1);
}

const name = `smarthealth-beta-web-${version}`;
const staging = join(root, 'out', name);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(app, join(staging, 'app'), { recursive: true });
for (const file of ['smarthealth_beta.py', 'iniciar-linux.py', 'iniciar-windows.py']) cpSync(join(root, 'beta-web', file), join(staging, file));
// El LEEME se abre en el Bloc de notas de Windows: lleva saltos de línea de Windows.
for (const file of ['LEEME.txt']) writeFileSync(join(staging, file), readFileSync(join(root, 'beta-web', file), 'utf8').replace(/\r?\n/g, '\r\n'));
writeFileSync(join(staging, 'VERSION.txt'), `SmartHealth beta web ${version}\n`);

const zip = join(root, 'out', `${name}.zip`);
rmSync(zip, { force: true });
// `zip` guarda los permisos (el arranque de Linux ejecutable); sin él, Python.
let result = spawnSync('zip', ['-qr', zip, name], { cwd: join(root, 'out'), stdio: 'inherit' });
if (result.status !== 0) {
  result = spawnSync('python3', ['-c', `import shutil,sys;shutil.make_archive(sys.argv[1],'zip',sys.argv[2],sys.argv[3])`, zip.replace(/\.zip$/, ''), join(root, 'out'), name], { stdio: 'inherit' });
}
if (result.status !== 0 || !existsSync(zip)) {
  console.error('No se pudo crear el zip (hace falta «zip» o python3).');
  process.exit(1);
}
console.log(`Listo: ${zip}`);
console.log(`Contiene: ${readdirSync(staging).join(', ')}`);
