import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../browser-test-support.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const reference=resolve(process.argv[2]);
const output=resolve(process.argv[3] ?? 'title-test-results');
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const sources={
  f1359401f59561069f7117c3600252585188105594a16e64f35f23b5566d1818:'https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/de1.gif',
  cb8cfecd08d3e6013ea9479edbb2e83492d3f5a5e89523c30d89d542c39ac849:'https://www.chai.uni-hamburg.de/~moeller/symbolics-info/docex/de2.gif'
};
const referenceHash=hash(await readFile(reference));
assert(sources[referenceHash],'The reference must be the original de1.gif or de2.gif');
const font=await readFile(join(root,'eurex24i.ttf'));
const crop=path=>execFileSync('magick',[path,'-crop','320x24+175+7','+repage','-depth','8','gray:-']);
const expected=crop(reference);
await mkdir(output,{recursive:true});
const browser=await openBrowser('about:blank');
try {
  await browser.evaluate(`(async()=>{
    const face=new FontFace('EUREX24I','url(data:font/ttf;base64,${font.toString('base64')})');
    await face.load();document.fonts.add(face);
    document.body.style.cssText='margin:0;background:#fff;color:#000';
    const span=document.createElement('span');span.id='title';span.textContent='Document Examiner';
    span.style.cssText='position:absolute;left:175px;top:7px;display:inline-block;font:24px/24px EUREX24I;font-synthesis:none;white-space:pre';
    document.body.append(span);
  })()`);
  const metrics=await browser.evaluate("(()=>{const r=document.querySelector('#title').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  assert.deepEqual(metrics,{x:175,y:7,width:313,height:24});
  const reports=[];
  for(const clipped of [false,true]) {
    await browser.evaluate(`document.querySelector('#title').style.overflow=${JSON.stringify(clipped?'hidden':'visible')}`);
    const path=join(output,clipped?'clipped.png':'unclipped.png');
    await browser.screenshot(path);
    const actual=crop(path);
    assert.equal(actual.length,expected.length);
    let differences=0,gray=0;
    for(let i=0;i<actual.length;i++) {
      if(actual[i]!==expected[i])differences++;
      if(actual[i]!==0&&actual[i]!==255)gray++;
    }
    reports.push({clipped,differences,gray,screenshot:path,sha256:hash(await readFile(path))});
    assert.equal(differences,clipped?0:6);assert.equal(gray,0);
  }
  assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
  await writeFile(join(output,'title-report.json'),JSON.stringify({reference:sources[referenceHash],referenceHash,fontHash:hash(font),metrics,reports},null,2)+'\n');
  console.log('PASS original title pixels with advance clipping, unchanged font glyphs, and exact metrics');
}finally{await browser.close()}
