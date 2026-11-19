import asyncio, os, sys, threading, http.server, functools, json
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8770), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
PROBE = "async (u) => { const [t] = await chrome.tabs.query({url: u}); const r = await chrome.scripting.executeScript({target:{tabId:t.id, allFrames:true}, func: () => window.__kantoroProbe ? window.__kantoroProbe() : null}); return r.map(x=>x.result); }"
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/p2', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--autoplay-policy=no-user-gesture-required'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        logs=[]
        # ---- 1. Imagen del cuento: menú contextual (simulado) ----
        page = await ctx.new_page(); page.on('console', lambda m: logs.append('page: '+m.text))
        await page.goto('http://127.0.0.1:8770/story.html'); await page.wait_for_timeout(3000)
        print('PROBE cuento:', json.dumps(await sw.evaluate(PROBE, 'http://127.0.0.1:8770/story.html'), ensure_ascii=False)[:300])
        res = await sw.evaluate("""async () => { const t0=performance.now(); const [tab] = await chrome.tabs.query({url:'http://127.0.0.1:8770/story.html'});
            const src='http://127.0.0.1:8770/story.png'; chrome.tabs.sendMessage(tab.id,{cmd:'ocrBusy',src});
            const res = await engine({cmd:'ocr', src, kind:'page'}); chrome.tabs.sendMessage(tab.id,{cmd:'ocrImageResult',src,res}); return {ms: performance.now()-t0, lines: res.lines && res.lines.map(l=>l.text+'  (conf '+Math.round(l.conf)+', dudosos '+l.low.length+')'), err: res.error}; }""")
        print('OCR imagen (incl. carga del OCR):', round(res['ms']), 'ms'); print('\n'.join(res['lines'] or [str(res)]))
        await page.wait_for_timeout(2500)
        panel = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.pn')).filter(p=>p&&p.style.display!=='none').map(p=>p.innerText)")
        print('PANEL:\n', (panel[0] if panel else 'NO PANEL')[:900])
        # hover en una palabra del panel + resaltado
        pos = await page.evaluate("""(()=>{for(const h of document.querySelectorAll('kantoro-layer')){const p=h.shadowRoot&&h.shadowRoot.querySelector('.pn');if(p&&p.style.display!=='none'){const w=p.querySelectorAll('.w')[3];const r=w.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:w.textContent}}}})()""")
        await page.mouse.move(pos['x'], pos['y']); await page.wait_for_timeout(900)
        await page.screenshot(path='shot_story.png')
        # ---- 2. Zona con el ratón sobre el cuento (captura de pantalla real) ----
        await page.evaluate("1"); await page.mouse.move(5,5)
        await sw.evaluate("async () => { const [t] = await chrome.tabs.query({url:'http://127.0.0.1:8770/story.html'}); await chrome.tabs.sendMessage(t.id,{cmd:'ocrStart'}); }")
        await page.wait_for_timeout(400)
        await page.mouse.move(45, 45); await page.mouse.down(); await page.mouse.move(300, 200, steps=5); await page.mouse.move(505, 500, steps=5); await page.mouse.up()
        await page.wait_for_timeout(5000)
        panel = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].map(h=>h.shadowRoot&&h.shadowRoot.querySelector('.pn')).filter(p=>p&&p.style.display!=='none').map(p=>p.innerText)")
        print('PANEL zona:\n', (panel[0] if panel else 'NO PANEL')[:500])
        # ---- 3. Subtítulos dibujados en canvas, OCR continuo (fondo oscuro y fondo claro en movimiento) ----
        for q in ('', '?bg'):
            v = await ctx.new_page(); v.on('console', lambda m: logs.append('canvas: '+m.text))
            url = 'http://127.0.0.1:8770/canvas.html' + q
            await v.goto(url); await v.wait_for_timeout(1500)
            if not q: print('PROBE canvas:', json.dumps(await sw.evaluate(PROBE, url), ensure_ascii=False)[:300])
            await sw.evaluate("async (u) => { const [t] = await chrome.tabs.query({url: u}); await chrome.tabs.sendMessage(t.id,{cmd:'ocrStart'}); }", url)
            await v.wait_for_timeout(400)
            await v.mouse.move(180, 540); await v.mouse.down(); await v.mouse.move(700, 580, steps=4); await v.mouse.move(1100, 625, steps=4); await v.mouse.up()
            seen = {}; last = None
            for k in range(100):
                await v.wait_for_timeout(200)
                st = await v.evaluate("""(()=>{let ro=null;for(const h of document.querySelectorAll('kantoro-layer')){const b=h.shadowRoot&&h.shadowRoot.querySelector('.box.on .ro');if(b)ro=b.textContent}return {shown:window.__shown, at:window.__shownAt, now:performance.now(), ro}})()""")
                if st['ro'] and st['ro'] != last:
                    last = st['ro']
                    if st['shown'] not in seen: seen[st['shown']] = (st['ro'], round(st['now']-st['at']))
            print('== fondo', 'claro en movimiento' if q else 'oscuro')
            for k2, val in seen.items(): print('  ', k2, '→', val[0], f'(~{val[1]} ms)')
            await v.screenshot(path='shot_canvas%s.png' % q.replace('?','_'))
            await v.close()
        print('errores:', [l for l in logs if 'rror' in l][:5])
        await ctx.close()
asyncio.run(main())
