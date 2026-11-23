"""Install verified, pinned inference assets for the offline compensation mode.

Only Python's standard library is required. A fully verified installation is
reused without network access; no ML training packages are installed.
"""
from pathlib import Path, PurePosixPath
import base64
import hashlib
import io
import json
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "dist" / "vendor" / "compensation"
ORT_VERSION = "1.31.1"
ORT_INTEGRITY = "sha512-5GeH+bWQ+HxM10z7erGlsWqryrwMbSvm/1tkIsKTT48g0fI19VXVVC435t4t7VsPdSQeS7NmuZPXrQ73k82URw=="
ORT_URL = f"https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-{ORT_VERSION}.tgz"
GAZE_COMMIT = "4bf557d8a819da2b208214a9ef9268fd84cb52f1"
FACE_COMMIT = "5338be56f67f4e27a0faf13a3877d1cf6e8624b5"
MODEL_URL = "https://github.com/yakhyo/gaze-estimation/releases/download/weights/mobileone_s0_gaze.onnx"
MODEL_SHA256 = "8b4fdc4e3da44733c9a82e7776b411e4a39f94e8e285aee0fc85a548a55f7d9f"
FACE_URL = f"https://raw.githubusercontent.com/google-ai-edge/mediapipe/{FACE_COMMIT}/mediapipe/modules/face_geometry/data/canonical_face_model.obj"
FACE_SHA256 = "8bac80443397e113f41a8b565ea72c59390bc031d9defab289dba7bc0c54e618"
ORT_FILES = (
    "ort.webgpu.bundle.min.mjs", "ort.wasm.bundle.min.mjs",
    "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def target(relative):
    value = DEST.joinpath(*PurePosixPath(relative).parts).resolve()
    if not value.is_relative_to(DEST.resolve()):
        raise RuntimeError("Unsafe asset path")
    return value


def fetch(url):
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Gaze-Lab-offline-installer/1.3"})
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except OSError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def checked_fetch(url, expected):
    data = fetch(url)
    if digest(data) != expected:
        raise RuntimeError(f"Asset SHA-256 mismatch: {url}")
    return data


def write_asset(relative, data, source):
    path = target(relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"path": relative, "bytes": len(data), "sha256": digest(data), "source": source}


def valid_installation():
    manifest_path = DEST / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf8"))
        if manifest.get("runtime", {}).get("version") != ORT_VERSION or manifest.get("model", {}).get("sha256") != MODEL_SHA256 or manifest.get("canonicalFace", {}).get("commit") != FACE_COMMIT:
            return None
        expected = {"mobileone_s0_gaze.onnx", "canonical-face.json", "MOBILEGAZE-LICENSE.txt", "MEDIAPIPE-LICENSE.txt", "ort/LICENSE"} | {"ort/" + name for name in ORT_FILES}
        if {entry["path"] for entry in manifest["files"]} != expected:
            return None
        for entry in manifest["files"]:
            path = target(entry["path"])
            if not path.is_file() or path.stat().st_size != entry["bytes"] or digest(path.read_bytes()) != entry["sha256"]:
                return None
        return manifest
    except (OSError, ValueError, KeyError, TypeError):
        return None


def protobuf_fields(data):
    """Minimal wire reader for ONNX metadata only; it does not execute models."""
    position = 0

    def varint():
        nonlocal position
        value, shift = 0, 0
        while position < len(data):
            byte = data[position]
            position += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
            shift += 7
            if shift > 70:
                break
        raise ValueError("Invalid protobuf varint")

    while position < len(data):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value = varint()
        elif wire == 2:
            length = varint()
            value = data[position:position + length]
            position += length
        elif wire in (1, 5):
            length = 8 if wire == 1 else 4
            value = data[position:position + length]
            position += length
        else:
            raise ValueError("Unsupported protobuf wire type")
        yield number, value


def onnx_metadata(data):
    def value_info(message):
        fields = dict(protobuf_fields(message))
        tensor = dict(protobuf_fields(dict(protobuf_fields(fields[2]))[1]))
        dimensions = []
        for key, dimension in protobuf_fields(tensor[2]):
            if key == 1:
                values = dict(protobuf_fields(dimension))
                dimensions.append(values.get(1, values.get(2, b"?").decode("utf8")))
        return {"name": fields[1].decode("utf8"), "elementType": tensor[1], "shape": dimensions}

    model_fields = list(protobuf_fields(data))
    graph = next(value for key, value in model_fields if key == 7)
    graph_fields = list(protobuf_fields(graph))
    return {"inputs": [value_info(value) for key, value in graph_fields if key == 11], "outputs": [value_info(value) for key, value in graph_fields if key == 12]}


def main():
    cached = valid_installation()
    if cached:
        print(f"Verified cached compensation assets: {len(cached['files'])} files, {sum(entry['bytes'] for entry in cached['files']):,} bytes", flush=True)
        return

    files = []
    print("Downloading pinned MobileGaze model...", flush=True)
    model = checked_fetch(MODEL_URL, MODEL_SHA256)
    if len(model) != 4974521:
        raise RuntimeError("Unexpected MobileGaze model size")
    metadata = onnx_metadata(model)
    if metadata != {"inputs": [{"name": "input", "elementType": 1, "shape": [1, 3, 448, 448]}], "outputs": [{"name": "yaw", "elementType": 1, "shape": [1, 90]}, {"name": "pitch", "elementType": 1, "shape": [1, 90]}]}:
        raise RuntimeError(f"Unexpected model interface: {metadata}")
    files.append(write_asset("mobileone_s0_gaze.onnx", model, MODEL_URL))
    license_url = f"https://raw.githubusercontent.com/yakhyo/gaze-estimation/{GAZE_COMMIT}/LICENSE"
    files.append(write_asset("MOBILEGAZE-LICENSE.txt", checked_fetch(license_url, "a4f7998feb5c90555daae4329db61caf7049e6b2706991dc1d9eb2a0923847ae"), license_url))

    print(f"Downloading ONNX Runtime Web {ORT_VERSION}...", flush=True)
    payload = fetch(ORT_URL)
    actual = "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode("ascii")
    if actual != ORT_INTEGRITY:
        raise RuntimeError("ONNX Runtime archive integrity mismatch")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for filename in ORT_FILES:
            name = "package/dist/" + filename
            member = archive.getmember(name)
            if not member.isfile():
                raise RuntimeError(f"Expected runtime file: {name}")
            files.append(write_asset("ort/" + filename, archive.extractfile(member).read(), ORT_URL + "#" + name))
    # The npm archive omits the license and the upstream tag URL can disappear.
    license_path = "licenses/onnxruntime-LICENSE.txt"
    license_text = (ROOT / license_path).read_bytes()
    if digest(license_text) != "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c":
        raise RuntimeError("ONNX Runtime license checksum mismatch")
    files.append(write_asset("ort/LICENSE", license_text, license_path))

    print("Downloading pinned canonical face template...", flush=True)
    face = checked_fetch(FACE_URL, FACE_SHA256)
    vertices = [[float(component) for component in line.split()[1:]] for line in face.decode("utf8").splitlines() if line.startswith("v ")]
    if len(vertices) != 468 or any(len(point) != 3 for point in vertices):
        raise RuntimeError("Unexpected canonical face geometry")
    json_face = (json.dumps(vertices, separators=(",", ":"), allow_nan=False) + "\n").encode("utf8")
    files.append(write_asset("canonical-face.json", json_face, FACE_URL))
    license_url = f"https://raw.githubusercontent.com/google-ai-edge/mediapipe/{FACE_COMMIT}/LICENSE"
    files.append(write_asset("MEDIAPIPE-LICENSE.txt", checked_fetch(license_url, "8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8"), license_url))

    manifest = {
        "schemaVersion": 1,
        "model": {"name": "MobileGaze MobileOne S0", "trainingDataset": "Gaze360", "sourceCommit": GAZE_COMMIT, "source": MODEL_URL, "sha256": MODEL_SHA256, "interface": metadata},
        "runtime": {"name": "onnxruntime-web", "version": ORT_VERSION, "source": ORT_URL, "integrity": ORT_INTEGRITY},
        "canonicalFace": {"name": "MediaPipe canonical face model", "commit": FACE_COMMIT, "source": FACE_URL, "sourceSha256": FACE_SHA256, "vertexCount": 468},
        "files": sorted(files, key=lambda entry: entry["path"]),
    }
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
    print(f"Installed compensation assets: {len(files)} files, {sum(entry['bytes'] for entry in files):,} bytes", flush=True)
    print(json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
