import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("screenshot", type=Path)
    parser.add_argument("--radius", type=int, default=24)
    args = parser.parse_args()
    root = Path(__file__).parent
    reference = json.loads((root / "herald-matches.json").read_text())
    fonts = {font["name"]: font for font in json.loads((root / "pixels.json").read_text())["fonts"]}
    raster = subprocess.check_output(["magick", str(args.screenshot), "-depth", "8", "gray:-"])
    width, height = reference["source_size"]
    if len(raster) != width * height:
        raise ValueError("Expected a 1024 by 768 screenshot")
    samples = []
    for sample in reference["samples"]:
        left, top, columns, rows = sample["ink_rectangle"]
        if "rows" in sample:
            points = {(x, y) for y, row in enumerate(sample["rows"]) for x in range(columns)
                      if int(row, 16) & (1 << (columns - x - 1))}
        else:
            glyphs = {glyph["scalar"]: glyph for glyph in fonts[sample["font"]]["glyphs"]}
            points, advance = set(), 0
            for char in sample["text"]:
                glyph = glyphs[ord(char)]
                points.update((advance + x, y) for x, y in glyph["pixels"])
                advance += glyph["advance"]
            min_x, min_y = min(x for x, y in points), min(y for x, y in points)
            points = {(x - min_x, y - min_y) for x, y in points}
        expected_x, expected_y = left, top - 20
        best = None
        for y in range(max(0, expected_y - args.radius), min(height - rows, expected_y + args.radius) + 1):
            for x in range(max(0, expected_x - args.radius), min(width - columns, expected_x + args.radius) + 1):
                actual, gray = set(), 0
                for dy in range(rows):
                    for dx in range(columns):
                        value = raster[(y + dy) * width + x + dx]
                        if value == 0:
                            actual.add((dx, dy))
                        elif value != 255:
                            gray += 1
                missing, extra = len(points - actual), len(actual - points)
                candidate = (missing + extra + gray, abs(x - expected_x) + abs(y - expected_y), x, y, missing, extra, gray)
                if best is None or candidate < best:
                    best = candidate
        _, _, x, y, missing, extra, gray = best
        samples.append({"role": sample["role"], "text": sample["text"], "font": sample["font"],
                        "reference": [left, top], "expected_application": [expected_x, expected_y],
                        "application": [x, y], "offset": [x - expected_x, y - expected_y],
                        "missing": missing, "extra": extra, "gray": gray})
    palette = Counter(raster)
    print(json.dumps({"reference_sha256": reference["source_sha256"],
                      "application_sha256": hashlib.sha256(args.screenshot.read_bytes()).hexdigest(),
                      "size": [width, height], "reference_coordinate_offset": [0, -20],
                      "offset_reason": "The browser omits the original 20-pixel Macintosh menu bar.",
                      "search_radius": args.radius,
                      "intermediate_gray_pixels": sum(count for value, count in palette.items() if value not in (0, 255)),
                      "samples": samples}, indent=2))


if __name__ == "__main__":
    main()
