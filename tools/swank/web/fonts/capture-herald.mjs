import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {openBrowser} from '../browser-test-support.mjs';

const [url, directory] = process.argv.slice(2);
if (!url || !directory) throw new Error('Usage: node fonts/capture-herald.mjs URL OUTPUT-DIRECTORY');
const output = resolve(directory);
await mkdir(output, {recursive: true});
const reference = JSON.parse(await readFile(new URL('herald-reference.json', import.meta.url), 'utf8'));
const browser = await openBrowser('about:blank');
try {
  await browser.send('Emulation.setDeviceMetricsOverride', {width: 1024, height: 768, deviceScaleFactor: 1, mobile: false});
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.fixtureRequests = [];
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = new URL(input, location.href);
      if (url.pathname !== '/api') return originalFetch.call(this, input, init);
      const request = JSON.parse(init.body);
      window.fixtureRequests.push(request.operation);
      let value;
      if (['open-session', 'resume-session'].includes(request.operation)) value = {};
      else if (request.operation === 'listener-information') {
        value = {package: 'CL-USER', prompt: 'Command: ', herald: ${JSON.stringify(reference.herald)}};
      } else if (['jobs', 'stops'].includes(request.operation)) value = [];
      else throw new Error('Unexpected fixture API request: ' + request.operation);
      return new Response(JSON.stringify({value, diagnostics: []}), {headers: {'Content-Type': 'application/json'}});
    };`});
  const navigation = await browser.send('Page.navigate', {url});
  if (navigation.errorText) throw new Error(navigation.errorText);
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy && document.querySelector('#herald .herald')");
  await browser.evaluate('document.fonts.ready');
  await browser.evaluate('placeHeraldOnPixels()');
  await browser.waitFor("document.querySelector('#clock').textContent.length > 0");
  await browser.screenshot(join(output, 'reference-content.png'));
  const geometry = await browser.evaluate(`
    [...document.querySelectorAll('#herald .herald, #herald .herald-title, #herald .herald-facts p, #herald .herald-systems, #herald .herald-systems td, #herald .herald-help, #herald .herald-help p, #herald .herald-key')]
      .map(element => ({class: element.className, rect: element.getBoundingClientRect().toJSON(), text: element.textContent}))`);
  const rows = await browser.evaluate("[...document.querySelectorAll('#herald .herald-systems tr')].map(row => row.getBoundingClientRect().toJSON())");
  assert(rows.every(row => Number.isInteger(row.y) && Number.isInteger(row.height)), 'Fractional system-table rows');
  const assets = {};
  for (const path of ['app.js', 'style.css', 'fonts/eurex24i.ttf', 'fonts/hl12.ttf', 'fonts/hl12bi.ttf', 'fonts/hl12i.ttf', 'fonts/hl8.ttf', 'fonts/5x5.ttf']) {
    const response = await fetch(new URL(path, url));
    if (!response.ok) throw new Error('Cannot read tested asset: ' + path);
    assets[path] = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  }
  const result = {reference: reference.source_url, reference_sha256: reference.source_sha256,
    chromium: await browser.send('Browser.getVersion'), viewport: [1024, 768], device_scale_factor: 1,
    source: url, assets, requests: await browser.evaluate('fixtureRequests'), errors: browser.errors,
    limitations: [
      'The original registered and trademark characters use fallback fonts because the recovered Unicode mapping lacks them.',
      'The Mezzano help separates its introductory line from command help. The original groups its first three lines.',
      'The fixture measures the shared herald renderer with historical content. Product content comes from the Lisp guest.',
      'The comparison covers selected herald rectangles. Macintosh chrome, scrollbars, copyright text, and the full window differ.'
    ]};
  await writeFile(join(output, 'geometry.json'), JSON.stringify(geometry, null, 2) + '\n');
  await writeFile(join(output, 'capture.json'), JSON.stringify(result, null, 2) + '\n');
  assert.deepEqual(browser.errors, []);
  console.log('Saved herald fixture to ' + output);
} finally {
  await browser.close();
}
