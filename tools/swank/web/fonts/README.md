# Recovered Symbolics display fonts

These TrueType files preserve recovered Genera 8.5 bitmap glyphs as integer pixel contours.  Their source is [genera-fonts revision 809694a73ece7f840b6541b4781cd47152d1ea35](https://github.com/htayj/genera-fonts/tree/809694a73ece7f840b6541b4781cd47152d1ea35).  The [font identification report](../font-research/README.md) compares the recovered glyphs with original Listener and debugger captures.  The Document Examiner reference is Rainer Joswig's [Genera 8.3 MacIvory capture](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/de2.gif).

## Build and provenance

The user approved fontTools as a build dependency.  The server has no font conversion dependency.  The conversion script pins fontTools 4.60.1 and verifies SHA-256 hashes for each input font and the Unicode mapping.  Build on minideb2 with the existing Python interpreter:

```sh
uv run --no-python-downloads --python /usr/bin/python3 build.py /path/to/genera-fonts
```

The converter represents each contiguous black raster run as a rectangular contour, retains left kerns and advances, and maps the original baseline and character height into OpenType metrics.  The scale is 64 font units per original pixel.  Each font's CSS size equals its original character height.  The generated font has no hinting instructions.  The OS/2 table uses version 4 and USE_TYPO_METRICS.  Timestamps are fixed for reproducible output.  `pixels.json` records source and output hashes, metrics, and expected glyph pixels for browser tests.

The Unicode mapping comes from the recovery repository.  ASCII and its documented mathematical symbols and combining marks retain that mapping.  Characters absent from the original font use browser fallback fonts.

`identify-examiner.py` compares selected recovered glyph strings with the unscaled, untransformed Genera 8.3 GIF.  It uses the installed ImageMagick `magick` command to decode that image.  `examiner-matches.json` records the source URL and hash, tested strings and rectangles, selected font hashes, and pixel differences.  Ten tested rectangles match exactly.  The full title has six recovered black pixels absent from the capture and no extra capture pixels.  These comparisons establish compatible glyphs for the tested strings.  They do not prove a unique original font-object identity.  Advances and baselines in that report come from recovered metadata, while the screenshot tests the ink rectangles and placement within each string.

```sh
python3 identify-examiner.py /path/to/genera-fonts /path/to/de2.gif > examiner-matches.json
```

[Recovery license](RECOVERY-LICENSE) covers the recovery project's software and documentation.  [Recovery notice](RECOVERY-NOTICE.md) states the separate provenance and publication basis for historical glyph designs.  The historical typeface payload has no BSD license grant from Symbolics.

## Browser tests

From the parent directory on a host with Node and Chromium:

```sh
node fonts/test-fonts.mjs /tmp/mezzano-font-test
```

The test loads each built font into Chromium through FontFace and compares each mapped glyph with the source raster at device-pixel ratio 1.  It counts missing, extra, and intermediate-gray pixels, checks advance widths, and measures DOM baselines and line heights.  It saves a JSON report and a specimen screenshot.  The test uses the existing native CDP harness and requires no npm dependency.

Chromium 145.0.7632.109 passed all 1,555 mapped glyphs in twelve fonts with zero pixel differences, exact advances, and exact baseline and line-height measurements.  The first conversion emitted an OS/2 version warning.  The converter now sets version 4, and the tested build produced no warning.  Browser zoom, other device-pixel ratios, other browsers, and fallback Unicode glyphs require separate measurements.  A focused Chromium test at offsets 0, 0.25, 0.5, and 0.75 pixels found zero intermediate-gray pixels at integer placement and 314 at each fractional offset for the tested HL12 string, under each of four `gasp` settings.  The application therefore places measured widgets on integer pixels and uses integer pane and table widths.

| Role | Recovered font | CSS size / baseline |
|---|---|---|
| Listener text and who-line | CPTFONT | 12 / 10 pixels |
| Debugger bold text | CPTFONTCB | 12 / 10 pixels |
| Fixed-width italic text | CPTFONTI | 12 / 10 pixels |
| Herald and document body | HL12 | 14 / 11 pixels |
| Document headings | HL12B | 14 / 11 pixels |
| Listener label and menu headings | HL12I | 14 / 11 pixels |
| System Menu title and Examiner pane labels | HL12BI | 14 / 11 pixels |
| Classic debugger label and topic-menu title | TR12I | 14 / 11 pixels |
| System Menu items | JESS14 | 14 / 12 pixels |
| Examiner command menu | JESS13 | 13 / 11 pixels |
| Reverse-video mouse help | SWISS12B-CCAPS | 14 / 11 pixels |
| Herald and Examiner title | EUREX24I | 24 / 18 pixels |

The tests establish the recovered font rasterization.  Historical source matching and complete application layout remain separate comparisons.  Mezzano content, application state, and available commands differ from the original machine.

## Application comparison

`compare-layout.py` compares a 1160 by 852 application screenshot with the selected historical title, pane-label, and command-menu positions.  It searches within ten pixels of each reference position and reports ink differences against the recovered glyph rasters, position differences against the original capture, and the complete screenshot's intermediate-gray pixel count.  The [measured application positions](application-layout.json) have zero offsets for all seven samples and zero intermediate-gray pixels in the complete screenshot.  The title clips its final glyph overhang at the string advance, as detailed below.  Other samples compare the complete recovered ink.

```sh
python3 compare-layout.py /path/to/reference-size.png
```

The application uses left-aligned paragraphs.  The reference uses justified paragraphs.  Reproducing its word spacing remains unfinished.  Pane contents, available commands, and Mezzano text differ from the reference, so matching the tested glyphs and labels does not establish an exact complete-window reproduction.  The reference's original topic body and the application's project documentation cannot be compared as identical text.

Application tests caught a table-width feedback error, in which an existing table's width became the next layout input and grew on successive renders.  Column widths now derive from the parent width.  The browser test asserts that every table fits its parent.  A data-URL command marker then failed the server's content-security policy.  The marker now uses an inline SVG path, and the final Examiner run reported no browser errors.  A separate diagnostic run found a late Chromium profile-file write during cleanup.  The harness now uses bounded retries when removing its own temporary profile.

The final Examiner browser run passed its functional suite, source-link and table-width assertions, exact 100-pixel reading-position restoration, and session cleanup with zero browser errors.  The full Listener/Debugger suite passed after the shared typography changes, released its owned files, jobs, stops, and session, and reported only the two expected HTTP 409 responses from release reconciliation.

## Title clipping

The six pixels absent from the original title are the final `r` glyph's two-column by three-row overhang beyond the 313-pixel string advance.  Both [de1.gif](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/de1.gif) and [de2.gif](https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/de2.gif) omit exactly those pixels.  The application clips the title's inline block at its advance.  Its 320 by 24 title rectangle then matches both original captures pixel for pixel.  The original drawing code's clipping behavior remains an inference.  The fonts retain the complete glyphs.

The focused test verifies the source image's hash, checks the unclipped six-pixel difference, and requires zero differences after clipping, exact 313 by 24 metrics, and zero intermediate-gray pixels.  It uses Chromium and the installed ImageMagick image decoder.

```sh
node fonts/test-title.mjs /path/to/de2.gif /tmp/title-test
```

The final application screenshot and comparison retain zero offsets for all seven selected samples and zero gray pixels across the complete image.  This closes the measured title mismatch.  Paragraph justification and complete-window comparison remain unfinished.
