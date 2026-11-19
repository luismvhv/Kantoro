import asyncio, os, threading, http.server, functools, json, subprocess
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8784), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pme', headless=False, no_viewport=True, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate("chrome.storage.sync.set({settings:{videoSource:'audio', asrLocal:false, asrMaxFails: 99999}})")
        await sw.evaluate('ensureEngine()')
        for url, title, label in [('audio.html', 'Audio test', 'vídeo con voz'), ('canvas.html?ms=99999', 'Canvas subs', 'vídeo mudo')]:
            page = await ctx.new_page(); await page.goto(f'http://127.0.0.1:8784/{url}'); await page.bring_to_front(); await page.wait_for_timeout(1500)
            subprocess.run(['xdotool', 'search', '--name', title, 'windowactivate', '--sync'], capture_output=True)
            subprocess.run(['xdotool', 'key', '--clearmodifiers', 'alt+o'])
            for t in (3, 9, 17):
                await page.wait_for_timeout(3000 if t == 3 else (6000 if t == 9 else 8000))
                st = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.p')).filter(Boolean).map(p=>p.innerText.replace(/\\n/g,' '))")
                print(f'{label} ~{t}s:', st)
            tid = await sw.evaluate(f"async () => (await chrome.tabs.query({{active:true}}))[0].id")
            await sw.evaluate(f"stopCapture({tid})")
            # ¿se mantiene el permiso de captura tras el primer Alt+O? (necesario para la burbuja)
            r = await sw.evaluate(f"chrome.tabCapture.getMediaStreamId({{targetTabId:{tid}}}).then(()=> 'SÍ, se puede capturar sin nuevo gesto', e => 'NO: ' + e.message)")
            print('  después, sin gesto:', r)
            if label == 'vídeo con voz': await page.screenshot(path='shot_meter.png')
            await page.close()
        await ctx.close()
asyncio.run(main())
