import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://localhost:8765/';
const output = resolve(process.argv[3] ?? 'browser-complete-results');
await mkdir(output, { recursive: true });
const browser = await openBrowser(url);
try {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
  const started = Date.now();
  await browser.click('#source');
  await browser.send('Input.insertText', { text: '(complete "Reply with exactly: Browser completion works.")' });
  for (const type of ['keyDown', 'keyUp'])
    await browser.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.waitFor(`state.inputHistory.some(item => !${JSON.stringify(previous)}.includes(item.name))`);
  const name = await browser.evaluate(`state.inputHistory.find(item => !${JSON.stringify(previous)}.includes(item.name)).name`);
  const view = `views.get(${JSON.stringify(name)})`;
  await browser.waitFor(`${view}?.info && (${view}.info.state !== ':running' || ${view}.info.stops?.length)`, 120);
  const result = await browser.evaluate(`({name:${JSON.stringify(name)}, info:${view}.info, text:${view}.element.textContent})`);
  result.elapsedMilliseconds = Date.now() - started;
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  await browser.screenshot(join(output, 'result.png'));
  assert.equal(result.info.state, ':returned');
  assert.equal((result.info.stops ?? []).length, 0);
  assert(result.info.values.some(value => value.includes('Browser completion works.')));
  assert(result.text.includes('Browser completion works.'));
  assert.deepEqual(browser.errors, []);
  console.log(`PASS browser COMPLETE expression in ${result.elapsedMilliseconds} ms`);
} finally {
  await browser.close();
}
