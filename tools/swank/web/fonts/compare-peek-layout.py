import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("screenshot", type=Path)
    args = parser.parse_args()
    root = Path(__file__).parent
    reference = json.loads((root / "peek-matches.json").read_text())
    fonts = {font["name"]: font for font in json.loads((root / "pixels.json").read_text())["fonts"]}
    raster = subprocess.check_output(["magick", str(args.screenshot), "-depth", "8", "gray:-"])
    width, height = reference["source_size"]
    if len(raster) != width * height:
        raise ValueError("Expected a 980 by 717 screenshot")
    samples = []
    for sample in reference["samples"]:
        if sample["text"] == "Describe":
            continue
        glyphs = {glyph["scalar"]: glyph for glyph in fonts[sample["font"]]["glyphs"]}
        points, advance = set(), 0
        for char in sample["text"]:
            glyph = glyphs[ord(char)]
            points.update((advance + x, y) for x, y in glyph["pixels"])
            advance += glyph["advance"]
        min_x, min_y = min(x for x, y in points), min(y for x, y in points)
        points = {(x - min_x, y - min_y) for x, y in points}
        left, top, columns, rows = sample["ink_rectangle"]
        best = None
        for y in range(max(0, top - 10), min(height - rows, top + 10) + 1):
            for x in range(max(0, left - 10), min(width - columns, left + 10) + 1):
                actual = {(dx, dy) for dy in range(rows) for dx in range(columns)
                          if (raster[(y + dy) * width + x + dx] > 127) == sample["reverse_video"]}
                missing, extra = len(points - actual), len(actual - points)
                candidate = (missing + extra, abs(x - left) + abs(y - top), x, y, missing, extra)
                if best is None or candidate < best:
                    best = candidate
        _, _, x, y, missing, extra = best
        samples.append({"text": sample["text"], "font": sample["font"], "reference": [left, top],
                        "application": [x, y], "offset": [x - left, y - top],
                        "missing": missing, "extra": extra})
    print(json.dumps({"reference_sha256": reference["source_sha256"],
                      "application_sha256": hashlib.sha256(args.screenshot.read_bytes()).hexdigest(),
                      "size": [width, height], "intermediate_gray_pixels": sum(value not in (0, 255) for value in raster),
                      "samples": samples}, indent=2))


if __name__ == "__main__":
    main()
