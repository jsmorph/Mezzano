import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'document-inline-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const current = 'state.examiner.viewers.find(item => item.name === state.examiner.current)';
const reference = "[...document.querySelectorAll('#examiner-topics td .document-topic')].find(item => item.textContent === 'Debugger and evaluation reference')";
const guide = "[...document.querySelectorAll('#examiner-candidates button')].find(item => item.textContent === 'Mezzano user guide')";
const ready = () => browser.waitFor("typeof connected !== 'undefined' && connected && !busy", 60);
async function key(key, code, windowsVirtualKeyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode});
  }
}
async function showGuide() {
  await browser.evaluate(`${guide}.click()`);
  await ready();
  await browser.waitFor(reference);
  await browser.evaluate(`${reference}.scrollIntoView({block:'center'})`);
}
async function mouse(button) {
  const point = await browser.evaluate(`(() => {
    const rect = ${reference}.getClientRects()[0];
    return {x: rect.x + rect.width/2, y: rect.y + rect.height/2};
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {type, button, clickCount: 1, ...point});
  }
}

try {
  await ready();
  await browser.send('Emulation.setDeviceMetricsOverride', {width:1160,height:852,deviceScaleFactor:1,mobile:false});
  await browser.evaluate("showActivity('examiner')");
  await browser.waitFor(guide);
  await showGuide();
  const metrics = await browser.evaluate(`(() => {
    const item = ${reference};
    const range = document.createRange();
    range.setStart(item.firstChild, item.textContent.length-1);
    range.setEnd(item.firstChild, item.textContent.length);
    const last = range.getBoundingClientRect();
    range.selectNode(item.nextSibling);
    const punctuation = range.getBoundingClientRect();
    return {tag:item.tagName, role:item.getAttribute('role'), tabIndex:item.tabIndex,
      lines:item.getClientRects().length, lastY:last.y, punctuationY:punctuation.y,
      punctuation:item.nextSibling.textContent, target:item.dataset.topic};
  })()`);
  assert.equal(metrics.tag, 'SPAN');
  assert.equal(metrics.role, 'button');
  assert.equal(metrics.tabIndex, 0);
  assert(metrics.lines > 1);
  assert.equal(metrics.punctuation, '.');
  assert.equal(metrics.lastY, metrics.punctuationY);
  await browser.screenshot(join(output, 'inline-reference.png'));
  for (const [name, code, number] of [['Enter','Enter',13],[' ','Space',32]]) {
    await showGuide();
    await browser.evaluate(`${reference}.focus()`);
    assert.equal(await browser.evaluate(`document.activeElement === ${reference}`), true);
    await key(name, code, number);
    await browser.waitFor(`${current}.current === ${JSON.stringify(metrics.target)} && !busy`, 60);
  }
  await showGuide();
  await mouse('left');
  await browser.waitFor(`${current}.current === ${JSON.stringify(metrics.target)} && !busy`, 60);
  await showGuide();
  await mouse('middle');
  await browser.waitFor("!document.querySelector('#examiner-typeout').hidden && !busy", 60);
  assert((await browser.evaluate("document.querySelector('#examiner-typeout').textContent")).includes('Debugger and evaluation reference'));
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#examiner-typeout').hidden");
  await showGuide();
  await mouse('right');
  await browser.waitFor("document.querySelector('#examiner-menu').open");
  assert((await browser.evaluate("document.querySelector('#examiner-menu').textContent")).includes('Display an overview'));
  await browser.evaluate("[...document.querySelectorAll('#examiner-menu button')].find(item => item.textContent === 'Close').click()");
  await browser.evaluate("void run(() => mutate('release-session', {}))");
  await browser.waitFor('!connected && !busy', 60);
  assert.deepEqual(browser.errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({metrics,errors:browser.errors,cleaned:true},null,2));
  console.log('PASS wrapped topic reference punctuation, focus, Enter/Space, mouse reading, overview, menu, and session cleanup');
} catch (error) {
  await browser.screenshot(join(output, 'failure.png'));
  await writeFile(join(output, 'failure.json'), JSON.stringify({error:error.stack,state:await browser.evaluate('state'),errors:browser.errors},null,2));
  throw error;
} finally {
  await browser.close();
}
