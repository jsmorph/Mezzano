#!/usr/bin/env python3
"""Compare recovered Genera glyphs with original screenshot pixels."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

FONT_COMMIT = '809694a73ece7f840b6541b4781cd47152d1ea35'
SOURCES = {
    'debugger': 'https://www.chai.uni-hamburg.de/~moeller/symbolics-info/symbolics-images/source-code-debugging.gif',
    'workbook': 'https://bitsavers.trailing-edge.com/pdf/symbolics/software/genera_8/Genera_Workbook.pdf',
}
SAMPLES = [
    ('debugger', 'interaction-label', 'Lisp Interaction Window', (88, 101), (675, 685), False),
    ('debugger', 'interaction-menu-title-prefix', 'File', (72, 85), (334, 352), False),
    ('debugger', 'menu-item', 'Tree Edit Root', (118, 127), (351, 365), False),
    ('debugger', 'mouse-help-first-line', 'Mouse-R: Menu.', (3, 10), (720, 731), True),
    ('debugger', 'mouse-help-second-line', 'To see other commands,', (3, 10), (734, 749), True),
    ('debugger', 'condition-prefix', 'Trap: There was', (92, 101), (417, 430), False),
    ('debugger', 'function', 'TEST', (90, 102), (445, 460), False),
    ('debugger', 'argument', 'Arg 0 (X): 0', (116, 124), (460, 471), False),
    ('debugger', 'restart-key', 's-A,', (90, 102), (473, 487), False),
    ('debugger', 'who-line', 'Sun 9 Apr 13:51:21', (0, 12), (748, 758), False),
    ('listener', 'herald-title', 'Symbolics Genera', (335, 351), (78, 100), False),
    ('listener', 'herald-body', 'This machine is', (293, 309), (125, 154), False),
    ('listener', 'herald-emphasis', 'Symbolics Nuthatch', (420, 435), (126, 153), False),
    ('listener', 'activity-label', 'Dynamic Lisp Listener 1', (78, 98), (690, 731), False),
    ('listener', 'listener-prompt', 'Command:', (78, 95), (639, 658), False),
    ('listener', 'mouse-help', 'Mouse-L: Select Activity', (0, 12), (746, 773), False),
    ('menu', 'system-menu-title-prefix', 'The', (5, 15), (3, 18), False),
    ('menu', 'column-heading', 'Windows', (48, 76), (16, 38), False),
    ('menu', 'second-column-heading', 'This window', (220, 246), (16, 38), False),
    ('menu', 'item', 'Create', (57, 80), (32, 55), False),
    ('menu', 'second-item', 'Lisp', (420, 449), (170, 195), False),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_image(path, width, height, flip=False):
    pixels = subprocess.check_output(['magick', str(path), '-depth', '8', 'gray:-'])
    if len(pixels) != width * height:
        raise ValueError(f'Unexpected image dimensions for {path}')
    rows = [sum(1 << x for x in range(width) if pixels[y * width + x] == 0)
            for y in range(height)]
    other = [sum(1 << x for x in range(width) if pixels[y * width + x] not in (0, 255))
             for y in range(height)]
    return {'ink': rows[::-1] if flip else rows, 'nonbinary': other[::-1] if flip else other}


def render(font, text):
    slots = {slot['code']: slot for slot in font['slots']}
    points = set()
    advance = 0
    for char in text:
        glyph = slots.get(ord(char))
        if not glyph or not glyph['exists']:
            return None
        for y, row in enumerate(glyph['rows']):
            bits = int(row, 16)
            for x in range(glyph['raster_width']):
                if bits & (1 << (glyph['raster_width'] - 1 - x)):
                    points.add((advance - glyph['left_kern'] + x, y))
        advance += glyph['advance']
    if not points:
        return None
    min_x = min(x for x, y in points)
    max_x = max(x for x, y in points)
    min_y = min(y for x, y in points)
    max_y = max(y for x, y in points)
    rows = [sum(1 << (x - min_x) for x, y in points if y == line)
            for line in range(min_y, max_y + 1)]
    return rows, max_x - min_x + 1, advance, len(points), min_x, min_y


def compare(image, fonts, text, x_range, y_range, inverted):
    candidates = []
    nonbinary = image['nonbinary']
    image = image['ink']
    for source, font in fonts:
        glyph = render(font, text)
        if not glyph:
            continue
        rows, width, advance, count, min_x, min_y = glyph
        if width > 950:
            continue
        mask = (1 << width) - 1
        best = None
        for y in range(*y_range):
            if y + len(rows) > len(image):
                continue
            for x in range(*x_range):
                if any((row >> x) & mask for row in nonbinary[y:y + len(rows)]):
                    continue
                actual = [(((~row if inverted else row) >> x) & mask)
                          for row in image[y:y + len(rows)]]
                common = sum((a & b).bit_count() for a, b in zip(rows, actual))
                observed = sum(row.bit_count() for row in actual)
                score = 2 * common / (count + observed)
                if best is None or score > best['dice_score']:
                    best = {'dice_score': score, 'ink_x': x, 'ink_y': y,
                            'origin_x': x - min_x, 'origin_y': y - min_y,
                            'width': width, 'height': len(rows), 'advance': advance,
                            'expected_ink_pixels': count, 'observed_ink_pixels': observed,
                            'missing_pixels': count - common, 'extra_pixels': observed - common}
        if best is None:
            continue
        best.update(font=font['name'], font_sha256=digest(source), metrics=font['metrics'])
        candidates.append(best)
    return sorted(candidates, key=lambda item: (-item['dice_score'], item['font']))[:5]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-root', type=Path, required=True)
    parser.add_argument('--workbook', type=Path, required=True)
    parser.add_argument('--debugger-image', type=Path, required=True)
    args = parser.parse_args()
    fonts = [(path, json.loads(path.read_text())) for path in
             sorted((args.font_root / 'sources/genera-8.5/fonts').glob('*.json'))]
    if len(fonts) != 89:
        raise ValueError('Expected the pinned 89-font source corpus.')
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        subprocess.run(['pdfimages', '-f', '10', '-l', '10', '-png', str(args.workbook),
                        str(temporary / 'listener')], check=True)
        subprocess.run(['pdfimages', '-f', '7', '-l', '7', '-png', str(args.workbook),
                        str(temporary / 'menu')], check=True)
        paths = {'debugger': args.debugger_image,
                 'listener': temporary / 'listener-000.png',
                 'menu': temporary / 'menu-001.png'}
        images = {'debugger': load_image(paths['debugger'], 1024, 768),
                  'listener': load_image(paths['listener'], 1067, 796, True),
                  'menu': load_image(paths['menu'], 542, 250, True)}
        result = {'font_commit': FONT_COMMIT,
                  'font_url': f'https://github.com/htayj/genera-fonts/tree/{FONT_COMMIT}',
                  'sources': {name: {'url': SOURCES[name], 'sha256': digest(path)}
                              for name, path in [('workbook', args.workbook),
                                                 ('debugger', args.debugger_image)]},
                  'images': {name: {'sha256': digest(path), 'vertical_flip_for_display': name != 'debugger'}
                             for name, path in paths.items()},
                  'samples': []}
        for image, role, text, x_range, y_range, inverted in SAMPLES:
            candidates = compare(images[image], fonts, text, x_range, y_range, inverted)
            result['samples'].append({'image': image, 'role': role, 'text': text,
                                      'x_search': x_range, 'y_search': y_range,
                                      'inverted': inverted, 'candidates': candidates})
            if candidates[0]['missing_pixels'] or candidates[0]['extra_pixels']:
                raise ValueError(f'No exact candidate for {image}: {role}')
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
