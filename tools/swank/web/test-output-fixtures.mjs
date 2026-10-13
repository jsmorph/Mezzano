import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'output-fixture-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.fetch = async (url, options) => {
      if (url !== '/api') throw new Error('Unexpected fixture fetch ' + url);
      const request = JSON.parse(options.body);
      let value;
      switch (request.operation) {
        case 'open-session': value = {}; break;
        case 'monitor-state': value = {listener: {package: 'COMMON-LISP-USER', prompt: 'Command: '}, jobs: [], stops: []}; break;
        default: throw new Error('Unexpected fixture operation ' + request.operation);
      }
      return new Response(JSON.stringify({value, diagnostics: []}), {status: 200});
    };
  `});
  await browser.send('Page.navigate', {url});
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  const result = await browser.evaluate(`(() => {
    connected = false;
    const prefix = 'α🚀 before ', pathname = '/guest/🚀.lisp', middle = ' after 🚀 ';
    const heraldText = 'Herald text 🚀 tail', suffix = ' end🚀';
    const text = prefix + pathname + middle + heraldText + suffix;
    const chars = Array.from(text), length = value => Array.from(value).length;
    const path = {type: ':pathname', start: length(prefix), end: length(prefix + pathname), value: pathname};
    const herald = {type: ':herald', start: length(prefix + pathname + middle),
      end: length(prefix + pathname + middle + heraldText),
      herald: {title: 'Fixture herald', facts: [], help: [], systems: [], 'detailed-p': false}};
    const job = {name: '1'.repeat(64), source: 'Output fixture', listener: true};
    const info = {state: ':returned', 'output-length': chars.length, 'current-boot-p': true,
      'listener-result': {kind: ':command', presentations: [path, herald]}};
    state.jobs[job.name] = job;
    const cuts = [path.start + 3, path.end, herald.start + 5, herald.end, chars.length];
    let start = 0;
    const chunks = [];
    for (const end of cuts) {
      updateJob(job, info, {start, end, text: chars.slice(start, end).join('')});
      const view = views.get(job.name);
      chunks.push({start, end, text: view.text, displayed: view.output.textContent,
        pathnames: [...view.output.querySelectorAll('.presentation')].map(item => item.textContent),
        heralds: view.output.querySelectorAll('.herald').length, status: view.status.textContent});
      start = end;
    }
    const errors = [];
    for (const range of [
      {start: chars.length - 1, end: chars.length, text: ''},
      {start: chars.length, end: chars.length + 1, text: 'x'},
      {start: chars.length, end: chars.length - 1, text: ''}
    ]) {
      try { updateJob(job, info, range); }
      catch (error) { errors.push(error.message); }
    }
    const presentationErrors = [];
    for (const presentations of [
      [{...path, end: chars.length + 1}],
      [path, {...herald, start: path.end - 1}],
      [{...herald, type: ':unknown'}]
    ]) {
      try { renderOutput({text: prefix, output: document.createElement('div')}, presentations, chars.length); }
      catch (error) { presentationErrors.push(error.message); }
    }
    return {text, chars: chars.length, path, herald, chunks, errors, presentationErrors};
  })()`);
  assert.equal(result.chunks[0].displayed, result.chunks[0].text);
  assert.deepEqual(result.chunks.map(item => item.pathnames.length), [0, 1, 1, 1, 1]);
  assert.deepEqual(result.chunks.map(item => item.heralds), [0, 0, 0, 1, 1]);
  for (const chunk of result.chunks) {
    assert.equal(Array.from(chunk.text).length, chunk.end);
    assert.equal(chunk.status.includes('receiving output'), chunk.end < result.chars);
    if (chunk.pathnames.length) assert.equal(chunk.pathnames[0], result.path.value);
  }
  assert.equal(result.chunks.at(-1).text, result.text);
  assert(result.chunks.at(-1).displayed.endsWith(' end🚀'));
  assert.deepEqual(result.errors, Array(3).fill('Invalid retained output range.'));
  assert.deepEqual(result.presentationErrors, ['Invalid Listener presentation range.',
    'Invalid Listener presentation range.', 'Unknown Listener presentation type: :unknown']);
  assert.deepEqual(browser.errors, []);
  await browser.screenshot(join(output, 'complete-presentations.png'));
  await writeFile(join(output, 'result.json'), JSON.stringify({fixtureOnly: true, guestRequests: 0, result, errors: browser.errors}, null, 2));
  console.log('PASS Unicode chunks, split pathname/herald presentations, transfer progress, exact accumulated text, and invalid ranges; zero guest requests');
} catch (error) {
  await browser.screenshot(join(output, 'failure.png'));
  throw error;
} finally {
  await browser.close();
}
