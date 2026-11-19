import asyncio, os, threading, http.server, functools, json
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8785), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pbu', headless=False, no_viewport=True, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8785/canvas.html?bg&ms=2500'); await page.wait_for_timeout(2500)
        await page.evaluate("document.getElementById('p').addEventListener('click', () => document.getElementById('p').requestFullscreen())")
        await page.mouse.click(640, 300); await page.wait_for_timeout(1500)
        info = await page.evaluate("""(() => { const fs = document.fullscreenElement; const h = [...document.querySelectorAll('kantoro-layer')].find(h => h.shadowRoot && h.shadowRoot.querySelector('.b'));
            const b = h && h.shadowRoot.querySelector('.b').getBoundingClientRect();
            return { fullscreen: !!fs, bubbleInsideFullscreen: !!(h && fs && fs.contains(h)), bubble: b && [Math.round(b.x), Math.round(b.y)] }; })()""")
        print('pantalla completa + burbuja:', info)
        await page.mouse.click(info['bubble'][0] + 21, info['bubble'][1] + 21); await page.wait_for_timeout(2500)
        fr = next((f for f in page.frames if 'popup.html' in f.url), None)
        print('panel abierto con el popup dentro:', bool(fr), '| sigue en pantalla completa:', await page.evaluate('!!document.fullscreenElement'))
        if fr:
            print('  diagnóstico en el panel:', (await fr.inner_text('#diag'))[:160])
            print('  botón principal:', await fr.inner_text('#ocr'))
        await page.screenshot(path='shot_bubble.png')
        await fr.click('#ocr'); await page.wait_for_timeout(1500)
        sel = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].some(h=>h.shadowRoot&&h.shadowRoot.querySelector('.shade'))")
        panel_on = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].some(h=>h.shadowRoot&&h.shadowRoot.querySelector('.pn.on'))")
        print('tras pulsar OCR en el panel → panel cerrado:', not panel_on, '| selector de zona visible:', sel, '| sigue en pantalla completa:', await page.evaluate('!!document.fullscreenElement'))
        # marcar la franja de subtítulos y ver el rōmaji (sin gesto previo: método de respaldo por capturas)
        c = await page.evaluate("(()=>{const r=document.getElementById('c').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()")
        x0, y0, x1, y1 = c[0]+40, c[1]+470, c[0]+c[2]-40, c[1]+560
        await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0+x1)/2, (y0+y1)/2, steps=4); await page.mouse.move(x1, y1, steps=4); await page.mouse.up()
        await page.wait_for_timeout(5000)
        ro = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.box.on .ro')).filter(Boolean).map(b=>b.textContent)")
        print('rōmaji en pantalla completa:', ro, '| texto mostrado:', await page.evaluate('window.__shown'))
        await page.screenshot(path='shot_bubble2.png')
        await ctx.close()
asyncio.run(main())
