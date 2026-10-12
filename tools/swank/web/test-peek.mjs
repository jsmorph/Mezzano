import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'peek-test-results');
const navigationOnly = process.argv.includes('--navigation-only');
await mkdir(output, {recursive:true});
const browser = await openBrowser(url);
const text = JSON.stringify;
async function key(key, code, number, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode:number, modifiers});
  }
}
async function select(letter) {
  await key('F9','F9',120);
  await browser.waitFor("document.querySelector('#process-state').textContent === 'Select:'");
  await key(letter, 'Key' + letter.toUpperCase(), letter.toUpperCase().charCodeAt(0));
}
async function topic(container, id) {
  const expression = `[...document.querySelectorAll(${text(container + ' .document-topic')})].find(item => item.dataset.topic === ${text(id)})`;
  await browser.waitFor(expression);
  await browser.evaluate(`${expression}.setAttribute('data-peek-test','topic')`);
  await browser.click('[data-peek-test=topic]');
  await browser.evaluate("document.querySelector('[data-peek-test=topic]')?.removeAttribute('data-peek-test')");
}
try {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  await browser.click('#source');
  await browser.send('Input.insertText',{text:'(+ 17 25)'});
  await key('F9','F9',120);
  await browser.waitFor("document.querySelector('#process-state').textContent === 'Select:'");
  await key('Backspace','Backspace',8);
  assert.equal(await browser.evaluate('document.querySelector("#source").value'),'(+ 17 25)');
  assert.equal(await browser.evaluate('activity'),'listener');
  await key('F9','F9',120); await key('F12','F12',123);
  await browser.waitFor('document.querySelector("#select-help").open');
  await browser.screenshot(join(output,'select-help.png'));
  await key('F11','F11',122,8);
  await browser.waitFor('!document.querySelector("#select-help").open');
  assert.equal(await browser.evaluate('document.activeElement.id'),'source');
  await select('d');
  await browser.waitFor('activity === "examiner" && document.querySelectorAll("#examiner-candidates .document-topic").length > 0');
  const catalog = await browser.evaluate('api("document-query",{action:"catalog"})');
  assert(catalog.topics.length >= 13);
  assert(catalog.topics.every(topic => !/devnotes|TESTING|font-research|\/fonts\/|minideb2|debugger-design/.test(topic.id)));
  await topic('#examiner-candidates','doc/project-guide.md');
  await topic('#examiner-topics','doc/installation.md');
  await browser.waitFor('[...document.querySelectorAll("#examiner-topics .document-section")].some(item => item.dataset.topic === "doc/installation.md")');
  await topic('#examiner-topics','doc/debugger.md');
  await browser.waitFor('[...document.querySelectorAll("#examiner-topics .document-section")].some(item => item.dataset.topic === "doc/debugger.md")');
  await browser.screenshot(join(output,'product-guides.png'));
  await select('p');
  await browser.waitFor('activity === "peek" && !document.querySelector("#peek-help").hidden');
  await browser.screenshot(join(output,'peek-help.png'));
  await key('q','KeyQ',81);
  await browser.waitFor('activity === "examiner"');
  await select('l');
  assert.equal(await browser.evaluate('document.querySelector("#source").value'),'(+ 17 25)');
  assert.equal(await browser.evaluate('document.activeElement.id'),'source');
  console.log('PASS SELECT prompt, cancellation, help, L/D/P, Peek Quit, preserved input, and product-guide navigation');

  if (!navigationOnly) {
    const fixtureName = 'PEEK-BROWSER-' + randomBytes(6).toString('hex').toUpperCase();
    const jobName = randomBytes(32).toString('hex');
    let commandName = null;
    const source = `(progn (setf (mezzano.supervisor:thread-name (mezzano.supervisor:current-thread)) "${fixtureName}") (cerror "Continue." "Peek browser test.") 42)`;
    await writeFile(join(output,'fixture.json'),JSON.stringify({session:await browser.evaluate('state.session'),jobName,commandName,fixtureName},null,2));
    await browser.evaluate(`run(() => mutate("start-evaluation",{name:${text(jobName)},source:${text(source)}}))`);
    await browser.waitFor(`stops.some(stop => stop.info.thread === ${text(fixtureName)})`);
    await select('p'); await key('p','KeyP',80);
    await browser.waitFor(`[...document.querySelectorAll('.process-name')].some(item => item.textContent === ${text(fixtureName)})`);
    const sample = await browser.evaluate('api("processes")');
    const own = sample.threads.filter(row => row.name === fixtureName);
    assert.equal(own.length,1);
    assert.equal(own[0].stops.length,1);
    assert.equal(typeof own[0]['run-time'],'number');
    assert(sample['run-time-units-per-second'] > 0);
    const stop = own[0].stops[0];
    await writeFile(join(output,'live-process.json'),JSON.stringify(own[0],null,2));
    await browser.send('Emulation.setDeviceMetricsOverride',{width:980,height:717,deviceScaleFactor:1,mobile:false});
    await browser.screenshot(join(output,'processes.png'));
    const rowMatch = `[...document.querySelectorAll('.process-name')].find(item => item.textContent === ${text(fixtureName)})`;
    async function processMenu() {
      await browser.evaluate(`${rowMatch}.setAttribute('data-peek-test','process')`);
      await browser.click('[data-peek-test=process]');
      await browser.waitFor('document.querySelector("#peek-process-menu").open');
    }
    async function menuAction(prefix) {
      const match = `[...document.querySelectorAll('#peek-process-actions button')].find(item => item.textContent.startsWith(${text(prefix)}))`;
      await browser.waitFor(match);
      await browser.evaluate(`${match}.setAttribute('data-peek-test','action')`);
      await browser.click('[data-peek-test=action]');
    }
    await processMenu(); await menuAction('Describe');
    await browser.waitFor('document.querySelector("#peek-description").open');
    assert(await browser.evaluate(`document.querySelector('#peek-description-fields').textContent.includes(${text(fixtureName)})`));
    assert(await browser.evaluate("document.querySelector('#peek-description-fields').textContent.includes('Recorded runtime:')"));
    await browser.screenshot(join(output,'describe.png'));
    await browser.click('#close-peek-description');
    await processMenu(); await menuAction('Debugger:');
    await browser.waitFor('activity === "debugger" && !busy');
    assert.deepEqual(await browser.evaluate('selectedStop'),stop);
    console.log('PASS live thread sample, bounded Describe, and exact retained-stop navigation');

    await select('l');
    await browser.click('#source'); await key('a','KeyA',65,2);
    await browser.send('Input.insertText',{text:'Show Processes'}); await key('Enter','Enter',13);
    await browser.waitFor('state.inputHistory.at(-1)?.source === "Show Processes"');
    commandName = await browser.evaluate('state.inputHistory.at(-1).name');
    await writeFile(join(output,'fixture.json'),JSON.stringify({session:await browser.evaluate('state.session'),jobName,commandName,fixtureName},null,2));
    await browser.waitFor(`views.get(${text(commandName)})?.info?.state === ':returned'`);
    const commandJob = await browser.evaluate(`state.jobs[${text(commandName)}].token`);
    const commandOutput = await browser.evaluate(`api("job-output",{job:${text(commandJob)},start:0})`);
    assert(JSON.stringify(commandOutput).includes(fixtureName));
    console.log('PASS Show Processes reports the same live fixture');

    await browser.evaluate(`run(async () => { await selectStop(${text(stop)}); await submit(selectedStop,'restarts'); })`);
    await browser.waitFor('returnedResult("restarts")?.some(item => item.name.includes("CONTINUE"))');
    const restart = await browser.evaluate('returnedResult("restarts").find(item => item.name.includes("CONTINUE")).index');
    await browser.evaluate(`run(() => submit(selectedStop,'invoke-restart',${restart}))`);
    await browser.waitFor(`views.get(${text(jobName)})?.info?.state === ':returned'`);
    await browser.evaluate(`run(async () => {
      await mutate('release-job',{job:state.jobs[${text(jobName)}].token});
      await mutate('release-job',{job:state.jobs[${text(commandName)}].token});
      await mutate('release-stop',{stop:${text(stop)}});
    })`);
    console.log('PASS own CERROR worker continued; evaluation jobs and stop released');
  }

  await browser.evaluate('run(async () => { await api("release-session"); connected = false; })');
  assert.equal(await browser.evaluate('connected'),false);
  assert.deepEqual(browser.errors,[]);
  await writeFile(join(output,'result.json'),JSON.stringify({navigation:true,liveProcesses:!navigationOnly,errors:browser.errors},null,2));
  console.log('PASS own session released; zero browser errors');
} catch (error) {
  await writeFile(join(output,'failure-session.json'),JSON.stringify(await browser.evaluate('state'),null,2));
  await browser.screenshot(join(output,'failure.png'));
  console.error('Owned session record:',join(output,'failure-session.json'));
  throw error;
} finally { await browser.close(); }
