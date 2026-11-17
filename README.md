# Kantoro — web app (prototipo 0.1.0)

Escucha japonés por el **micrófono** y lo muestra en **rōmaji** al momento, con el texto japonés debajo y una ficha de diccionario al tocar cada palabra. Pensada para el móvil (Chrome para Android) e instalable desde el menú ⋮ → «Instalar aplicación». Sirve para conversaciones, anime, vídeos o cualquier audio japonés que suene cerca del móvil.

## Qué hace y con qué

- **Voz → texto**: reconocimiento de voz del navegador (Web Speech API, `ja-JP`) directamente del micrófono. En Chrome usa el servicio de Google: **el audio sale del dispositivo** mientras escucha y hace falta conexión.
- **Texto → rōmaji y diccionario**: el mismo motor que la extensión (kuromoji + JMdict + KANJIDIC2), dentro de la página, en un Web Worker. No sale nada del dispositivo.
- Texto provisional mientras se habla, que se confirma al acabar la frase; si la sesión se corta, lo provisional se conserva.
- Ajustes: japonés debajo (kanji o kana), tamaño, vocales largas, partículas, pantalla siempre encendida, y un cuadro para escribir o pegar japonés.
- Traducción: solo donde el navegador trae traductor integrado (hoy, Chrome de escritorio). **En el móvil no hay traducción** en este prototipo.

## Publicarla (hace falta HTTPS)

El micrófono y la instalación solo funcionan por **HTTPS** (o en `localhost`). La carpeta `web/` es estática y autónoma (504 archivos, 32 MB): se sube tal cual a cualquier alojamiento estático.

- **Cloudflare Pages** o **Netlify**: crear un sitio y arrastrar la carpeta `web/` (o `Kantoro_web_v0.1.0.zip`). Dan una dirección `https://…` para compartir con amigos.
- **GitHub Pages**: subir el contenido de `web/` a un repositorio y activar Pages (en el plan gratuito el repositorio debe ser público).

En el móvil: abrir la dirección en Chrome → ⋮ → «Instalar aplicación» (o el botón «Instalar» de la cabecera, cuando Chrome lo ofrece).

Probar en el PC sin publicar: `powershell -ExecutionPolicy Bypass -File tools\serve.ps1` y abrir `http://localhost:8765/web/` en Chrome.
Probar en el móvil sin publicar: con depuración USB, `adb reverse tcp:8765 tcp:8765` y abrir `http://localhost:8765/web/` en el Chrome del móvil.

## Estructura

```
index.html, app.css, app.js   interfaz (estética Edo, como la extensión)
engine-worker.js              motor en un Web Worker
sw.js, manifest.webmanifest   instalación y caché (los diccionarios se guardan la primera vez)
icons/                        sello 読 (192, 512 y versión adaptable)
engine/, lib/, kuromoji-dict/, data/   COPIAS de ext/ generadas por tools/build_web.ps1 (no editar aquí)
```

Tras cambiar `ext/engine` o `ext/data`: `powershell -ExecutionPolicy Bypass -File tools\build_web.ps1`. Al publicar una versión nueva, subir `SHELL_V` en `sw.js` y `VERSION` en `app.js`.

## Límites conocidos (prototipo)

- **Sin probar en un móvil real.** Probado en un navegador de escritorio con el reconocedor simulado y el diccionario real.
- **Android, sesión continua**: Chrome para Android repite resultados en modo continuo, así que por defecto allí se usa una frase por sesión y se reinicia al acabar. Entre sesiones puede perderse alguna palabra y algunos móviles emiten un pitido en cada inicio. El ajuste «Sesión continua» permite probar el otro modo.
- **Mismo móvil que reproduce el vídeo**: al activar el micrófono, Android puede pausar o bajar el audio de la otra app, y la web app no puede dibujarse encima de ella (sí en pantalla dividida). El caso que funciona con seguridad es el sonido que llega de fuera: una conversación, la tele, el ordenador.
- Ruido de fondo, música y varias voces a la vez empeoran el reconocimiento; no hay colores por personaje ni medición del retraso (el navegador no da acceso al audio mientras reconoce).
- Primera carga: descarga ~20 MB de diccionario antes de poder empezar; después queda guardado. Memoria: el analizador ocupa del orden de 200–270 MB.
- iPhone: Safari tiene reconocimiento de voz, pero no se ha probado y el diccionario comprimido requiere iOS 16.4 o posterior.

## Licencias

JMdict y KANJIDIC2 © EDRDG (CC BY-SA 4.0). kuromoji.js (Apache 2.0) + IPADIC (licencia NAIST).
