# Kantoro — documento de traspaso para Claude Code

> Extensión de Chrome (Manifest V3) que lee el japonés que aparece en pantalla (subtítulos, texto, imágenes, audio) y dibuja encima un overlay con **rōmaji**, opcionalmente con traducción, y una **ficha de diccionario** al pasar el ratón por cada palabra.
> El proyecto se llamaba **RomanJap** hasta el 17-nov-2026; ahora es **Kantoro** en todas partes (carpeta, textos, identificadores `kantoro-layer`, `__kantoro`, `kantoroBubble`…). Los prefijos `RJ` de los módulos (`RJDict`, `RJAnalyzer`…) y el puerto `rj-asr` se han dejado.
> Además de la extensión hay una **web app instalable** (`web/`, prototipo 0.1.0) que escucha por el micrófono: ver §16.
> Versión actual de la extensión: **1.7.1**. Autor/usuario: Luis. Idioma de trabajo con el usuario: **español**.
> Este archivo está pensado para dejarlo como `CLAUDE.md` en la raíz del repositorio.

---

## 0. Cómo usar este documento

- §1–2: qué pidió el usuario y cómo trabaja; léelo antes de proponer cambios.
- §3–10: **cómo está construida la versión actual** (lo importante para continuar): arquitectura, archivos, motor, fuentes de texto, interfaz, captura (OCR y voz), ajustes y mensajes.
- §11: pruebas y cómo ejecutarlas.
- §12: lecciones aprendidas y trampas de Chrome que ya costaron iteraciones. **Léelas antes de tocar captura, voz u OCR.**
- §13: limitaciones conocidas y lo que no está verificado en Chrome real.
- §14: historial de versiones y qué arregló cada una.

---

## 1. Requisitos originales del usuario (y cómo han evolucionado)

Petición inicial (20-oct-2026):
1. Compatible con Google Chrome.
2. Elegir entre mostrar **solo rōmaji** o **rōmaji + otro idioma** (desplegable), con la traducción **encima** del rōmaji.
3. Transcribir kanji, katakana e hiragana a rōmaji en tiempo real, **< 100 ms**.
4. **Hover** sobre una palabra en rōmaji: pausar el reproductor y mostrar una explicación (kanji que la componen, significado y usos).
5. Transcripción "100 % rigurosa y literal".

Peticiones posteriores, por orden:
- Que funcione en **Crunchyroll** (lo más importante), YouTube, Prime Video y con **imágenes** (p. ej. un cuento escaneado con furigana).
- **OCR** para imágenes, canvas y subtítulos incrustados. Después: que no se salte frases y tenga menos retraso.
- **Reconocimiento de voz** del audio de la pestaña como alternativa elegible al OCR. Requisitos: distinguir palabras de ruido, ≤ 0,1 s, reconocer todas las palabras (voces agudas o graves, bajo volumen) y mostrarlas siempre, aunque sea tarde.
- **Burbuja flotante** para abrir el panel sin salir de pantalla completa.
- Visualización de la voz: **frase a frase** o **cinta con desplazamiento** (las palabras entran por la derecha y salen por la izquierda; ancho fijo, anclada a la derecha).
- **Distinguir personajes** por la voz, con colores y un carril para cada uno (uno encima del otro).
- Palabras que no están en JMdict: mostrar una lectura estimada en rōmaji en vez del kanji.
- Hover: mantener la pausa mientras el cursor esté dentro del cuadro de subtítulos y cambiar solo la ficha al pasar de palabra en palabra.
- **Texto japonés bajo el rōmaji**, con opción de escritura «kanji y kana» o «hiragana y katakana».

Petición de la 1.6.0 (16-nov-2026): optimizar al máximo la voz — texto en pantalla en **menos de ~0,5 s** desde que suena la palabra, **no saltarse ninguna palabra** y acertarla combinando lo que el reconocedor ha entendido con el **contexto**; que funcione **tanto con la API de Google como con el japonés descargado en el dispositivo**; mantener el OCR; y dar a toda la extensión una **estética de Japón feudal / época Edo**. Los cambios de 1.6.0 están probados con bancos de pruebas en navegador (reconocedor y `chrome.*` simulados), **no en Chrome real con la extensión cargada**: falta la confirmación del usuario.

Estado según el usuario (último feedback, v1.5): la intercepción de subtítulos de Crunchyroll funciona, y el reconocimiento de voz «reconoce prácticamente todas las palabras». Los cambios de **1.5.1** (hover y texto japonés) están probados en Chromium automatizado, pero **aún no los ha confirmado el usuario**.

## 2. Cómo trabaja el usuario (preferencias observadas)

- Responde y documenta en **español**.
- Exige rigor. Sé **honesto con los límites**: no prometas el 100 % de exactitud de voz u OCR ni ≤ 100 ms donde la física o Chrome no lo permiten. Explica qué sí se garantiza y mídelo.
- Prueba en su Chrome real (Windows, Chrome reciente) con Crunchyroll, Prime Video y YouTube, y manda capturas de errores. El popup y el monitor de la etiqueta roja existen sobre todo para diagnosticar a partir de sus capturas.
- Instala con «Cargar descomprimida» (carpeta `ext/`). Tras cada cambio: sustituir `ext/`, pulsar ↻ en `chrome://extensions` y recargar la pestaña.
- Entrega habitual: zip con `README.md`, `ext/`, `tools/` y `test/`.

---

## 3. Arquitectura general

```
┌──────────────── Pestaña (cada marco) ────────────────┐      ┌────────── Service worker ──────────┐
│ content/content.js  (todas las URLs, all_frames)      │◄────►│ background.js                      │
│   · detecta fuentes de subtítulos (DOM, <track>,      │      │   · crea/vigila el documento       │
│     archivos interceptados)                           │      │     offscreen (motor)              │
│   · overlay (shadow DOM), ficha, panel OCR, burbuja   │      │   · inyecta en pestañas abiertas   │
│   · hover → pausa del <video>                         │      │   · webRequest: archivos .ass/.vtt │
│   · inserta asr/asr.html (iframe invisible) en el     │      │   · tabCapture → streamId          │
│     marco SUPERIOR para la voz                        │      │   · relés entre marcos, menús,     │
│ content/hook.js (solo crunchyroll.com, world MAIN)    │      │     atajos, estado por pestaña     │
│   · observa fetch/XHR → lista de pistas de subtítulos │      └──────────────┬─────────────────────┘
└───────────────────────────────────────────────────────┘                     │ chrome.runtime msgs
        ▲  port "rj-asr" (PCM 16 kHz)                                         ▼
┌───────┴──────────────── asr/asr.html (iframe/ventana) ┐      ┌──── offscreen/offscreen.html (motor) ───┐
│ asr.js: SpeechRecognition.start(pista generada)       │◄─────│ kuromoji + JMdict/KANJIDIC2 (analyzer)  │
│ diarize.js: quién habla                               │ PCM  │ Tesseract (OCR)                          │
└───────────────────────────────────────────────────────┘      │ capture.js: getUserMedia(tab) → audio a  │
                                                               │   altavoces, OCR por fotogramas, bomba   │
                                                               │   de PCM al reconocedor                  │
                                                               │ Translator API (traducción local)        │
                                                               └──────────────────────────────────────────┘
```

Principios de diseño:
- **Todo en local** salvo el reconocimiento de voz en modo «servicio de Google» (opcional).
- **Un único documento offscreen** compartido por todas las pestañas (≈270 MB por IPADIC). Arranque ≈ 2–3 s una vez por sesión del navegador.
- Las capas visibles se pintan en **shadow DOM** (`<kantoro-layer>`) para no heredar CSS de la página. En pantalla completa se cuelgan del `document.fullscreenElement`.
- Los módulos de `engine/` son **UMD** (`globalThis.RJxxx` y `module.exports`) para poder probarlos en Node.

## 4. Mapa de archivos

```
ext/
  manifest.json            MV3; permisos: storage, offscreen, activeTab, scripting, contextMenus, tabCapture, webRequest
                           host_permissions <all_urls>; CSP extension_pages con 'wasm-unsafe-eval' (Tesseract)
                           web_accessible_resources: popup/*, icons/*, asr/* (use_dynamic_url)
                           commands: Alt+R (activar/desactivar), Alt+O (OCR/audio; pulsar otra vez = detener)
  background.js     (291)  service worker
  offscreen/offscreen.html|js (110)  motor: análisis, explicación, traducción, OCR, captura
  engine/romaji.js  (141)  kana → Hepburn (puro)
  engine/dict.js     (82)  acceso a JMdict fragmentado + LRU
  engine/analyzer.js(333)  kuromoji → palabras → rōmaji + verificación JMdict + explicación para la ficha
  engine/subparse.js (94)  parser ASS/SSA/VTT/SRT + detección japonés vs chino (también en content scripts)
  engine/ocr.js     (276)  OCR (Tesseract) con borrado de furigana y aislamiento de subtítulos
  engine/capture.js (179)  tabCapture en offscreen: OCR por fotogramas + bomba de PCM para la voz
  engine/diarize.js (210)  distinción de personajes (tono SHS + timbre MFCC, agrupamiento en línea)
  content/content.js(1607) todo lo visible en la página (ver §7)
  content/hook.js    (73)  Crunchyroll, mundo MAIN: observa respuestas JSON de la API y archivos de subtítulos
  asr/asr.html|js   (204)  reconocedor de voz (iframe invisible en la pestaña, o ventana propia)
  popup/popup.html|css|js (289)  ajustes + diagnóstico; también se carga dentro de la burbuja (iframe)
  lib/kuromoji.js          kuromoji 0.1.2 PARCHEADO (path.join → concatenación de URL)
  kuromoji-dict/           diccionario IPADIC de kuromoji (18 MB)
  data/jmdict/             f0..f255.json.gz (índice forma→ids), e0..e218.json.gz (entradas), meta.json
  data/kanji.json.gz       KANJIDIC2 compacto + palabras frecuentes por kanji
  ocr/                     tesseract.js 7.0.0 (tesseract.min.js, worker.min.js, worker-quiet.js),
                           core/*.wasm.js (lstm, simd-lstm, relaxedsimd-lstm), lang/jpn.traineddata.gz (4.0.0_best_int)
  icons/                   16/32/48/128 png (círculo rojo con cuadrado blanco)
tools/
  build_dicts.py           genera data/ desde jmdict-simplified (eng, spa, kanjidic2-all)
  test_engine.js           pruebas del motor en Node (frases → rōmaji)
  test_diarize.js, sweep_pitch.js, sweep_cluster.js   evaluación y ajuste de diarize.js
test/                      páginas de prueba + scripts Playwright (ver §11)
README.md                  documentación de usuario (español)
```

Tamaño: `ext/` ≈ 47 MB (data 16 MB, kuromoji-dict 18 MB, ocr 14 MB). Zip ≈ 37 MB.

## 5. Motor de texto (offscreen)

### 5.1 Diccionarios (`tools/build_dicts.py`)
- Fuente: https://github.com/scriptin/jmdict-simplified (release 3.6.2+20261019180022): `jmdict-eng` (completo, 218.930 entradas), `jmdict-spa` (glosas en español, 34.310) y `kanjidic2-all` (10.384 kanji, significados en/es).
- Entrada compacta: `k: [[forma, común]]`, `r: [[lectura, común, appliesToKanji?]]`, `s: [{p: POS, g: glosas, m: misc, f: field, i: info, ak, ar}]`, `es: glosas ES por sentido`, `c: 1` si es común. Las comunes van primero.
- **Fragmentado**: 256 fragmentos del índice por hash **FNV-1a 32 bits sobre unidades UTF-16** (`fnv` idéntico en Python y JS; si cambias uno, cambia el otro) y fragmentos de 1000 entradas. Carga bajo demanda con LRU (160 fragmentos de formas, 80 de entradas). Cargar todo en memoria costaba 243 MB y 1,8 s; por eso se fragmentó.
- `kanji.json.gz`: `{s: trazos, g: grado, j: JLPT, f: frecuencia, on, kun, n: nanori, en, es, w: hasta 8 palabras comunes ≤4 caracteres}`. Para las glosas de `w` se usa el español si existe y tiene paréntesis equilibrados; si no, el inglés.
- Regenerar: descargar los tres JSON, descomprimir en una carpeta y ejecutar `python3 tools/build_dicts.py <carpeta> ext/data`.

### 5.2 Análisis (`engine/analyzer.js`)
1. Normaliza NFKC y separa por líneas; tokeniza con kuromoji (IPADIC).
2. Consulta en JMdict superficies, formas base y compuestos candidatos (hasta 4 tokens nominales seguidos).
3. **Fusión de compuestos** (日本+語 → 日本語) solo si la forma unida existe en JMdict. Elección de lectura: (a) concatenación de lecturas de kuromoji si es una lectura común en JMdict, (b) si no, la primera lectura común (p. ej. 二人 → ふたり, no ににん), (c) concatenación si existe aunque no sea común, (d) lectura única.
4. **Agrupación en palabras**: verbo/adjetivo + auxiliares (pegados), て/で/ば conjuntivos tras verbo, sufijos (さん/様 de nombre con guion: `tanaka-san`), っ + lo siguiente (言っ+てる → itteru).
5. Rōmaji por palabra; protección de la -u final de verbos en modo macrón (omou, no omō).
6. **Verificación**: palabras con kanji en forma diccionario o compuestas se contrastan con JMdict; si hay otras lecturas comunes, `amb = true` (subrayado de puntos) y `alt`/`ra` llevan las alternativas.
7. **Palabras desconocidas** (no están en JMdict ni tienen lectura de kuromoji): `_guess()` estima la lectura carácter a carácter con KANJIDIC2 (kun'yomi si es un kanji suelto, on'yomi en compuestos; `々` repite el anterior). Se marca `guess: true` (cursiva y aviso en la ficha). Si no se puede estimar, se deja el original.
8. Espaciado tipográfico: sin espacio tras signos de apertura ni antes de signos de cierre.
- Salida por palabra: `{s, k, r, punct, amb, guess, alt, ra, open, close, toks:[{s,b,pos,d1,d2,cf,ct,k}], comp, sp}`.
- `explain(word)`: hasta 3 entradas JMdict ordenadas por (común, coincidencia de lectura, forma), sentidos con POS/misc traducidos al español (`JM_POS_ES`, `JM_MISC_ES`), glosas en español; kanji con on/kun (on en MAYÚSCULAS), trazos, JLPT, grado y palabras frecuentes; y gramática por token (`POS_ES`, `DETAIL_ES`, `CFORM_ES`, `AUX_ES`, `PRT_ES` con explicaciones de partículas y auxiliares).
- Caché de 2000 análisis. Calentamiento al arrancar con ~33 frases de diálogo típicas (`WARMUP` en `offscreen.js`) para precargar los fragmentos frecuentes.

### 5.3 Rōmaji (`engine/romaji.js`)
Hepburn modificado: yōon, combinaciones de préstamos en katakana (ふぁ, てぃ, ゔぁ, しぇ…), sokuon (っ ante consonante = duplicación, ante ch → `tch`, final → `’`), ん + vocal/y → `n'`, ん ante b/m/p → `n` o `m` (opción), ー → vocal repetida o macrón, iteración ゝゞ, puntuación japonesa → ASCII o tipográfica. Opciones: `longVowels` (`literal` tou/kyou | `macron` tō/kyō), `particles` (`phonetic` wa/e/o | `literal` ha/he/wo; se aplica con la *pronunciation* de kuromoji), `n` (`n` | `m`).

### 5.4 Traducción
Translator API de Chrome (138+), en el dispositivo. Se intenta en este orden: el offscreen, el propio marco y, desde un iframe de otro origen, el marco superior (relé `translateViaTop`). El modelo se descarga desde el popup (requiere un gesto del usuario). Hay 38 idiomas destino en el desplegable. Las cachés de traducción se limpian al cambiar de idioma.

## 6. Fuentes de texto japonés (orden de preferencia)

1. **Subtítulos interceptados** (texto exacto, retraso ≈ 1 fotograma, rōmaji precalculado):
   - `content/hook.js` (solo `*.crunchyroll.com`, `run_at: document_start`, `world: MAIN`) envuelve `fetch` y `XMLHttpRequest` **sin modificar nada**. En respuestas JSON cuya URL contiene play/stream/subtitle/caption/playback, busca objetos `subtitles`/`captions` con `{url, format, language|locale}` y los envía por `postMessage({__kantoro:'subs-index'})`. También reenvía archivos de subtítulos que contengan japonés (`subs-file`).
   - El SW (`subsIndex`) guarda los idiomas del episodio en el estado de la pestaña, elige `ja-*` (preferentemente `subtitles` antes que `captions`), lo descarga con `credentials:'omit'` y lo entrega a todos los marcos (`subFile`). Así se obtiene la pista japonesa **aunque el usuario tenga seleccionados subtítulos en español**.
   - `webRequest.onHeadersReceived` detecta en cualquier web archivos `.ass/.ssa/.vtt/.srt` o con tipo MIME de subtítulos.
   - Filtro **japonés frente a chino** (mismos kanji): locale `zh*/ko*/yue*` descartado; texto con >20 kana y kana ≥ 15 % de los kanji; en `subparse.looksJapanese`, ≥ 25 % de los cues con kana. Si ya hay una pista `ja-JP` oficial cargada, no se sustituye por otro archivo detectado.
   - El content script sincroniza con el `<video>` más grande (rAF + eventos seeked/play/pause/timeupdate), busca los cues activos con búsqueda binaria y precalcula el análisis (y la traducción) de todo el episodio, empezando por lo que viene a continuación. Ignora los archivos que pertenecen a un `<track>` de la página (ya los gestiona la ruta nativa).
2. **Subtítulos en el DOM**: selectores conocidos (`SITE_SELECTORS`: YouTube `.ytp-caption-window-container`, Netflix, Prime, Disney+, Max, Video.js, JW, Plyr, Shaka, Bitmovin, ArtPlayer, DPlayer) más el selector propio que elige el usuario por dominio (`customSelectors`, mediante «Elegir subtítulos»). Se observan con MutationObserver; la posición sale del rectángulo del texto (Range), no del contenedor.
3. **`<track>` nativos** (`textTracks` en modo `showing`): `cuechange` y precálculo de los próximos 45 s.
4. **Texto seleccionado** en cualquier página (≤ 500 caracteres).
5. **OCR** (§8.1) y **voz** (§8.2) para vídeo sin subtítulos de texto: el usuario elige cuál en el popup (`videoSource`).

## 7. Interfaz en la página (`content/content.js`)

- **Ciclo de vida**: `window.__kantoro = {alive, teardown}`. Si la extensión se recarga, el script huérfano se desmonta (AbortController + cleanups) y el nuevo lo sustituye. El SW inyecta `engine/subparse.js` + `content/content.js` (y `hook.js` en Crunchyroll) en las pestañas abiertas al instalar o actualizar.
- **Overlay** (`class Overlay`): caja con posición fija y bucle rAF que la reposiciona. Métodos: `render(text)` (analiza y dibuja), `draw(res, note)` (subtítulos de texto; traducción encima, rōmaji y, si `showOriginal`, línea japonesa debajo), `drawLanes(lanes, {ticker})` (voz por carriles, §8.2), `setTr`, `hide`, `destroy`. `opts.selection` = sin pausa; `opts.ocr` = nunca tapar (si no, se capturaría a sí mismo).
- **Texto japonés bajo el rōmaji**: `jaOf(word)`/`jaLine(words)`. Con `origScript:'kana'`, los tokens con kanji se sustituyen por su lectura en hiragana (`tok.k`) y lo que ya es kana se deja tal cual (katakana, は/へ/を); las palabras se separan con espacios salvo ante la puntuación. En la cinta de voz cada palabra es un bloque `.wd` (rōmaji arriba y `.jw` japonés debajo) para que se desplacen juntos.
- **Ficha (tooltip) y sesión de hover** (`tip`):
  - Entrar en una palabra `.w` → `tip.enter()` → empieza una **sesión** (`startSession`). La primera vez pausa los vídeos (`mediaAction('pause', token)`, también en otros marcos mediante el SW).
  - Durante la sesión, el Overlay dueño está **congelado**: `render/draw/drawLanes/hide` se guardan como `pending` y no tocan el DOM (`frozen()`/`flush()`). Esto evita que la palabra bajo el cursor se sustituya o desaparezca.
  - La sesión termina cuando el puntero lleva > 250 ms fuera de la caja (+10 px), de la ficha y del pasillo vertical entre ambas. Se vigila con `pointermove` (capture) y un intervalo, **no con mouseout**, así que no la cortan los espacios entre palabras ni los redibujados. Al terminar: ocultar la ficha, reanudar si `resumeOnLeave` y aplicar `flush()`.
  - Pasar a otra palabra solo cambia el contenido de la ficha. La ficha va encima de la palabra o debajo; si no cabe, se ajusta su altura. En el panel OCR va a un lado del panel.
  - Contenido: cabecera (forma, kana, rōmaji, aviso de ambigüedad o de lectura estimada), significados (ES/EN), kanji (on/kun, trazos, JLPT, palabras frecuentes), uso gramatical en la frase y créditos.
- **Panel OCR** (`panel`): lista de frases (agrupa líneas hasta el final de frase), con rōmaji, japonés con caracteres dudosos subrayados en rojo y traducción. Al pasar por una línea se resalta su zona en la imagen. Botones: Otra zona, Copiar, ✕.
- **Selector de zona** (OCR): capa a pantalla completa para arrastrar un rectángulo, con dos modos: «Imagen / texto fijo» (una vez → panel) y «Subtítulos de vídeo (continuo)». Añade un margen automático de 8 px.
- **Etiqueta roja (pill)** del modo continuo y de la voz: muestra el estado y ✕ para detener. En voz incluye el **monitor**: nivel de audio ▮▮▮▮, voz detectada o nº de resultados, nº de voces, avisos («No llega sonido…», «el reconocedor no devuelve texto (error: …)») y un `title` con el JSON de estado (`nivel`, `reconocedor`: results, sound, speech, starts, ends, error, chunks, mode, forced, deaf, promoted, preroll, voices, visible).
- **Burbuja flotante**: botón rojo de 42 px que se puede arrastrar (posición en `localStorage.kantoroBubble`). Al pulsarla abre `popup/popup.html` en un iframe dentro de la página, también en pantalla completa. Se muestra según `bubble`: `video` (si hay vídeo ≥ 200×120, un iframe ≥ 400×225 o pantalla completa), `always` o `never`. El popup detecta que va incrustado (`EMBEDDED`) y se cierra con `postMessage({__kantoroPanel:'close'})`. El panel se coloca junto a la burbuja sin taparla.
- **Avisos (toast)** `notice` para errores al iniciar con atajo o menú (sin popup abierto).
- **Selector manual de subtítulos** (`pick`): resalta el bloque bajo el cursor y guarda un selector CSS por dominio.
- **Diagnóstico** `window.__kantoroProbe()` (lo llama el popup con `scripting.executeScript` en todos los marcos): fuentes, pistas, vídeos, canvas, imágenes, si hay texto japonés, estado del OCR/voz y del archivo de subtítulos.

## 8. Captura de pestaña: OCR y voz

`startSource(tabId, mode)` en el SW: obtiene el `streamId` (`chrome.tabCapture.getMediaStreamId`; **requiere un gesto**: lo pide el popup durante el clic y se lo pasa al SW; también vale el atajo o el menú). Luego `capStart` en el offscreen con `getUserMedia({chromeMediaSource:'tab'})`, vídeo con el tamaño exacto del viewport × devicePixelRatio, y audio devuelto a los altavoces con un `AudioContext` (capturar silencia la pestaña). `Alt+O` con captura activa = detener. Estado por pestaña en `chrome.storage.session` (`tab<id>`: capture, asrFrame, asrCfg, asrWindow, subLoaded, subLocales, subJa, subError, capError).

### 8.1 OCR (`engine/ocr.js`, `engine/capture.js`)
- Tesseract 7 con `jpn` 4.0.0 best_int; núcleo **SIMD estándar** (no relaxed-SIMD); worker `ocr/worker-quiet.js` (silencia los avisos «Parameter not found» que aparecían en `chrome://extensions`); un único worker y cola en serie.
- Las imágenes se pasan a Tesseract como **PGM generado a mano** (no `convertToBlob`, ver §12).
- `page` (imágenes y texto impreso): grises normalizados, invertidos si el fondo es oscuro; **se borran las franjas de furigana** (franjas finas pegadas encima de una línea normal) antes del OCR; escala **entera** 1/2/3 según la altura mediana de línea; **PSM 6**; filtro de líneas por altura y confianza ≥ 35; `lineText()` quita restos de furigana por geometría de símbolos y marca los caracteres con confianza < 60.
- `subs` (subtítulos de vídeo): máscara = píxeles claros y poco saturados **cerca de un contorno oscuro** (dilatación de 3 px), lo que elimina el fondo del vídeo. Si apenas hay, usa el texto oscuro. Franjas horizontales → cada línea se recorta, se rellena, se escala y se reconoce con **PSM 7**.
- `fixText`: quita espacios entre caracteres japoneses; `ー` tras un no-kana → `一`; quita basura de los extremos.
- **Modo continuo con stream** (`capture.js ocr()`): `MediaStreamTrackProcessor` lee fotogramas de hasta 30 fps; toma muestras cada ~45 ms; calcula la huella de la máscara (64×16) y **espera a que el cambio se estabilice** (dos muestras iguales) antes de reconocer; descarta fotogramas mientras Tesseract trabaja; envía `ocrPush` con `seq`. Las coordenadas viewport→fotograma contemplan bandas negras.
- **Respaldo** sin stream: `captureVisibleTab` (máx. 2/s) + `ocrCapture` con huella para saltarse lo repetido.
- Menú contextual sobre una imagen: OCR de la imagen original por URL; si falla (p. ej. `file://` sin permiso), recurre a capturar la zona visible.

### 8.2 Voz
Flujo: offscreen `capPump` → `ScriptProcessor(1024)` (~21 ms; era 2048 hasta la 1.5.1) → **paso alto 90 Hz + paso bajo 7,2 kHz** (sin compresor, ver §12) → **ganancia automática lenta** (×1–×8, se recalcula una vez por segundo para que el pico ronde 0,5; baja al instante y sube poco a poco) → reducción a 16 kHz → Int16 en base64 → `postMessage` por el puerto `rj-asr` a cada reconocedor conectado. Además mide el nivel (RMS, sin la ganancia) una vez por segundo para el monitor.

**Cambios de la 1.6.0 en `asr/asr.js`** (sustituyen o amplían lo descrito más abajo; verificados en `test/h_asr.html`):
- **Motor** (`asrEngine`): `auto` | `local` | `cloud`. El SW decide el inicial (`auto` = local si `asrStatus` da `available`, si no Google) y pasa `local`, `auto` y `ctx` (título de la pestaña) en el hash del marco. Con `auto=1`, `switchEngine()` cambia de motor **una sola vez** si hay un error grave, `maxFails` errores seguidos, o 3 reinicios por sordera sin haber dado nunca un resultado; avisa con `asrPush {engine, reason}` (la interfaz cambia la etiqueta y muestra un aviso).
- `onresult`: los finales se procesan una sola vez por índice (`finalUpTo`) y lo provisional se compone con **todos** los resultados sin confirmar (antes solo desde `resultIndex`, y se perdían tramos). `maxAlternatives = 3`.
- **Alternativas** (`pickAlt`): pide al motor `{cmd:'score'}` (nº de palabras `guess` por texto, con 150 ms de plazo) y suma el vocabulario de la sesión; otra alternativa solo gana a la primera con ≥ 0,5 de ventaja (`−0,25·posición + 0,6·términos conocidos − 0,8·palabras inexistentes`).
- **Vocabulario** (`vocab`): katakana ≥ 3 y kanji ≥ 2 caracteres de los finales y de `ctx`; los que salen ≥ 3 veces (`known()`, máx. 40) se pasan como `SpeechRecognitionPhrase` (boost 2.0) **solo en el motor local** y si la API existe; el error `phrases-not-supported` las desactiva sin contar como fallo.
- **Rescates** (`stats.rescued`): hipótesis abandonada (`abandoned()`: ≥ 4 caracteres, > 0,8 s en pantalla, sustituida por otra de menos de la mitad que no empieza igual) y provisional huérfano (se queda vacío sin final durante 0,6 s) se emiten como finales promovidos.
- **Reinyección**: historial de 8 s; en `onaudiostart` se reinyecta desde `gapFrom − 0,4 s` (`gapFrom` = momento del `onend`, o el último resultado si el reinicio fue por sordera), mínimo 1 s y máximo 5 s.
- **Vigilante** (cada 200 ms): sordera = > 2,2 s sin resultados con > 1,5 s de sonido y > 0,6 s de **voz con tono** (tramas del diarizador con `f0 > 0`), o > 4,4 s con > 3 s de sonido aunque no se detecte tono. El plazo se multiplica por 1,6 (máx. ×4) en cada reinicio sin resultados y vuelve a 1 con el primero.
- **Cola de salida** (`push`): todo lo que se emite pasa por una cola de promesas para conservar el orden aunque elegir alternativa tarde.
- **Retraso medido** (`stats.lat`): mediana de los últimos 15 intervalos entre el inicio de una voz tras ≥ 0,45 s de silencio y el primer resultado; el monitor le suma el tiempo de pintado (`a.paintMs`).
- `recStatus` añade: `engine`, `switched`, `lat`, `rescued`, `rescored`, `biased`, `vocab`.

**Cambios de la 1.6.0 en la interfaz de la voz** (`content.js`, verificados en `test/h_content.html`): los mensajes provisionales que ya tienen otro posterior en la cola se descartan sin analizar (los finales nunca); `asrWords(text, live, prev)` conserva la clave `key` de las palabras que no cambian de posición (la cinta no salta); la etiqueta se alinea por la derecha y muestra el motor y el retraso.

`asr/asr.html` (con `engine/diarize.js` y `asr/asr.js`):
- **Dónde se ejecuta**: iframe invisible de 2×2 px colgado de `<html>` del **marco superior** (`asrHost`), aunque el vídeo esté en un iframe; la interfaz va en el marco del vídeo (`uiFrame`). Si la web prohíbe la voz por Permissions Policy (`NotAllowedError`), el SW abre una **ventana popup propia** de 340×150 (`asrPolicyBlocked`, `#…&window=1`) y avisa al usuario.
- Pista para el reconocedor: `MediaStreamTrackGenerator` + `AudioData` (alternativa: `AudioContext` → `MediaStreamDestination`). `SpeechRecognition` con `lang ja-JP`, `continuous`, `interimResults` y `processLocally` = ajuste `asrLocal`; se arranca con `rec.start(track)`.
- Garantías para no perder palabras:
  1. En `onend`, lo que estaba en curso sin confirmar se **promueve a final** (`promoted`).
  2. Historial de 3 s de PCM; en `onaudiostart` se **reinyecta el último segundo** (`preroll`); `dedupe()` elimina el solapamiento con lo ya mostrado (cola de 40 caracteres, coincidencia ≥ 3 caracteres).
  3. Reinicio inmediato en `onend` (300 ms si hubo errores).
  4. **Vigilante** cada 250 ms: una frase en curso de > 48 caracteres (o > 20 tras 7 s sin final) → `rec.stop()` para cerrarla (`forced`); > 2,6 s sin resultados con > 1,8 s de audio con voz → reinicio (`deaf`).
  5. Solo se descartan finales con confianza < 0,05 **y** ≤ 2 caracteres (el filtro anterior de 0,15 tiraba frases correctas en anime con música); y lo que no contiene japonés.
  6. Errores: `no-speech` ignorado; `aborted` tolerado hasta `maxFails×3`; otros hasta `maxFails` (3) → fatal; `not-allowed`, `language-not-supported`… → fatal.
- Mensajes `asrPush`: `{fin, interim, conf, spk, promoted}`; `{recStatus}` cada segundo; `{status}` (nivel, desde el offscreen); `{error, fatal}`.
- **Interfaz de la voz** (content.js): cola `a.queue` que procesa cada mensaje **en orden**, análisis incluido. Carriles por personaje (`lanes[id]`, `id = spk % 2`, colores `#fff, #8fd8ff, #ffbf7a, #d2b4ff`). La traducción se hace **solo de frases finales**.
  - `asrView:'phrase'`: frases confirmadas recientes (cada una visible ≥ 2,5 s; la última hasta 4,5 s si no hay voz) más lo que se está oyendo (`.live`, más tenue); máx. 2 renglones por carril (si hay más, `…` y las últimas palabras).
  - `asrView:'ticker'`: cinta de ancho fijo (ancho del vídeo, mín. 320 px), **anclada a la derecha** (`translateX(clientWidth - scrollWidth)`), con transición de 0,45 s; al recortar palabras antiguas se compensa el desplazamiento con `data-k` y máscara de difuminado a la izquierda; se vacía tras 7 s sin voz.
  - Repintado cada 800 ms para caducar carriles (congelado durante el hover).
- **Diarización** (`engine/diarize.js`, clase `Diarizer`): tramas de 512 muestras con salto de 256 (16 kHz); suelo de ruido = percentil 20 del RMS de los últimos ~3 s; FFT de 2048 puntos con espectro de fondo restado (seguimiento de mínimos). **Tono por suma de subarmónicos (SHS)** con parámetros `gap 0, decay 0.7, H 8, comp 10` (barrido en `tools/sweep_pitch.js`; la autocorrelación y el HPS fallaban por errores de octava con música), y **timbre MFCC 1–12** (24 filtros mel, 100–7000 Hz). Por frase: mediana de log2 F0 y media de MFCC. Distancia `|ΔlogF0|/0.25 + ‖ΔMFCC‖/12`; nuevo personaje si la distancia > 2.3 (máx. 4); media adaptativa y **fusión** de grupos que acaban pareciéndose. La ventana de cada frase es [primer resultado − 1 s, ahora − 0,2 s]; `peek()` sirve para lo provisional y `assign()` para los finales.

## 9. Ajustes (`chrome.storage.sync`, clave `settings`)

| Clave | Valores (por defecto en **negrita**) | Uso |
|---|---|---|
| enabled | **true** | Alt+R |
| mode | **romaji** \| romaji+tr | traducción encima del rōmaji |
| target | **es** (38 idiomas) | Translator API |
| position | **above** \| cover | overlay encima o tapando el original |
| pauseOnHover / resumeOnLeave | **true / true** | sesión de hover |
| longVowels | **literal** \| macron | rōmaji |
| particles | **phonetic** \| literal | は/へ/を |
| n | **n** \| m | ん ante b/m/p |
| markAmbiguous | **true** | subrayado de lecturas dependientes del contexto |
| showOriginal | **false** | japonés debajo del rōmaji |
| origScript | **kanji** \| kana | escritura de esa línea |
| selection | **true** | romanizar el texto seleccionado |
| fontScale | **1** (0,6–1,8) | tamaño |
| customSelectors | {} por hostname | selector propio de subtítulos |
| subFiles | **true** | usar archivos de subtítulos interceptados |
| videoSource | **ocr** \| audio | fuente para vídeo sin subtítulos de texto |
| asrEngine | **auto** \| local \| cloud | motor de voz (1.6). Si falta, se deduce de `asrLocal` (false → cloud) |
| asrLocal | **true** | (obsoleto desde 1.6; el popup lo mantiene coherente con `asrEngine`) |
| asrView | **phrase** \| ticker | visualización de la voz |
| asrSpeakers | **true** | colores y carriles por personaje |
| bubble | **video** \| always \| never | burbuja flotante |
| (pruebas) asrMaxFails, asrSkipLocalCheck | — | solo para tests |

Los `DEFAULTS` están duplicados en `content.js` y `popup.js`; **mantenlos sincronizados**.

## 10. Mensajes (protocolo)

- Al SW (`{to:'bg', cmd}`): `ensureEngine`, `translateViaTop`, `media`, `subsIndex`, `subsText`, `tabState`, `startSource`, `capStop`, `ocrStreamRegion`, `ocrPush`/`asrPush` (relé al `frameId`), `capEnded`, `ocrCapture`, `asrPolicyBlocked`.
- Al motor (`{to:'engine', cmd}`): `status`, `analyze`, `explain`, `translate`, `trAvailability`, `ocr`, `capStart`, `capStop`, `capDebug`, `capHas`, `capOcr`, `capPump`, `asrStatus`.
- A los content scripts (`{cmd}`): `subFile`, `ocrStart{stream}`, `ocrPush`, `ocrBusy`, `ocrImageResult`, `ocrImageFallback`, `asrStart`, `asrHost`, `asrPush`, `capStopped`, `notice{code}`, `translate`, `media`, `pick`.
- Página → content (`postMessage`): `__kantoro: 'subs-index' | 'subs-file'` (hook.js); popup en la burbuja → página: `__kantoroPanel: 'close'`.

## 11. Pruebas

Entorno usado: Chromium de Playwright (141), `xvfb-run`, Python Playwright, Node, `xdotool` (para pulsar Alt+O de verdad: los atajos y tabCapture requieren un gesto real), `espeak-ng` (voces japonesas sintéticas), `ffmpeg`. **Las rutas están fijadas** (`/tmp/w/...`, puertos 87xx, `/tmp/w/node_modules`); hay que adaptarlas a la máquina nueva.

| Script | Qué prueba | Último resultado |
|---|---|---|
| `test/run_test.py` | subtítulos DOM tipo YouTube (latencia), `<track>`, hover+pausa, selección, popup | 9–100 ms en frío por línea; pausa/reanudación correctas |
| `test/run_cr.py` (+ `cr/crserver.py`, `cr/watch.html`, `cr/*.ass`, cert propio) | Crunchyroll simulado por HTTPS con `--host-resolver-rules` y `--no-proxy-server`; API `cr-play-service.prd.crunchyrollsvc.com/v1/<id>/web/chrome/play` con pistas es-ES, ja-JP, en-US y zh-TW | pista china ignorada; japonés con 1–13 ms de retraso (una línea sale «MAL» por un fallo del propio test con `\N`) |
| `test/run_stream.py` | OCR continuo por stream (Alt+O real) sobre `canvas.html?bg&ms=1500` (fondo claro en movimiento) | 13/13 frases; 330–550 ms de media según la ejecución |
| `test/run2.py`, `zona.py` | OCR del cuento (`story.png`, captura del usuario) e imagen por menú; método de respaldo | 1 carácter dudoso de ~150 |
| `test/run_bubble.py` | burbuja en pantalla completa, panel, OCR desde el panel | OK |
| `test/run_hover.py` | sesión de hover (8 s quieto, voz nueva durante el hover, recorrer palabras parando en los espacios, pasar a la ficha, salir) | OK |
| `test/run_orig.py` | japonés bajo el rōmaji en subtítulos, frase y cinta, con kanji y kana | OK |
| `test/run_asrview.py` | modos frase y cinta con secuencias simuladas de la voz | cinta anclada a la derecha (≤ 8 px del borde) |
| `test/run_audio.py`, `run_meter2.py`, `run_nested.py`, `run_diar_e2e.py` | captura de audio, monitor, reconocedor en iframe anidado o con política que lo bloquea (ventana propia), diarización a través de la extensión | 14/15 frases en el carril correcto |
| `tools/test_engine.js` | motor en Node: `NODE_PATH=<node_modules> node tools/test_engine.js 'frase'…` | — |
| `tools/test_diarize.js <dir>` | diarización offline (`dialog.f32` + `segs.json` generados con espeak-ng) | 15/15 (3 voces), 17/20 (4 voces, dos parecidas) |

**Bancos de pruebas de la 1.6.0** (solo necesitan un navegador; `chrome.*`, el motor y `SpeechRecognition` están simulados). Servir la carpeta con `powershell -ExecutionPolicy Bypass -File tools\serve.ps1` (puerto 8765; el equipo del usuario no tiene Node ni Python) y ejecutar `runAll()` en la consola:

| Página | Qué prueba | Resultado (17-nov-2026) |
|---|---|---|
| `test/h_asr.html` | `asr.js`: provisional con varios tramos, final único, promoción, sin duplicados tras reinyección, elección de alternativa, rescates, sordera + reinyección, retraso medido, cambio de motor, vocabulario | 12/12 |
| `test/h_content.html` | interfaz de la voz: etiqueta del motor, claves estables, ráfaga de provisionales con motor lento, monitor con retraso. `scene('phrase'|'ticker')` monta una escena para capturas | 7/7 |
| `test/h_popup.html?av=downloadable` | popup real con API simulada: estado del motor de voz y descarga de la voz japonesa | OK |

Los scripts Playwright de la tabla anterior **no se han vuelto a ejecutar con la 1.6.0** (no hay Python en el equipo). Posibles ajustes: la burbuja ya no contiene `<i>` sino `<span>読</span>`, y la etiqueta se coloca con `right` en vez de `left`.

Lo que **no** se puede probar en el entorno sin red: el resultado real del reconocedor de voz (no hay acceso al servicio de Google ni modelo local), Crunchyroll, YouTube o Prime reales, y la descarga de modelos de traducción.

## 12. Lecciones aprendidas y trampas de Chrome (no las repitas)

1. **«Página no compatible» en todas partes** (v1.0): faltaban `activeTab`/`scripting`, y las pestañas abiertas antes de instalar no tenían content script. Por eso hay inyección en `onInstalled`, el botón «Activar en esta pestaña» y el teardown de scripts huérfanos.
2. **Documentos offscreen ocultos**: `OffscreenCanvas.convertToBlob` tarda ~1 s (estrangulado) → usar PGM a mano. `setTimeout` también se retrasa → reinicios con microtareas. **`SpeechRecognition` se aborta (`aborted`)** → el reconocedor tiene que vivir en un documento visible (iframe en la pestaña).
3. **Permissions Policy**: los iframes de reproductores (Crunchyroll) no delegan funciones de voz → el reconocedor va en el **marco superior**. Si toda la web lo prohíbe → ventana propia de la extensión.
4. **Mover un iframe en el DOM lo recarga**: el iframe del reconocedor se cuelga de `<html>` y no se mueve nunca (ni al entrar en pantalla completa).
5. `chrome.tabCapture.getMediaStreamId` necesita un **gesto del usuario** (popup, atajo o menú). Después de activar la extensión una vez en la pestaña, la burbuja ya puede iniciarla.
6. `captureVisibleTab` está limitado a ~2/s → el OCR por capturas se saltaba 4 de cada 5 frases; con tabCapture + MediaStreamTrackProcessor capta todas.
7. Capturar la pestaña **silencia su audio** → hay que devolverlo con un AudioContext (sin eco).
8. **Compresor de audio = peor**: subía la música al nivel de la voz. Solo filtros paso alto y paso bajo.
9. OCR: PSM 6 > PSM 3 en páginas; las escalas fraccionarias empeoran el resultado (solo 1/2/3); el **relaxed-SIMD** de Tesseract daba otros resultados → forzar SIMD estándar; borrar el furigana **antes** del OCR (después no basta).
10. **Chino frente a japonés**: Crunchyroll ofrece pistas zh-TW que el filtro «hay kanji» aceptaba (el usuario vio 我們會留在這裡待命). Filtrar por kana y por locale.
11. Overlay redibujado bajo el cursor (repintado cada 0,8 s de la voz, caducidad de carriles) → la ficha «vibraba» y el vídeo se reanudaba solo. De ahí la **congelación durante el hover** y la sesión por posición del puntero.
12. Diarización: la autocorrelación y el HPS tenían errores de octava con música; el suelo de ruido con EMA lenta tardaba en adaptarse (la primera frase salía mal) → percentil 20 de una ventana.
13. Comprobaciones de `SpeechRecognition.available()` **dentro de un iframe en una web ajena** dan respuestas falsas (políticas de la página) → la burbuja pregunta al motor (`asrStatus`).
14. Avisos «Parameter not found» de Tesseract en `chrome://extensions` → `worker-quiet.js`.
15. **Silencio digital exacto** (vídeo en pausa, pista muda): en `diarize.js` el percentil 20 del RMS valía 0 y `sorted[i] || rms` lo tomaba por «sin dato», así que el suelo de ruido pasaba a ser el nivel de la propia voz y no se detectaba tono. Corregido en 1.6.0 (`p20 === undefined ? rms : p20`). Afectaba a la diarización tras cada pausa.
16. `e.resultIndex` apunta al **primer resultado que cambió**: si el reconocedor mantiene dos tramos provisionales y solo cambia el segundo, leer desde `resultIndex` pierde el primero. Lo provisional se compone recorriendo todos los resultados no finales.
17. El reloj del diarizador solo se fija cuando su búfer está vacío: tras un corte de audio se queda atrasado. `asr.js` lo resincroniza si se separa más de 0,4 s del reloj real.
18. Equipos Windows sin fuentes japonesas adicionales **no tienen ninguna mincho** (ni Yu Mincho ni MS Mincho; es el caso del equipo del usuario): las pilas de fuentes acaban en Yu Gothic / Meiryo, y los iconos se generan con Yu Gothic.
19. En las capas dentro de la página (shadow DOM) no se usan imágenes `data:` en CSS (la CSP de la web puede bloquearlas): el motivo seigaiha solo está en el popup; en la página, colores y filetes.

## 13. Limitaciones conocidas y pendientes

- **Exactitud**: kana→rōmaji es determinista; la lectura de kanji depende del contexto (se marca la ambigüedad). La voz depende del reconocedor de Chrome (música, gritos, varias voces a la vez). El OCR no es perfecto (caracteres dudosos marcados). Diarización aproximada: voces parecidas pueden compartir color, y a veces sale un color de más en la primera frase.
- **Latencia**: subtítulos de texto e interceptados < 100 ms (≈ 1–60 ms). OCR ≈ 0,3–0,6 s por cambio. Voz: la extensión pinta en 7–48 ms desde que el reconocedor entrega la palabra, pero el reconocedor necesita oír la palabra entera.
- OCR solo de texto **horizontal** (no manga vertical). Vídeos con DRM salen negros en la captura (no impide leer subtítulos dibujados encima).
- Muchos episodios de Crunchyroll no traen pista japonesa → voz u OCR.
- Memoria: ~270 MB del motor.
- **Sin verificar en Chrome real (1.6.0)**: todo lo de la voz se ha probado con un reconocedor simulado. En particular: que `SpeechRecognition` devuelva de verdad varias alternativas (si solo da una, `pickAlt` no hace nada); que `phrases` exista y funcione en el Chrome del usuario; que la reinyección de hasta 5 s no retrase al reconocedor real; el efecto de la ganancia automática con música (si empeora, poner el máximo en ×1 en `capture.js`); el bloque de 1024 muestras en el documento offscreen; y el cambio automático de motor. El retraso real se lee en la etiqueta («retraso ≈»).
- Privacidad: con el motor `auto`, si la voz japonesa no está instalada el audio se envía a Google (el popup lo dice antes de empezar y la etiqueta lo indica). Quien quiera garantía de privacidad debe elegir «En el dispositivo».
- Sin verificar por el usuario: cambios de 1.5.1 (hover y japonés bajo el rōmaji). Sin verificar en general: modo local del reconocedor con descarga de «voz japonesa» (`SpeechRecognition.install`), y la ventana propia en pantalla completa (podría considerarse oculta).
- Observación abierta: en la última sesión el OCR por stream midió 450–550 ms de media frente a 330–370 ms en sesiones anteriores, sin cambios en el OCR. Probablemente es variación de la máquina, pero no está confirmado.
- Ideas no implementadas: texto vertical en el OCR; más de 2 carriles; guardar los personajes por serie; exportar las palabras consultadas.

## 14. Historial de versiones

- **1.0.0** Motor (kuromoji + JMdict fragmentado + KANJIDIC2), overlay, ficha con pausa, traducción local, detectores de sitios, `<track>`, selección, popup.
- **1.1.0** Arreglo de «Página no compatible» (permisos e inyección), diagnóstico en el popup, OCR (Tesseract) con borrado de furigana y aislamiento de subtítulos, menú contextual en imágenes, lecturas comunes en compuestos (二人→futari).
- **1.2.0** Intercepción de subtítulos (Crunchyroll hook + webRequest + parser ASS/VTT/SRT), OCR por tabCapture (13/13 frases), modo Audio con Web Speech API, selección OCR/Audio, Alt+O inicia/detiene.
- **1.3.0** Filtro chino/japonés, lecturas estimadas para palabras desconocidas, monitor de audio, burbuja flotante.
- **1.3.1** Reconocedor movido a un iframe en la pestaña (error `aborted`), estado de voz de la burbuja consultando al motor, avisos de Tesseract silenciados, burbuja sin tapar el panel.
- **1.3.2** Reconocedor siempre en el marco superior (Permissions Policy de Crunchyroll) y ventana propia como respaldo.
- **1.4.0** Sin filtro de confianza agresivo, vigilante anti-atascos, frase a frase y cinta, traducción solo de frases completas.
- **1.5.0** Promoción de lo provisional, reinyección de 1 s de audio sin duplicados, cola en orden, filtros paso alto y bajo (compresor retirado), cinta anclada a la derecha, diarización con colores y carriles.
- **1.5.1** Sesión de hover con overlay congelado (pausa estable, cambio de ficha entre palabras), japonés bajo el rōmaji en todos los modos con opción kanji o kana.

- **1.6.0** Voz: motor automático / dispositivo / Google con cambio en caliente; bloques de audio de 21 ms; ganancia automática lenta; provisional con todos los tramos; rescate de hipótesis abandonadas y huérfanas; reinyección de todo el audio no transcrito (hasta 5 s); vigilante por voz real con plazo creciente; elección entre alternativas con diccionario y vocabulario de la sesión; frases de contexto en el motor local; retraso medido en la etiqueta; descarte de provisionales atrasados y claves estables en la interfaz; corrección del suelo de ruido del diarizador con silencio digital. Estética Edo en toda la interfaz (popup, overlay, ficha, panel OCR, selector de zona, etiqueta, avisos, sello flotante 読, ventana de voz, iconos). Bancos de pruebas en navegador y `tools/serve.ps1`.

### Estética Edo (1.6.0)
Paleta: washi `#f3ead6` / `#ebdfc4`, sumi `#1b1713`, bermellón shu `#c8402f`, índigo ai `#1f3a5f`, oro kin `#c9a24a`, líneas `#c9b88f` / `#b9a680`. Tipografía: Palatino Linotype / Book Antiqua / Georgia para el rōmaji y el español; pila mincho para el japonés. En `content.js` las fuentes están en `F_SERIF` y `F_JP`; en el popup, en las variables `--serif` y `--mincho` de `popup.css` (donde también está el motivo seigaiha como SVG `data:`). Superficies claras (washi con barras índigo arriba y abajo, como un rollo): popup, ficha, panel OCR, avisos, ventana de voz. Superficies oscuras (sumi translúcido con filete dorado): subtítulos, etiqueta, barra del selector de zona. Colores de personajes: `#f7f0dc`, `#8fd0dc`, `#f3bd5c`, `#cdb0e2`. Iconos: sello bermellón con 読 (ロ a 16 px), generados con System.Drawing desde PowerShell.

- **1.6.1** Cambio de nombre a Kantoro. Voz: ante cortes `aborted` repetidos se quitan primero las frases de contexto y luego las alternativas (`safe` 1 y 2) y, en modo automático, al cuarto corte se pasa al otro motor (antes `aborted` no provocaba el cambio y la transcripción se detenía). **Resultado en el Chrome del usuario: el motor en el dispositivo sigue fallando con `aborted` en Crunchyroll; con el servicio de Google funciona.** La causa del fallo local no está identificada; el tema queda aparcado por decisión del usuario.

## 15. Licencias de terceros

JMdict y KANJIDIC2 © EDRDG (CC BY-SA 4.0; el crédito aparece en la ficha y en el popup). kuromoji.js (Apache 2.0) + IPADIC (licencia NAIST). Tesseract.js / Tesseract (Apache 2.0); modelo `jpn` de tessdata_best (Apache 2.0).

## 16. Web app instalable (`web/`, prototipo 0.1.0, 17-nov-2026)

**Por qué existe**: el usuario quiere usar Kantoro en el móvil, donde Chrome no admite extensiones. Se descartó capturar el audio de la app de Crunchyroll (el usuario da por hecho que lo bloquea y no quiere gastar tiempo en comprobarlo) y se eligió **escuchar por el micrófono**, que además sirve para conversaciones en japonés y cualquier otro audio: es el planteamiento con el que piensa venderla. De momento es una herramienta para él y sus amigos; a largo plazo valora comercializarla o publicarla como código abierto.

**Qué es**: PWA estática y autónoma. `index.html` + `app.css` + `app.js` (interfaz), `engine-worker.js` (el motor de la extensión en un Web Worker: `self.window = self` antes de `importScripts`, porque kuromoji.js usa `window`), `sw.js` + `manifest.webmanifest` (instalación y caché), `icons/`. Las carpetas `web/engine`, `web/lib`, `web/kuromoji-dict` y `web/data` son **copias de `ext/`** hechas por `tools/build_web.ps1`: no se editan ahí.

**Cómo funciona**:
- Voz: `SpeechRecognition` del navegador directamente del micrófono (sin pista de audio propia, así que no hay reinyección, diarización ni medición del retraso). `listener` en `app.js`: finales una sola vez por índice, provisional con todos los tramos, promoción de lo provisional en `onend`, reinicio inmediato, cierre forzado de frases de más de 60 caracteres, errores graves con mensaje en español.
- **Android**: `continuous` vale `false` por defecto (Chrome para Android repite resultados en sesión continua); además se recorta el prefijo repetido si un final empieza por el anterior. En escritorio, `continuous = true`.
- Pantalla: lista de frases (rōmaji grande, japonés debajo, traducción encima si el navegador tiene `Translator`); frase provisional al final con un cuadrado bermellón parpadeante; cola en orden que descarta provisionales atrasados; tocar una palabra abre la ficha en una hoja inferior (`explain`).
- Ajustes en `localStorage['kantoro.settings']`. Bloqueo de pantalla (`wakeLock`) mientras escucha. Botón «Instalar» con `beforeinstallprompt`.
- `sw.js`: aplicación con caché y actualización en segundo plano (`SHELL_V`); diccionarios guardados la primera vez y para siempre (`DATA_V`).

**Probado** (navegador integrado, reconocedor simulado, diccionario real): carga del motor en el Worker, provisional → final → promoción al cortarse → reinicio, ficha de diccionario, ajustes, aspecto a 375×812. **Sin probar**: un móvil real, el micrófono real, la instalación y el service worker (en el navegador integrado el registro falla con «unknown error when fetching the script»; puede ser una limitación de ese panel, hay que comprobarlo en Chrome).

**Dudas abiertas que solo resuelve un móvil real**: si Android pausa o atenúa el audio de otra app al activar el micrófono (afecta a ver anime en el mismo móvil); si hay pitido en cada reinicio de sesión; cuántas palabras se pierden entre sesiones; memoria y tiempo de carga del diccionario.

**Publicación**: hace falta HTTPS (micrófono e instalación). Subir `web/` a Cloudflare Pages, Netlify o GitHub Pages; ver `web/README.md`. El usuario aún no ha elegido alojamiento.

**Marco legal comentado con el usuario** (orientación, no asesoría): con micrófono no se captura ni se elude nada de Crunchyroll, así que desaparece el riesgo principal; no usar su nombre ni logo en la marca; si se comercializa con reconocimiento en la nube propio, política de privacidad y RGPD; los diccionarios siguen siendo CC BY-SA (atribución y misma licencia para los datos).

### Web app 0.2.0 (17-nov-2026) — publicada en https://luismvhv.github.io/Kantoro/ (repo `luismvhv/Kantoro`, rama `main`, solo el contenido de `web/`)

Tras la 0.1.0 el usuario informó de que **no reconocía nada de lo que sonaba, ni en el móvil ni en el ordenador** (la página y el diccionario cargaban bien). Hipótesis no confirmada: la cancelación de eco del micrófono elimina el sonido del altavoz del propio equipo. Cambios:
- `S.rawMic` (por defecto sí en escritorio, no en Android): `getUserMedia` con `echoCancellation/noiseSuppression/autoGainControl: false` y `rec.start(pista)`. Si `start(pista)` lanza error, vuelve a `start()` sin pista.
- Botón **Pestaña** (solo escritorio): `getDisplayMedia` con audio → `rec.start(pista)`.
- Cabecera con diagnóstico: origen, nivel ▮▮▮▮ (si la app tiene la pista), `micrófono abierto / sonido detectado / voz detectada`, nº de resultados, avisos y último error.
- Botón **⧉ ventana flotante**: lienzo 960×300 → `captureStream` → `<video>` → `requestPictureInPicture()`. Es la única forma que tiene una web de quedar encima de otras apps. Petición del usuario: ver el anime en la app y los subtítulos encima, como en la extensión.
- `sw.js`: primero la red (`SHELL_V` v2).
- **Sin verificar en dispositivo real**: si Android mantiene el reconocimiento con Chrome en segundo plano, si pausa el audio de la otra app, y si `start(pista)` funciona en Chrome para Android. Si no, la alternativa es una app Android nativa (captura de audio del sistema + capa flotante).
- Publicar: copiar los archivos cambiados de `web/` a un clon del repo y `git push` (Git para Windows instalado en `C:\Program Files\Git`; hay que poner `$env:GCM_INTERACTIVE='always'` para que el gestor de credenciales pueda actuar). Los commits usan `luismvhv@users.noreply.github.com`.
### Web app 0.3.0 (17-nov-2026)

Feedback del usuario sobre la 0.2.0: **en el móvil funciona dentro de la app**, pero con la ventana flotante abierta y Crunchyroll reproduciendo, **el vídeo de Crunchyroll se pausa solo cada 2–3 s** (vuelve a pausarse al darle a play). En el ordenador, error de **sin acceso al servicio de reconocimiento** (`network`). Pide poder elegir motor Google / local en móvil y ordenador, que el local funcione de verdad, y una ventana flotante ajustable en ancho y alto.

Diagnóstico (no confirmado en dispositivo): el reconocedor de Google en Android (el `SpeechRecognizer` del sistema que usa Chrome) **pide el foco de audio en cada sesión**; las apps de vídeo se pausan al perderlo. Una sesión dura una frase o unos segundos de silencio, de ahí la cadencia de 2–3 s. Desde una web no se puede evitar con ese motor.

Cambios:
- **Motor local con Vosk** (`web/lib/vosk/vosk.js` = vosk-browser 0.0.8, Apache 2.0, WASM sin hilos; modelo `web/models/vosk-model-small-ja-0.22.tar.gz`, 50 MB, Apache 2.0, convertido del zip oficial con `tar`). `localEng` en `app.js`: `getUserMedia` (sin cancelación de eco, con control de ganancia) → `ScriptProcessor(4096)` conectado a un `MediaStreamDestination` (no a los altavoces) → `KaldiRecognizer(ctx.sampleRate).acceptWaveformFloat`. `partialresult` → provisional, `result` → final; `cleanJa` quita los espacios que Vosk pone entre palabras. Cierre forzado con `retrieveFinalResult()` si el provisional pasa de 40 caracteres u 8 s. El modelo lo guarda vosk-browser en IndexedDB tras la primera descarga; `sw.js` no intercepta `/models/`. Como no usa el reconocedor del sistema, **no debería pedir el foco de audio** (por verificar en el móvil).
- **Selector de motor** visible encima del sello (Google | Local) y en Ajustes, con nota de cada uno. Por defecto: local en Android, Google en escritorio (`S.engine`).
- Google: ante `network` sin resultados se reintenta una vez sin la pista propia; si persiste, mensaje que sugiere el motor local (el error aparece en Edge, Brave, Opera y con bloqueadores).
- **Ventana flotante**: en escritorio, **Document Picture-in-Picture** (HTML real, se estira libremente; tamaño recordado en `S.pipW/pipH`, texto que se ajusta al tamaño). En Android, ventana de vídeo con **forma elegible** (`S.pipShape`: franja 2,39:1, 16:9, cuadrada, vertical; Android no admite más de 2,39:1, la 0.2.0 usaba 3,2:1) y tamaño por pellizco. Una superposición libre como la burbuja de la extensión solo es posible con una app nativa (permiso de superposición).
- Medición: Vosk procesa en el PC 34 s de audio en 5,5 s; el modelo carga en ~3 s desde local. Con la voz sintética de `test/voice.webm` (espeak) el texto sale muy mal, lo esperable con esa voz; **falta medir la exactitud con voz real**.
- Pruebas nuevas: `test/h_vosk.html?auto` (Vosk aislado) y `test/h_app.html?engine=local&wait=50` (la app real con un audio de prueba en lugar del micrófono; resultado en pantalla). En esta sesión el clasificador de permisos bloqueó ejecutar JavaScript en el panel del navegador, por eso las páginas de prueba se ejecutan solas con `?auto` y se leen con `get_page_text`.

### Web app 0.3.1–0.3.2 (17/18-nov-2026)

- 0.3.1: el selector Google | Local de abajo quedaba tapado por el sello → botón en la cabecera (`btnEngine`, SVG nube = Google / disco duro = local) que alterna y avisa con un toast.
- Feedback del usuario: **en modo local funciona** con Crunchyroll sonando (sin pausar el vídeo). **Con Google, la escucha se para** al abrir Crunchyroll (antes era el vídeo el que se pausaba).
- 0.3.2: en Android, con el motor Google, al abrir la ventana flotante (⧉) o al pasar a segundo plano (`visibilitychange`), `listener.toBackground()` aborta el reconocedor de Google, abre un micrófono propio y arranca `localEng`; al volver a primer plano, `toForeground()` cierra el local y retoma Google. La etiqueta muestra «Local (segundo plano)». Motivo: desde una web, el reconocedor de Google en Android no puede escuchar en segundo plano ni dejar de pedir el foco de audio. **Sin verificar en el móvil.** Si `getUserMedia` falla estando ya en segundo plano, se sigue con Google; por eso conviene abrir ⧉ antes de salir.
- Única vía para tener la precisión de Google (u otro servicio en la nube) fuera de la app sin pausar el vídeo: enviar el audio del micrófono propio a una API de reconocimiento en la nube de pago (Google Cloud Speech-to-Text, Azure, Deepgram…) a través de un pequeño servidor que guarde la clave. GitHub Pages no puede alojar ese servidor. No implementado.

### Web app 0.4.0 (18-nov-2026) — Google Cloud Speech-to-Text

- Feedback del usuario sobre la 0.3.2: no quiere que, con Google elegido, la app pase sola al motor local fuera de la app. Quiere **Google funcionando en segundo plano** (no solo en la ventana flotante) con Crunchyroll sonando y sin pausas. El cambio automático a local solo es aceptable si Google falla de verdad varias veces, y avisando de por qué.
- Retirado `toBackground` de la 0.3.2. Nuevo `cloudEng` en `app.js`: micrófono propio (`getUserMedia` sin cancelación de eco, con control de ganancia) → `ScriptProcessor(2048)` → 16 kHz → tramas de 20 ms → detección de voz con umbral `max(0.0035, 1.7 × percentil 20 de 3 s)` (bajo a propósito) → frases con 300 ms de antes, cierre por 360 ms de silencio y corte a los 6 s por el punto más silencioso del último 1,5 s → `POST https://speech.googleapis.com/v1/speech:recognize?key=…` (LINEAR16, ja-JP, puntuación automática). Los finales se entregan en orden (`out`); provisional opcional (`S.gInterim`, por defecto sí) reenviando la frase en curso cada 1 s a partir de 1 s (≈2,2× de audio facturado en la prueba). Consumo estimado del mes en `S.gUse`.
- Ajustes: `S.gBackend` (`auto` = Cloud en Android si hay clave; `browser`; `cloud`), `S.gkey` (solo en localStorage), `S.gInterim`. Etiqueta «Google Cloud».
- Relevo a local (`listener.fallbackLocal(reason)`) con aviso (toast + ventana flotante): clave rechazada (400/401/403), 4 fallos seguidos de red/servidor en Cloud, `network`, 5 errores del reconocedor del navegador, o sesiones inútiles seguidas del reconocedor del navegador (2 con la app oculta: motivo `bg`, que vuelve a Google al regresar a Kantoro; 4 delante).
- Probado en el navegador integrado con `test/h_app.html?cloud=mock` (Google Cloud simulado: frases de 1,1–2,8 s, entregadas en orden, provisional y final) y `?cloud=bad` (clave rechazada → local con aviso). **Sin probar con la API real ni en el móvil.** Pendiente de confirmar en Android: que el micrófono propio y `fetch` siguen funcionando con Kantoro en segundo plano sin ventana flotante (con el motor local ya funcionaba con la ventana flotante).

### Web app 0.5.0 (18-nov-2026) — motor local optimizado

- Feedback: la clave de Google Cloud no le funciona de momento (aparcado). Prioridad: que el **motor local** vaya fluido en el móvil; ahora carga tanto el procesador que el audio de Crunchyroll se oye mal («vibraciones raras»). Acepta ~1 s de retraso.
- Medido en el PC con `test/h_vosk.html?auto&model=…&rate=…&chunk=…` (todo el audio de golpe, tiempo hasta el último mensaje; RTF = proceso / duración): configuración anterior (modelo original, 48 kHz, trozos de 85 ms) **RTF 0,379**, 393 mensajes provisionales; modelo original a 16 kHz y 200 ms 0,373 (remuestrear no era el problema); **modelo `-lite` 0,185** (la mitad, mismo texto con la voz de prueba); prueba más agresiva (max-active 1200, beam 8) 0,151, descartada: lo que queda es el coste fijo de la red neuronal. Un móvil es varias veces más lento que el PC, así que con la configuración anterior probablemente iba al límite de un núcleo.
- Cambios: `models/vosk-model-small-ja-0.22-lite.tar.gz` (mismo modelo, `conf/model.conf` con max-active 2500, beam 10, lattice-beam 2, fin de frase tras 0,4 s; regenerar con `tar` desde el original); `micTap()` en `app.js`: 1) `MediaStreamTrackProcessor` (sin AudioContext: no abre ninguna salida de audio del sistema), 2) `AudioContext({sampleRate:16000, latencyHint:'playback'})` + `mic-worklet.js`, 3) ScriptProcessor; bloques de 200 ms a 16 kHz (`KaldiRecognizer(16000)`); `openMic()`: micrófono sin cancelación de eco, supresión de ruido **ni control de ganancia** (evita el procesador de llamadas de Chrome y el modo comunicación de Android) y, si el micrófono por defecto es Bluetooth, usa el del móvil (el Bluetooth pasa los auriculares a perfil de llamada); ganancia propia lenta ×1–×6; **puerta de ruido** (`S.localGate`, ajuste visible): con el nivel por debajo de 1,5 × el percentil 20 de 5 s no se envía nada al reconocedor; deja pasar el bloque anterior y 800 ms después; provisional analizado y pintado como mucho cada 330 ms; ventana flotante a 4 fps con repintado cada 1 s.
- `S.capture` ('auto' | 'worklet' | 'script') solo para pruebas: `test/h_app.html?engine=local&cap=worklet`. Probadas en el PC las vías directa y worklet. **Sin probar en el móvil.**

### Web app 0.6.0 (18-nov-2026) — precisión del motor local y traducción en el móvil

- Feedback de la 0.5.0: el móvil ya no distorsiona el audio, pero el texto es **menos coherente**, falla más palabras y **se salta muchas frases**.
- Causas probables: (1) el modelo `-lite` cerraba las frases tras 0,4 s de silencio (10 frases frente a 7 del original con el mismo audio: menos contexto) y su búsqueda estrecha descarta antes las hipótesis que luego se corregían por contexto; (2) la puerta de ruido (1,5 × fondo) se comía frases con música o voces bajas y además forzaba el cierre de frase al cerrarse; (3) la ganancia propia saltaba deprisa dentro de la frase.
- Cambios: modelo **`-mid`** por defecto (max-active 4000, beam 11,5, lattice-beam 3, cierres 0,5/1/2 s del original; RTF 0,25 en el PC, frente a 0,379 del original y 0,185 del ligero), «Ligero» elegible en Ajustes (`S.localModel`; al cambiar se libera el anterior con `terminate()`); puerta solo para **silencio real** (nivel < máx(0,0012, mín(0,006, 1,15 × percentil 10 de 10 s)) durante 2 s; se reabre al momento y recupera 0,6 s; ya no fuerza el cierre de frase); ganancia ×1–×4 que sube como mucho un 2 % por bloque.
- **Traducción en el móvil**: `S.trEngine` 'auto' | 'online' | 'local'. En línea: `translate.googleapis.com/translate_a/single?client=gtx` (CORS abierto, sin clave, no oficial) y MyMemory de reserva; caché de 500 frases; al activar o cambiar de idioma se traducen las 30 últimas frases. En la ventana flotante la traducción va en cursiva en lugar del japonés.
- Probado en el PC con `test/h_app.html?engine=local&tr=online` (frases traducidas al español). **Sin probar en el móvil**; la precisión real con anime solo la puede juzgar el usuario.

### Extensión 1.7.0 (19-nov-2026) — traducción en línea y más idiomas

- Problema del usuario: en el popup salía «Combinación no disponible en este dispositivo» (la Translator API de su Chrome no tiene japonés → ese idioma) y no traducía.
- `offscreen.js`: `translate(text, target, mode)` con `mode` 'auto' (integrado si está `available`; si no, en línea) | 'online' | 'local'. En línea: `translate.googleapis.com/translate_a/single?client=gtx` (sin clave, no oficial; la extensión tiene permiso de host, sin problemas de CORS) y MyMemory de reserva; si Google responde con error (p. ej. **429**, que salió en las pruebas tras muchas peticiones seguidas) se va directo a MyMemory durante 5 min. Códigos: zh→zh-CN, zh-Hant→zh-TW, fil→tl.
- Ajuste `trEngine` (DEFAULTS de `content.js` y `popup.js`), selector «Traductor» en el popup, estado en verde cuando se traduce en línea; la caché de traducciones se limpia también al cambiar de traductor. Idiomas: 46 (añadidos catalán, gallego, euskera, malayo, filipino, urdu, persa y suajili; los principales primero). Los mismos idiomas y la misma pausa ante el 429 en la web app (0.6.1).
- Probado: estados del popup con `test/h_popup.html?tav=unavailable|none|available&tr=…`; la traducción en línea con la web app (`test/h_app.html?tr=online`, por MyMemory porque Google estaba limitando). **Sin probar con la extensión cargada en Chrome.**
- Repositorio: la extensión está en la rama **`extension`** de `luismvhv/Kantoro` (rama huérfana: `ext/`, `tools/`, `test/` sin `story.png`, `README.md`, `CLAUDE.md`). `main` sigue siendo solo la web app (GitHub Pages).

### Extensión 1.7.1 (19-nov-2026) — cinta sin temblor y mejor distinción de personajes

- Petición del usuario: en el modo cinta (desplazamiento), mientras espera una palabra nueva **la cinta tiembla** (amago de avanzar y volver varias veces); que no se mueva hasta que entre una palabra nueva. Y que el color de personaje **cambie cuando cambia la tonalidad, y solo entonces**, distinguiendo mejor las voces.
- Causas del temblor (`Overlay.drawLanes`, content.js): (1) la posición se recalculaba en cada repintado como `ancho − scrollWidth`, así que una palabra provisional que aparecía y desaparecía movía la cinta adelante y atrás; (2) la compensación al recortar palabras antiguas por la izquierda iba con el signo cambiado (`prev − dx`, debe ser `prev + dx`); (3) cuando el personaje de lo provisional parpadeaba, aparecía o desaparecía un carril y se rehacían todas las cintas desde la posición 0.
- Arreglo: la cinta **solo se mueve hacia la izquierda y solo si hay una clave de palabra nueva** (`this.seen[id]`); si lo provisional se acorta, se queda quieta (hueco a la derecha que ocupará la siguiente palabra); salvaguardas si el desfase es enorme (cambio de tamaño de letra, texto borrado). Los carriles existentes se conservan al cambiar la disposición. Prueba nueva en `test/h_content.html?auto` (7: quieta mientras espera y sin retroceder; 8: recorte sin saltos); con el content.js anterior (`?old`, `test/content_v1.js`) la 7 falla mostrando el vaivén.
- Personajes (`engine/diarize.js`): distancia = √((Δtono en semitonos / 1,5)² + (Δtimbre MFCC / 12)²) frente a la media de cada personaje; **histéresis**: ≤ 1,25 sigue el mismo, ≥ 1,6 cambia (a un personaje conocido o a uno nuevo), en medio no cambia; frases con < 20 tramas con tono no cambian de personaje; `peek` (provisional) mantiene el personaje actual salvo pruebas claras y solo adelanta un personaje nuevo con datos de sobra; `features(t0, t1, anchor)` corta la ventana en la última pausa ≥ 0,3 s anterior al inicio de la frase (asr.js pasa `uttStart`). La fusión de personajes solo con distancia < 0,63.
- Banco nuevo `test/h_diar.html` (`?dbg`, `?sweep`, `?lib=diarize_v1.js` = versión anterior) con `test/dialog4.wav` + `dialog4_segs.json` generados por `tools/make_dialog.ps1` (voces de Windows Pablo, Helena, Laura y Helena +35 % de tono, con música de fondo; Windows del usuario no tiene voces japonesas, y la distinción solo usa tono y timbre). Resultados: anterior 8/15 frases, 2 voces, 3 cambios perdidos, 31/87 provisionales con otro color → nuevo **12/15, 3 voces, 14/14 cambios y ninguno de más, 19/87**. Límite: Laura y Helena+35 % (mismo tono, timbre parecido) se confunden. Con voces de anime reales (gritos, susurros) un mismo personaje que cambia mucho de tono puede cambiar de color: es lo que pidió el usuario.
- `tools/test_diarize.js` y `tools/sweep_cluster.js` usan las opciones antiguas (`fW`, `thr`): no actualizados (no hay Node en el equipo).
- **Sin probar en Chrome real con la extensión cargada.**
