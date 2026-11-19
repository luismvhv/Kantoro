import asyncio, os, threading, http.server, functools, subprocess, json
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8780), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
EXP = {'今日は本当にいい天気ですね。': 'kyou wa hontouni ii tenki desu ne.', 'ちょっと待って、何を言ってるの？': 'chotto matte, nani o itteru no?',
       '一緒に頑張ろうね！': 'issho ni ganbarou ne!', 'お前はもう死んでいる': 'omae wa mou shinde iru',
       '俺たちの冒険はこれからだ': 'oretachi no bouken wa korekara da', '先生、私を信じてください': 'sensei, watashi o shinjite kudasai'}
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pst', headless=False, no_viewport=True,
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900', '--window-position=0,0', '--no-proxy-server'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8780/canvas.html?bg&ms=1500'); await page.bring_to_front(); await page.wait_for_timeout(3000)
        subprocess.run(['xdotool', 'search', '--name', 'Canvas subs', 'windowactivate', '--sync'], capture_output=True)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'alt+o']); await page.wait_for_timeout(1200)
        has = await page.evaluate("[...document.querySelectorAll('kantoro-layer')].some(h=>h.shadowRoot&&h.shadowRoot.querySelector('.shade'))")
        st = await sw.evaluate("async () => { const [t] = await chrome.tabs.query({url:'http://127.0.0.1:8780/*'}); return tabState(t.id); }")
        print('selector de zona visible:', has, '| estado:', st)
        # franja de subtítulos del vídeo (#p centrado: x 128..1152, y 60..636; texto en y≈580)
        b = await page.evaluate("(()=>{const r=document.getElementById('p').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()")
        x0, y0, x1, y1 = b['x'] + 40, b['y'] + 470, b['x'] + b['w'] - 40, b['y'] + 560
        await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0+x1)/2, (y0+y1)/2, steps=4); await page.mouse.move(x1, y1, steps=4); await page.mouse.up()
        await page.evaluate("window.__log=[]")
        res = await page.evaluate("""() => new Promise((done) => {
            const seen = []; let last = null; const T0 = performance.now();
            const tick = () => { let ro = '';
              for (const h of document.querySelectorAll('kantoro-layer')) { const b = h.shadowRoot && h.shadowRoot.querySelector('.box.on .ro'); if (b) ro = b.textContent; }
              if (ro !== last) { last = ro; seen.push([performance.now(), ro]); }
              if (performance.now() - T0 > 19000) done({seen, log: window.__log}); else requestAnimationFrame(tick); }; tick(); })""")
        dbg = await sw.evaluate("async () => { const [t] = await chrome.tabs.query({url:'http://127.0.0.1:8780/*'}); return engine({cmd:'capDebug', tabId:t.id}); }")
        print('DEBUG', json.dumps(dbg, ensure_ascii=False))
        shown = res['log']; seen = res['seen']
        ok = 0; delays = []
        for i, (jp, t) in enumerate(shown):
            tend = shown[i+1][1] if i+1 < len(shown) else t + 1500
            hit = next(((ts, ro) for ts, ro in seen if t <= ts < tend and ro.strip() == EXP[jp]), None)
            if hit: ok += 1; delays.append(hit[0] - t)
            print(f"  {jp:22} → {'OK  %4d ms' % (hit[0]-t) if hit else 'NO captada'}")
        print(f'captadas {ok}/{len(shown)}  · retraso medio {sum(delays)/max(1,len(delays)):.0f} ms  · máx {max(delays) if delays else 0:.0f} ms')
        await ctx.close()
asyncio.run(main())
