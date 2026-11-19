import asyncio, os, threading, http.server, functools, json, subprocess
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
import sys
if 'policy' in sys.argv:
    import subprocess as sp; sp.Popen(['python3','pp_server.py','8789'])
for port in (8787, 8788):
    threading.Thread(target=lambda port=port: http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
LOCAL = 'true' if 'local' in sys.argv else 'false'
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pne', headless=False, no_viewport=True, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate(f"chrome.storage.sync.set({{settings:{{videoSource:'audio', asrLocal: {LOCAL}, asrSkipLocalCheck: true, asrMaxFails: 99999}}}})")
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:%d/%s' % ((8789, 'audio.html') if 'policy' in sys.argv else (8787, 'nested_top.html'))); await page.bring_to_front(); await page.wait_for_timeout(2500)
        subprocess.run(['xdotool', 'search', '--name', 'Audio test' if 'policy' in sys.argv else 'Nested test', 'windowactivate', '--sync'], capture_output=True)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'alt+o'])
        await page.wait_for_timeout(3500)
        if 'forcewin' in sys.argv:
            for f in page.frames:
                if 'asr.html' in f.url: await f.evaluate("chrome.runtime.sendMessage({ to: 'bg', cmd: 'asrPolicyBlocked' })")
            await page.wait_for_timeout(4000)
        for f in page.frames:
            if 'asr.html' in f.url:
                try: print('estado del reconocedor:', await f.evaluate('JSON.stringify(stats)'))
                except Exception as e: print('ERR', e)
        for pg in ctx.pages:
            if 'asr.html' in pg.url: print('ventana:', await pg.evaluate('JSON.stringify(stats)'))
        await page.wait_for_timeout(500)
        for f in page.frames:
            if 'asr.html' in f.url:
                parent = f.parent_frame.url if f.parent_frame else None
                print('marco reconocedor dentro de:', parent)
        for f in page.frames:
            try:
                r = await f.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&(h.shadowRoot.querySelector('.p .st')||h.shadowRoot.querySelector('.box.on'))).filter(Boolean).map(e=>e.textContent)")
                if r: print('UI en', f.url, '→', r)
            except Exception: pass
        pops = [pg.url.split('#')[0].split('/')[-1] for pg in ctx.pages if 'asr.html' in pg.url]
        print('ventanas propias del reconocedor:', pops)
        for f in page.frames:
            try:
                t = await f.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.t')).filter(Boolean).map(e=>e.textContent)")
                if t: print('aviso:', t)
            except Exception: pass
        await ctx.close()
asyncio.run(main())
