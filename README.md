# Kantoro — web app (prototipo 0.1.0)

Escucha japonés por el **micrófono** y lo muestra en **rōmaji** al momento, con el texto japonés debajo y una ficha de diccionario al tocar cada palabra. Pensada para el móvil (Chrome para Android) e instalable desde el menú ⋮ → «Instalar aplicación». Sirve para conversaciones, anime, vídeos o cualquier audio japonés que suene cerca del móvil.

## Qué hace y con qué

- **Voz → texto**, con dos motores a elegir (botones «Google | Local» encima del sello):
  - **Google**: dos variantes (Ajustes → «Reconocedor de Google»):
    - *Del navegador* (Web Speech API, `ja-JP`, gratis). En Android es el reconocedor del sistema: pausa los vídeos de otras apps al arrancar y deja de escuchar con Kantoro en segundo plano; si falla varias veces, la app pasa al motor local y avisa.
    - *Google Cloud Speech-to-Text* con una clave de API propia (0.4.0). La app abre su propio micrófono, corta el audio en frases por los silencios (máx. 6 s) y envía cada frase a `speech.googleapis.com`. Funciona con la ventana flotante y la app en segundo plano sin tocar el audio de otras apps. 60 min/mes gratis y después de pago; la app cuenta los minutos enviados. Para la clave: proyecto en console.cloud.google.com, activar «Cloud Speech-to-Text API» (pide cuenta de facturación), crear una clave de API restringida a esa API y al sitio web.
  - **Local**: [Vosk](https://alphacephei.com/vosk/) en WebAssembly con el modelo japonés pequeño (50 MB, se descarga la primera vez y queda guardado). Todo en el dispositivo, sin conexión y sin interrumpir otras apps; acierta menos que Google, sobre todo con música de fondo. Desde la 0.5.0 usa una copia del modelo con la búsqueda recortada (`models/vosk-model-small-ja-0.22-lite.tar.gz`, `conf/model.conf`: max-active 2500, beam 10, lattice-beam 2), micrófono en crudo leído sin AudioContext cuando el navegador lo permite, audio a 16 kHz y una puerta de ruido que deja al reconocedor en reposo cuando no suena nada.
- **Ventana flotante** (⧉): subtítulos encima de otras apps. En el ordenador se estira libremente; en el móvil se elige la forma en Ajustes y el tamaño se cambia pellizcándola.
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

JMdict y KANJIDIC2 © EDRDG (CC BY-SA 4.0). kuromoji.js (Apache 2.0) + IPADIC (licencia NAIST). vosk-browser (Apache 2.0) y modelo vosk-model-small-ja-0.22 de Alpha Cephei (Apache 2.0).
