import http.server, functools, os, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if 'nested_top' in self.path or 'audio.html' in self.path:
            self.send_header('Permissions-Policy', 'microphone=(), on-device-speech-recognition=()')
        super().end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), functools.partial(H, directory=os.path.dirname(os.path.abspath(__file__)))).serve_forever()
