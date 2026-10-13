import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://localhost:8765/';
const output = resolve(process.argv[3] ?? 'browser-https-results');
const cases = [
  {
    name: 'complete',
    source: '(complete "Reply with exactly: Browser completion works.")',
    check(values) {
      assert.equal(values.length, 1);
      assert(values[0].includes('Browser completion works.'));
    },
  },
  {
    name: 'curl-text',
    source: '(curl "https://example.org/")',
    check(values) {
      assert.equal(values.length, 3);
      assert(values[0].includes('Example Domain'));
      assert.equal(values[1], '200');
      assert.match(values[2], /:content-type\b/i);
    },
  },
  {
    name: 'curl-http-error',
    source: '(curl "https://api.openai.com/v1/models")',
    check(values) {
      assert.equal(values.length, 3);
      assert.match(values[0], /^#\(/);
      assert.equal(values[1], '401');
      assert.match(values[2], /application\/json/i);
    },
  },
];
await mkdir(output, { recursive: true });
const browser = await openBrowser(url);
const owned = [];
let session;
try {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  session = await browser.evaluate('state.session');
  for (const test of cases) {
    await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
    const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
    const started = Date.now();
    await browser.click('#source');
    await browser.send('Input.insertText', { text: test.source });
    for (const type of ['keyDown', 'keyUp'])
      await browser.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await browser.waitFor(`state.inputHistory.some(item => !${JSON.stringify(previous)}.includes(item.name))`);
    const name = await browser.evaluate(`state.inputHistory.find(item => !${JSON.stringify(previous)}.includes(item.name)).name`);
    owned.push(name);
    await writeFile(join(output, 'owned-fixtures.json'), JSON.stringify({session, jobs: owned}, null, 2));
    const view = `views.get(${JSON.stringify(name)})`;
    await browser.waitFor(`${view}?.info && (${view}.info.state !== ':running' || ${view}.info.stops?.length)`, 120);
    const result = await browser.evaluate(`({
      name: ${JSON.stringify(name)},
      info: ${view}.info,
      displayed: ${view}.values.textContent,
      visible: !${view}.element.hidden && ${view}.values.getBoundingClientRect().height > 0
    })`);
    result.elapsedMilliseconds = Date.now() - started;
    await writeFile(join(output, test.name + '.json'), JSON.stringify(result, null, 2));
    await browser.screenshot(join(output, test.name + '.png'));
    assert.equal(result.info.state, ':returned');
    assert.equal((result.info.stops ?? []).length, 0);
    test.check(result.info.values);
    assert.equal(result.displayed, result.info.values.join('\n'));
    assert.equal(result.visible, true);
    assert.deepEqual(browser.errors, []);
    console.log(`PASS browser ${test.name} in ${result.elapsedMilliseconds} ms`);
  }
  assert.equal(await browser.evaluate('state.session'), session);
  await browser.evaluate(`(async () => {
    for (const name of ${JSON.stringify(owned)}) {
      const job = state.jobs[name];
      if (!job?.token) throw new Error('Owned HTTPS job token is missing: ' + name);
      await mutate('release-job', {job: job.token});
    }
    await mutate('release-session', {});
  })()`);
  assert.equal(await browser.evaluate('connected'), false);
  for (const name of owned) assert.equal(await browser.evaluate(`Boolean(state.jobs[${JSON.stringify(name)}])`), false);
  assert.deepEqual(browser.errors, []);
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({session, releasedJobs: owned, sessionReleased: true}, null, 2));
  console.log('PASS owned HTTPS evaluations and session released');
} catch (error) {
  await writeFile(join(output, 'failure-fixtures.json'), JSON.stringify({session, jobs: owned,
    state: await browser.evaluate('state'), error: error.stack, browserErrors: browser.errors}, null, 2));
  await browser.screenshot(join(output, 'failure.png'));
  throw error;
} finally {
  await browser.close();
}
