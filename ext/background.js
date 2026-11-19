/* Kantoro — service worker: motor offscreen, inyección, subtítulos interceptados, captura de pestaña
 * (OCR y audio), menús y atajos. */
'use strict';

const OFFSCREEN = 'offscreen/offscreen.html';
let creating = null;

async function hasEngineDoc() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN)],
  });
  return ctx.length > 0;
}

async function ensureEngine() {
  if (!(await hasEngineDoc())) {
    if (!creating) {
      creating = chrome.offscreen.createDocument({
        url: OFFSCREEN,
        reasons: ['WORKERS', 'USER_MEDIA'],
        justification: 'Analizador japonés, diccionario, OCR y reconocimiento de voz locales para generar rōmaji.',
      }).catch((e) => { if (!String(e).includes('single offscreen')) throw e; })
        .finally(() => { creating = null; });
    }
    await creating;
  }
  for (let i = 0; i < 300; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ to: 'engine', cmd: 'status' });
      if (r && (r.ready || r.error)) return r;
    } catch (_) { /* aún no escucha */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return { ready: false, error: 'timeout' };
}
const engine = async (msg) => { await ensureEngine(); return chrome.runtime.sendMessage(Object.assign({ to: 'engine' }, msg)); };

const CONTENT_FILES = ['engine/subparse.js', 'content/content.js'];
// Inyectar en las pestañas que ya estaban abiertas al instalar/actualizar (si no, no funcionaría hasta recargarlas)
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (t) => {
    if (!t.id || !/^(https?|file):/.test(t.url || '')) return;
    await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: CONTENT_FILES }).catch(() => {});
    if (/crunchyroll\.com/.test(t.url)) {
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content/hook.js'], world: 'MAIN' }).catch(() => {});
    }
  }));
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'rj-image', title: 'Kantoro: leer el texto japonés de esta imagen', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'rj-region', title: 'Kantoro: leer una zona de la pantalla (OCR)…', contexts: ['page', 'frame', 'video', 'selection', 'link'] });
    chrome.contextMenus.create({ id: 'rj-audio', title: 'Kantoro: transcribir el audio de esta pestaña', contexts: ['page', 'frame', 'video'] });
  });
}

chrome.runtime.onInstalled.addListener(() => { setupMenus(); injectIntoOpenTabs(); ensureEngine(); });
chrome.runtime.onStartup.addListener(() => { setupMenus(); ensureEngine(); });

// ───────────────────── Estado por pestaña (sobrevive a que el SW se duerma) ─────────────────────
async function tabState(tabId, patch) {
  const key = 'tab' + tabId;
  const cur = (await chrome.storage.session.get(key))[key] || {};
  if (!patch) return cur;
  const next = Object.assign(cur, patch);
  await chrome.storage.session.set({ [key]: next });
  return next;
}
chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove('tab' + tabId); engine({ cmd: 'capStop', tabId }).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) chrome.storage.session.remove('tab' + tabId); // navegación a otra página
});

// ───────────────────── Subtítulos interceptados ─────────────────────
const JP = /[぀-ヿ一-鿿]/;
const seenSubs = new Map(); // url → texto (caché breve)
async function fetchText(url) {
  if (seenSubs.has(url)) return seenSubs.get(url);
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const t = await res.text();
  seenSubs.set(url, t);
  if (seenSubs.size > 30) seenSubs.delete(seenSubs.keys().next().value);
  return t;
}
const KANA = /[\u3041-\u3096\u30a1-\u30fa]/g;
// Japonés y no chino: el diálogo japonés lleva kana; una pista china (zh-*) usa los mismos kanji sin kana
function isJapaneseText(text) {
  const sample = text.slice(0, 200000);
  const kana = (sample.match(KANA) || []).length;
  const han = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  return kana > 20 && kana >= han * 0.15;
}
async function deliverSubs(tabId, text, meta) {
  if (/^(zh|ko|yue|cmn)/i.test(meta.locale || '')) return false;
  if (!isJapaneseText(text)) return false;
  const st = await tabState(tabId);
  // Si ya hay una pista ja-JP oficial del episodio, no sustituirla por otro archivo detectado
  if (st.subLoaded && st.subLoaded.locale && !meta.locale && st.subLoaded.url !== meta.url) return false;
  await tabState(tabId, { subLoaded: { locale: meta.locale || '', url: meta.url } });
  // A todos los marcos: lo usa el que contiene el vídeo
  chrome.tabs.sendMessage(tabId, Object.assign({ cmd: 'subFile', text }, meta)).catch(() => {});
  return true;
}
const isJaLocale = (l) => /^ja([-_]|$)/i.test(l || '') || /japanese|日本語/i.test(l || '');

// Archivos de subtítulos descargados por cualquier reproductor (.ass/.ssa/.vtt/.srt o tipo MIME de subtítulos)
chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode !== 200) return;
  const ct = ((d.responseHeaders || []).find((h) => /^content-type$/i.test(h.name)) || {}).value || '';
  if (!/\.(ass|ssa|vtt|srt)(\?|$)/i.test(d.url) && !/x-ssa|x-ass|text\/vtt|subrip/i.test(ct)) return;
  fetchText(d.url).then((t) => deliverSubs(d.tabId, t, { url: d.url, locale: '', format: '' })).catch(() => {});
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other', 'media', 'object', 'sub_frame'] }, ['responseHeaders']);

// ───────────────────── Captura de la pestaña (OCR por vídeo y audio) ─────────────────────
async function biggestVideoFrame(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => Math.max(0, ...[...document.querySelectorAll('video')].map((v) => { const r = v.getBoundingClientRect(); return r.width * r.height; })),
  }).catch(() => []);
  let best = { frameId: 0, area: 0 };
  for (const r of res) if (r.result > best.area) best = { frameId: r.frameId, area: r.result };
  return best.frameId;
}

// mode: 'ocr' | 'audio'. Debe llamarse justo tras un gesto del usuario (popup, atajo, menú).
async function startSource(tabId, mode, streamIdFromPopup) {
  const st = await tabState(tabId);
  let streamId = streamIdFromPopup;
  if (!streamId) {
    try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); }
    catch (e) { streamId = null; await tabState(tabId, { capError: String(e.message || e) }); }
  }
  let cap = { error: 'no-stream' };
  if (streamId) {
    await engine({ cmd: 'capStop', tabId }).catch(() => {});
    // tamaño real del contenido de la pestaña en píxeles físicos
    const dims = await chrome.scripting.executeScript({ target: { tabId }, func: () => [innerWidth, innerHeight, devicePixelRatio] }).then((r) => r[0].result).catch(() => null);
    const width = dims ? Math.round(dims[0] * dims[2]) : 0, height = dims ? Math.round(dims[1] * dims[2]) : 0;
    cap = await engine({ cmd: 'capStart', tabId, streamId, video: mode === 'ocr', audio: mode === 'audio', width, height }).catch((e) => ({ error: String(e) }));
  }
  if (mode === 'ocr') {
    await tabState(tabId, { capture: cap && cap.ok ? 'ocr' : null });
    // Con captura de pestaña: OCR por fotogramas. Sin ella: capturas de pantalla (más lento)
    chrome.tabs.sendMessage(tabId, { cmd: 'ocrStart', stream: !!(cap && cap.ok) }).catch(() => {});
    return { ok: true, stream: !!(cap && cap.ok), error: cap && cap.error };
  }
  // Audio
  if (!cap || !cap.ok) { notice(tabId, 'no-stream'); return { error: (cap && cap.error) || 'capture', detail: st.capError }; }
  const frameId = await biggestVideoFrame(tabId);
  const { settings = {} } = await chrome.storage.sync.get('settings');
  // Motor de voz: 'auto' (dispositivo si la voz japonesa está instalada; si no, Google; y cambia solo si uno falla),
  // 'local' (solo dispositivo) o 'cloud' (solo Google). Compatibilidad: asrLocal=false de versiones anteriores = Google.
  const eng = settings.asrEngine || (settings.asrLocal === false ? 'cloud' : 'auto');
  let local = eng !== 'cloud';
  // Comprobación del modelo local en un contexto de la extensión (no afectado por las políticas de la página)
  if (local && !settings.asrSkipLocalCheck) {
    const st = await engine({ cmd: 'asrStatus', local: true }).catch(() => ({ av: 'error' }));
    if (!st || st.av !== 'available') {
      if (eng === 'auto') local = false; // sin voz japonesa instalada: servicio de Google
      else { await engine({ cmd: 'capStop', tabId }).catch(() => {}); notice(tabId, 'local-' + ((st && st.av) || 'error')); return { error: 'local-' + ((st && st.av) || 'error') }; }
    }
  }
  const r = await engine({ cmd: 'capPump', tabId, frameId });
  if (!r || r.error) { await engine({ cmd: 'capStop', tabId }).catch(() => {}); notice(tabId, (r && r.error) || 'asr'); return r || { error: 'asr' }; }
  await tabState(tabId, { capture: 'audio', asrFrame: frameId });
  // Contexto para el reconocedor: el título de la pestaña (serie, episodio, nombres)
  const title = await chrome.tabs.get(tabId).then((t) => (t.title || '').slice(0, 200)).catch(() => '');
  // La página inserta el marco invisible del reconocedor (asr/asr.html)
  const cfg = { tabId, uiFrame: frameId, local, auto: eng === 'auto', ctx: title, minConf: 0.05, maxFails: settings.asrMaxFails || 3 };
  // La interfaz (rōmaji) va en el marco del vídeo; el reconocedor, SIEMPRE en la página principal: los marcos
  // de los reproductores (p. ej. Crunchyroll) no delegan las funciones de voz y Chrome lo bloquearía.
  chrome.tabs.sendMessage(tabId, Object.assign({ cmd: 'asrStart', host: frameId === 0 }, cfg), { frameId }).catch(() => {});
  if (frameId !== 0) chrome.tabs.sendMessage(tabId, Object.assign({ cmd: 'asrHost' }, cfg), { frameId: 0 }).catch(() => {});
  await tabState(tabId, { asrCfg: cfg });
  return { ok: true };
}

// Aviso visible en la página (p. ej. al usar Alt+O sin el popup abierto)
function notice(tabId, code) {
  // A todos los marcos: lo muestra el que ocupa la pantalla (también un iframe en pantalla completa)
  chrome.tabs.sendMessage(tabId, { cmd: 'notice', code }).catch(() => {});
}

async function stopCapture(tabId) {
  await engine({ cmd: 'capStop', tabId }).catch(() => {});
  const st = await tabState(tabId);
  if (st.asrWindow) { chrome.windows.remove(st.asrWindow).catch(() => {}); await tabState(tabId, { asrWindow: null }); }
  await tabState(tabId, { capture: null });
  chrome.tabs.sendMessage(tabId, { cmd: 'capStopped' }).catch(() => {});
}

// ───────────────────── Mensajes ─────────────────────
let lastCapture = 0;
async function captureTab(windowId) {
  const wait = lastCapture + 520 - Date.now(); // captureVisibleTab: máx. ~2 por segundo
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'bg') return false;
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    switch (msg.cmd) {
      case 'ensureEngine':
        return ensureEngine();
      case 'translateViaTop':
        return chrome.tabs.sendMessage(tabId, { cmd: 'translate', text: msg.text, target: msg.target }, { frameId: 0 });
      case 'media':
        await chrome.tabs.sendMessage(tabId, { cmd: 'media', action: msg.action, token: msg.token }).catch(() => {});
        return { ok: true };
      // — subtítulos —
      case 'subsIndex': { // lista de pistas que ofrece el episodio (Crunchyroll)
        const tracks = msg.tracks || [];
        const locales = [...new Set(tracks.map((t) => t.locale).filter(Boolean))];
        const ja = tracks.find((t) => isJaLocale(t.locale) && t.kind === 'subtitles') || tracks.find((t) => isJaLocale(t.locale));
        await tabState(tabId, { subLocales: locales, subJa: ja ? ja.locale : null });
        if (ja) {
          try { await deliverSubs(tabId, await fetchText(ja.url), { url: ja.url, locale: ja.locale, format: ja.format }); }
          catch (e) { await tabState(tabId, { subError: String(e.message || e) }); }
        }
        return { ok: true };
      }
      case 'subsText':
        return { ok: await deliverSubs(tabId, msg.text, { url: msg.url, locale: '', format: '' }) };
      case 'tabState':
        return tabState(msg.tabId);
      // — captura —
      case 'startSource':
        return startSource(msg.tabId, msg.mode, msg.streamId);
      case 'capStop':
        await stopCapture(msg.tabId || tabId);
        return { ok: true };
      case 'ocrStreamRegion': // zona elegida en la página → OCR por fotogramas
        return engine({ cmd: 'capOcr', tabId, frameId: sender.frameId, rect: msg.rect, viewW: msg.viewW, viewH: msg.viewH, kind: msg.kind });
      case 'asrPolicyBlocked': { // la web prohíbe la voz incluso en la página principal → ventana propia
        const st = await tabState(tabId);
        if (st.asrWindow) return { ok: true };
        const c = st.asrCfg || {};
        const url = chrome.runtime.getURL('asr/asr.html') + `#tab=${tabId}&frame=${c.uiFrame || 0}&local=${c.local ? 1 : 0}&auto=${c.auto ? 1 : 0}&ctx=${encodeURIComponent(c.ctx || '')}&minConf=${c.minConf || 0.05}&maxFails=${c.maxFails || 3}&window=1`;
        const w = await chrome.windows.create({ url, type: 'popup', width: 360, height: 160, focused: false }).catch(() => null);
        await tabState(tabId, { asrWindow: w ? w.id : null });
        notice(tabId, w ? 'asr-window' : 'asr-policy');
        return { ok: !!w };
      }
      case 'ocrPush':
      case 'asrPush':
        chrome.tabs.sendMessage(msg.tabId, msg, { frameId: msg.frameId || 0 }).catch(() => {});
        return { ok: true };
      case 'capEnded':
        await tabState(msg.tabId, { capture: null });
        chrome.tabs.sendMessage(msg.tabId, { cmd: 'capStopped' }).catch(() => {});
        return { ok: true };
      case 'ocrCapture': { // modo antiguo: captura de pantalla (sin tabCapture)
        let src;
        try { src = await captureTab(sender.tab.windowId); }
        catch (e) { return { error: 'capture', detail: String(e.message || e) }; }
        return engine({ cmd: 'ocr', src, crop: msg.rect, viewW: msg.viewW, kind: msg.kind, key: msg.key });
      }
      default:
        return { error: 'unknown' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const frame = { frameId: info.frameId || 0 };
  if (info.menuItemId === 'rj-region') { startSource(tab.id, 'ocr'); return; }
  if (info.menuItemId === 'rj-audio') { startSource(tab.id, 'audio'); return; }
  if (info.menuItemId === 'rj-image') {
    chrome.tabs.sendMessage(tab.id, { cmd: 'ocrBusy', src: info.srcUrl }, frame).catch(() => {});
    const res = await engine({ cmd: 'ocr', src: info.srcUrl, kind: 'page' }).catch((e) => ({ error: String(e) }));
    if (!res || res.error) {
      chrome.tabs.sendMessage(tab.id, { cmd: 'ocrImageFallback', src: info.srcUrl }, frame).catch(() => {});
      return;
    }
    chrome.tabs.sendMessage(tab.id, { cmd: 'ocrImageResult', src: info.srcUrl, res }, frame).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === 'toggle-overlay') {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    settings.enabled = settings.enabled === false;
    await chrome.storage.sync.set({ settings });
  } else if (cmd === 'ocr-region' && tab && tab.id) {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    const st = await tabState(tab.id);
    if (st.capture) await stopCapture(tab.id); // Alt+O otra vez = detener
    else startSource(tab.id, settings.videoSource === 'audio' ? 'audio' : 'ocr');
  }
});
