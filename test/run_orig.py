import asyncio, os, threading, http.server, functools, json
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8793), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
GET = """(() => { for (const h of document.querySelectorAll('kantoro-layer')) { const b = h.shadowRoot && h.shadowRoot.querySelector('.box.on .ro'); if (!b) continue;
  const box = b.closest('.box'); const ja = box.querySelector('.ja'); const jw = [...box.querySelectorAll('.jw')].map(x => x.textContent);
  const ro = b.querySelector('.rl, .row, .rail'); const rr = (ro || b).getBoundingClientRect(); const jr = (ja || box.querySelector('.jw') || b).getBoundingClientRect();
  return { ja: ja ? ja.textContent : null, jw: jw.length ? jw.join('|') : null, debajo: jr.top >= rr.top + 5 }; } })()"""
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/por', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--autoplay-policy=no-user-gesture-required'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate('ensureEngine()')
        # 1) subtítulos de texto (como los de YouTube / archivos interceptados)
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8793/index.html'); await page.wait_for_timeout(2000)
        for script in ('kanji', 'kana'):
            await sw.evaluate(f"chrome.storage.sync.set({{settings:{{showOriginal:true, origScript:'{script}'}}}})"); await page.wait_for_timeout(400)
            await page.evaluate("document.getElementById('seg').textContent='コーヒーを飲みに東京へ行きました。'"); await page.wait_for_timeout(700)
            print(f'subtítulos de texto · {script:5} →', await page.evaluate(GET))
            await page.evaluate("document.getElementById('seg').textContent=''"); await page.wait_for_timeout(300)
        await page.close()
        # 2) voz: frase a frase y cinta
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8793/audio.html'); await page.wait_for_timeout(1500)
        tid = await sw.evaluate("async () => (await chrome.tabs.query({url:'http://127.0.0.1:8793/audio.html'}))[0].id")
        for view in ('phrase', 'ticker'):
            for script in ('kanji', 'kana'):
                await sw.evaluate(f"chrome.storage.sync.set({{settings:{{showOriginal:true, origScript:'{script}', asrView:'{view}'}}}})")
                await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {{cmd:'asrStart', tabId:{tid}, uiFrame:0, host:false}}, {{frameId:0}})")
                await page.wait_for_timeout(300)
                await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {json.dumps({'cmd':'asrPush','fin':'先生はコーヒーが好きです','spk':0,'interim':''}, ensure_ascii=False)}, {{frameId:0}})")
                await page.wait_for_timeout(900)
                print(f'voz · {view:6} · {script:5} →', await page.evaluate(GET))
                if view == 'ticker' and script == 'kana': await page.screenshot(path='shot_orig_ticker.png', clip={'x':160,'y':380,'width':960,'height':160})
                if view == 'phrase' and script == 'kanji': await page.screenshot(path='shot_orig_phrase.png', clip={'x':160,'y':380,'width':960,'height':160})
        await ctx.close()
asyncio.run(main())
