import asyncio, os, threading, http.server, functools
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8774), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/p6', headless=False, no_viewport=True, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8774/story.html'); await page.wait_for_timeout(6000)
        print('viewport', await page.evaluate("[innerWidth, innerHeight]"))
        for (x0,y0,x1,y1) in [(30,30,520,600), (45,45,505,500)]:
            await sw.evaluate("async () => { const [t] = await chrome.tabs.query({url:'http://127.0.0.1:8774/story.html'}); await chrome.tabs.sendMessage(t.id,{cmd:'ocrStart'}); }")
            await page.wait_for_timeout(400)
            await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0+x1)//2, (y0+y1)//2, steps=5); await page.mouse.move(x1, y1, steps=5); await page.mouse.up()
            await page.wait_for_timeout(3500)
            panel = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.pn')).filter(p=>p&&p.style.display!=='none').map(p=>[...p.querySelectorAll('.ja')].map(j=>j.innerText).join('\\n'))")
            print(f'== zona {x0},{y0} → {x1},{y1}\n' + (panel[0] if panel else 'NO PANEL'))
        await page.screenshot(path='shot_zona.png')
        await ctx.close()
asyncio.run(main())
