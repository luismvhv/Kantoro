/* Kantoro — popup de ajustes */
'use strict';

const DEFAULTS = {
  enabled: true, mode: 'romaji', target: 'es', position: 'above', pauseOnHover: true, resumeOnLeave: true,
  trEngine: 'auto', longVowels: 'literal', particles: 'phonetic', n: 'n', markAmbiguous: true, showOriginal: false,
  selection: true, fontScale: 1, customSelectors: {}, subFiles: true, videoSource: 'ocr', asrLocal: true, asrEngine: 'auto', bubble: 'video', asrView: 'phrase', asrSpeakers: true, origScript: 'kanji',
};
// Idiomas destino. Los principales van primero; con el traductor en línea están todos disponibles, con el integrado
// de Chrome depende del equipo (el estado lo dice debajo).
const LANGS = [
  ['es', 'Español'], ['en', 'Inglés'], ['fr', 'Francés'], ['de', 'Alemán'], ['it', 'Italiano'], ['pt', 'Portugués'],
  ['ca', 'Catalán'], ['gl', 'Gallego'], ['eu', 'Euskera'],
  ['zh', 'Chino simplificado'], ['zh-Hant', 'Chino tradicional'], ['ko', 'Coreano'], ['ru', 'Ruso'], ['ar', 'Árabe'], ['hi', 'Hindi'],
  ['nl', 'Neerlandés'], ['pl', 'Polaco'], ['uk', 'Ucraniano'], ['tr', 'Turco'], ['vi', 'Vietnamita'], ['th', 'Tailandés'],
  ['id', 'Indonesio'], ['ms', 'Malayo'], ['fil', 'Filipino'], ['bn', 'Bengalí'], ['ur', 'Urdu'], ['fa', 'Persa'], ['sw', 'Suajili'],
  ['sv', 'Sueco'], ['da', 'Danés'], ['no', 'Noruego'], ['fi', 'Finés'],
  ['cs', 'Checo'], ['sk', 'Eslovaco'], ['sl', 'Esloveno'], ['hr', 'Croata'], ['hu', 'Húngaro'], ['ro', 'Rumano'], ['bg', 'Búlgaro'],
  ['el', 'Griego'], ['lt', 'Lituano'], ['iw', 'Hebreo'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Canarés'], ['mr', 'Maratí'],
];

const $ = (id) => document.getElementById(id);
let S = { ...DEFAULTS };
let tab = null;

async function save(patch) {
  Object.assign(S, patch);
  await chrome.storage.sync.set({ settings: S });
}

function fill() {
  $('enabled').checked = S.enabled;
  document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === S.mode; });
  $('trBlock').classList.toggle('off', S.mode !== 'romaji+tr');
  for (const id of ['target', 'trEngine', 'longVowels', 'particles', 'n', 'position', 'bubble', 'asrView', 'origScript', 'asrEngine']) $(id).value = S[id];
  $('origRow').style.display = S.showOriginal ? '' : 'none';
  for (const id of ['markAmbiguous', 'showOriginal', 'selection', 'pauseOnHover', 'resumeOnLeave', 'subFiles', 'asrSpeakers']) $(id).checked = S[id];
  document.querySelectorAll('input[name=videoSource]').forEach((r) => { r.checked = r.value === S.videoSource; });
  $('asrBlock').hidden = S.videoSource !== 'audio';
  paintStart();
  $('fontScale').value = S.fontScale;
  $('fsOut').textContent = Math.round(S.fontScale * 100) + '%';
  $('resumeOnLeave').disabled = !S.pauseOnHover;
}

async function engineStatus() {
  const el = $('engine');
  try {
    let r = await chrome.runtime.sendMessage({ to: 'engine', cmd: 'status' }).catch(() => null);
    if (!r || !r.ready) {
      el.textContent = 'Cargando analizador y diccionarios…';
      r = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'ensureEngine' });
    }
    if (r && r.ready) { el.textContent = 'Motor local listo · sin conexión'; el.className = 'sub ok'; }
    else { el.textContent = 'Error del motor: ' + ((r && r.error) || 'desconocido').slice(0, 60); el.className = 'sub err'; }
  } catch (e) { el.textContent = 'Error del motor'; el.className = 'sub err'; }
}

async function trStatus() {
  const st = $('trStatus'), btn = $('dl');
  btn.hidden = true;
  const ONLINE = 'En línea (Google Translate): se envía el texto japonés de cada frase, no el audio';
  if (S.trEngine === 'online') { st.textContent = ONLINE + '.'; st.className = 'muted ok'; return; }
  const av = typeof Translator === 'undefined' ? 'no-api'
    : await Translator.availability({ sourceLanguage: 'ja', targetLanguage: S.target }).catch(() => 'unavailable');
  const auto = S.trEngine !== 'local';
  const map = {
    available: ['Integrado de Chrome: japonés → ' + langName(S.target) + ' en el dispositivo', 'ok'],
    downloadable: auto ? ['Se traduce en línea hasta que descargues el modelo integrado (opcional, una sola vez)', 'ok'] : ['Hace falta descargar el modelo (una sola vez)', 'warn'],
    downloading: [auto ? 'Descargando el modelo integrado; mientras, se traduce en línea' : 'Descargando modelo…', 'warn'],
    unavailable: auto ? ['Chrome no tiene este idioma integrado: ' + ONLINE.charAt(0).toLowerCase() + ONLINE.slice(1), 'ok'] : ['Combinación no disponible en este dispositivo: elige «Automático» o «En línea»', 'err'],
    'no-api': auto ? ['Este Chrome no trae traductor integrado: ' + ONLINE.charAt(0).toLowerCase() + ONLINE.slice(1), 'ok'] : ['Este Chrome no trae traductor integrado: elige «Automático» o «En línea»', 'err'],
  };
  const [txt, cls] = map[av] || [av, ''];
  st.textContent = txt;
  st.className = 'muted ' + cls;
  btn.hidden = !(av === 'downloadable' || av === 'downloading') || EMBEDDED;
  if (EMBEDDED && (av === 'downloadable' || av === 'downloading')) st.textContent += ' — descárgala desde el icono de Kantoro en la barra de Chrome.';
}
const langName = (c) => (LANGS.find((l) => l[0] === c) || [c, c])[1];

async function download() {
  const prog = $('dlProg');
  prog.hidden = false; $('dl').disabled = true;
  try {
    // Requiere el gesto del usuario (clic): por eso se hace desde el popup
    const tr = await Translator.create({
      sourceLanguage: 'ja', targetLanguage: S.target,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { prog.value = e.loaded; }); },
    });
    tr.destroy && tr.destroy();
  } catch (e) {
    $('trStatus').textContent = 'No se pudo descargar: ' + e.message;
    $('trStatus').className = 'muted err';
  }
  prog.hidden = true; $('dl').disabled = false;
  trStatus();
}

let capturing = null;
function paintStart() {
  const b = $('ocr');
  if (!b) return;
  if (capturing) { b.innerHTML = 'Detener ' + (capturing === 'audio' ? 'la transcripción' : 'el OCR') + ' <kbd>Alt+O</kbd>'; b.classList.add('stop'); }
  else { b.innerHTML = (S.videoSource === 'audio' ? 'Transcribir el audio' : 'Leer subtítulos con OCR') + ' <kbd>Alt+O</kbd>'; b.classList.remove('stop'); }
}

async function startOrStop() {
  if (capturing) {
    await chrome.runtime.sendMessage({ to: 'bg', cmd: 'capStop', tabId: tab.id }).catch(() => {});
    capturing = null; paintStart(); setTimeout(siteInfo, 300);
    return;
  }
  const mode = S.videoSource === 'audio' ? 'audio' : 'ocr';
  $('ocr').disabled = true;
  // El id de captura se pide aquí, durante el clic del usuario (Chrome lo exige)
  let streamId = null;
  try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }); } catch (_) { /* lo intentará el SW */ }
  const r = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'startSource', tabId: tab.id, mode, streamId }).catch((e) => ({ error: String(e) }));
  $('ocr').disabled = false;
  if (mode === 'ocr' || (r && r.ok)) { closeUI(); return; }
  const ERR = {
    'no-stream': 'Chrome exige activar Kantoro una vez en esta pestaña antes de capturarla: pulsa Alt+O (o el icono de Kantoro en la barra) y después ya podrás usar la burbuja.',
    'no-api': 'Este Chrome no incluye reconocimiento de voz.',
    'local-downloadable': 'Falta la voz japonesa en el dispositivo: pulsa «Descargar voz japonesa» o elige el motor «Automático» o «Servicio de Google».',
    'local-downloading': 'La voz japonesa se está descargando; prueba en un momento (o elige «Automático»).',
    'local-unavailable': 'Este dispositivo no admite reconocimiento de japonés local. Elige el motor «Automático» o «Servicio de Google».',
    'local-no-local-api': 'Este Chrome no admite reconocimiento local (requiere Chrome 139+). Elige el motor «Automático» o «Servicio de Google».',
  };
  diag('No se pudo iniciar la transcripción: ' + (ERR[r && r.error] || (r && (r.detail || r.error)) || 'error desconocido'), 'err');
}

const SRc = window.SpeechRecognition || window.webkitSpeechRecognition;
async function asrStatus() {
  if (S.videoSource !== 'audio') return;
  const st = $('asrStatus'), btn = $('asrDl');
  btn.hidden = true;
  if (!SRc && !EMBEDDED) { st.textContent = 'Este Chrome no incluye reconocimiento de voz.'; st.className = 'muted err'; return; }
  const eng = S.asrEngine;
  if (eng === 'cloud') { st.textContent = 'Usará el reconocimiento de Google (el audio sale del equipo).'; st.className = 'muted warn'; return; }
  // Dentro del sello flotante (iframe en una página ajena) la respuesta de available() depende de las políticas
  // de esa página y no es fiable: se pregunta al motor de la extensión.
  let av;
  if (EMBEDDED) {
    const r = await chrome.runtime.sendMessage({ to: 'engine', cmd: 'asrStatus', local: true }).catch(() => null);
    av = (r && r.av) || 'unavailable';
  } else if (!SRc.available) av = 'no-local-api';
  else av = await SRc.available({ langs: ['ja-JP'], processLocally: true }).catch(() => 'unavailable');
  const auto = eng === 'auto';
  const map = auto ? {
    available: ['Voz japonesa instalada: se reconoce en el dispositivo (privado). Si fallase, pasa a Google.', 'ok'],
    downloadable: ['Ahora usará Google (el audio sale del equipo). Descarga la voz japonesa para reconocer en el dispositivo.', 'warn'],
    downloading: ['Descargando la voz japonesa… mientras tanto usará Google.', 'warn'],
    unavailable: ['Este equipo no admite japonés local: usará Google (el audio sale del equipo).', 'warn'],
    'no-local-api': ['Este Chrome no reconoce en local (requiere 139+): usará Google.', 'warn'],
  } : {
    available: ['Voz japonesa instalada en el dispositivo', 'ok'],
    downloadable: ['Falta descargar la voz japonesa (una vez)', 'warn'],
    downloading: ['Descargando la voz japonesa…', 'warn'],
    unavailable: ['Japonés local no disponible en este equipo', 'err'],
    'no-local-api': ['Reconocimiento local no disponible (Chrome 139+).', 'err'],
  };
  const [t, c] = map[av] || [String(av), ''];
  st.textContent = t; st.className = 'muted ' + c;
  const canDl = av === 'downloadable' || av === 'downloading';
  btn.hidden = !canDl || EMBEDDED;
  if (EMBEDDED && canDl) st.textContent += ' — descárgala desde el icono de Kantoro en la barra de Chrome.';
  return av;
}
// Descarga del paquete de japonés de Chrome para reconocer en el propio equipo (requiere el clic del usuario)
async function installAsr() {
  const btn = $('asrDl'), st = $('asrStatus');
  btn.disabled = true;
  st.textContent = 'Descargando la voz japonesa… (puede tardar unos minutos; no cierres esta ventana)'; st.className = 'muted warn';
  let ok = false;
  try { ok = await SRc.install({ langs: ['ja-JP'], processLocally: true }); }
  catch (e) { st.textContent = 'No se pudo descargar: ' + e.message; st.className = 'muted err'; btn.disabled = false; return; }
  // install() puede resolverse antes de que el paquete esté listo: se espera a que figure como disponible
  for (let i = 0; i < 90; i++) {
    const av = await SRc.available({ langs: ['ja-JP'], processLocally: true }).catch(() => 'unavailable');
    if (av === 'available' || (av !== 'downloading' && i > 2)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  btn.disabled = false;
  const av = await asrStatus();
  if (!ok && av !== 'available') { st.textContent = 'Chrome no ha podido instalar la voz japonesa en este equipo. Usa «Automático» o «Servicio de Google».'; st.className = 'muted err'; }
}

// Dentro de la burbuja flotante el popup va en un iframe de la página: cerrar = avisar a la página
const EMBEDDED = window.top !== window;
function closeUI() {
  if (EMBEDDED) parent.postMessage({ __kantoroPanel: 'close' }, '*');
  else window.close();
}
if (EMBEDDED) document.documentElement.classList.add('embedded');

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/chrome(webstore)?\.google\.com\/(webstore)?/;

async function probe() {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => (window.__kantoroProbe ? window.__kantoroProbe() : null),
    });
    return res.map((r) => r.result);
  } catch (e) { return null; }
}

function diag(html, cls) { const d = $('diag'); d.innerHTML = html; d.className = 'diag ' + (cls || ''); }
const q = (t) => `<q>${t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).slice(0, 70)}</q>`;

async function siteInfo() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';
  let host = '';
  try { host = new URL(url).hostname; } catch (_) {}
  $('resetSel').hidden = !S.customSelectors[host];
  $('inject').hidden = true;
  if (RESTRICTED.test(url)) {
    diag('Chrome no permite que las extensiones funcionen en esta página (páginas internas o Chrome Web Store).', 'err');
    ['ocr', 'pick'].forEach((id) => { $(id).disabled = true; });
    return host;
  }
  const frames = await probe();
  const live = (frames || []).filter(Boolean);
  if (!live.length) {
    if (url.startsWith('file:')) {
      diag('<b>Es un archivo local.</b> Chrome solo deja entrar a las extensiones si lo autorizas: abre <b>chrome://extensions</b> → Kantoro → <b>Detalles</b> → activa «Permitir acceso a URLs de archivo», y recarga esta pestaña.', 'warn');
    } else {
      diag('<b>Kantoro aún no está activo en esta pestaña</b> (estaba abierta antes de instalar la extensión). Pulsa «Activar en esta pestaña» o recárgala (F5).', 'warn');
      $('inject').hidden = false;
    }
    return host;
  }
  if (!S.enabled) { diag('Kantoro está <b>desactivado</b>. Actívalo con el interruptor de arriba o con Alt+R.', 'warn'); return host; }
  const srcs = live.flatMap((f) => f.sources);
  const tracks = live.flatMap((f) => f.tracks);
  const jpSrc = srcs.find((s) => s.jp) || tracks.find((t) => t.jp);
  const videos = live.reduce((a, f) => a + f.videos, 0);
  const canvases = live.reduce((a, f) => a + f.canvases, 0);
  const images = live.reduce((a, f) => a + f.images, 0);
  const jpText = live.some((f) => f.jpText);
  const ocrOn = live.some((f) => f.ocr);
  const asrOn = live.some((f) => f.asr);
  const sf = live.map((f) => f.subFile).find(Boolean);
  const ts = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'tabState', tabId: tab.id }).catch(() => ({})) || {};
  capturing = ts.capture || (ocrOn ? 'ocr' : asrOn ? 'audio' : null);
  paintStart();
  const locs = (ts.subLocales || []).join(', ');
  if (sf && S.subFiles) diag(`<b>Funcionando con el archivo de subtítulos${sf.locale ? ' ' + sf.locale : ''}</b> del episodio (texto exacto, ${sf.cues} frases, sin retraso)${sf.text ? ': ' + q(sf.text) : '.'}`, 'ok');
  else if (asrOn) diag('<b>Transcribiendo el audio</b>. Pulsa «Detener» o Alt+O para parar.', 'ok');
  else if (ocrOn) diag('<b>OCR continuo activo</b>: leyendo la zona marcada. Pulsa «Detener» o Alt+O para parar.', 'ok');
  else if (ts.subLocales && ts.subLocales.length && !ts.subJa) diag(`Este episodio trae subtítulos en <b>${locs}</b>, pero <b>ninguno en japonés</b>. Puedes usar el <b>audio</b> (reconocimiento de voz) o el OCR si ves japonés en pantalla.`, 'warn');
  else if (ts.subJa && !sf) diag(`El episodio tiene subtítulos en japonés (${ts.subJa}) pero no he podido cargarlos${ts.subError ? ': ' + ts.subError : ''}. Recarga la página.`, 'err');
  else if (jpSrc) diag(`<b>Funcionando</b> — leyendo subtítulos${jpSrc.site ? ' de ' + jpSrc.site : ''}: ${q(jpSrc.text)}`, 'ok');
  else if (srcs.length) {
    const s0 = srcs[0];
    diag(`Detecto el reproductor de <b>${s0.site}</b>, pero ${s0.text ? 'sus subtítulos ahora mismo no están en japonés: ' + q(s0.text) : 'ahora mismo no muestra subtítulos'}. ` +
      'Activa los subtítulos <b>en japonés</b> en el reproductor. Si el japonés está incrustado en la imagen, usa «Leer zona con OCR».', 'warn');
  } else if (videos && /crunchyroll\.com/.test(url)) diag('Crunchyroll: abre (o recarga) el episodio con Kantoro activo para que pueda ver qué subtítulos ofrece. Si no trae japonés, usa el audio o el OCR.', 'warn');
  else if (videos && canvases) diag('Hay un vídeo cuyos subtítulos <b>se dibujan como imagen</b> (no son texto). Usa el botón de abajo (OCR o audio) y, con OCR, marca la franja donde aparecen.', 'warn');
  else if (videos) diag('Hay un vídeo, pero no encuentro subtítulos en forma de texto. Si ves japonés en pantalla (incrustado en la imagen), usa <b>«Leer zona con OCR»</b>. Si son subtítulos de texto que no detecto, usa «Elegir subtítulos».', 'warn');
  else if (images) diag('El texto de las imágenes no es texto: usa <b>«Leer zona con OCR»</b>, o haz <b>clic derecho sobre la imagen → «Kantoro: leer el texto japonés de esta imagen»</b>.', 'warn');
  else if (jpText) diag('Hay texto japonés en la página: <b>selecciónalo</b> con el ratón y aparecerá el rōmaji.', 'ok');
  else diag('No encuentro texto japonés en esta página. Si está dentro de una imagen o vídeo, usa «Leer zona con OCR».', '');
  return host;
}

document.addEventListener('DOMContentLoaded', async () => {
  const sel = $('target');
  for (const [code, name] of LANGS) sel.add(new Option(name, code));
  const { settings } = await chrome.storage.sync.get('settings');
  S = { ...DEFAULTS, ...(settings || {}) };
  // Ajuste de versiones anteriores: «Reconocer en el dispositivo» desmarcado = servicio de Google
  if (!(settings && settings.asrEngine)) S.asrEngine = settings && settings.asrLocal === false ? 'cloud' : 'auto';
  fill();
  engineStatus();
  trStatus();
  const host = await siteInfo();

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', async () => {
    await save({ mode: r.value }); fill(); trStatus();
  }));
  $('target').addEventListener('change', async (e) => { await save({ target: e.target.value }); trStatus(); });
  $('trEngine').addEventListener('change', async (e) => { await save({ trEngine: e.target.value }); trStatus(); });
  for (const id of ['longVowels', 'particles', 'n', 'position', 'bubble', 'asrView', 'origScript']) $(id).addEventListener('change', (e) => save({ [id]: e.target.value }));
  for (const id of ['markAmbiguous', 'showOriginal', 'selection', 'pauseOnHover', 'resumeOnLeave']) {
    $(id).addEventListener('change', async (e) => { await save({ [id]: e.target.checked }); fill(); });
  }
  $('fontScale').addEventListener('input', (e) => { $('fsOut').textContent = Math.round(e.target.value * 100) + '%'; });
  $('fontScale').addEventListener('change', (e) => save({ fontScale: +e.target.value }));
  $('dl').addEventListener('click', download);
  $('ocr').addEventListener('click', startOrStop);
  document.querySelectorAll('input[name=videoSource]').forEach((r) => r.addEventListener('change', async () => {
    await save({ videoSource: r.value }); fill(); asrStatus();
  }));
  $('asrEngine').addEventListener('change', async (e) => { await save({ asrEngine: e.target.value, asrLocal: e.target.value !== 'cloud' }); asrStatus(); });
  $('subFiles').addEventListener('change', (e) => save({ subFiles: e.target.checked }));
  $('asrSpeakers').addEventListener('change', (e) => save({ asrSpeakers: e.target.checked }));
  $('asrDl').addEventListener('click', installAsr);
  asrStatus();
  $('inject').addEventListener('click', async () => {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['engine/subparse.js', 'content/content.js'] }).catch(() => {});
    setTimeout(siteInfo, 600);
  });
  $('pick').addEventListener('click', async () => {
    await chrome.tabs.sendMessage(tab.id, { cmd: 'pick' }).catch(() => {});
    closeUI();
  });
  $('resetSel').addEventListener('click', async () => {
    const cs = { ...S.customSelectors }; delete cs[host];
    await save({ customSelectors: cs }); siteInfo();
  });
});
