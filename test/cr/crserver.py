import http.server, ssl, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
PLAY = {"assetId": 1, "audioLocale": "ja-JP", "url": "https://v.vrv.co/manifest.mpd",
  "hardSubs": {}, "captions": {},
  "subtitles": {
    "es-ES": {"format": "ass", "language": "es-ES", "url": "https://v.vrv.co/evs3/abc/assets/p/es_ES.txt?Policy=x&Signature=y"},
    "ja-JP": {"format": "ass", "language": "ja-JP", "url": "https://v.vrv.co/evs3/abc/assets/p/ja_JP.txt?Policy=x&Signature=y"},
    "en-US": {"format": "ass", "language": "en-US", "url": "https://v.vrv.co/evs3/abc/assets/p/en_US.txt?Policy=x&Signature=y"},
    "zh-TW": {"format": "ass", "language": "zh-TW", "url": "https://v.vrv.co/evs3/abc/assets/p/zh_TW.txt?Policy=x&Signature=y"}}}
NOJA = dict(PLAY, subtitles={k: v for k, v in PLAY['subtitles'].items() if k != 'ja-JP'})
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b)))
        self.send_header('Access-Control-Allow-Origin', 'https://www.crunchyroll.com'); self.send_header('Access-Control-Allow-Headers', 'Authorization')
        self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self): self.send(204, b'', 'text/plain')
    def do_GET(self):
        host = self.headers.get('Host', '').split(':')[0]; p = self.path
        if host == 'cr-play-service.prd.crunchyrollsvc.com':
            return self.send(200, json.dumps(NOJA if os.environ.get('NOJA') else PLAY), 'application/json')
        if host == 'v.vrv.co':
            f = 'ja.ass' if 'ja_JP' in p else 'zh.ass' if 'zh_TW' in p else 'es.ass'
            return self.send(200, open(os.path.join(HERE, f), 'rb').read(), 'text/plain; charset=utf-8')
        if p.startswith('/watch'): return self.send(200, open(os.path.join(HERE, 'watch.html'), 'rb').read(), 'text/html; charset=utf-8')
        if p.startswith('/clip.webm'): return self.send(200, open(os.path.join(HERE, '..', 'clip.webm'), 'rb').read(), 'video/webm')
        self.send(404, 'no', 'text/plain')
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 443), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(os.path.join(HERE, 'cert.pem'), os.path.join(HERE, 'key.pem'))
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
