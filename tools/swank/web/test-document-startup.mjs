import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'document-startup-results');
await mkdir(output, {recursive:true});
const browser = await openBrowser('about:blank');
const report = {passes:[]};
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`
    window.monitorTrace = [];
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (!request) return originalFetch(...args);
      const record = {operation:request.operation, arguments:request.arguments, start:performance.now()};
      window.monitorTrace.push(record);
      try {
        const response = await originalFetch(...args);
        record.status = response.status;
        const data = await response.clone().json();
        if (request.operation === 'monitor-state') {
          record.jobs = data.value?.jobs?.length || 0;
          record.stops = data.value?.stops?.length || 0;
        }
        return response;
      } finally { record.end = performance.now(); }
    };
  `});
  let bookmarks;
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await browser.send('Page.reload');
    else await browser.send('Page.navigate', {url});
    await browser.waitFor("typeof examiner !== 'undefined'");
    await browser.evaluate('document.fonts.ready.then(()=>true)');
    await browser.click('#window-label');
    await browser.waitFor("document.querySelector('#system-menu').open");
    await browser.click('[data-activity="examiner"]');
    const selected = await browser.evaluate('performance.now()');
    await browser.waitFor("document.querySelector('#examiner-candidates [data-topic=\"doc/project-guide.md\"]')");
    const catalog = await browser.evaluate('performance.now()');
    if (!pass) await browser.click('#examiner-candidates [data-topic="doc/project-guide.md"]');
    await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Getting started')");
    const displayed = await browser.evaluate('performance.now()');
    const trace = await browser.evaluate('window.monitorTrace');
    const monitor = trace.find(record => record.operation === 'monitor-state');
    assert(monitor?.status === 200, 'Startup did not obtain a batched monitor response');
    assert(!trace.some(record => ['jobs','job-information','job-output','stops','information'].includes(record.operation)),
      'Startup performed per-object monitor requests');
    const current = await browser.evaluate('state.examiner.viewers.find(viewer=>viewer.name===state.examiner.current)');
    if (pass) assert.deepEqual(current.bookmarks, bookmarks);
    else bookmarks = current.bookmarks;
    await browser.screenshot(join(output, pass ? 'retained-viewer.png' : 'first-document.png'));
    report.passes.push({pass, selected, catalog, displayed, catalogDelay:catalog-selected,
      documentDelay:displayed-selected, jobs:monitor.jobs, stops:monitor.stops, trace});
    console.log(JSON.stringify(report.passes.at(-1)));
  }
  assert.deepEqual(browser.errors, []);
  await browser.evaluate('run(async()=>{await api("release-session");connected=false})');
  report.sessionReleased = true;
  report.errors = browser.errors;
  console.log('PASS batched startup, first documentation content, retained viewer reload, and owned-session cleanup');
} catch (error) {
  report.failure = error.stack;
  report.state = await browser.evaluate('state');
  await browser.screenshot(join(output, 'failure.png'));
  throw error;
} finally {
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
