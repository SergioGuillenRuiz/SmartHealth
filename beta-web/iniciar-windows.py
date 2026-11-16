"""SmartHealth · versión web para betatesters · arranque para WINDOWS.

Haz doble clic en este archivo (hace falta Python: https://www.python.org/downloads/ , marcando «Add python.exe to PATH»).
Si no hay una consola delante (por ejemplo con `pythonw`), abre una ventana de consola él solo. La ventana no se cierra
si algo falla: se queda el mensaje y espera una tecla.

    iniciar-windows.py                 → sirve la app e imprime el enlace https para los testers (lo normal)
    iniciar-windows.py --sin-tunel     → solo el servidor, para la MISMA wifi (sin cámara, GPS ni «instalar» en los móviles)
    iniciar-windows.py --puerto 9000   → otro puerto (por omisión 8080; si está ocupado prueba los siguientes)
    iniciar-windows.py --app RUTA      → otra carpeta con la app compilada

Lo demás lo instala él solo la primera vez: `cloudflared` (la herramienta oficial de Cloudflare que da el enlace https) en la carpeta
`herramientas/`, sin permisos de administrador. Windows puede preguntar por SmartScreen o por el cortafuegos: es normal.
"""

import os
import subprocess
import sys
from pathlib import Path, PureWindowsPath

import smarthealth_beta as nucleo

CREATE_NEW_CONSOLE = 0x00000010


def hay_consola() -> bool:
    return sys.stdout is not None and sys.stdout.isatty()


def python_de_consola(ejecutable: str) -> str:
    """`pythonw.exe` no abre consola; su hermano `python.exe` sí."""
    ruta = PureWindowsPath(ejecutable)
    if ruta.name.lower() == "pythonw.exe":
        return str(ruta.with_name("python.exe"))
    return ejecutable


def reabrir_en_consola(argumentos: list) -> bool:
    """Lanza este mismo archivo en una ventana de consola nueva. True si se pudo (solo Windows)."""
    if os.name != "nt":
        return False
    orden = [python_de_consola(sys.executable), str(Path(__file__).resolve()), "--aqui", *argumentos]
    try:
        subprocess.Popen(orden, creationflags=CREATE_NEW_CONSOLE)
        return True
    except OSError:
        return False


def esperar_tecla():
    try:
        input("\n  Pulsa Intro para cerrar esta ventana.")
    except (EOFError, KeyboardInterrupt, RuntimeError):
        pass


def principal(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    opciones = nucleo.leer_argumentos(__doc__ or "", argv)
    if not opciones.aqui and not hay_consola() and reabrir_en_consola([a for a in argv if a != "--aqui"]):
        return 0  # el trabajo sigue en la consola nueva
    try:
        codigo = nucleo.ejecutar(opciones)
    except Exception as error:  # noqa: BLE001 - que la ventana enseñe el motivo en vez de cerrarse
        print(f"\n  Algo ha fallado: {error}")
        codigo = 1
    if codigo != 0 and sys.stdin is not None and sys.stdin.isatty():
        esperar_tecla()
    return codigo


if __name__ == "__main__":
    sys.exit(principal())
