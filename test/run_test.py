import asyncio, json, sys, threading, http.server, functools, os
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    http.server.ThreadingHTTPServer(('127.0.0.1', 8765), h).serve_forever()
threading.Thread(target=serve, daemon=True).start()
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None

async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/profile', headless=False,
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--autoplay-policy=no-user-gesture-required'],
            viewport={'width': 1280, 'height': 900})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        logs = []
        page = await ctx.new_page()
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        await page.goto('http://127.0.0.1:8765/index.html')
        await page.evaluate("document.getElementById('v').play()")
        # Esperar motor
        t = await sw.evaluate("""async () => { const t0 = performance.now(); const r = await (async () => {
            for (let i=0;i<300;i++){ try { const r = await chrome.runtime.sendMessage({to:'engine',cmd:'status'}); if (r && (r.ready||r.error)) return r; } catch(e){} await new Promise(r=>setTimeout(r,100)); } })();
            return {r, waited: performance.now()-t0}; }""")
        print('ENGINE', json.dumps(t))
        res = []
        for rnd in range(2):
            for i in range(5):
                r = await page.evaluate(f'setLine({i})')
                res.append(r); print(('frío ' if rnd == 0 else 'caché') , json.dumps(r, ensure_ascii=False))
                await page.wait_for_timeout(250)
        # Pista nativa
        await page.evaluate("document.getElementById('v2').play()")
        await page.wait_for_timeout(1500)
        tr = await page.evaluate("""[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.box.on .ro')).filter(Boolean).map(x=>x.textContent)""")
        print('TRACK overlays:', tr)
        await page.screenshot(path='shot_overlay.png')
        # Hover → pausa + tooltip
        await page.evaluate('setLine(2)')
        box = await page.evaluate("""(() => { for (const h of document.querySelectorAll('kantoro-layer')) { const b = h.shadowRoot && h.shadowRoot.querySelector('.box.on'); if (b && b.getBoundingClientRect().top < 640) { const w = b.querySelectorAll('.w')[0]; const r = w.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, w: w.textContent}; } } })()""")
        print('hover sobre', box)
        before = await page.evaluate("document.getElementById('v').paused")
        await page.mouse.move(box['x'], box['y'])
        await page.wait_for_timeout(900)
        after = await page.evaluate("document.getElementById('v').paused")
        tipText = await page.evaluate("""[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.tip')).filter(t=>t&&t.style.display!=='none').map(t=>t.innerText.slice(0,700))""")
        print('pausado antes/después:', before, after)
        print('TOOLTIP:', tipText)
        await page.screenshot(path='shot_tooltip.png')
        await page.mouse.move(5, 5)
        await page.wait_for_timeout(700)
        print('reanudado:', not await page.evaluate("document.getElementById('v').paused"))
        # Selección de texto
        await page.evaluate("""(()=>{const p=document.querySelector('p');const r=document.createRange();r.selectNodeContents(p.firstChild);r.setStart(p.firstChild,8);getSelection().removeAllRanges();getSelection().addRange(r);})()""")
        await page.mouse.move(500, 820); await page.mouse.down(); await page.mouse.up()
        await page.evaluate("""(()=>{const p=document.querySelector('p');const r=document.createRange();r.setStart(p.firstChild,8);r.setEnd(p.firstChild,p.firstChild.length);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));})()""")
        await page.wait_for_timeout(600)
        sel = await page.evaluate("""[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.box.sel.on .ro')).filter(Boolean).map(x=>x.textContent)""")
        print('SELECCIÓN:', sel)
        # Popup
        ext_id = sw.url.split('/')[2]
        pp = await ctx.new_page(); await pp.set_viewport_size({'width': 360, 'height': 640})
        await pp.goto(f'chrome-extension://{ext_id}/popup/popup.html'); await pp.wait_for_timeout(1500)
        await pp.screenshot(path='shot_popup.png', full_page=True)
        print('popup engine:', await pp.inner_text('#engine'), '| tr:', await pp.inner_text('#trStatus'))
        errs = [l for l in logs if l.startswith('error')]
        print('errores consola:', errs[:5])
        await ctx.close()
asyncio.run(main())
