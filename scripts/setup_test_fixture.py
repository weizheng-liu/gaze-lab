"""Download the browser test photograph and verify its SHA-256."""
from hashlib import sha256
import json
from pathlib import Path
from urllib.request import urlopen


def main():
    fixtures = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
    metadata = json.loads((fixtures / "source.json").read_text(encoding="utf-8"))
    portrait = fixtures / "portrait.jpg"
    expected = metadata["sha256"]
    if not portrait.is_file() or sha256(portrait.read_bytes()).hexdigest() != expected:
        with urlopen(metadata["source"], timeout=40) as response:
            data = response.read()
        if sha256(data).hexdigest() != expected:
            raise RuntimeError("Browser test photo SHA-256 mismatch.")
        portrait.write_bytes(data)
    print("Verified browser test photo.")


if __name__ == "__main__":
    main()
