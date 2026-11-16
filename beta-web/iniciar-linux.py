#!/usr/bin/env python3
"""SmartHealth · versión web para betatesters · arranque para LINUX (CachyOS, Arch, Ubuntu…).

    python3 iniciar-linux.py                 → sirve la app e imprime el enlace https para los testers (lo normal)
    python3 iniciar-linux.py --sin-tunel     → solo el servidor, para la MISMA wifi (sin cámara, GPS ni «instalar» en los móviles)
    python3 iniciar-linux.py --puerto 9000   → otro puerto (por omisión 8080; si está ocupado prueba los siguientes)
    python3 iniciar-linux.py --app RUTA      → otra carpeta con la app compilada

Se ejecuta en el terminal desde el que lo lanzas. Solo necesita Python: lo demás lo instala él solo la primera vez
(`cloudflared` en la carpeta `herramientas/`, sin permisos de administrador; si lo tienes instalado en el sistema, usa ese).
"""

import sys

import smarthealth_beta as nucleo


def principal() -> int:
    return nucleo.ejecutar(nucleo.leer_argumentos(__doc__ or ""))


if __name__ == "__main__":
    sys.exit(principal())
