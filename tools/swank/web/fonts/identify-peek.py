import argparse
import hashlib
import json
from pathlib import Path
import subprocess

SOURCE_URL = "https://ssw.jku.at/General/Staff/PF/peek.gif"
SOURCE_SHA256 = "691c8722aa85aba15c31b0599483e4f99639753b0b3340894d479e1af81182a1"
SAMPLES = [
    ("Process Name", "tvfont", 23, 30, False),
    ("State", "tvfont", 371, 30, False),
    ("Notifications 1", "tvfont", 23, 54, False),
    ("Processes", "jess14", 14, 6, True),
    ("Describe", "jess14", 154, 329, False),
    ("Processes", "cptfont", 24, 649, False),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("font_root", type=Path)
    parser.add_argument("reference", type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.reference.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("Unexpected original Peek image hash")
    pixels = subprocess.check_output(["magick", str(args.reference), "-depth", "8", "gray:-"])
    if len(pixels) != 980 * 717:
        raise ValueError("Unexpected original Peek image dimensions")
    records = []
    for text, name, left, top, reverse in SAMPLES:
        path = args.font_root / "sources/genera-8.5/fonts" / (name + ".json")
        font = json.loads(path.read_text())
        slots = {slot["code"]: slot for slot in font["slots"]}
        points, advance = set(), 0
        for char in text:
            slot = slots[ord(char)]
            for y, row in enumerate(slot["rows"]):
                for x in range(slot["raster_width"]):
                    if int(row, 16) & (1 << (slot["raster_width"] - x - 1)):
                        points.add((advance - slot["left_kern"] + x, y))
            advance += slot["advance"]
        min_x, min_y = min(x for x, y in points), min(y for x, y in points)
        points = {(x - min_x, y - min_y) for x, y in points}
        width, height = max(x for x, y in points) + 1, max(y for x, y in points) + 1
        actual = {(x, y) for y in range(height) for x in range(width)
                  if (pixels[(top + y) * 980 + left + x] > 127) == reverse}
        record = {"text": text, "font": font["name"], "font_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                  "ink_rectangle": [left, top, width, height], "reverse_video": reverse,
                  "missing": len(points - actual), "extra": len(actual - points),
                  "metadata_advance": advance, "metadata_metrics": font["metrics"]}
        records.append(record)
        if record["missing"] or record["extra"]:
            raise ValueError(record)
    print(json.dumps({"source_url": SOURCE_URL, "source_sha256": SOURCE_SHA256,
                      "source_size": [980, 717], "orientation": "Unscaled original GIF, top-to-bottom rows",
                      "samples": records}, indent=2))


if __name__ == "__main__":
    main()
