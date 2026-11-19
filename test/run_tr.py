import asyncio, os, threading, http.server, functools
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/profile2', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'], viewport={'width': 1280, 'height': 900})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate("chrome.storage.sync.set({settings:{mode:'romaji+tr', target:'es', longVowels:'macron', showOriginal:true}})")
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8766/index.html')
        await page.wait_for_timeout(3500)
        print(await page.evaluate('setLine(0)'))
        await page.wait_for_timeout(800)
        print(await page.evaluate("""[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.box.on')).filter(Boolean).map(b=>b.innerText)"""))
        await page.screenshot(path='shot_tr.png', clip={'x':150,'y':380,'width':980,'height':260})
        b = await page.evaluate("""(()=>{for(const h of document.querySelectorAll('kantoro-layer')){const b=h.shadowRoot&&h.shadowRoot.querySelector('.box.on');if(b&&b.getBoundingClientRect().top<640){const r=b.querySelectorAll('.w')[2].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}}})()""")
        await page.mouse.move(b['x'], b['y']); await page.wait_for_timeout(800)
        await page.screenshot(path='shot_tooltip2.png')
        await ctx.close()
asyncio.run(main())
