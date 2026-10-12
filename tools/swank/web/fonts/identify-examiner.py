import argparse
import hashlib
import json
from pathlib import Path
import subprocess

SOURCE_URL = "https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/de2.gif"
SOURCE_SHA = "cb8cfecd08d3e6013ea9479edbb2e83492d3f5a5e89523c30d89d542c39ac849"
SAMPLES = [
    ("title", "Document Examiner", "EUREX24I", 177, 8, False),
    ("title prefix", "Document", "EUREX24I", 177, 8, False),
    ("candidates label", "Current Candidates", "HL12BI", 682, 6, False),
    ("bookmarks label", "Bookmarks", "HL12BI", 682, 368, False),
    ("viewer label", "Viewer: Default Viewer", "HL12BI", 25, 692, False),
    ("commands label", "Commands", "HL12BI", 24, 730, False),
    ("document heading", "Creating and Using Macintosh Dialogs", "HL12B", 82, 76, False),
    ("body word", "Sometimes", "HL12", 82, 98, False),
    ("candidate", "Creating and Using Macintosh Dialogs", "CPTFONT", 682, 20, False),
    ("command menu", "Show Candidates", "JESS13", 689, 729, False),
    ("reverse help prefix", "To see other commands,", "SWISS12B-CCAPS", 6, 819, True),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("font_root", type=Path)
    parser.add_argument("image", type=Path)
    args = parser.parse_args()
    digest = hashlib.sha256(args.image.read_bytes()).hexdigest()
    if digest != SOURCE_SHA:
        raise ValueError(f"Reference hash mismatch: {digest}")
    raster = subprocess.check_output(["magick", str(args.image), "-depth", "8", "gray:-"])
    if len(raster) != 1160 * 852:
        raise ValueError("Reference dimensions changed")
    results = []
    for role, text, name, x, y, inverse in SAMPLES:
        path = args.font_root / "sources/genera-8.5/fonts" / (name.lower() + ".json")
        font = json.loads(path.read_text())
        slots = {slot["code"]: slot for slot in font["slots"]}
        expected, advance = set(), 0
        for char in text:
            slot = slots[ord(char)]
            for row_index, row in enumerate(slot["rows"]):
                bits = int(row, 16)
                for column in range(slot["raster_width"]):
                    if bits & (1 << (slot["raster_width"] - column - 1)):
                        expected.add((advance - slot["left_kern"] + column, row_index))
            advance += slot["advance"]
        min_x, min_y = min(px for px, py in expected), min(py for px, py in expected)
        width = max(px for px, py in expected) - min_x + 1
        height = max(py for px, py in expected) - min_y + 1
        expected = {(px-min_x, py-min_y) for px, py in expected}
        actual, gray = set(), 0
        for py in range(height):
            for px in range(width):
                value = raster[(y+py)*1160+x+px]
                if value not in (0, 255): gray += 1
                if value == (255 if inverse else 0): actual.add((px, py))
        results.append({"role": role, "text": text, "font": name,
                        "font_source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "ink_rectangle": [x, y, width, height], "inverse": inverse,
                        "missing_pixels": len(expected-actual), "extra_pixels": len(actual-expected),
                        "gray_pixels": gray, "advance_from_metadata": advance,
                        "raster_origin_from_metadata": [x-min_x, y-min_y], "metrics": font["metrics"]})
    print(json.dumps({"source_url": SOURCE_URL, "source_sha256": SOURCE_SHA,
                      "orientation": "Original GIF, no transform", "samples": results}, indent=2))


if __name__ == "__main__":
    main()
