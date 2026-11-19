import asyncio, os, threading, http.server, functools, subprocess, json, sys
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8781), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
LOCAL = sys.argv[1] == 'local'
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pau', headless=False, no_viewport=True,
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate(f"chrome.storage.sync.set({{settings:{{videoSource:'audio', asrLocal:{'true' if LOCAL else 'false'}}}}})")
        await sw.evaluate('ensureEngine()')
        print('estado voz:', await sw.evaluate(f"engine({{cmd:'asrStatus', local:{'true' if LOCAL else 'false'}}})"))
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8781/audio.html'); await page.wait_for_timeout(2500)
        subprocess.run(['xdotool', 'search', '--name', 'Audio test', 'windowactivate', '--sync'], capture_output=True)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'alt+o']); await page.wait_for_timeout(9000 if not LOCAL else 3000)
        tid = await sw.evaluate("async () => (await chrome.tabs.query({url:'http://127.0.0.1:8781/*'}))[0].id")
        print('estado pestaña:', await sw.evaluate(f"tabState({tid})"))
        print('DEBUG:', json.dumps(await sw.evaluate(f"engine({{cmd:'capDebug', tabId:{tid}}})"), ensure_ascii=False))
        print('aviso:', await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.t')).filter(Boolean).map(t=>t.textContent)"))
        print('overlay:', await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.box.on')).filter(Boolean).map(b=>b.innerText)"))
        print('video sigue sonando (no silenciado por la captura):', await page.evaluate("!document.getElementById('v').paused"))
        await ctx.close()
asyncio.run(main())
