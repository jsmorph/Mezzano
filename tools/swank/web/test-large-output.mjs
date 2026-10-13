import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join, resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'large-output-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
const q = JSON.stringify;
const marker = 'OUTPUT-' + randomBytes(6).toString('hex').toUpperCase();
const large = randomBytes(32).toString('hex');
const small = randomBytes(32).toString('hex');
const largeSource = `(progn ; ${marker}\n(dotimes (i 512) (write-line (make-string 1024 :initial-element (char "🚀" 0)))) (values))`;
const smallSource = `(progn (write-line "${marker}-SHORT") (values))`;

async function key(key, code, windowsVirtualKeyCode, modifiers = 0, text) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode, modifiers,
      ...(type === 'keyDown' && text ? {text} : {})
    });
  }
}

try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.outputBatches = [];
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const request = args[1]?.body && JSON.parse(args[1].body);
      const started = performance.now();
      const response = await originalFetch(...args);
      if (request?.operation === 'monitor-state' && response.ok) {
        const {value} = await response.clone().json();
        window.outputBatches.push({elapsed: performance.now() - started,
          characters: value.jobs.reduce((sum, row) => sum + Array.from(row.output.text).length, 0),
          jobs: value.jobs.filter(row => ${q([large, small])}.includes(row.information.name))
            .map(row => ({name: row.information.name, start: row.output.start,
              end: row.output.end, total: row.information['output-length']}))});
      }
      return response;
    };
  `});
  await browser.send('Page.navigate', {url});
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  console.log('Fixture', marker);
  await browser.evaluate(`void run(async () => {
    await mutate('start-evaluation', {name: ${q(large)}, source: ${q(largeSource)}, package: 'CL-USER'});
    await mutate('start-evaluation', {name: ${q(small)}, source: ${q(smallSource)}, package: 'CL-USER'});
    const deadline = performance.now() + 30000;
    for (const name of ${q([large, small])}) {
      while ((await api('job-information', {job: state.jobs[name].token})).state !== ':returned') {
        if (performance.now() > deadline) throw new Error('Output fixture did not return');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await refresh();
    window.outputReady = true;
  })`);
  await browser.waitFor('window.outputReady && !busy', 40);
  const first = await browser.evaluate(`({large: {end: views.get(${q(large)}).end,
    total: views.get(${q(large)}).info['output-length'], status: views.get(${q(large)}).status.textContent},
    small: views.get(${q(small)}).text})`);
  assert(first.large.end > 0 && first.large.end < first.large.total);
  assert(first.large.status.includes('receiving output'));
  assert.equal(first.small, marker + '-SHORT\n');
  console.log('PASS both unread jobs progress in the first batch');

  const completionStarted = Date.now();
  await browser.click('#source');
  await browser.send('Input.insertText', {text: 'Se'});
  await key(' ', 'Space', 32, 0, ' ');
  await browser.waitFor("document.querySelector('#source').value === 'Set '");
  const completionMs = Date.now() - completionStarted;
  const completionPending = await browser.evaluate(`views.get(${q(large)}).end < views.get(${q(large)}).info['output-length']`);
  assert(completionPending, 'Completion must finish while output remains unread');

  const docsStarted = Date.now();
  await browser.evaluate("showActivity('examiner')");
  await browser.waitFor("[...document.querySelectorAll('#examiner-candidates button')].some(item => item.textContent === 'Mezzano user guide')");
  await browser.evaluate(`(() => {
    const item = [...document.querySelectorAll('#examiner-candidates button')]
      .find(item => item.textContent === 'Mezzano user guide');
    item.dataset.outputTarget = 'guide';
  })()`);
  await browser.click('[data-output-target="guide"]');
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Mezzano user guide')");
  const docsMs = Date.now() - docsStarted;
  const docsPending = await browser.evaluate(`views.get(${q(large)}).end < views.get(${q(large)}).info['output-length']`);
  assert(docsPending, 'Documentation must render while output remains unread');
  await browser.screenshot(join(output, 'documentation-during-output.png'));
  console.log('PASS SPACE completion and documentation during pending output', {completionMs, docsMs});

  await browser.waitFor(`views.get(${q(large)})?.end === 524800`, 60);
  const complete = await browser.evaluate(`(() => {
    const view = views.get(${q(large)});
    const expected = ('🚀'.repeat(1024) + '\\n').repeat(512);
    return {end: view.end, exact: view.text === expected, status: view.status.textContent,
      small: views.get(${q(small)}).text, batches: window.outputBatches};
  })()`);
  assert(complete.exact, 'The final retained output must contain every character exactly once');
  assert(!complete.status.includes('receiving output'));
  assert.equal(complete.small, marker + '-SHORT\n');
  assert(complete.batches.every(batch => batch.characters <= 65536));
  const chunks = complete.batches.flatMap(batch => batch.jobs.filter(job => job.name === large && job.end > job.start));
  assert(chunks.length > 1);
  let end = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.start, end);
    end = chunk.end;
  }
  assert.equal(end, 524800);
  assert.deepEqual(browser.errors, []);
  await browser.evaluate(`void run(async () => {
    for (const name of ${q([large, small])}) await mutate('release-job', {job: state.jobs[name].token});
    await mutate('release-session', {});
  })`);
  await browser.waitFor('!state.session && !busy');
  await writeFile(join(output, 'result.json'), JSON.stringify({marker, names: [large, small], first,
    completionMs, docsMs, completionPending, docsPending, complete, errors: browser.errors, released: true}, null, 2));
  console.log('PASS exact 524800-character Unicode output, bounded contiguous batches, and owned cleanup');
} catch (error) {
  await writeFile(join(output, 'failure-session.json'), JSON.stringify(await browser.evaluate(`({state,
    owned: ${q([large, small])}, batches: window.outputBatches, message: document.querySelector('#message').textContent})`), null, 2));
  await browser.screenshot(join(output, 'failure.png'));
  throw error;
} finally {
  await browser.close();
}
