import argparse
import hashlib
import json
from pathlib import Path
import subprocess

SOURCE_URL = "https://www.chai.uni-hamburg.de/~moeller/symbolics-info/genera.gif"
SOURCE_SHA256 = "ae41963fe5460cb4a8c9f3a82ea843d9c98287ced7e26b37a5f398c82531328f"
SAMPLES = [
    ("title prefix", "Symbolics Genera", "eurex24i", 326, 98),
    ("machine prefix", "This machine is", "hl12", 260, 154),
    ("machine name", "Ivory KOGS20", "hl12bi", 381, 154),
    ("image version", "Symbolics Genera 8.3", "hl12", 421, 194),
    ("left system name", "Genera", "hl8", 155, 255),
    ("left system version", "8.3", "hl8", 442, 255),
    ("right system name", "HTML Parser", "hl8", 485, 255),
    ("right system version", "1.0", "hl8", 821, 255),
    ("left last system name", "HTTP Proxy Server", "hl8", 155, 372),
    ("help introduction", "You are typing to", "hl12", 88, 419),
    ("help Listener name", "Dynamic Lisp Listener 1.", "hl12i", 225, 419),
    ("help key", "HELP", "5x5", 199, 454),
]


def glyph_pixels(font, text):
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
    return points, advance


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("font_root", type=Path)
    parser.add_argument("reference", type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.reference.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("Unexpected original Listener image hash")
    pixels = subprocess.check_output(["magick", str(args.reference), "-depth", "8", "gray:-"])
    if len(pixels) != 1024 * 768:
        raise ValueError("Unexpected original Listener image dimensions")
    records = []
    for role, text, name, left, top in SAMPLES:
        path = args.font_root / "sources/genera-8.5/fonts" / (name + ".json")
        font = json.loads(path.read_text())
        points, advance = glyph_pixels(font, text)
        width, height = max(x for x, y in points) + 1, max(y for x, y in points) + 1
        actual = {(x, y) for y in range(height) for x in range(width)
                  if pixels[(top + y) * 1024 + left + x] == 0}
        record = {"role": role, "text": text, "font": font["name"],
                  "font_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                  "ink_rectangle": [left, top, width, height],
                  "missing": len(points - actual), "extra": len(actual - points),
                  "metadata_advance": advance, "metadata_metrics": font["metrics"]}
        records.append(record)
        if record["missing"] or record["extra"]:
            raise ValueError(record)
    left, top, width, height = 194, 452, 34, 9
    keycap_rows = []
    for y in range(height):
        bits = sum((pixels[(top + y) * 1024 + left + x] == 0) << (width - x - 1)
                   for x in range(width))
        keycap_rows.append(format(bits, "09x"))
    records.append({"role": "help keycap", "text": "HELP", "font": None,
                    "ink_rectangle": [left, top, width, height], "rows": keycap_rows})
    print(json.dumps({"source_url": SOURCE_URL, "source_sha256": SOURCE_SHA256,
                      "source_size": [1024, 768], "orientation": "Unscaled original GIF, top-to-bottom rows",
                      "samples": records}, indent=2))


if __name__ == "__main__":
    main()
