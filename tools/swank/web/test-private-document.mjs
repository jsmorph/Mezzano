import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://minideb2:8765/';
const output = resolve(process.argv[3] ?? 'private-document-test-results');
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

const pathname = 'SYS:HOME;BROWSER-PRIVATE-' + marker + '.PSB';
const saveSource = 'Save Private Document ' + pathname;
let savedJob;
let cleanupJob;
try {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  await browser.click('#window-label'); await browser.click('[data-activity=examiner]');
  await browser.waitFor('document.querySelectorAll("#examiner-candidates > .document-topic").length >= 2');
  const session = await browser.evaluate('state.session');
  const [first, second] = await browser.evaluate(`${current}.candidates[0].topics`);
  await clickText('#examiner-command-menu','Read Private Document','right');
  await browser.waitFor("document.querySelector('#examiner-menu').open");
  await clickText('#examiner-menu','Save Private Document');
  await browser.waitFor("document.querySelector('#examiner-command').value === 'Save Private Document '");
  await browser.waitFor("document.querySelector('#examiner-assistance').textContent.includes('SYS:HOME;PRIVATE.PSB')");
  await shot('pathname-default');
  await topic('#examiner-candidates', second.id, 'middle', 8);
  await browser.waitFor(`${current}.bookmarks.some(item => item.topic.id === ${text(second.id)} && !item.viewed)`);
  await topic('#examiner-candidates', first.id);
  await browser.waitFor(`${current}.bookmarks.some(item => item.topic.id === ${text(first.id)} && item.viewed)`);
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (JSON.parse(args[1]?.body || '{}').operation === 'save-private-document') {
        window.fetch = original;
        window.acceptedSave = (await response.clone().json()).value;
        throw new TypeError('Browser test discarded the accepted Save response');
      }
      return response;
    };
  })()`);
  await fill(saveSource); await key('Enter','Enter',13);
  await browser.waitFor("state.pending.some(item => item.operation === 'save-private-document' && item.status === 'outcome unknown')");
  const original = await browser.evaluate("state.pending.find(item => item.operation === 'save-private-document')");
  savedJob = await browser.evaluate('window.acceptedSave');
  assert(savedJob);
  assert.deepEqual(original.arguments.topics,[first.id,second.id]);
  assert.equal(original.source,saveSource);
  await browser.send('Page.reload');
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  assert.equal(await browser.evaluate('state.session'),session);
  assert.deepEqual(await browser.evaluate("state.pending.find(item => item.operation === 'save-private-document')"),original);
  await browser.click('#window-label'); await browser.click('[data-activity=requests]');
  await clickText('#pending','Repeat Original Request');
  await browser.waitFor('!busy && !state.pending.length');
  assert.deepEqual(await browser.evaluate(`state.jobs[${text(original.arguments.name)}].token`),savedJob);
  assert.equal(await browser.evaluate(`state.jobs[${text(original.arguments.name)}].source`),saveSource);
  await browser.waitFor(`views.get(${text(original.arguments.name)})?.info?.state === ':returned'`);
  assert.equal(await browser.evaluate(`views.get(${text(original.arguments.name)}).source.textContent`),'Command: ' + saveSource);
  const stored = await browser.evaluate(`api('read-private-document', {pathname:${text(original.arguments.pathname)}})`);
  assert.deepEqual(stored.topics.map(item=>item.id),[first.id,second.id]);
  await browser.click('#window-label'); await browser.click('[data-activity=evaluations]');
  await shot('retained-save');
  await browser.click('#window-label'); await browser.click('[data-activity=examiner]');
  await command('Select Viewer ' + marker + ' Load');
  await clickText('#examiner-command-menu','Read Private Document','right');
  await clickText('#examiner-menu','Load Private Document');
  await browser.waitFor("document.querySelector('#examiner-command').value === 'Load Private Document '");
  await command('Load Private Document ' + pathname);
  assert.deepEqual(await browser.evaluate(`${current}.bookmarks.map(item=>({id:item.topic.id,viewed:item.viewed}))`),
    [{id:first.id,viewed:false},{id:second.id,viewed:false}]);
  assert.equal(await browser.evaluate(`${current}.sections.length`),0);
  await shot('loaded-bookmarks');
  const beforePrint = await browser.evaluate(`JSON.stringify(${current})`);
  await browser.evaluate(`window.print = () => {
    window.privatePrinted = [...document.querySelectorAll('#examiner-print-topic .document-section')].map(item=>item.dataset.topic);
    window.privatePrintText = document.querySelector('#examiner-print-topic').textContent;
  }`);
  await clickText('#examiner-command-menu','Read Private Document','right');
  await clickText('#examiner-menu','Hardcopy Private Document');
  await browser.waitFor("document.querySelector('#examiner-command').value === 'Hardcopy Private Document '");
  await command('Hardcopy Private Document ' + pathname);
  const printed = await browser.evaluate('window.privatePrinted');
  assert(printed.includes(first.id) && printed.includes(second.id));
  assert.equal(new Set(printed).size,printed.length);
  assert.equal(await browser.evaluate(`JSON.stringify(${current})`),beforePrint);
  assert.equal(await browser.evaluate("!!document.querySelector('#examiner-print-topic')"),false);
  await clickText('#examiner-command-menu','Read Private Document');
  await browser.waitFor("document.querySelector('#examiner-command').value === 'Read Private Document '");
  await command('Read Private Document ' + pathname);
  assert.deepEqual(await browser.evaluate(`${current}.bookmarks.filter(item=>item.viewed).map(item=>item.topic.id)`),[first.id,second.id]);
  assert(await browser.evaluate(`${current}.sections.some(item=>item.topic.id === ${text(first.id)}) && ${current}.sections.some(item=>item.topic.id === ${text(second.id)})`));
  await shot('read-document');
  const cleanupSource = `(let ((path ${JSON.stringify(stored.pathname)})) (delete-file path) (null (probe-file path)))`;
  cleanupJob = await browser.evaluate(`api('start-evaluation',{name:freshName(),source:${text(cleanupSource)}})`);
  await browser.waitFor(`api('job-information',{job:${text(cleanupJob)}}).then(info=>info.state === ':returned')`);
  assert.deepEqual((await browser.evaluate(`api('job-information',{job:${text(cleanupJob)}})`)).values,['T']);
  await browser.evaluate(`api('release-job',{job:${text(cleanupJob)}})`);
  await browser.evaluate(`api('release-job',{job:${text(savedJob)}})`);
  await browser.click('#package-label'); await browser.click('#release-session');
  await browser.waitFor('!connected');
  assert.equal(await browser.evaluate('state.pending.length'),0);
  assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));
  await writeFile(join(output,'state.json'),await browser.evaluate('JSON.stringify(state,null,2)'));
  console.log('PASS private-document menus/defaults, bookmark order, retained Save reply loss/reload/replay, Load without text, Read, Hardcopy without viewer mutation, and owned file/jobs/session cleanup');
} catch(error) {
  await shot('failure');
  await writeFile(join(output,'state.json'),await browser.evaluate('JSON.stringify(state,null,2)'));
  await writeFile(join(output,'body.txt'),await browser.evaluate('document.body.innerText'));
  await writeFile(join(output,'fixtures.json'),JSON.stringify({pathname,savedJob,cleanupJob},null,2));
  throw error;
} finally {
  await writeFile(join(output,'browser-errors.json'),JSON.stringify(browser.errors,null,2));
  await browser.close();
}
