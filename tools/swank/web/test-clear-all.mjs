import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

if (!process.argv.includes('--allow-global-clear')) {
  throw new Error('This test clears every retained evaluation. Pass --allow-global-clear explicitly.');
}
const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'clear-all-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const marker = 'CLEAR-ALL-' + randomBytes(6).toString('hex').toUpperCase();
const q = JSON.stringify;
const owned = [];
const ready = () => browser.waitFor("typeof connected !== 'undefined' && connected && !busy", 60);

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode, modifiers});
  }
}
async function fill(source) {
  await ready();
  await browser.evaluate("showActivity('listener')");
  await browser.click('#source');
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text: source});
}
async function accept(source, returned = true) {
  await fill(source);
  const previous = await browser.evaluate('Object.keys(state.jobs)');
  await key('Enter', 'Enter', 13);
  const found = `Object.values(state.jobs).find(job => job.source === ${q(source)} && !${q(previous)}.includes(job.name))`;
  await browser.waitFor(found, 60);
  const job = await browser.evaluate(found);
  owned.push(job.name);
  if (returned) await browser.waitFor(`views.get(${q(job.name)})?.info.state === ':returned' && !busy`, 60);
  return job.name;
}
async function cleared(name) {
  await browser.waitFor(`state.jobs[${q(name)}]?.receipt && state.jobs[${q(name)}]?.effectsApplied && !busy`, 60);
  assert.equal(await browser.evaluate(`state.jobs[${q(name)}].hidden`), true);
  assert.equal(await browser.evaluate('state.inputHistory.length'), 0);
  assert.equal(await browser.evaluate('state.commands.length'), 0);
  assert.equal(await browser.evaluate('state.history.length'), 0);
  assert.equal(await browser.evaluate('selectedStop'), null);
  assert.equal(await browser.evaluate("document.querySelector('#herald').hidden"), true);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#transcript article')].filter(item => !item.hidden).length"), 0);
  assert((await browser.evaluate("document.querySelector('#jobs').textContent")).includes('Command result'));
}

try {
  await ready();
  console.log('Fixture', marker);
  await browser.evaluate("showActivity('examiner')");
  await browser.waitFor("[...document.querySelectorAll('#examiner-candidates button')].some(item => item.textContent === 'Mezzano user guide')");
  await browser.evaluate("[...document.querySelectorAll('#examiner-candidates button')].find(item => item.textContent === 'Mezzano user guide').click()");
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Mezzano user guide') && !busy");
  const documents = await browser.evaluate('state.examiner');
  const completed = await accept(`(progn (write-line "${marker}") 17)`);
  const stopped = await browser.evaluate(`(() => {
    const name = freshName();
    run(() => mutate('start-evaluation', {name, package: 'CL-USER', source: '(cerror "Continue." "${marker}")'}));
    return name;
  })()`);
  owned.push(stopped);
  await browser.waitFor(`views.get(${q(stopped)})?.info.stops?.length`, 60);
  await browser.evaluate(`void run(async () => {
    const stop = views.get(${q(stopped)}).info.stops[0];
    await selectStop(stop);
    await submit(stop, 'condition');
  })`);
  await browser.waitFor("state.commands.length && [...commandResults.values()].some(item => item.state === ':returned')", 60);
  await browser.evaluate("document.querySelector('#interactive').checked = true");
  const input = await accept(`(progn (write-line "${marker}-INPUT") (read-line))`, false);
  await browser.waitFor(`views.get(${q(input)})?.info['input-waiting-p'] && !busy`, 60);
  await browser.evaluate("document.querySelector('#interactive').checked = false");
  await browser.evaluate(`(() => {
    const record = {id: freshName(), session: state.session, operation: 'release-job',
      arguments: {job: state.jobs[${q(completed)}].token}, status: 'outcome unknown'};
    state.pending.push(record);
    state.history.push({session: freshName(), pending: [{...record, id: freshName()}], commands: []});
    save();
  })()`);
  const clear = await accept('Clear All');
  await cleared(clear);
  assert.equal(await browser.evaluate('state.pending.length'), 0);
  assert.deepEqual(await browser.evaluate('Object.keys(state.jobs)'), [clear]);
  assert.deepEqual(await browser.evaluate('state.examiner'), documents);
  await browser.screenshot(join(output, 'clear-all.png'));
  await browser.send('Page.reload', {ignoreCache: true});
  await ready();
  await cleared(clear);
  console.log('PASS Clear All accepts while its Listener waits for input, releases evaluations/stops, clears browser histories, hides its receipt, and preserves document viewers on reload');

  await accept(`(progn (write-line "${marker}-LOST") 23)`);
  await fill('Clear All');
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const request = args[1]?.body && JSON.parse(args[1].body);
      const response = await original(...args);
      if (request?.operation === 'start-listener') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Clear All fixture discarded its accepted reply');
      }
      return response;
    };
  })()`);
  await key('Enter', 'Enter', 13);
  await browser.waitFor("state.pending.some(record => record.operation === 'start-listener' && record.status === 'outcome unknown')");
  const pending = await browser.evaluate("state.pending.find(record => record.operation === 'start-listener' && record.status === 'outcome unknown')");
  owned.push(pending.arguments.name);
  await browser.evaluate('void run(connect)');
  await ready();
  await cleared(pending.arguments.name);
  assert.equal(await browser.evaluate('state.pending[0].id'), pending.id);
  assert.equal(await browser.evaluate('state.pending[0].status'), 'outcome unknown');
  const later = await accept('(+ 6 7)');
  const laterToken = await browser.evaluate(`state.jobs[${q(later)}].token`);
  await browser.evaluate("showActivity('requests')");
  await browser.waitFor("[...document.querySelectorAll('#pending button')].some(item => item.textContent === 'Repeat Original Request')");
  await browser.evaluate("[...document.querySelectorAll('#pending button')].find(item => item.textContent === 'Repeat Original Request').click()");
  await browser.waitFor('state.pending.length === 0 && !busy', 60);
  assert.deepEqual(await browser.evaluate(`state.jobs[${q(later)}].token`), laterToken);
  assert.deepEqual(await browser.evaluate('state.inputHistory.map(item => item.name)'), [later]);
  assert.equal(await browser.evaluate(`state.jobs[${q(pending.arguments.name)}].hidden`), true);
  assert.equal(await browser.evaluate(`views.get(${q(later)}).info.state`), ':returned');
  await browser.screenshot(join(output, 'reconciled-clear-all.png'));
  console.log('PASS a lost Clear All reply recovers its typed effect and retained receipt; explicit replay preserves the later evaluation');

  await browser.evaluate(`void run(async () => {
    for (const name of ${q(owned)}) {
      if (state.jobs[name]) await mutate('release-job', {job: state.jobs[name].token});
    }
    await mutate('release-session', {});
  })`);
  await browser.waitFor('!connected && !busy', 60);
  assert.deepEqual(browser.errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({marker, clear, pending, later, owned, cleaned: true, errors: browser.errors}, null, 2));
  console.log('PASS test receipts, later evaluation, and session released');
} catch (error) {
  await browser.screenshot(join(output, 'failure.png'));
  await writeFile(join(output, 'failure.json'), JSON.stringify({error: error.stack, marker, owned,
    state: await browser.evaluate('state'), errors: browser.errors}, null, 2));
  throw error;
} finally {
  await browser.close();
}
