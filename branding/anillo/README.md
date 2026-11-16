# Iconos del anillo (archivados)

Antes el icono de la aplicación era **el anillo inteligente** (el dibujo de `public/icon.svg`); ahora es una manzana con una línea de pulso (alimentación y ejercicio).
Estos archivos se guardan por si se quiere volver atrás o reutilizarlos. **Nada de aquí se compila ni se empaqueta en el APK.**

- `public/icon.svg` y `public/icons/*.png`: el icono de la PWA (192, 512, «maskable» 512 y `apple-touch-icon`).
- `android-res/`: los recursos de Android de entonces —iconos del lanzador (`mipmap-*`, adaptativos y redondos), el color de fondo y las pantallas de arranque (`drawable*/splash.png`)—.

## Volver al icono del anillo

```
cp branding/anillo/public/icon.svg public/icon.svg
npm run icons                              # PNG de la PWA
node scripts/make-android-icons.mjs        # lanzador y pantallas de arranque de Android
```

(`scripts/make-android-icons.mjs` ajusta el tamaño de la pantalla de arranque con `GLYPH_WIDTH`, que ahora mide el dibujo nuevo: para el anillo eran 337 px sobre 512.)
Para restaurar los PNG tal cual estaban basta copiar `public/icons/*` y `android-res/*` a `public/icons/` y a `android/app/src/main/res/`.

El icono del anillo que se ve **dentro de la app** (el botón del anillo de la barra superior, `RingIcon`) no es este y no ha cambiado: sigue representando al anillo como dispositivo.
