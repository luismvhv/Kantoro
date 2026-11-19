import asyncio, os, threading, http.server, functools, json
from playwright.async_api import async_playwright
EXT = os.path.abspath('../ext'); HERE = os.path.dirname(os.path.abspath(__file__))
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8790), functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)).serve_forever(), daemon=True).start()
SEQ = [
  {'interim': 'おい', 'spk': 0},                                   # palabra suelta
  {'fin': 'おい', 'spk': 0, 'interim': ''},
  {'interim': 'どうしたの', 'spk': 1},
  {'fin': 'どうしたのそんなに急いで', 'spk': 1, 'interim': '大変な', 'ispk': 0},
  {'interim': '大変なことが起きた', 'spk': 0},
  {'fin': '大変なことが起きたんだ', 'spk': 0, 'interim': ''},
  {'interim': '落ち着いて話して', 'spk': 1},
  {'fin': '落ち着いて話してください', 'spk': 1, 'interim': ''},
  {'interim': '村の外に化け物が出たから早く逃げる準備をしろと村長が言っていたぞ', 'spk': 0},
]
async def run(view):
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context('/tmp/w/pav', headless=False, args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--autoplay-policy=no-user-gesture-required'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        await sw.evaluate(f"chrome.storage.sync.set({{settings:{{asrView:'{view}'}}}})")
        await sw.evaluate('ensureEngine()')
        page = await ctx.new_page(); await page.goto('http://127.0.0.1:8790/audio.html'); await page.wait_for_timeout(2000)
        tid = await sw.evaluate("async () => (await chrome.tabs.query({url:'http://127.0.0.1:8790/*'}))[0].id")
        await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {{cmd:'asrStart', tabId:{tid}, uiFrame:0, host:false}}, {{frameId:0}})")
        print('== modo', view)
        for m in SEQ:
            m = dict(m, cmd='asrPush')
            if 'ispk' in m: m['spk_i'] = m.pop('ispk')
            await sw.evaluate(f"chrome.tabs.sendMessage({tid}, {json.dumps(m, ensure_ascii=False)}, {{frameId:0}})")
            await page.wait_for_timeout(450)
            st = await page.evaluate("""(() => { for (const h of document.querySelectorAll('kantoro-layer')) { const b = h.shadowRoot && h.shadowRoot.querySelector('.box.on .ro'); if (!b) continue;
                return [...b.querySelectorAll('.lane')].map(l => { const r = l.getBoundingClientRect(); const ws = [...l.querySelectorAll('.w')]; const last = ws[ws.length-1];
                  const lr = last && last.getBoundingClientRect();
                  return { color: l.style.color, txt: l.textContent.trim().slice(-48), bordeDcho: lr ? Math.round(r.right - lr.right) : null, h: Math.round(r.height) }; }); } })()""")
            if st: print(f"  {json.dumps(m, ensure_ascii=False)[:58]:58} → " + ' || '.join(f"[{x['color']}] {x['txt']!r} (al borde dcho: {x['bordeDcho']} px, alto {x['h']})" for x in st))
        await page.screenshot(path=f'shot_asr_{view}.png')
        await ctx.close()
async def main():
    for v in ('phrase', 'ticker'):
        os.system('rm -rf /tmp/w/pav'); await run(v)
asyncio.run(main())
