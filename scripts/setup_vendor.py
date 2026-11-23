"""Fetch a pinned upstream release; keep all inference assets on this computer."""
from pathlib import Path, PurePosixPath
import base64
import hashlib
import io
import json
import tarfile
import urllib.request

VERSION = "3.5.3"
INTEGRITY = "sha512-i6P97fWeixASmHWrJxgLUICugqV6qljIafi2ne6p0WYXAuldpwoaFRkedKFcu/qm95d128gdUxhOr336estXOw=="
ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "dist" / "vendor"


def main():
    with urllib.request.urlopen(f"https://registry.npmjs.org/webgazer/{VERSION}", timeout=60) as response:
        metadata = json.load(response)
    with urllib.request.urlopen(metadata["dist"]["tarball"], timeout=120) as response:
        payload = response.read()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode()
    if integrity != INTEGRITY:
        raise RuntimeError("Upstream archive integrity mismatch")
    VENDOR.mkdir(parents=True, exist_ok=True)
    installed = []
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            if member.name == "package/dist/webgazer.js":
                relative = "webgazer.js"
            elif member.name.startswith("package/dist/mediapipe/face_mesh/"):
                relative = member.name.removeprefix("package/dist/")
            elif member.name == "package/LICENSE.md":
                relative = "WEBGAZER-LICENSE.md"
            else:
                continue
            parts = PurePosixPath(relative).parts
            target = VENDOR.joinpath(*parts).resolve()
            if not target.is_relative_to(VENDOR.resolve()):
                raise RuntimeError("Unsafe archive path")
            target.parent.mkdir(parents=True, exist_ok=True)
            data = archive.extractfile(member).read()
            target.write_bytes(data)
            installed.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    manifest = {"name": "webgazer", "version": VERSION, "source": metadata["dist"]["tarball"], "integrity": integrity, "files": installed}
    (VENDOR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Installed WebGazer {VERSION}: {len(installed)} local files ({sum(f['bytes'] for f in installed):,} bytes)")


if __name__ == "__main__":
    main()
