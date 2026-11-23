"""Start or reuse the local service, then open it in Chrome or Edge."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
PORTS = range(8765, 8775)
APP_VERSION = "1.4.1"
CLIENT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def find_service():
    for port in PORTS:
        try:
            with CLIENT.open(f"http://127.0.0.1:{port}/health", timeout=0.3) as response:
                status = json.load(response)
            if status.get("app") == "gaze-lab" and status.get("version") == 1 and status.get("deviceInfo") is True:
                return f"http://localhost:{port}/"
        except (OSError, ValueError):
            continue
    return None


def ensure_service():
    existing = find_service()
    if existing:
        return existing, False
    CACHE.mkdir(exist_ok=True)
    executable = Path(sys.executable)
    if executable.name.lower() == "pythonw.exe":
        executable = executable.with_name("python.exe")
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    with (CACHE / "server.log").open("ab") as log:
        process = subprocess.Popen(
            [str(executable), str(ROOT / "server.py"), "--no-browser"],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=flags, start_new_session=os.name != "nt",
        )
    (CACHE / "server.pid").write_text(str(process.pid), encoding="ascii")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        address = find_service()
        if address:
            return address, True
        if process.poll() is not None:
            raise RuntimeError(f"Local service exited. See {CACHE / 'server.log'}")
        time.sleep(0.2)
    raise RuntimeError(f"Local service did not become ready. See {CACHE / 'server.log'}")


def open_browser(address):
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    for browser in candidates:
        if browser.is_file():
            subprocess.Popen([str(browser), "--new-tab", address], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
    webbrowser.open(address)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    address, started = ensure_service()
    CACHE.mkdir(exist_ok=True)
    (CACHE / "address.txt").write_text(address + "\n", encoding="ascii")
    print(json.dumps({"url": address, "started": started, "appVersion": APP_VERSION}), flush=True)
    if not args.no_browser:
        open_browser(address)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
