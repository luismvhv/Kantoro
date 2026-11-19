# Kantoro — subtítulos japoneses en rōmaji para Chrome

> **Kantoro** (antes RomanJap). Además de esta extensión hay una **web app instalable para el móvil** que escucha japonés por el micrófono: ver [web/README.md](web/README.md).

Extensión Manifest V3 que lee los subtítulos, el texto japonés seleccionado y —mediante OCR— el japonés de imágenes, canvas y subtítulos incrustados, y dibuja encima un overlay en rōmaji, opcionalmente con una traducción, y una ficha de diccionario al pasar el ratón por cada palabra. El análisis se ejecuta **en local**; solo salen del equipo el audio si se usa el reconocimiento de voz de Google y el texto de cada frase si se usa la traducción en línea.

## Instalación

1. Descomprime el zip.
2. Abre `chrome://extensions`, activa **Modo de desarrollador**.
3. **Cargar descomprimida** → elige la carpeta `ext/`.
4. Requiere Chrome de escritorio **138 o superior** (por la API de traducción integrada).
5. Para traducir: abre el popup de Kantoro, elige «Rōmaji + traducción» y el idioma. Con el traductor en «Automático» (por defecto) se usa el integrado de Chrome si está descargado y, si no, el traductor en línea (Google Translate, con MyMemory de reserva). **Descargar modelo** es opcional: traduce en el dispositivo, sin enviar el texto.

Atajos: **Alt+R** activa/desactiva el overlay · **Alt+O** inicia/detiene la lectura del vídeo (OCR o audio, según el popup).

Al instalar o actualizar, la extensión se activa sola en las pestañas que ya estaban abiertas. Para **archivos locales** (`file://`, p. ej. una imagen abierta desde el disco) Chrome exige activar «Permitir acceso a URLs de archivo» en `chrome://extensions` → Kantoro → Detalles.

**Si algo no funciona, abre el popup**: la sección «Esta página» dice qué está detectando (o por qué no) y qué hacer.

## Qué hace

| Requisito | Cómo se cumple |
|---|---|
| Compatible con Chrome | MV3, Chrome 138+ (probado en Chromium 141). |
| Solo rōmaji o rōmaji + idioma | Selector en el popup; la traducción aparece **encima** del rōmaji. 46 idiomas destino; los principales primero. Traductor elegible: Automático, En línea o Integrado de Chrome. |
| Kanji, hiragana y katakana → rōmaji en < 100 ms | Análisis morfológico con kuromoji (IPADIC) + Hepburn. Medido en Chromium: **10–13 ms** con caché, **12–63 ms** en la primera aparición de una línea. |
| Hover → pausa + explicación | La pausa dura mientras el cursor esté dentro del cuadro de subtítulos (o de la ficha); al pasar de una palabra a otra solo cambia la ficha, y mientras tanto el cuadro no se redibuja. Pausa el `<video>` (incluso si está en otro iframe) y muestra: lectura, rōmaji, acepciones de JMdict (inglés + español cuando existe), categoría gramatical, registro (coloquial, honorífico…), cada kanji con on'yomi/kun'yomi, significado, trazos, JLPT y palabras frecuentes, y el papel gramatical de cada pieza en la frase (p. ej. まし = cortesía, た = pasado). Al retirar el ratón se reanuda. |
| Transcripción rigurosa | Ver la sección siguiente. |

**Fuentes de subtítulos detectadas automáticamente:** YouTube, Netflix, Prime Video, Disney+, Max, Video.js, JW Player, Plyr, Shaka, Bitmovin, ArtPlayer, DPlayer y cualquier `<video>` con pistas `<track>` nativas (estas se precalculan por adelantado: latencia prácticamente cero). Para cualquier otra web: popup → **Elegir subtítulos en la página** y haz clic sobre ellos; se recuerda por dominio.

**Otros textos:** selecciona cualquier texto japonés de una página y aparece su rōmaji con las mismas fichas al pasar el ratón.

### Subtítulos interceptados (Crunchyroll y otros reproductores)

Si el reproductor descarga un archivo de subtítulos japonés (`.ass`, `.ssa`, `.vtt`, `.srt`), Kantoro lo lee directamente: **texto exacto, sincronizado con el vídeo y con el rōmaji precalculado** (retraso medido: 13 ms, un fotograma).

- **Crunchyroll**: Kantoro observa la respuesta de su API de reproducción, que lista todas las pistas del episodio, y descarga la japonesa (`ja-JP`) **aunque tengas seleccionados los subtítulos en otro idioma**. Puedes ver en pantalla, a la vez, los subtítulos en español de Crunchyroll y el rōmaji del japonés.
- Muchos episodios de Crunchyroll **no traen pista japonesa**. El popup te lo dice («Este episodio trae subtítulos en es-ES, en-US… ninguno en japonés»), y entonces puedes usar el audio o el OCR.
- Hay que abrir o recargar el episodio con la extensión ya activa, para que vea la respuesta de la API.
- Solo se aceptan pistas realmente japonesas: una pista china (zh-TW, zh-CN…) usa los mismos kanji pero no lleva kana, y se descarta.

### Vídeo sin subtítulos de texto: OCR o Audio (a elegir en el popup)

El botón principal del popup y **Alt+O** (pulsar de nuevo para detener) usan la fuente elegida:

**OCR de la pantalla.** Marca la franja de los subtítulos. Kantoro recibe la pestaña como vídeo (`tabCapture`, hasta 30 fps, sin el límite de 2 capturas/s de las capturas de pantalla), detecta cada cambio de texto, espera a que se estabilice y solo entonces lo reconoce.
- Prueba con subtítulos cambiando cada 1,5 s sobre fondo claro en movimiento: **13/13 frases captadas, retraso medio 0,33 s** (máximo 0,58 s). La versión anterior captaba ~1 de cada 5 con más de 1 s.
- Se aísla el texto por su contorno oscuro (elimina el fondo del vídeo). Los vídeos con DRM salen negros en la captura, lo que no impide leer los subtítulos dibujados encima.

**Audio (voz).** La etiqueta roja muestra un monitor en vivo: nivel del audio que llega (▮▮▮▮), si el reconocedor detecta voz y cuántos resultados lleva. Si no llega sonido (vídeo en pausa, o audio entregado mudo por protección DRM) o si llega audio pero el reconocedor no devuelve texto, lo indica con el motivo.
Funcionamiento: el audio se captura en el motor de la extensión (y se devuelve a los altavoces). El reconocedor, en cambio, se ejecuta en un marco invisible dentro de la propia pestaña, porque Chrome aborta el reconocimiento de voz (`aborted`) en documentos ocultos. El audio le llega en trozos de ~45 ms a 16 kHz. Ese marco se coloca siempre en la página principal: los marcos de los reproductores (como el de Crunchyroll) no permiten funciones de voz. Si la web las prohíbe en toda la página, Kantoro abre una pequeña ventana propia para el reconocimiento (no la cierres; puede quedar detrás).
El audio de la pestaña pasa al reconocedor de voz de Chrome (Web Speech API con pista de audio). Las palabras aparecen mientras se dicen (resultados parciales) y se fijan al terminar cada frase.
- **Motor de voz** (popup → «Motor de voz»), desde la 1.6:
  - *Automático* (por defecto): reconoce **en el dispositivo** si la voz japonesa está instalada; si no, usa el **servicio de Google**. Si el motor en uso falla o no devuelve nada, cambia al otro sin detener la transcripción (lo avisa y la etiqueta indica cuál se usa).
  - *En el dispositivo* (privado, Chrome 139+): pulsa «Descargar voz japonesa» una vez (lo descarga Chrome; el audio no sale del equipo).
  - *Servicio de Google*: el audio de la pestaña se envía a Google.
- Ruido: el reconocedor solo produce texto cuando detecta habla; se descartan los resultados sin japonés. No se filtra por confianza: en anime, con música y efectos, frases correctas llegan con confianza baja.
- Vigilante anti-atascos: si una frase crece sin cerrarse, se fuerza su cierre; si entra **voz** (no solo música: se usa el detector de tono) durante ~2,2 s y el reconocedor no devuelve nada, se reinicia al instante. Si los reinicios no lo arreglan (una canción), el plazo se alarga para no reiniciar sin parar.
- Para no perder palabras: (1) lo que el reconocedor tenía "en curso" se confirma si la sesión se corta, si abandona esa hipótesis por otra sin confirmarla, o si la deja vacía sin dar un resultado final; (2) en cada reinicio se le reinyecta **todo el audio que no llegó a transcribir** (desde el corte, o desde su último resultado si estaba sordo; entre 1 y 5 s), eliminando las repeticiones; (3) el texto provisional se compone con todos los tramos sin confirmar, no solo con el último que cambió; (4) las frases confirmadas se procesan todas y en orden.
- Contexto para acertar la palabra: se piden al reconocedor varias alternativas por frase y se elige con el diccionario (la que tiene menos palabras inexistentes) y con el vocabulario de la sesión (nombres en katakana y términos en kanji que ya han salido, más los del título de la pestaña). Si no hay una ventaja clara, se respeta la primera. En el motor local, ese vocabulario se pasa además al reconocedor como frases de contexto (si el Chrome instalado lo admite).
- Audio para el reconocedor: filtro paso alto (90 Hz) y paso bajo (7,2 kHz), en trozos de ~21 ms. No se usa compresor, porque subía la música hasta el nivel de la voz; sí una **ganancia automática lenta** (hasta ×8, igual para voz y fondo) cuando la pestaña suena baja, para las voces flojas.
- **Retraso medido**: la etiqueta muestra «retraso ≈ 0,xx s» = tiempo desde que empieza a sonar una voz (tras un silencio) hasta que su primer texto está en pantalla. Úsalo para comparar los dos motores en tu equipo.
- Visualización (popup → «Mostrar la voz»): *Frase a frase* (cada frase se mantiene al menos 2,5 s; máximo 2 renglones por personaje) o *Desplazamiento continuo* (cinta de ancho fijo anclada a la derecha: las palabras entran por la derecha y salen por la izquierda). La traducción se hace solo de frases completas.
- Personajes (popup → «Distinguir personajes por la voz»): cada frase se asigna a un personaje según su tono (suma de subarmónicos, con el fondo musical restado) y su timbre (MFCC). Cada personaje tiene un color y los dos últimos que hablan van en carriles separados, uno encima del otro. Pruebas con voces sintéticas y música de fondo: 15/15 frases bien agrupadas en un diálogo de 3 voces y 17/20 en otro de 4 voces con dos parecidas; a través de la extensión real, 14/15. Es una aproximación: las voces de tipo distinto se separan bien, pero las parecidas pueden confundirse.
- Retraso: desde que el reconocedor entrega una palabra, Kantoro la pinta en unas decenas de ms, y si llegan varias versiones provisionales seguidas solo se analiza la más reciente (la pantalla nunca va por detrás del reconocedor). El retraso total depende del reconocedor de Chrome: **ninguno puede escribir una palabra antes de oírla entera**, así que el mínimo realista son unas décimas de segundo tras cada palabra. El objetivo es quedar por debajo de 0,5 s; el valor real de tu equipo es el que muestra la etiqueta.
- La pestaña sigue sonando con normalidad durante la captura.

### Estética

Desde la 1.6 toda la interfaz sigue una estética de época Edo: papel washi, tinta sumi, bermellón de sello (hanko), índigo con olas seigaiha y oro. El popup es una hoja de washi con cabecera de noren índigo; la ficha de diccionario y el panel de OCR son hojas colgadas como un rollo; los subtítulos van sobre tinta translúcida con filetes dorados; y la burbuja es un sello 読 («leer»). Si el equipo no tiene ninguna fuente mincho instalada, el japonés se muestra con Yu Gothic / Meiryo.

### Sello flotante (antes «burbuja»)

En páginas con vídeo aparece un sello bermellón 読 (arrástralo para moverlo). Al pulsarla se abre el panel de Kantoro **dentro de la página**, también en pantalla completa, sin salir de ella. Se configura en «Overlay → Burbuja flotante» (solo con vídeo / siempre / nunca).
Chrome solo deja capturar una pestaña después de activar la extensión en ella una vez (icono de la barra, Alt+O o menú contextual). A partir de ahí, la burbuja puede iniciar el OCR rápido o el audio. Si no, el OCR usa el método de respaldo.

### Palabras que no están en el diccionario

Si una palabra japonesa no está en JMdict (casi siempre un nombre propio), se muestra una **lectura estimada** carácter a carácter con KANJIDIC2, en cursiva y subrayada, y la ficha avisa de que es una estimación.

### OCR de imágenes y texto fijo

- *Imagen / texto fijo* en el selector de zona: panel con cada frase en rōmaji, el japonés reconocido y la traducción. Al pasar por una frase se resalta en la imagen.
- **Clic derecho sobre una imagen → «Kantoro: leer el texto japonés de esta imagen»** (resolución original, más preciso).
- Se **borran las líneas de furigana** antes de reconocer. El cuento de prueba (texto de 22 px con furigana): 1 carácter dudoso de ~150. Los caracteres de baja confianza se subrayan en rojo.

## Sobre el rigor de la transcripción (importante)

La conversión de **kana** a rōmaji es determinista y exacta. La lectura de los **kanji**, en cambio, depende del contexto (今日 = *kyou* o *konnichi*; 何 = *nani* o *nan*; los nombres propios pueden leerse de muchas formas), así que ningún sistema automático puede garantizar el 100 %. Lo que hace Kantoro para acercarse al máximo y ser honesto cuando no puede:

- Usa el análisis morfológico completo (no kanji a kanji), que acierta la inmensa mayoría de lecturas en diálogo normal.
- Contrasta cada palabra con JMdict; los compuestos solo se unen si la lectura coincide con el diccionario.
- **Subraya con puntos** las palabras cuya lectura tiene alternativas comunes registradas, y la ficha las lista. Si una palabra no figura en ningún diccionario, se deja en su forma original entre corchetes en vez de inventar una lectura.

Texto japonés bajo el rōmaji (popup → «Mostrar también el texto japonés»): en todos los modos, como se escribe (kanji y kana) o solo en hiragana y katakana (los kanji se sustituyen por su lectura; el katakana se conserva). En la cinta de voz, cada palabra lleva su japonés justo debajo.

Opciones de estilo (popup): vocales largas literales (*toukyou*) o con macrón (*tōkyō*); partículas は/へ/を como se pronuncian (*wa/e/o*) o como se escriben (*ha/he/wo*); ん ante b/m/p como *n* o *m*.

## Limitaciones conocidas

- **OCR**: ≈0,2–0,6 s por cambio de subtítulo con captura de pestaña; no llega a 0,1 s ni garantiza el 100 % de exactitud: revisa los caracteres subrayados en rojo. Si Chrome no concede la captura de pestaña, se usa el método antiguo de capturas de pantalla (más lento).
- **Audio**: la exactitud depende del reconocedor de Chrome y empeora con música, efectos o varias voces a la vez. Úsalo cuando no haya subtítulos japoneses; la pista de subtítulos interceptada siempre es más exacta. Solo texto **horizontal** (el texto vertical de manga no está soportado). Los vídeos con DRM (Netflix, Prime, a veces Crunchyroll) salen en negro en la captura, pero eso no impide leer subtítulos dibujados encima.
- **Crunchyroll / Prime Video en España** casi nunca ofrecen subtítulos en japonés: si los subtítulos activos están en español, no hay japonés que leer (el popup lo indica).
- **Traducción:** la hace el modelo integrado de Chrome o, si no está disponible para ese idioma o equipo, el traductor en línea (no es una API oficial de Google: para uso comercial habría que pasar a una de pago). En subtítulos DOM suele llegar en unas décimas de segundo tras el rōmaji (que se pinta primero, sin esperar); en pistas `<track>` se precalcula y aparece a la vez. Es una traducción automática: útil, pero no literal.
- **Memoria:** el analizador mantiene cargado el diccionario IPADIC (~270 MB en un único documento de la extensión, compartido por todas las pestañas). El arranque tarda ~2–3 s una vez por sesión del navegador.
- Netflix y otros servicios cambian sus clases CSS de vez en cuando; si deja de detectar, usa «Elegir subtítulos en la página».

## Estructura

```
ext/
  manifest.json
  background.js          service worker: crea el motor offscreen, relés entre marcos, atajo Alt+R
  offscreen/             motor: kuromoji + JMdict + OCR + Translator API (un solo documento para todas las pestañas)
  engine/ocr.js          OCR: borrado de furigana, aislamiento de subtítulos, Tesseract
  engine/capture.js      captura de pestaña: OCR por fotogramas y envío del audio al reconocedor
  asr/                   reconocedor de voz (marco invisible dentro de la pestaña)
  engine/diarize.js      distinción de personajes por tono y timbre
tools/test_diarize.js, tools/sweep_*.js  evaluación y ajuste de la distinción de personajes
  engine/subparse.js     lector de subtítulos ASS/SSA/VTT/SRT
  content/hook.js        Crunchyroll: observa la lista de pistas de subtítulos de su API (mundo principal de la página)
  ocr/                   Tesseract.js (worker, núcleo WebAssembly y modelo jpn)
  engine/romaji.js       kana → Hepburn (yōon, sokuon, ん, ー, combinaciones de préstamos)
  engine/analyzer.js     tokens → palabras, verificación con JMdict, explicación gramatical
  engine/dict.js         acceso a diccionarios fragmentados (carga bajo demanda + LRU)
  content/content.js     detección de subtítulos, overlay (shadow DOM), ficha, pausa, selección, selector manual
  popup/                 ajustes
  data/                  JMdict (eng + spa) y KANJIDIC2 compilados en 476 fragmentos .json.gz
  kuromoji-dict/         diccionario IPADIC de kuromoji
tools/build_dicts.py     regenera data/ desde jmdict-simplified
tools/test_engine.js     pruebas del motor en Node
test/                    páginas de prueba + pruebas E2E con Playwright (incl. Crunchyroll simulado por HTTPS)
test/h_asr.html, h_content.html, h_popup.html   bancos de pruebas que solo necesitan un navegador (chrome.* y reconocedor simulados)
tools/serve.ps1          servidor estático para esos bancos en Windows sin Node ni Python
```

Bancos de pruebas sin Node ni Python (Windows): ejecuta `powershell -ExecutionPolicy Bypass -File tools\serve.ps1`, abre `http://localhost:8765/test/h_asr.html` (lógica del reconocedor, 12 comprobaciones) o `http://localhost:8765/test/h_content.html` (interfaz de la voz, 7 comprobaciones) y ejecuta `runAll()` en la consola. `h_popup.html?av=downloadable` muestra el popup con la descarga de la voz japonesa simulada.

Para actualizar JMdict: descarga `jmdict-eng`, `jmdict-spa` y `kanjidic2-all` de https://github.com/scriptin/jmdict-simplified/releases, descomprímelos en una carpeta y ejecuta `python3 tools/build_dicts.py <carpeta> ext/data`.

## Licencias de terceros

- JMdict y KANJIDIC2 © Electronic Dictionary Research and Development Group, CC BY-SA 4.0.
- Tesseract.js / Tesseract OCR, Apache 2.0; modelo `jpn` de tessdata_best (Apache 2.0).
- kuromoji.js © Takuya Asano, Apache 2.0. Diccionario IPADIC © NAIST, licencia propia (permite redistribución).
