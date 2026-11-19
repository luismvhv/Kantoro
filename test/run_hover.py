import asyncio, os, threading, http.server, functools, json
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8792), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
W = """(() => { for (const h of document.querySelectorAll('kantoro-layer')) { const b = h.shadowRoot && h.shadowRoot.querySelector('.box.on'); if (!b) continue;
  return [...b.querySelectorAll('.w')].map(w => { const r = w.getBoundingClientRect(); return { t: w.textContent, x: r.x + r.width/2, y: r.y + r.height/2, l: r.left, r: r.right }; }); } return []; })()"""
TIP = """(() => { for (const h of document.querySelectorAll('kantoro-layer')) { const c = h.shadowRoot && h.shadowRoot.querySelector('.tip'); if (c && c.style.display !== 'none') return c.querySelector('.rm') ? c.querySelector('.rm').textContent : '(cargando)'; } return null; })()"""
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pho', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--autoplay-policy=no-user-gesture-required'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate("chrome.storage.sync.set({settings:{asrView:'phrase'}})")
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8792/audio.html'); await page.wait_for_timeout(2000)
        await page.evaluate("document.getElementById('v').play()")
        tid = await sw.evaluate("async () => (await chrome.tabs.query({url:'http://127.0.0.1:8792/*'}))[0].id")
        await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {{cmd:'asrStart', tabId:{tid}, uiFrame:0, host:false}}, {{frameId:0}})")
        await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {json.dumps({'cmd':'asrPush','fin':'大変なことが起きたんだ早く逃げろ','spk':0,'interim':''}, ensure_ascii=False)}, {{frameId:0}})")
        await page.wait_for_timeout(700)
        ws = await page.evaluate(W); print('palabras:', [w['t'] for w in ws])
        paused = lambda: page.evaluate("document.getElementById('v').paused")
        await page.mouse.move(ws[0]['x'], ws[0]['y']); await page.wait_for_timeout(900)
        print('1) sobre', ws[0]['t'], '→ pausado:', await paused(), '| ficha:', await page.evaluate(TIP))
        # mantener el ratón quieto 8 s (antes: a los 4,5 s el subtítulo de voz caducaba y se reanudaba solo)
        seen = set()
        for _ in range(16):
            await page.wait_for_timeout(500); seen.add((await paused(), await page.evaluate(TIP)))
        print('2) 8 s quieto → estados vistos:', seen)
        # mientras está congelado llega voz nueva: no debe cambiar la palabra bajo el cursor
        await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {json.dumps({'cmd':'asrPush','interim':'お前はもう','spk':0}, ensure_ascii=False)}, {{frameId:0}})")
        await page.wait_for_timeout(600)
        print('3) llega voz nueva durante el hover → palabras siguen siendo:', [w['t'] for w in await page.evaluate(W)][:3], '| ficha:', await page.evaluate(TIP))
        # pasar despacio de palabra en palabra, deteniéndose en los espacios
        for i in range(1, min(5, len(ws))):
            gx = (ws[i-1]['r'] + ws[i]['l']) / 2
            await page.mouse.move(gx, ws[i]['y'], steps=6); await page.wait_for_timeout(600)   # parado en el espacio 0,6 s
            await page.mouse.move(ws[i]['x'], ws[i]['y'], steps=6); await page.wait_for_timeout(700)
            print(f'4.{i}) en {ws[i]["t"]!r} → pausado: {await paused()} | ficha: {await page.evaluate(TIP)}')
        # salir del cuadro
        card = await page.evaluate("(() => { for (const h of document.querySelectorAll('kantoro-layer')) { const c = h.shadowRoot && h.shadowRoot.querySelector('.tip'); if (c && c.style.display !== 'none') { const r = c.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; } } })()")
        print('   ficha ocupa', [round(v) for v in card])
        # pasar a la ficha (debe seguir en pausa) y después salir a una esquina vacía
        await page.mouse.move((card[0]+card[2])/2, card[3]-30, steps=12); await page.wait_for_timeout(700)
        print('4.9) dentro de la ficha → pausado:', await paused(), '| ficha:', await page.evaluate(TIP))
        await page.mouse.move(40, 780, steps=10); await page.wait_for_timeout(800)
        print('5) fuera del cuadro → pausado:', await paused(), '| ficha:', await page.evaluate(TIP))
        print('   palabras tras salir (se aplica lo pendiente):', [w['t'] for w in await page.evaluate(W)])
        await ctx.close()
asyncio.run(main())
