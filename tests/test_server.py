import hashlib
from http.server import ThreadingHTTPServer
from functools import partial
import importlib.util
import json
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("gaze_server", ROOT / "server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LocalServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(module.LocalHandler, directory=str(ROOT / "dist")))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_health_and_html(self):
        with self.client.open(self.base + "/health") as response:
            self.assertEqual(json.load(response)["app"], "gaze-lab")
        with self.client.open(self.base + "/") as response:
            self.assertIn("目光".encode(), response.read())
            csp = response.headers["Content-Security-Policy"]
            self.assertIn("connect-src 'self'", csp)
            self.assertIn("frame-ancestors 'self'", csp)
            self.assertIn("microphone=()", response.headers["Permissions-Policy"])

    def test_local_model_files_and_mime(self):
        manifest = json.loads((ROOT / "dist/vendor/manifest.json").read_text())
        self.assertEqual(manifest["version"], "3.5.3")
        for entry in manifest["files"]:
            content = (ROOT / "dist/vendor" / entry["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), entry["sha256"])
        for path, expected in [("/core.mjs", "text/javascript"), ("/vendor/mediapipe/face_mesh/face_mesh_solution_wasm_bin.wasm", "application/wasm")]:
            with self.client.open(self.base + path) as response:
                self.assertEqual(response.headers.get_content_type(), expected)
                response.read()

    def test_parent_files_are_not_served(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.client.open(self.base + "/../server.py")
        self.assertEqual(caught.exception.code, 404)

    def test_display_endpoint_only_exposes_dimensions_and_rejects_cross_origin(self):
        with self.client.open(self.base + "/device-info") as response:
            displays = json.load(response)["displays"]
        for display in displays:
            self.assertEqual(set(display), {"widthCm", "heightCm", "diagonalInches",
                                           "resolutionWidth", "resolutionHeight", "primary"})
            self.assertGreater(display["resolutionWidth"], 0)
            self.assertGreater(display["resolutionHeight"], 0)
        request = urllib.request.Request(self.base + "/device-info", headers={"Sec-Fetch-Site": "cross-site"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.client.open(request)
        self.assertEqual(caught.exception.code, 403)

    def test_compensation_assets_and_offline_installer(self):
        spec = importlib.util.spec_from_file_location("compensation_setup", ROOT / "scripts/setup_compensation.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        installer.fetch = lambda *args: self.fail("Verified assets must not require network")
        manifest = installer.valid_installation()
        self.assertIsNotNone(manifest)
        self.assertEqual(manifest["runtime"]["version"], "1.31.1")
        self.assertEqual(len(manifest["files"]), 11)
        self.assertEqual(installer.onnx_metadata((ROOT / "dist/vendor/compensation/mobileone_s0_gaze.onnx").read_bytes()), manifest["model"]["interface"])
        installer.main()
        with self.assertRaises(RuntimeError):
            installer.target("../../outside.txt")
        for path, expected in [("/gaze-worker.mjs", "text/javascript"), ("/vendor/compensation/ort/ort-wasm-simd-threaded.asyncify.wasm", "application/wasm"), ("/vendor/compensation/mobileone_s0_gaze.onnx", "application/octet-stream")]:
            with self.client.open(self.base + path) as response:
                self.assertEqual(response.headers.get_content_type(), expected)
                response.read()


if __name__ == "__main__":
    unittest.main()
