"""Run browser QA with its own temporary loopback server; clean up on exit."""
from functools import partial
from http.server import ThreadingHTTPServer
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("gaze_server", ROOT / "server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class QuietHandler(module.LocalHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT / "dist")))
server.daemon_threads = True
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    env = {**os.environ, "GAZE_LAB_URL": f"http://localhost:{server.server_port}/"}
    completed = subprocess.run(["node", sys.argv[1] if len(sys.argv)>1 else "tests/browser.test.mjs"], cwd=ROOT, env=env)
finally:
    server.shutdown()
    server.server_close()
    thread.join()
raise SystemExit(completed.returncode)
