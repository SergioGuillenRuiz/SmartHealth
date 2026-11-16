"""Núcleo de la versión WEB de SmartHealth para betatesters. Solo biblioteca estándar de Python (3.8 o más): no hay nada que instalar con pip.

Lo usan los dos arranques, `iniciar-linux.py` y `iniciar-windows.py`. Hace tres cosas:

1. Sirve la app ya compilada (carpeta `app/`) como un servidor de ARCHIVOS: no guarda ni recibe nada de nadie. Lo que cada tester anota se queda en SU móvil.
2. Se encarga él mismo de lo que hace falta para funcionar: baja `cloudflared` (la herramienta oficial de Cloudflare que da el enlace https) la primera vez y, si se ejecuta desde
   el repositorio sin la app compilada, la compila con `npm`.
3. Imprime el enlace `https://….trycloudflare.com` que se manda a los testers. Con HTTPS el móvil deja usar la cámara, la ubicación y «instalar como app»; con la dirección normal
   del PC (`http://192.168…`) no.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import mimetypes
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

AQUI = Path(__file__).resolve().parent
BARRA = "─" * 64
PYTHON_MINIMO = (3, 8)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".bin": "application/octet-stream",
    ".map": "application/json; charset=utf-8",
}
COMPRIMIBLES = {".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".wasm", ".txt", ".bin", ".map"}

CABECERAS_SEGURIDAD = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    # La app usa la cámara (escáner y fotos) y la ubicación (entrenos y mapa); nada más.
    "Permissions-Policy": "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()",
    "X-Frame-Options": "DENY",
}


# ───────────────────────────── servidor de archivos ─────────────────────────────


def resolver(raiz: Path, ruta_url: str) -> "Path | None":
    """El archivo del disco que corresponde a una dirección, o None si no cuelga de `raiz` (`..`, barras invertidas, bytes nulos…)."""
    try:
        ruta = unquote(urlsplit(ruta_url).path, errors="strict")
    except UnicodeDecodeError:
        return None
    if "\0" in ruta or "\\" in ruta or ".." in ruta.split("/"):
        return None
    if ruta == "" or ruta.endswith("/"):
        ruta += "index.html"
    completa = (raiz / ruta.lstrip("/")).resolve()
    if completa != raiz and raiz not in completa.parents:
        return None
    return completa


def cache_control(ruta_url: str) -> str:
    """Lo que cambia con cada versión se revalida siempre; lo de nombre con huella (/assets/), para siempre."""
    ruta = urlsplit(ruta_url).path
    if ruta.startswith("/assets/"):
        return "public, max-age=31536000, immutable"
    if ruta == "/" or ruta.endswith((".html", "/sw.js", ".webmanifest")):
        return "no-cache"
    return "public, max-age=3600"


def aparato(user_agent: str) -> str:
    if re.search(r"iPhone|iPad|iPod", user_agent):
        return "iPhone/iPad"
    if "Android" in user_agent:
        return "Android"
    if re.search(r"Windows|Macintosh|Linux", user_agent):
        return "ordenador"
    return "aparato desconocido"


def crear_servidor(raiz: Path, puerto: int, host: str = "127.0.0.1", al_visitar=lambda n, dispositivo: None) -> ThreadingHTTPServer:
    raiz = Path(raiz).resolve()
    gz_cache: dict = {}
    vistos: set = set()
    cerrojo = threading.Lock()

    class Manejador(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "SmartHealthBeta"

        def log_message(self, *_args):  # sin ruido por cada petición
            pass

        def _responder(self, estado, cuerpo=b"", cabeceras=None, solo_cabeceras=False):
            self.send_response(estado)
            for clave, valor in {**CABECERAS_SEGURIDAD, **(cabeceras or {})}.items():
                self.send_header(clave, valor)
            self.send_header("Content-Length", str(len(cuerpo)))
            self.end_headers()
            if not solo_cabeceras:
                self.wfile.write(cuerpo)

        def _servir(self, solo_cabeceras):
            if self.command not in ("GET", "HEAD"):
                return self._responder(HTTPStatus.METHOD_NOT_ALLOWED, b"Metodo no permitido", {"Allow": "GET, HEAD", "Content-Type": "text/plain"})
            archivo = resolver(raiz, self.path)
            if archivo is None:
                return self._responder(HTTPStatus.BAD_REQUEST, b"Ruta no valida", {"Content-Type": "text/plain"}, solo_cabeceras)
            if not archivo.is_file():
                return self._responder(HTTPStatus.NOT_FOUND, b"No encontrado", {"Content-Type": "text/plain"}, solo_cabeceras)

            # Un visitante nuevo (por su dirección, o la que dé el túnel) se avisa una sola vez, y solo al abrir la app.
            if urlsplit(self.path).path in ("/", "/index.html"):
                ip = self.headers.get("CF-Connecting-IP") or self.client_address[0]
                with cerrojo:
                    nuevo = ip not in vistos
                    vistos.add(ip)
                    cuenta = len(vistos)
                if nuevo:
                    al_visitar(cuenta, aparato(self.headers.get("User-Agent", "")))

            info = archivo.stat()
            extension = archivo.suffix.lower()
            etag = '"' + hashlib.sha1(f"{info.st_size}-{info.st_mtime_ns}".encode()).hexdigest()[:20] + '"'
            cabeceras = {
                "Content-Type": MIME.get(extension) or mimetypes.guess_type(archivo.name)[0] or "application/octet-stream",
                "Cache-Control": cache_control(self.path),
                "ETag": etag,
                "Vary": "Accept-Encoding",
            }
            if self.headers.get("If-None-Match") == etag:
                return self._responder(HTTPStatus.NOT_MODIFIED, b"", cabeceras, True)

            cuerpo = archivo.read_bytes()
            if extension in COMPRIMIBLES and len(cuerpo) > 512 and "gzip" in self.headers.get("Accept-Encoding", ""):
                clave = (str(archivo), info.st_mtime)
                with cerrojo:
                    if clave not in gz_cache:
                        gz_cache[clave] = gzip.compress(cuerpo, 6)
                    cuerpo = gz_cache[clave]
                cabeceras["Content-Encoding"] = "gzip"
            self._responder(HTTPStatus.OK, cuerpo, cabeceras, solo_cabeceras)

        def do_GET(self):
            self._servir(False)

        def do_HEAD(self):
            self._servir(True)

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = lambda self: self._servir(False)

    class Servidor(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    return Servidor((host, puerto), Manejador)


def abrir_en_puerto_libre(raiz: Path, deseado: int, host: str, al_visitar):
    for puerto in range(deseado, deseado + 10):
        try:
            return crear_servidor(raiz, puerto, host, al_visitar), puerto
        except OSError:
            continue
    raise SystemExit(f"No hay ningún puerto libre entre el {deseado} y el {deseado + 9}.")


def direcciones_lan() -> list:
    """La dirección del PC en la red local (para abrir la app desde un móvil en la misma wifi)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:  # no envía nada: solo averigua qué interfaz sale a la red
            s.connect(("10.255.255.255", 1))
            direccion = s.getsockname()[0]
    except OSError:
        return []
    return [] if direccion.startswith("127.") else [direccion]


# ───────────────────────────── la app compilada ─────────────────────────────


def encontrar_app(indicada: "str | None" = None) -> "Path | None":
    """La carpeta con la app compilada: la indicada, `app/` junto al arranque (el zip) o `dist-beta/` del repositorio."""
    for candidata in [indicada, AQUI / "app", AQUI.parent / "dist-beta"]:
        if candidata and (Path(candidata) / "index.html").is_file():
            return Path(candidata).resolve()
    return None


def preparar_app(log=print) -> "Path | None":
    """Desde el repositorio y sin la app compilada: instala lo que falte de `npm` y la compila en `dist-beta/`. None si no se puede (sin Node)."""
    repo = AQUI.parent
    if not (repo / "package.json").is_file():
        return None
    npm = shutil.which("npm")
    if npm is None:
        log("  No encuentro la app compilada y para compilarla hace falta Node.js (https://nodejs.org). Instálalo y vuelve a arrancar,")
        log("  o usa el zip de la release «beta-web-…» del repositorio, que ya la lleva dentro.")
        return None
    if not (repo / "node_modules").is_dir():
        log("  Instalando las dependencias de la app (npm ci, una sola vez; tarda unos minutos)…")
        if subprocess.call([npm, "ci"], cwd=repo) != 0:
            log("  «npm ci» ha fallado.")
            return None
    log("  Compilando la app en modo beta (npm run build:beta)…")
    if subprocess.call([npm, "run", "build:beta"], cwd=repo) != 0:
        log("  La compilación ha fallado.")
        return None
    return encontrar_app()


# ───────────────────────────── enlace https (cloudflared) ─────────────────────────────

URL_TUNEL = re.compile(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com", re.I)


def asset_cloudflared(sistema: str, maquina: str) -> "tuple | None":
    """(nombre del archivo en las versiones oficiales de GitHub, nombre con el que se guarda aquí), o None si no hay binario suelto para este sistema."""
    maquina = maquina.lower()
    if sistema == "Linux":
        cpu = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(maquina)
        return (f"cloudflared-linux-{cpu}", "cloudflared") if cpu else None
    if sistema == "Windows":
        cpu = {"amd64": "amd64", "x86_64": "amd64", "x86": "386", "i386": "386", "i686": "386"}.get(maquina)
        return (f"cloudflared-windows-{cpu}.exe", "cloudflared.exe") if cpu else None
    return None


def _funciona(binario: str) -> bool:
    try:
        return subprocess.run([binario, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def buscar_cloudflared(herramientas: Path, log=print, sistema: "str | None" = None, maquina: "str | None" = None) -> "str | None":
    """cloudflared del sistema o, si no hay, el binario oficial que baja una sola vez junto a los arranques (carpeta `herramientas/`, sin permisos de administrador)."""
    en_path = shutil.which("cloudflared")
    if en_path and _funciona(en_path):
        return en_path
    asset = asset_cloudflared(sistema or platform.system(), maquina or platform.machine())
    if asset is None:
        log("  No sé bajar cloudflared para este sistema; instálalo a mano (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).")
        return None
    nombre_release, nombre_local = asset
    local = herramientas / nombre_local
    if local.is_file() and _funciona(str(local)):
        return str(local)
    log("  Instalando lo que falta: bajando cloudflared (una sola vez, ~40 MB) de las versiones oficiales de Cloudflare…")
    try:
        herramientas.mkdir(parents=True, exist_ok=True)
        temporal = herramientas / (nombre_local + ".parte")
        with urllib.request.urlopen(f"https://github.com/cloudflare/cloudflared/releases/latest/download/{nombre_release}", timeout=60) as r, open(temporal, "wb") as f:
            shutil.copyfileobj(r, f)
        temporal.chmod(0o755)
        temporal.replace(local)
    except Exception as error:  # noqa: BLE001 - cualquier fallo de red se explica igual
        log(f"  No he podido bajarlo ({error}).")
        return None
    if not _funciona(str(local)):
        log("  Lo he bajado pero no arranca (¿antivirus o falta de permisos?). Bórralo de la carpeta «herramientas» y vuelve a intentarlo.")
        return None
    return str(local)


def lanzar_tunel(binario: str, puerto: int, al_tener_url, al_cerrar) -> subprocess.Popen:
    hijo = subprocess.Popen(
        [binario, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{puerto}"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
        errors="replace",
    )

    def leer():
        anunciado = False
        for linea in hijo.stdout or []:
            encontrado = URL_TUNEL.search(linea)
            if encontrado and not anunciado:
                anunciado = True
                al_tener_url(encontrado.group(0))
        hijo.wait()
        al_cerrar(hijo.returncode, anunciado)

    threading.Thread(target=leer, daemon=True).start()
    return hijo


# ───────────────────────────── arranque común ─────────────────────────────


def leer_argumentos(descripcion: str, argv: "list | None" = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=descripcion)
    parser.add_argument("--puerto", type=int, default=8080, help="puerto del servidor (por omisión 8080; si está ocupado prueba los 9 siguientes)")
    parser.add_argument("--sin-tunel", action="store_true", help="solo el servidor, para la MISMA wifi (sin cámara, GPS ni «instalar» en los móviles)")
    parser.add_argument("--app", default=None, help="otra carpeta con la app compilada")
    parser.add_argument("--aqui", action="store_true", help="no abrir una ventana nueva (la usa el propio arranque)")
    opciones = parser.parse_args(argv)
    if not 1 <= opciones.puerto <= 65535:
        opciones.puerto = 8080
    return opciones


def comprobar_python() -> bool:
    if sys.version_info < PYTHON_MINIMO:
        print(f"Hace falta Python {PYTHON_MINIMO[0]}.{PYTHON_MINIMO[1]} o más reciente (tienes {platform.python_version()}).")
        return False
    return True


def ejecutar(opciones: argparse.Namespace) -> int:
    """Sirve la app y, salvo con --sin-tunel, imprime el enlace https. Devuelve cuando se pulsa Ctrl+C."""
    try:
        sys.stdout.reconfigure(errors="replace")  # una consola antigua sin UTF-8 no debe tumbar el arranque por una «ñ»
    except (AttributeError, ValueError):
        pass
    if not comprobar_python():
        return 1

    app = encontrar_app(opciones.app) or preparar_app()
    if app is None:
        print("No encuentro la app compilada (falta la carpeta «app» con index.html junto a este archivo).")
        print("Usa el zip de la release «beta-web-…» del repositorio, o ejecuta esto desde el repositorio con Node.js instalado.")
        return 1

    binario = None if opciones.sin_tunel else buscar_cloudflared(AQUI / "herramientas")
    # Con el túnel basta con escuchar en este mismo PC (el túnel entra por ahí): así el cortafuegos no pregunta ni se abre nada a la red local.
    host = "127.0.0.1" if binario else "0.0.0.0"

    def visita(cuenta: int, dispositivo: str):
        print(f"  {time.strftime('%H:%M:%S')}  Alguien ha abierto la app desde {dispositivo} (visitante n.º {cuenta})", flush=True)

    servidor, puerto = abrir_en_puerto_libre(app, opciones.puerto, host, visita)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()

    print()
    print(BARRA)
    print("  SmartHealth · versión web para betatesters")
    print(BARRA)
    print(f"  Servidor encendido en este PC (puerto {puerto}). Déjalo abierto mientras los testers la usen.")
    print("  Para apagarlo: cierra esta ventana o pulsa Ctrl+C.")
    print()

    def mostrar_lan():
        if host != "0.0.0.0":
            print("  Para usarla solo en tu wifi (sin cámara, GPS ni «instalar»), arranca con la opción --sin-tunel.")
            print()
            return
        lan = [f"http://{d}:{puerto}" for d in direcciones_lan()]
        if lan:
            print("  Solo para la MISMA wifi (sin HTTPS: el escáner, el GPS y «instalar» NO funcionan así):")
            for direccion in lan:
                print(f"     {direccion}")
            print()

    hijo = None
    if opciones.sin_tunel:
        mostrar_lan()
    elif binario is None:
        print()
        print("  No he podido crear el enlace con HTTPS. Sin él, los móviles no dejan usar la cámara,")
        print("  la ubicación ni instalar la app. Revisa tu conexión a internet y vuelve a arrancar.")
        print()
        mostrar_lan()
    else:
        print("  Creando el enlace público con HTTPS…", flush=True)

        def con_url(url: str):
            print()
            print(BARRA)
            print("  ENLACE PARA LOS BETATESTERS (funciona en cualquier móvil, con HTTPS):")
            print()
            print(f"     {url}")
            print()
            print("  Mándales ese enlace (WhatsApp, Telegram…). Cada uno lo abre en su móvil y, en el menú")
            print("  del navegador, elige «Instalar app» / «Añadir a la pantalla de inicio».")
            print("  IMPORTANTE: el enlace cambia cada vez que apagas y vuelves a encender este programa, y lo")
            print("  anotado en el móvil de cada uno está ligado al enlace. Si lo apagas, que exporten su copia antes.")
            print(BARRA)
            print(flush=True)

        def al_cerrar(codigo, anunciado):
            print()
            print("  El enlace público se ha cerrado (¿sin internet?). Los móviles ya no pueden abrir la app." if anunciado else f"  El túnel se cerró sin dar enlace (código {codigo}). Revisa tu conexión a internet y vuelve a arrancar.")
            mostrar_lan()

        hijo = lanzar_tunel(binario, puerto, con_url, al_cerrar)

    def terminar(*_):
        raise KeyboardInterrupt

    for nombre in ("SIGTERM", "SIGHUP", "SIGBREAK"):  # cerrar la ventana o parar el proceso apaga también el túnel
        if hasattr(signal, nombre):
            signal.signal(getattr(signal, nombre), terminar)

    try:
        while True:
            time.sleep(0.5)  # en Windows, esperar sin límite no deja pasar Ctrl+C
    except KeyboardInterrupt:
        pass
    finally:
        if hijo is not None:
            hijo.terminate()
        servidor.shutdown()
    return 0
