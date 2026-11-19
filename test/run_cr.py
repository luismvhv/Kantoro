import asyncio, os, sys, json, subprocess
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
RULES = 'MAP www.crunchyroll.com 127.0.0.1, MAP cr-play-service.prd.crunchyrollsvc.com 127.0.0.1, MAP v.vrv.co 127.0.0.1'
EXPECT = {0.8: 'kyou wa hontouni ii tenki desu ne.', 2.8: 'chotto matte, nani o itteru no?', 4.8: 'issho ni ganbarou ne!',
          6.8: 'omae wa mou shinde iru', 8.8: 'oretachi no bouken wa korekara da', 10.8: 'sensei, watashi o shinjite kudasai'}
async def main(noja):
    env = dict(os.environ, NOJA='1' if noja else '')
    srv = subprocess.Popen(['python3', 'cr/crserver.py'], env=env); await asyncio.sleep(0.8)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pcr', headless=False, ignore_https_errors=True, viewport={'width':1280,'height':800},
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', f'--host-resolver-rules={RULES}', '--ignore-certificate-errors', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); logs = []; page.on('console', lambda m: logs.append(m.text))
        await page.goto('https://www.crunchyroll.com/watch/GTEST01/episodio-de-prueba')
        await page.wait_for_function('window.__ready && window.__esLoaded', timeout=10000)
        await page.wait_for_timeout(2500)
        st = await sw.evaluate("async () => { const [t] = await chrome.tabs.query({url:'https://www.crunchyroll.com/*'}); return tabState(t.id); }")
        print('estado pestaña:', json.dumps(st, ensure_ascii=False))
        probe = await sw.evaluate("async () => { const [t] = await chrome.tabs.query({url:'https://www.crunchyroll.com/*'}); const r = await chrome.scripting.executeScript({target:{tabId:t.id, allFrames:true}, func: () => window.__kantoroProbe && window.__kantoroProbe().subFile}); return r.map(x=>x.result); }")
        print('subFile:', probe)
        if noja: await ctx.close(); srv.kill(); return
        # reproducir desde 0 y medir el retraso entre el inicio de cada frase y su rōmaji en pantalla
        res = await page.evaluate("""() => new Promise((done) => {
            const v = document.getElementById('v'); v.currentTime = 0; v.play();
            const seen = []; let last = null; const T0 = performance.now();
            const tick = () => {
              let ro = '';
              for (const h of document.querySelectorAll('kantoro-layer')) { const b = h.shadowRoot && h.shadowRoot.querySelector('.box.on .ro'); if (b) ro = b.textContent; }
              if (ro !== last) { last = ro; seen.push([+v.currentTime.toFixed(3), ro]); }
              if (v.currentTime > 12.8 || performance.now() - T0 > 20000) done(seen); else requestAnimationFrame(tick);
            }; tick(); })""")
        for t, ro in res:
            if not ro: continue
            start = max([s for s in EXPECT if s <= t + 0.001] or [None])
            ok = start is not None and EXPECT[start] == ro.replace('\n', ' ').strip()
            print(f'  t={t:6.3f}s  retraso={(t-start)*1000 if start is not None else 0:6.1f} ms  {"OK " if ok else "MAL"} {ro!r}')
        await page.screenshot(path='shot_cr.png')
        print('errores:', [l for l in logs if 'rror' in l][:4])
        await ctx.close()
    srv.kill()
asyncio.run(main('noja' in sys.argv))
