"""A loopback-only static server. Python standard library; no installation needed."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import webbrowser
from device_info import read_displays

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"


class LocalHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".wasm": "application/wasm", ".onnx":"application/octet-stream", ".data": "application/octet-stream", ".binarypb": "application/octet-stream"}

    def end_headers(self):
        # MediaPipe uses local WASM and generated functions. No external connections.
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json({"app": "gaze-lab", "version": 1, "appVersion": "1.4.1", "deviceInfo": True})
            return
        if self.path == "/device-info":
            port = self.server.server_port
            hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
            if self.headers.get("Host") not in hosts or self.headers.get("Sec-Fetch-Site") not in (None, "same-origin"):
                self.send_error(403)
                return
            try:
                displays = read_displays()
            except OSError:
                displays = []
            self.send_json({"displays": displays})
            return
        super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not (DIST / "vendor" / "manifest.json").exists():
        raise SystemExit("Missing local models. Run: python scripts/setup_vendor.py")
    handler = partial(LocalHandler, directory=str(DIST))
    for port in range(args.port, args.port + 10):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), handler)
            break
        except OSError:
            if port == args.port + 9:
                raise
    server.daemon_threads = True
    url = f"http://localhost:{server.server_port}/"
    print(f"Gaze Lab: {url}\nKeep this window open. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
