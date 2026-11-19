import asyncio, os, threading, http.server, functools, json, subprocess
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8791), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
segs = json.load(open(os.path.join(HERE, 'dialog_segs.json')))
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pde', headless=False, no_viewport=True, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required'])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate("chrome.storage.sync.set({settings:{videoSource:'audio', asrLocal:false, asrMaxFails: 99999}})")
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8791/dialog.html'); await page.bring_to_front(); await page.wait_for_timeout(1500)
        subprocess.run(['xdotool', 'search', '--name', 'Dialog test', 'windowactivate', '--sync'], capture_output=True)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', 'alt+o'])
        await page.wait_for_timeout(2500)
        await page.evaluate("document.getElementById('a').play()")
        await page.wait_for_function('window.__t0', timeout=10000)
        t0 = await page.evaluate('window.__t0')
        asr = next(f for f in page.frames if 'asr.html' in f.url)
        await asr.evaluate("window.__d = new RJDiarize.Diarizer({ rate: 16000 })")
        res = []
        import time
        for sg in segs:
            # esperar al final de la frase + 0,35 s (como cuando llega el resultado del reconocedor)
            wait = (t0 / 1000 + sg['end'] + 0.35) - time.time()
            if wait > 0: await asyncio.sleep(wait)
            if sg['spk'] in 'AB' and len(res) < 3:
                print(sg['spk'], await asr.evaluate("([a, b]) => { const fr = diar.frames.filter(f => f.t >= a && f.t <= b); const med = (x) => { x = x.slice().sort((p,q)=>p-q); return x[x.length>>1]; }; return { tramas: fr.length, conTono: fr.filter(f=>f.f0>0).length, conTimbre: fr.filter(f=>f.mf).length, rmsMed: +med(fr.map(f=>f.rms)).toFixed(4), ruido: +diar.noise.toFixed(4), tonos: fr.filter(f=>f.f0>0).slice(0,8).map(f=>Math.round(f.f0)) }; }", [t0 + sg['start'] * 1000, t0 + sg['end'] * 1000]))
            res.append(await asr.evaluate("([a, b]) => { __d.frames = diar.frames; return __d.assign(diar.features(a, b)); }", [t0 + (sg['start'] - 0.8) * 1000, t0 + (sg['end'] + 0.3) * 1000]))
        got = res
        bySpk = {}
        for g, s in zip(got, segs): bySpk.setdefault(s['spk'], {}).setdefault(g, 0); bySpk[s['spk']][g] += 1
        main_ = {k: max(v, key=v.get) for k, v in bySpk.items()}
        ok = sum(1 for g, s in zip(got, segs) if g == main_[s['spk']])
        print('asignaciones:', ' '.join(s['spk'] + str(g) for g, s in zip(got, segs)))
        print(f'frases con su color correcto: {ok}/{len(segs)} · un color por personaje: {len(set(main_.values())) == len(main_)}')
        print('tramas analizadas en el marco:', await asr.evaluate('diar.frames.length'), '| trozos de audio:', await asr.evaluate('stats.chunks'))
        await ctx.close()
asyncio.run(main())
