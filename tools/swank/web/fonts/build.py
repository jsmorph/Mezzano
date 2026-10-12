# /// script
# requires-python = ">=3.9"
# dependencies = ["fonttools==4.60.1"]
# ///

import argparse
import hashlib
import json
from pathlib import Path
import shutil

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable

REVISION = "809694a73ece7f840b6541b4781cd47152d1ea35"
SCALE = 64
SOURCES = {
    "cptfont": "61192f67793272aef9fd08c666988358bef7a6f81cbc270b0f55202e33f724ee",
    "cptfontcb": "69a76a4a0bd8bcbf4e0a29e2897ee8fce6955cf6367073b7c1d660ca9483a920",
    "cptfonti": "14e0c5b813e88054b15cf90bdea53ac03a6842b20663610519216c06116cfe7d",
    "hl12": "11dbd255500be2ffc39d57d6d0a2279085135731d009a3c55cee6d29bb63f073",
    "hl12b": "346656698c889486b8aa5f478fe6c2e82c46df5734212a94ed22971e3213d354",
    "hl12i": "9fada15083fbb084a0664ce86ab86823261ad0b28f0d329ee0e70eab2a90f864",
    "hl12bi": "e2d005605527661949a64c24302d30384b879ad993de551827e88e6171cf5a7a",
    "tr12i": "8cbe42aee8eaa208abff1ae448edf6f5ea295568a7f7e58bc77bc689431f7eb1",
    "jess14": "002e8bf152dad57488eb365e7886f3fb8fd95b7883023c181a8259728b03d445",
    "jess13": "736b6c570d3c9c5769bc01dcd91858a9b11e6dd5fb5fcc646a36a87b56baeb8c",
    "swiss12b-ccaps": "1bf1d2f3a483e2db6ddefe5ced15a766c0696bbc7b44f69cdc13bbe0bbab053b",
    "eurex24i": "a72438d5d7c09b9650fb6f46be02c7cff2c2184ab2a1ad6fc2273f19b49f0c95",
}
MAPPING_HASH = "6c055f6361bae60602ee9948910c0aa12e42771d6cacae565fb2966b36b87176"


def read_checked(path, expected):
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected:
        raise ValueError(f"Source hash mismatch: {path}: {digest}")
    return json.loads(data)


def build(source, mapping, output):
    name = source["name"]
    metrics = source["metrics"]
    height, baseline = metrics["character_height"], metrics["baseline"]
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    widths = {".notdef": (metrics["default_character_width"] * SCALE, 0)}
    cmap = {}
    expected = []
    for slot in source["slots"]:
        if not slot["exists"]:
            continue
        code = slot["code"]
        if str(code) in mapping["explicit"]:
            scalar = mapping["explicit"][str(code)]
        elif 32 <= code <= 126:
            scalar = code
        else:
            raise ValueError(f"Unmapped character {code} in {name}")
        glyph_name = f"uni{scalar:04X}"
        pen = TTGlyphPen(None)
        points = []
        for row_index, row in enumerate(slot["rows"]):
            bits = int(row, 16)
            start = None
            width = slot["raster_width"]
            for x in range(width + 1):
                black = x < width and bits & (1 << (width - x - 1))
                if black:
                    points.append([x - slot["left_kern"], row_index])
                    if start is None:
                        start = x
                elif start is not None:
                    left, right = (start - slot["left_kern"]) * SCALE, (x - slot["left_kern"]) * SCALE
                    top, bottom = (baseline - row_index) * SCALE, (baseline - row_index - 1) * SCALE
                    pen.moveTo((left, bottom))
                    pen.lineTo((left, top))
                    pen.lineTo((right, top))
                    pen.lineTo((right, bottom))
                    pen.closePath()
                    start = None
        glyphs[glyph_name] = pen.glyph()
        widths[glyph_name] = (slot["advance"] * SCALE, min((x for x, y in points), default=0) * SCALE)
        cmap[scalar] = glyph_name
        expected.append({"scalar": scalar, "advance": slot["advance"], "pixels": points})
    font = FontBuilder(height * SCALE, isTTF=True)
    font.setupGlyphOrder(list(glyphs))
    font.setupCharacterMap(cmap)
    font.setupGlyf(glyphs)
    font.setupHorizontalMetrics(widths)
    font.setupHorizontalHeader(ascent=baseline * SCALE, descent=-(height - baseline) * SCALE, lineGap=0)
    font.setupNameTable({"familyName": name, "styleName": "Regular", "fullName": name,
                        "uniqueFontIdentifier": f"Mezzano-Recovered-{REVISION[:12]}-{name}",
                        "psName": name, "version": "Version 1.000",
                        "description": "Recovered Genera bitmap shapes represented as pixel contours. See RECOVERY-NOTICE.md."})
    font.setupOS2(version=4, sTypoAscender=baseline * SCALE, sTypoDescender=-(height - baseline) * SCALE,
                 sTypoLineGap=0, usWinAscent=baseline * SCALE, usWinDescent=(height - baseline) * SCALE,
                 fsSelection=0xC0, fsType=0)
    font.setupPost()
    font.font["gasp"] = newTable("gasp")
    font.font["gasp"].gaspRange = {65535: 2}
    font.font["head"].created = font.font["head"].modified = 2082844800
    font.font.recalcTimestamp = False
    target = output / (name.lower() + ".ttf")
    font.save(target)
    return {"name": name, "file": target.name, "height": height, "baseline": baseline,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "glyphs": expected}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("font_root", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    mapping = read_checked(args.font_root / "config/unicode-mapping.json", MAPPING_HASH)
    fonts = []
    for name, digest in SOURCES.items():
        source = read_checked(args.font_root / "sources/genera-8.5/fonts" / (name + ".json"), digest)
        if mapping["assignments"][source["name"]] != "standard":
            raise ValueError("Nonstandard repertoire requires a separate mapping")
        fonts.append(build(source, mapping["standard_repertoire"], args.output))
    for src, dst in [("LICENSE", "RECOVERY-LICENSE"), ("NOTICE.md", "RECOVERY-NOTICE.md")]:
        shutil.copyfile(args.font_root / src, args.output / dst)
    result = {"revision": REVISION, "fonttools": "4.60.1", "sources": SOURCES,
              "mapping_sha256": MAPPING_HASH, "fonts": fonts}
    (args.output / "pixels.json").write_text(json.dumps(result, separators=(",", ":")) + "\n")
    print(f"Built {len(fonts)} fonts from verified source records.")


if __name__ == "__main__":
    main()
