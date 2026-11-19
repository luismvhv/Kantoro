import asyncio, os, threading, http.server, functools
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8775), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
open(os.path.join(HERE,'nojp.html'),'w').write('<!doctype html><meta charset=utf-8><p>Hola mundo, sin japonés aquí.</p>')
open(os.path.join(HERE,'ytfake.html'),'w').write('<!doctype html><meta charset=utf-8><div style="position:relative;width:640px;height:360px;background:#123"><video style="width:640px;height:360px" src="clip.webm"></video><div class="ytp-caption-window-container" style="position:absolute;bottom:20px;left:0;right:0;text-align:center;color:#fff"><span class="ytp-caption-segment">This is an English caption</span></div></div>')
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/p7', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        for name in ['index.html', 'ytfake.html', 'canvas.html', 'story.html', 'nojp.html']:
            pg = await ctx.new_page(); await pg.goto(f'http://127.0.0.1:8775/{name}'); await pg.wait_for_timeout(2500)
            tid = await sw.evaluate(f"async () => (await chrome.tabs.query({{url:'http://127.0.0.1:8775/{name}'}}))[0].id")
            pp = await ctx.new_page()
            await pp.add_init_script(f"const _q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = async (q) => (q && q.active) ? [await chrome.tabs.get({tid})] : _q(q);")
            await pp.set_viewport_size({'width': 360, 'height': 600})
            await pp.goto(f'chrome-extension://{eid}/popup/popup.html'); await pp.wait_for_timeout(1500)
            print(f'{name:12} →', (await pp.inner_text('#diag')).replace('\n',' '))
            if name == 'canvas.html': await pp.screenshot(path='shot_popup2.png')
            await pp.close(); await pg.close()
        await ctx.close()
asyncio.run(main())
