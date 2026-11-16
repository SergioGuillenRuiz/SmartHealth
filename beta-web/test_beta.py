"""Pruebas de la versión web para betatesters: servidor de archivos, rutas seguras, caché, gzip, nombres de cloudflared por sistema y los dos arranques.
Se ejecutan con `python3 -m unittest discover -s beta-web -p 'test_*.py'`."""

import gzip
import http.client
import importlib.util
import io
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import smarthealth_beta as nucleo

AQUI = Path(__file__).resolve().parent


def cargar(nombre_archivo: str):
    """Los arranques llevan guion en el nombre: se cargan por su ruta."""
    spec = importlib.util.spec_from_file_location(nombre_archivo.replace("-", "_").replace(".py", ""), AQUI / nombre_archivo)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


class Rutas(unittest.TestCase):
    def test_no_sale_de_la_carpeta(self):
        raiz = Path(tempfile.mkdtemp()).resolve()
        self.assertEqual(nucleo.resolver(raiz, "/"), raiz / "index.html")
        for mala in ["/../etc/passwd", "/a/../../x", "/%2e%2e/x", "/a\\b", "/a%00b", "/%ff"]:
            self.assertIsNone(nucleo.resolver(raiz, mala), mala)

    def test_cache(self):
        self.assertIn("immutable", nucleo.cache_control("/assets/a-123.js"))
        for ruta in ["/", "/index.html", "/sw.js", "/manifest.webmanifest"]:
            self.assertEqual(nucleo.cache_control(ruta), "no-cache")

    def test_aparatos_y_tunel(self):
        self.assertEqual(nucleo.aparato("Mozilla/5.0 (iPhone; CPU iPhone OS 17)"), "iPhone/iPad")
        self.assertEqual(nucleo.aparato("Mozilla/5.0 (Linux; Android 14)"), "Android")
        encontrado = nucleo.URL_TUNEL.search("INF |  https://tres-palabras-aqui.trycloudflare.com  |")
        self.assertEqual(encontrado.group(0), "https://tres-palabras-aqui.trycloudflare.com")
        self.assertIsNone(nucleo.URL_TUNEL.search("sin enlace aquí"))


class Cloudflared(unittest.TestCase):
    def test_nombres_por_sistema(self):
        self.assertEqual(nucleo.asset_cloudflared("Linux", "x86_64"), ("cloudflared-linux-amd64", "cloudflared"))
        self.assertEqual(nucleo.asset_cloudflared("Linux", "aarch64"), ("cloudflared-linux-arm64", "cloudflared"))
        self.assertEqual(nucleo.asset_cloudflared("Windows", "AMD64"), ("cloudflared-windows-amd64.exe", "cloudflared.exe"))
        self.assertEqual(nucleo.asset_cloudflared("Windows", "x86"), ("cloudflared-windows-386.exe", "cloudflared.exe"))
        self.assertIsNone(nucleo.asset_cloudflared("Darwin", "arm64"))
        self.assertIsNone(nucleo.asset_cloudflared("Linux", "riscv64"))

    def test_usa_el_del_sistema_si_funciona(self):
        with mock.patch.object(nucleo.shutil, "which", return_value="/usr/bin/cloudflared"), mock.patch.object(nucleo, "_funciona", return_value=True):
            self.assertEqual(nucleo.buscar_cloudflared(Path(tempfile.mkdtemp())), "/usr/bin/cloudflared")

    def test_lo_baja_una_sola_vez(self):
        herramientas = Path(tempfile.mkdtemp())
        pedidas = []

        class Falsa(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        def abrir(url, timeout=0):
            pedidas.append(url)
            return Falsa(b"binario")

        with mock.patch.object(nucleo.shutil, "which", return_value=None), mock.patch.object(nucleo.urllib.request, "urlopen", abrir), mock.patch.object(nucleo, "_funciona", return_value=True):
            primera = nucleo.buscar_cloudflared(herramientas, lambda *_: None, "Windows", "AMD64")
            segunda = nucleo.buscar_cloudflared(herramientas, lambda *_: None, "Windows", "AMD64")
        self.assertEqual(primera, str(herramientas / "cloudflared.exe"))
        self.assertEqual(segunda, primera)
        self.assertEqual(pedidas, ["https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"])
        self.assertEqual((herramientas / "cloudflared.exe").read_bytes(), b"binario")

    def test_sin_internet_no_revienta(self):
        mensajes = []

        def falla(*_a, **_k):
            raise OSError("sin red")

        with mock.patch.object(nucleo.shutil, "which", return_value=None), mock.patch.object(nucleo.urllib.request, "urlopen", falla):
            self.assertIsNone(nucleo.buscar_cloudflared(Path(tempfile.mkdtemp()), mensajes.append, "Linux", "x86_64"))
        self.assertTrue(any("sin red" in m for m in mensajes))


class Arranques(unittest.TestCase):
    def test_argumentos(self):
        opciones = nucleo.leer_argumentos("x", ["--sin-tunel", "--puerto", "9000", "--aqui"])
        self.assertEqual((opciones.sin_tunel, opciones.puerto, opciones.aqui), (True, 9000, True))
        self.assertEqual(nucleo.leer_argumentos("x", ["--puerto", "0"]).puerto, 8080)
        self.assertEqual(nucleo.leer_argumentos("x", []).puerto, 8080)

    def test_windows_pythonw_se_cambia_por_python(self):
        windows = cargar("iniciar-windows.py")
        self.assertEqual(windows.python_de_consola(r"C:\Python\pythonw.exe"), r"C:\Python\python.exe")
        self.assertEqual(windows.python_de_consola("python.exe"), "python.exe")

    def test_windows_sin_consola_la_reabre_y_con_consola_no(self):
        windows = cargar("iniciar-windows.py")
        with mock.patch.object(windows, "hay_consola", return_value=False), mock.patch.object(windows, "reabrir_en_consola", return_value=True) as reabrir, mock.patch.object(windows.nucleo, "ejecutar") as ejecutar:
            self.assertEqual(windows.principal(["--sin-tunel"]), 0)
        reabrir.assert_called_once_with(["--sin-tunel"])
        ejecutar.assert_not_called()
        with mock.patch.object(windows, "hay_consola", return_value=True), mock.patch.object(windows, "reabrir_en_consola") as reabrir, mock.patch.object(windows.nucleo, "ejecutar", return_value=0) as ejecutar:
            self.assertEqual(windows.principal([]), 0)
        reabrir.assert_not_called()
        ejecutar.assert_called_once()

    def test_windows_con_aqui_no_reabre(self):
        windows = cargar("iniciar-windows.py")
        with mock.patch.object(windows, "hay_consola", return_value=False), mock.patch.object(windows, "reabrir_en_consola") as reabrir, mock.patch.object(windows.nucleo, "ejecutar", return_value=0):
            windows.principal(["--aqui"])
        reabrir.assert_not_called()

    def test_windows_un_fallo_se_cuenta_y_espera_tecla(self):
        windows = cargar("iniciar-windows.py")
        fuera = io.StringIO()
        with mock.patch.object(windows, "hay_consola", return_value=True), mock.patch.object(windows.nucleo, "ejecutar", side_effect=RuntimeError("roto")), mock.patch.object(windows, "esperar_tecla") as espera, mock.patch.object(windows.sys, "stdin") as entrada, redirect_stdout(fuera):
            entrada.isatty.return_value = True
            self.assertEqual(windows.principal([]), 1)
        self.assertIn("roto", fuera.getvalue())
        espera.assert_called_once()

    def test_linux_no_abre_terminal(self):
        linux = cargar("iniciar-linux.py")
        self.assertFalse(hasattr(linux, "en_terminal_nuevo"))
        with mock.patch.object(linux.nucleo, "ejecutar", return_value=0) as ejecutar, mock.patch.object(linux.sys, "argv", ["iniciar-linux.py", "--sin-tunel"]):
            self.assertEqual(linux.principal(), 0)
        self.assertTrue(ejecutar.call_args[0][0].sin_tunel)


class Servidor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raiz = Path(tempfile.mkdtemp())
        (cls.raiz / "index.html").write_text("<!doctype html>" + "hola " * 300)
        (cls.raiz / "assets").mkdir()
        (cls.raiz / "assets" / "m.wasm").write_bytes(b"\0asm" + b"\0" * 1000)
        (cls.raiz.parent / "secreto.txt").write_text("no")
        cls.visitas = []
        cls.srv = nucleo.crear_servidor(cls.raiz, 0, "127.0.0.1", lambda n, d: cls.visitas.append((n, d)))
        cls.puerto = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def pedir(self, metodo, ruta, cabeceras=None):
        c = http.client.HTTPConnection("127.0.0.1", self.puerto)
        c.request(metodo, ruta, headers=cabeceras or {})
        r = c.getresponse()
        cuerpo = r.read()
        c.close()
        return r, cuerpo

    def test_html_gzip_y_cabeceras(self):
        r, cuerpo = self.pedir("GET", "/", {"Accept-Encoding": "gzip", "User-Agent": "Android"})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Encoding"), "gzip")
        self.assertIn("hola", gzip.decompress(cuerpo).decode())
        self.assertEqual(r.getheader("Cache-Control"), "no-cache")
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn("camera=(self)", r.getheader("Permissions-Policy"))

    def test_wasm_etag_304_head(self):
        r, _ = self.pedir("GET", "/assets/m.wasm")
        self.assertEqual(r.getheader("Content-Type"), "application/wasm")
        etag = r.getheader("ETag")
        r2, _ = self.pedir("GET", "/assets/m.wasm", {"If-None-Match": etag})
        self.assertEqual(r2.status, 304)
        r3, cuerpo = self.pedir("HEAD", "/")
        self.assertEqual((r3.status, cuerpo), (200, b""))

    def test_errores_y_sin_escapar(self):
        self.assertEqual(self.pedir("GET", "/nada.js")[0].status, 404)
        self.assertEqual(self.pedir("POST", "/")[0].status, 405)
        r, cuerpo = self.pedir("GET", "/../secreto.txt")
        self.assertIn(r.status, (400, 404))
        self.assertNotEqual(cuerpo, b"no")

    def test_visitante_nuevo_se_avisa_una_vez(self):
        antes = len(self.visitas)
        self.pedir("GET", "/", {"User-Agent": "iPhone"})
        self.pedir("GET", "/", {"User-Agent": "iPhone"})
        self.assertLessEqual(len(self.visitas) - antes, 1)


if __name__ == "__main__":
    unittest.main()
