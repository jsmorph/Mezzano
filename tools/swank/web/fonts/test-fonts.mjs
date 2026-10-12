import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../browser-test-support.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? 'font-test-results');
await mkdir(output, {recursive:true});
const manifest = JSON.parse(await readFile(join(root,'pixels.json'),'utf8'));
const browser = await openBrowser('about:blank');
const reports = [];
try {
  await browser.evaluate(`document.body.style.cssText = 'background:white;color:black;margin:16px';
    document.body.innerHTML = '<h1>Recovered font raster tests</h1>';`);
  for (const font of manifest.fonts) {
    const data = (await readFile(join(root,font.file))).toString('base64');
    const report = await browser.evaluate(`(async () => {
      const font = ${JSON.stringify(font)};
      const face = new FontFace(font.name, 'url(data:font/ttf;base64,${data})');
      await face.load(); document.fonts.add(face);
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96;
      const context = canvas.getContext('2d', {willReadFrequently:true});
      context.font = font.height + 'px "' + font.name + '"';
      context.textBaseline = 'alphabetic';
      const errors = [];
      let missing = 0, extra = 0, gray = 0, advances = 0;
      for (const glyph of font.glyphs) {
        context.fillStyle = '#fff'; context.fillRect(0,0,128,96);
        context.fillStyle = '#000';
        const char = String.fromCodePoint(glyph.scalar);
        context.fillText(char,32,32+font.baseline);
        const expected = new Set(glyph.pixels.map(([x,y]) => (y+32)*128+x+32));
        const actual = context.getImageData(0,0,128,96).data;
        let absent = 0, additional = 0, intermediate = 0;
        for (let i = 0; i < 128*96; i++) {
          if (expected.has(i) && actual[i*4] !== 0) absent++;
          if (!expected.has(i) && actual[i*4] !== 255) additional++;
          if (![0,255].includes(actual[i*4])) intermediate++;
        }
        const advance = context.measureText(char).width;
        if (advance !== glyph.advance) advances++;
        if (absent || additional || intermediate || advance !== glyph.advance) {
          errors.push({scalar:glyph.scalar, missing:absent,extra:additional,gray:intermediate,
                       advance,expectedAdvance:glyph.advance});
        }
        missing+=absent;extra+=additional;gray+=intermediate;
      }
      const row = document.createElement('div');
      row.style.cssText = 'margin:12px 0';
      const title = document.createElement('div'); title.textContent = font.name;
      const sample = document.createElement('div');
      sample.style.cssText = 'font-family:"'+font.name+'";font-size:'+font.height+'px;line-height:'+font.height+'px;font-synthesis:none;';
      sample.textContent = 'Document Examiner  Command: (+ 1 2)  ABC xyz 0123456789';
      const baseline = document.createElement('span'); baseline.style.cssText = 'display:inline-block;width:0;height:0;padding:0;vertical-align:baseline';
      sample.append(baseline); row.append(title,sample);document.body.append(row);
      const rect=sample.getBoundingClientRect(),mark=baseline.getBoundingClientRect();
      const metrics=context.measureText('Hg');
      return {name:font.name,glyphs:font.glyphs.length,missing,extra,gray,advanceErrors:advances,
              cssLineHeight:rect.height,cssBaseline:mark.top-rect.top,
              fontAscent:metrics.fontBoundingBoxAscent,fontDescent:metrics.fontBoundingBoxDescent,
              expectedHeight:font.height,expectedBaseline:font.baseline,errors};
    })()`);
    reports.push(report);
    console.log(JSON.stringify({...report,errors:report.errors.slice(0,8)}));
  }
  await browser.screenshot(join(output,'font-samples.png'));
  await writeFile(join(output,'raster-report.json'),JSON.stringify({revision:manifest.revision,reports},null,2)+'\n');
  for (const report of reports) {
    assert.equal(report.missing,0,report.name+' missing pixels');
    assert.equal(report.extra,0,report.name+' extra pixels');
    assert.equal(report.gray,0,report.name+' gray pixels');
    assert.equal(report.advanceErrors,0,report.name+' advances');
    assert.equal(report.cssLineHeight,report.expectedHeight,report.name+' line height');
    assert.equal(report.cssBaseline,report.expectedBaseline,report.name+' baseline');
    assert.equal(report.fontAscent,report.expectedBaseline,report.name+' ascent');
    assert.equal(report.fontDescent,report.expectedHeight-report.expectedBaseline,report.name+' descent');
  }
  assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
  console.log('PASS recovered font DPR1 glyph rasters, advances, CSS baselines, and line heights');
} finally { await browser.close(); }
