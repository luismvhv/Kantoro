import asyncio, os, threading, http.server, functools, json
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8782), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pui', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--autoplay-policy=no-user-gesture-required'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8782/audio.html'); await page.wait_for_timeout(2000)
        tid = await sw.evaluate("async () => (await chrome.tabs.query({url:'http://127.0.0.1:8782/*'}))[0].id")
        await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {{cmd:'asrStart', local:true}}, {{frameId:0}})")
        # Secuencia típica del reconocedor: parciales que crecen y un final
        seq = [('interim','きょうは'), ('interim','今日は本当に'), ('interim','今日は本当にいい天気'), ('fin','今日は本当にいい天気ですね'),
               ('interim','一緒に'), ('interim','一緒に頑張ろう'), ('fin','一緒に頑張ろうね')]
        for kind, text in seq:
            t = await page.evaluate("performance.now()")
            msg = {'cmd':'asrPush', 'fin': text if kind=='fin' else '', 'interim': text if kind=='interim' else ''}
            await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {json.dumps(msg, ensure_ascii=False)}, {{frameId:0}})")
            r = await page.evaluate("""(t0) => new Promise((done) => { const f = () => { let ro='';
                for (const h of document.querySelectorAll('kantoro-layer')) { const b = h.shadowRoot && h.shadowRoot.querySelector('.box.on .ro'); if (b) ro = [...b.querySelectorAll('.row')].map(x=>x.textContent).join(' / '); }
                if (ro && ro !== window.__lastRo) { window.__lastRo = ro; done([performance.now()-t0, ro]); } else if (performance.now()-t0 > 3000) done([-1, ro]); else requestAnimationFrame(f); }; f(); })""", t)
            print(f'{kind:7} {text:14} → {r[1]!r}  ({r[0]:.0f} ms desde el mensaje)')
        await page.screenshot(path='shot_asr.png')
        await ctx.close()
asyncio.run(main())
