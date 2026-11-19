import asyncio, os, threading, http.server, functools
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8783), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/ppo', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate("chrome.storage.sync.set({settings:{videoSource:'audio'}})")
        pg = await ctx.new_page(); await pg.goto('http://127.0.0.1:8783/canvas.html'); await pg.wait_for_timeout(2500)
        tid = await sw.evaluate("async () => (await chrome.tabs.query({url:'http://127.0.0.1:8783/*'}))[0].id")
        pp = await ctx.new_page()
        await pp.add_init_script(f"const _q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = async (q) => (q && q.active) ? [await chrome.tabs.get({tid})] : _q(q);")
        await pp.set_viewport_size({'width': 360, 'height': 640})
        await pp.goto(f"chrome-extension://{sw.url.split('/')[2]}/popup/popup.html"); await pp.wait_for_timeout(1800)
        await pp.screenshot(path='shot_popup3.png')
        await ctx.close()
asyncio.run(main())
