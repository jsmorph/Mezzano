import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://minideb2:8765/';
const output = resolve(process.argv[3] ?? 'document-examiner-test-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const text = JSON.stringify;
const marker = 'EXAMINER-' + randomBytes(6).toString('hex').toUpperCase();
const shot = name => browser.screenshot(join(output, name + '.png'));
async function key(key, code, number, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode: number, modifiers});
  }
}
async function clickText(container, value, mouse = 'left', modifiers = 0) {
  const match = `[...document.querySelectorAll(${text(container + ' button')})].filter(button => button.textContent === ${text(value)} && button.getBoundingClientRect().width && !button.disabled)`;
  await browser.waitFor(match + '.length === 1');
  await browser.evaluate(`(${match})[0].setAttribute('data-examiner-test', 'target')`);
  await click('[data-examiner-test=target]', mouse, modifiers);
  await browser.evaluate("document.querySelector('[data-examiner-test=target]')?.removeAttribute('data-examiner-test')");
}
async function click(selector, mouse = 'left', modifiers = 0) {
  const position = await browser.evaluate(`(() => {
    const element = document.querySelector(${text(selector)});
    if (!element) throw new Error('Missing ' + ${text(selector)});
    element.scrollIntoView({block:'center', inline:'nearest'});
    const r = element.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error('Invisible ' + ${text(selector)});
    return {x:r.x+r.width/2, y:r.y+r.height/2};
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {type, button: mouse, modifiers, clickCount:1, ...position});
  }
}
async function topic(container, id, mouse = 'left', modifiers = 0) {
  const match = `[...document.querySelectorAll(${text(container + ' .document-topic')})].find(item => item.dataset.topic === ${text(id)})`;
  await browser.waitFor(match);
  await browser.evaluate(`${match}.setAttribute('data-examiner-test', 'topic')`);
  await click('[data-examiner-test=topic]', mouse, modifiers);
  await browser.evaluate("document.querySelector('[data-examiner-test=topic]')?.removeAttribute('data-examiner-test')");
}
async function fill(source) {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  await browser.click('#examiner-command');
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text:source});
}
async function command(source) {
  await fill(source); await key('Enter','Enter',13);
  await browser.waitFor(`document.querySelector('#examiner-command-output').textContent === ${text('▶ ' + source)}`);
}
const current = "state.examiner.viewers.find(item => item.name === state.examiner.current)";

try {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  await browser.click('#window-label');
  await browser.click('[data-activity=examiner]');
  await browser.waitFor('document.querySelectorAll("#examiner-candidates > .document-topic").length >= 2');
  const session = await browser.evaluate('state.session');
  const initial = await browser.evaluate(`${current}.candidates[0].topics`);
  const [first, second] = initial;
  await shot('catalog');
  await fill('Show Doc'); await key('Tab','Tab',9);
  await browser.waitFor("document.querySelector('#examiner-command').value === 'Show Documentation '");
  await key('F12','F12',123);
  await browser.waitFor("document.querySelectorAll('#examiner-assistance button').length > 0");
  await shot('completion');
  await key('F10','F10',121);
  await topic('#examiner-candidates', first.id, 'middle', 8);
  await browser.waitFor(`${current}.bookmarks.some(item => item.topic.id === ${text(first.id)} && !item.viewed)`);
  await topic('#examiner-candidates', second.id);
  await browser.waitFor(`${current}.bookmarks.some(item => item.topic.id === ${text(second.id)} && item.viewed)`);
  await topic('#examiner-candidates', first.id);
  await browser.waitFor(`${current}.bookmarks.every(item => item.viewed)`);
  assert.deepEqual(await browser.evaluate(`${current}.bookmarks.filter(item => item.viewed).map(item => item.topic.id)`), [second.id, first.id]);
  await topic('#examiner-bookmarks', second.id, 'middle', 8);
  await browser.waitFor(`${current}.bookmarks.length === 1`);
  await topic('#examiner-candidates', first.id);
  await browser.waitFor(`${current}.bookmarks.some(item => item.topic.id === ${text(first.id)} && item.viewed)`);
  const sectionCount = await browser.evaluate(`${current}.sections.length`);
  assert(sectionCount > 0);
  await topic('#examiner-candidates', first.id);
  await browser.waitFor('!busy');
  assert.equal(await browser.evaluate(`${current}.sections.length`), sectionCount);
  await topic('#examiner-candidates', second.id, 'middle');
  await browser.waitFor("!document.querySelector('#examiner-typeout').hidden");
  assert.equal(await browser.evaluate(`${current}.bookmarks.length`), 1);
  assert(await browser.evaluate("document.querySelectorAll('#examiner-typeout .document-topic').length > 0"));
  assert.equal(await browser.evaluate("document.querySelector('#examiner-typeout .document-source a').href"),second.source);
  await shot('overview');
  await key(' ','Space',32);
  await browser.waitFor("document.querySelector('#examiner-typeout').hidden");
  await topic('#examiner-candidates', second.id, 'middle', 8);
  await browser.waitFor(`${current}.bookmarks.some(item => item.topic.id === ${text(second.id)} && !item.viewed)`);
  assert(await browser.evaluate(`!!document.querySelector('#examiner-bookmarks .deferred-bookmarks .document-topic')`));
  await topic('#examiner-bookmarks', second.id);
  await browser.waitFor(`${current}.bookmarks.some(item => item.topic.id === ${text(second.id)} && item.viewed)`);
  await shot('viewer');
  assert(await browser.evaluate("[...document.querySelectorAll('#examiner-pages table')].every(table => table.getBoundingClientRect().width <= table.parentElement.clientWidth)"));
  await topic('#examiner-candidates', first.id, 'right');
  await browser.waitFor("document.querySelector('#examiner-menu').open");
  await shot('topic-menu');
  await clickText('#examiner-menu','Display a table of contents');
  await browser.waitFor(`${current}.candidates.length === 2`);
  assert(await browser.evaluate("document.querySelectorAll('#examiner-candidates > .document-topic').length > 0"));
  await clickText('#examiner-command-menu','Reselect Candidates');
  await browser.waitFor("document.querySelector('#examiner-menu').open");
  await clickText('#examiner-menu', (await browser.evaluate(`${current}.candidates[0].title`)) + ' (1)');
  assert.equal(await browser.evaluate(`${current}.candidateIndex`),0);
  await fill('Show Candidates debugger');
  await key('F11','F11',122,1);
  await browser.waitFor("document.querySelector('#examiner-menu').open");
  await browser.click('[data-search-mode=":initial"]');
  await browser.waitFor(`${current}.search.mode === ':initial'`);
  await browser.click('#examiner-adjacent');
  await browser.waitFor(`${current}.search.adjacent === true`);
  await shot('search-options');
  await clickText('#examiner-menu','Close');
  await command('Show Candidates debugger');
  await browser.waitFor(`${current}.candidates.length === 3`);
  const search = await browser.evaluate(`${current}.candidates.at(-1)`);
  assert(search.topics.length > 0);
  assert.equal(search.mode, ':initial');
  assert.equal(search.adjacent, true);
  assert(await browser.evaluate("[...document.querySelectorAll('#examiner-candidates > .document-topic')].every(item => item.dataset.depth === '0')"));
  assert(await browser.evaluate("document.querySelector('#examiner-candidates .candidate-mode').textContent.includes('Search:')"));
  await shot('search');
  await command('Select Viewer ' + marker + ' 🚀');
  assert.equal(await browser.evaluate(`${current}.bookmarks.length`),0);
  assert.equal(await browser.evaluate(`${current}.candidates.length`),1);
  await key('l','KeyL',76,3);
  await browser.waitFor("state.examiner.current === 'Default Viewer'");
  assert.equal(await browser.evaluate(`${current}.candidates.length`),3);
  await key('?','Slash',191,2);
  await browser.waitFor("document.querySelector('#examiner-menu').open");
  assert(await browser.evaluate(`document.querySelector('#examiner-menu').textContent.includes(${text(marker)})`));
  await clickText('#examiner-menu','Close');
  await topic('#examiner-bookmarks', second.id, 'middle',8);
  await browser.waitFor(`!${current}.bookmarks.some(item => item.topic.id === ${text(second.id)})`);
  assert(!await browser.evaluate(`${current}.sections.some(item => item.topic.id === ${text(second.id)})`));
  await browser.evaluate("document.querySelector('#examiner-pages').scrollTop = 100");
  await browser.waitFor(`${current}.scroll === 100`);
  const persisted = await browser.evaluate('JSON.stringify(state.examiner)');
  await writeFile(join(output,'before-reload.json'), persisted);
  await browser.send('Page.reload');
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  assert.equal(await browser.evaluate('state.session'),session);
  await browser.click('#window-label'); await browser.click('[data-activity=examiner]');
  await browser.waitFor("document.querySelectorAll('#examiner-topics .document-section').length > 0");
  const restored = await browser.evaluate('JSON.stringify(state.examiner)');
  await writeFile(join(output,'after-reload.json'), restored);
  const withoutScroll = data => { const value = JSON.parse(data); for (const item of value.viewers) delete item.scroll; return value; };
  assert.deepEqual(withoutScroll(restored), withoutScroll(persisted));
  await browser.waitFor('!busy');
  assert.equal(await browser.evaluate("document.querySelector('#examiner-pages').scrollTop"),100);
  assert.equal(await browser.evaluate(`${current}.scroll`),100);
  await command('Remove Viewer ' + marker + ' 🚀');
  assert.equal(await browser.evaluate('state.examiner.viewers.length'),1);
  await command('Help');
  await browser.waitFor("!document.querySelector('#examiner-typeout').hidden");
  assert((await browser.evaluate("document.querySelector('#examiner-typeout').textContent")).includes('Show Documentation'));
  await key(' ','Space',32);
  await command('Document Examiner Documentation');
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Document Examiner')");
  await browser.evaluate('window.print = () => { window.examinerPrintCalls = (window.examinerPrintCalls || 0) + 1; }');
  await command('Hardcopy Viewer');
  assert.equal(await browser.evaluate('window.examinerPrintCalls'),1);
  await browser.send('Emulation.setEmulatedMedia',{media:'print'});
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#examiner-right')).display"),'none');
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#examiner-topics')).display"),'block');
  await browser.send('Emulation.setEmulatedMedia',{media:''});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:640,height:720,deviceScaleFactor:1,mobile:false});
  await shot('narrow');
  assert(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1160,height:852,deviceScaleFactor:1,mobile:false});
  await shot('reference-size');
  await browser.evaluate("document.querySelector('#package-label').click()");
  await browser.click('#release-session');
  await browser.waitFor('!connected');
  assert.equal(await browser.evaluate('state.pending.length'),0);
  assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
  await writeFile(join(output,'state.json'),await browser.evaluate('JSON.stringify(state,null,2)'));
  console.log('PASS Document Examiner completion, topic reuse, mouse actions, temporary overview, deferred bookmarks, contents, search, candidate history, named viewers, reload, help, print dispatch, 640px layout, and session cleanup');
} catch (error) {
  await shot('failure');
  await writeFile(join(output,'state.json'),await browser.evaluate('JSON.stringify(state,null,2)'));
  await writeFile(join(output,'body.txt'),await browser.evaluate('document.body.innerText'));
  throw error;
} finally {
  await writeFile(join(output,'browser-errors.json'),JSON.stringify(browser.errors,null,2));
  await browser.close();
}
