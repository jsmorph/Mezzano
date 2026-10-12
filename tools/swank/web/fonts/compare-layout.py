import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess


def read_image(path):
    data = subprocess.check_output(["magick", str(path), "-depth", "8", "gray:-"])
    if len(data) != 1160 * 852:
        raise ValueError("Layout comparison requires the 1160 by 852 reference viewport")
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("screenshot", type=Path)
    parser.add_argument("--radius", type=int, default=10)
    args = parser.parse_args()
    root = Path(__file__).parent
    fonts = {item["name"]: item for item in json.loads((root / "pixels.json").read_text())["fonts"]}
    references = json.loads((root / "examiner-matches.json").read_text())
    image = read_image(args.screenshot)
    names = {"title", "title prefix", "candidates label", "bookmarks label", "viewer label", "commands label", "command menu"}
    results = []
    for reference in references["samples"]:
        if reference["role"] not in names:
            continue
        font = fonts[reference["font"]]
        slots = {slot["scalar"]: slot for slot in font["glyphs"]}
        expected, advance = set(), 0
        for char in reference["text"]:
            glyph = slots[ord(char)]
            expected.update((advance+x, y) for x, y in glyph["pixels"])
            advance += glyph["advance"]
        minx = min(x for x, y in expected)
        miny = min(y for x, y in expected)
        width = max(x for x, y in expected) - minx + 1
        height = max(y for x, y in expected) - miny + 1
        clipped_pixels = 0
        if reference["role"] == "title":
            clipped_pixels = sum(x >= advance for x, y in expected)
            expected = {(x, y) for x, y in expected if x < advance}
        expected = {(x-minx, y-miny) for x, y in expected}
        refx, refy = reference["ink_rectangle"][:2]
        best = None
        for y in range(max(0, refy-args.radius), min(852-height, refy+args.radius)+1):
            for x in range(max(0, refx-args.radius), min(1160-width, refx+args.radius)+1):
                actual, gray = set(), 0
                for dy in range(height):
                    for dx in range(width):
                        value = image[(y+dy)*1160+x+dx]
                        if value == 0: actual.add((dx, dy))
                        elif value != 255: gray += 1
                missing, extra = len(expected-actual), len(actual-expected)
                candidate = (missing+extra+gray, abs(x-refx)+abs(y-refy), x, y, missing, extra, gray)
                if best is None or candidate < best:
                    best = candidate
        _, _, x, y, missing, extra, gray = best
        results.append({"role": reference["role"], "font": reference["font"], "text": reference["text"],
                        "position": [x, y], "reference_position": [refx, refy], "offset": [x-refx,y-refy],
                        "missing_pixels": missing, "extra_pixels": extra, "gray_pixels": gray,
                        "source_pixels_clipped_at_advance": clipped_pixels})
    palette = Counter(image)
    print(json.dumps({"screenshot": args.screenshot.name,
                      "sha256": hashlib.sha256(args.screenshot.read_bytes()).hexdigest(),
                      "reference": references["source_url"], "reference_sha256": references["source_sha256"],
                      "whole_image_intermediate_gray_pixels": sum(n for value,n in palette.items() if value not in (0,255)),
                      "samples": results}, indent=2))


if __name__ == "__main__":
    main()
