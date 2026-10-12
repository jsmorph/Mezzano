# Original display font identification

The comparison tests recovered Genera 8.5 glyphs against the original classic debugger capture and two embedded bitmap figures in the Genera 8 Workbook.  All 21 selected ink rectangles have a candidate with zero missing and zero extra pixels.  The JSON preserves the tested strings, search ranges, matching positions, candidate fonts, pixel counts, source hashes, and font metrics.

## Identified roles

| Display role | Matching recovered glyph set | Evidence |
|---|---|---|
| Listener input, classic debugger arguments and restart keys, who-line | CPTFONT | Exact tested ink rectangles. |
| Classic debugger condition and function name | CPTFONTCB | Exact tested ink rectangles.  CPTFONTB is a different font. |
| Dynamic Listener activity label | HL12I | Workbook figure 7. |
| Classic Lisp Interaction Window label | TR12I or MATH12 | Both have identical glyphs for the tested label.  Its pixels cannot distinguish these font objects. |
| Classic interaction menu title | TR12I | Its tested prefix distinguishes TR12I from MATH12. |
| System Menu title | HL12BI | Exact prefix from Workbook figure 4. |
| System Menu column headings | HL12I | Two exact headings from figure 4. |
| Menu items | JESS14 | Exact strings in both the classic capture and figure 4. |
| Mouse-documentation lines | SWISS12B-CCAPS | Exact strings in the classic capture and figure 7.  The classic capture uses reverse video. |
| Initial Listener herald title | EUREX24I | Exact title prefix from figure 7. |
| Herald body and emphasized hostname | HL12 and HL12BI | Exact strings from figure 7. |

A bitmap match identifies compatibility with the tested glyphs.  It does not inspect a running Genera font object or prove that every glyph in that recovered font matches the historical image.  TR12I is the recommended classic-label choice because it also matches the related text-menu title.  The label comparison alone retains the MATH12 ambiguity.

The [Symbolics UI manual, Volume B](https://bitsavers.trailing-edge.com/pdf/symbolics/software/genera_7/999029_Programming_the_User_Interface_Volume_B_Aug86.pdf), printed pages 156–157, independently names CPTFONT as the usual default, JESS14 as the menu default, CPTFONTI for fixed-width italics, and CPTFONTCB for matching fixed-width bold.  The window-label sections in Volume B, pages 189–190, and [Volume A](https://bitsavers.trailing-edge.com/pdf/symbolics/software/genera_7/999025_Programming_the_User_Interface_Sep86.pdf), pages 405–406, permit character-style overrides without identifying the Listener's override.

## Method and reproduction

`identify.py` requires Python's standard library, ImageMagick's `magick`, and Poppler's `pdfimages`.  Those tools were already installed on the analysis workstation.  It does not install fonts or convert them into browser fonts.

Supply the source PDF and GIF identified by URL and SHA-256 in `matches.json`, plus the font source checkout at commit 809694a73ece7f840b6541b4781cd47152d1ea35:

```sh
python3 identify.py \
  --font-root /path/to/genera-fonts \
  --workbook /path/to/Genera_Workbook.pdf \
  --debugger-image /path/to/source-code-debugging.gif > matches.json
```

The script extracts the Workbook's original one-bit images.  It does not render or rescale PDF pages.  PDF image extraction returns the Listener and menu bitmaps upside down because the PDF supplies a separate placement transform.  The comparison reverses the row order to restore the displayed orientation.  Coordinates in the result use that upright orientation.  The debugger GIF needs no orientation change.  Samples containing pixels other than black and white are excluded from the comparison.  No thresholding or antialias smoothing is used.

The script composes glyph masks from the original rows, left kerns, and advances.  It searches the specified small coordinate ranges and compares the entire tested ink bounding rectangle, including white pixels.  Candidate ranking uses the Dice score.  Missing and extra counts provide the exact-match assertion.  Menu-title prefixes avoid a horizontal border that overlaps the longer title's descenders in the historical capture.

Advance, baseline, character height, and the reported raster origin come from recovered font metadata.  The screenshot independently tests glyph placement and spacing within each tested string, but does not independently measure the invisible trailing advance.  The classic function, argument, and restart samples align at recovered raster origins y=450, 464, and 478, consistent with fourteen-pixel line spacing for the twelve-pixel CPTFONT/CPTFONTCB strikes.

## Required browser tests

A future outline conversion must pass raster comparisons in Chromium at device-pixel ratio 1.  Every tested glyph rectangle must preserve integer pixel placement, with zero missing, extra, or intermediate-gray pixels.  Measured string advance, baseline placement, and line height must match the selected role's recovered metrics and reference arrangement.  Body text, bold condition and function, each label style, menu title/headings/items, both mouse-help lines, and herald styles require separate samples.

Recovering the original pixels and generating rectangular contours does not establish that Chromium rasterizes those contours identically.  Conversion, font loading, browser raster tests, and whole-layout comparison remain separate steps.  No font-conversion dependency was installed during this research.
