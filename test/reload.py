import asyncio, os, threading, http.server, functools
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8776), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/p8', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8776/index.html'); await page.wait_for_timeout(3000)
        print('antes:', await page.evaluate('setLine(0)'))
        # pestaña sin script (como si estuviera abierta antes de instalar)
        await sw.evaluate("""async () => { const [t] = await chrome.tabs.query({url:'http://127.0.0.1:8776/index.html'});
            await chrome.scripting.executeScript({target:{tabId:t.id, allFrames:true}, func: () => { window.__kantoro && window.__kantoro.teardown(); delete window.__kantoro; }}); }""")
        await page.wait_for_timeout(300)
        r0 = await page.evaluate('setLine(1)')
        print('sin script:', r0, '| capas:', await page.evaluate("document.querySelectorAll('kantoro-layer').length"))
        await sw.evaluate('injectIntoOpenTabs()')
        await page.wait_for_timeout(1500)
        r = await page.evaluate('setLine(3)')
        await sw.evaluate('injectIntoOpenTabs()')  # una segunda inyección no debe duplicar nada
        await page.wait_for_timeout(800)
        r2 = await page.evaluate('setLine(4)')
        n = await page.evaluate("document.querySelectorAll('kantoro-layer').length")
        print('tras inyectar (sin recargar):', r, '\n2ª inyección:', r2, '| capas:', n)
        await ctx.close()
asyncio.run(main())
