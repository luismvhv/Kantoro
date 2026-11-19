import asyncio, os, threading, http.server, functools, json, subprocess
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8786), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pm2', headless=False, no_viewport=True, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate("chrome.storage.sync.set({settings:{videoSource:'audio', asrLocal:false, asrMaxFails: 99999}})")
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8786/audio.html'); await page.bring_to_front(); await page.wait_for_timeout(1500)
        subprocess.run(['xdotool', 'search', '--name', 'Audio test', 'windowactivate', '--sync'], capture_output=True)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'alt+o'])
        await page.wait_for_timeout(6000)
        fr = await page.evaluate("[...document.querySelectorAll('iframe')].map(f=>f.src.replace(/^chrome-extension:\\/\\/[^/]+/,''))")
        print('marco del reconocedor:', fr)
        info = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.p .st')).filter(Boolean).map(e=>[e.textContent, e.title])")
        print('monitor:', info[0][0] if info else None)
        if info: print('detalle:', info[0][1])
        asr = next((f for f in page.frames if 'asr.html' in f.url), None)
        if asr:
            b64 = await asr.evaluate('''() => new Promise((done) => { const rec = new MediaRecorder(new MediaStream([track]), { mimeType: 'audio/webm' }); const parts = [];
                rec.ondataavailable = (e) => parts.push(e.data); rec.onstop = async () => { const b = new Uint8Array(await new Blob(parts).arrayBuffer()); let s=''; for (let i=0;i<b.length;i+=8192) s += String.fromCharCode(...b.subarray(i,i+8192)); done(btoa(s)); };
                rec.start(); setTimeout(() => rec.stop(), 6000); })''')
            import base64; open('/tmp/w/gen.webm','wb').write(base64.b64decode(b64)); print('grabado de la pista generada:', len(b64), 'bytes b64')
        if asr: print('visibilidad del marco:', await asr.evaluate('document.visibilityState'), '| generador:', await asr.evaluate("typeof MediaStreamTrackGenerator"))
        await ctx.close()
asyncio.run(main())
