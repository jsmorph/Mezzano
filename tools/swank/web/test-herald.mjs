import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'herald-test-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const owned = [];
const quote = JSON.stringify;
const screenshot = name => browser.screenshot(join(output, name + '.png'));
const ready = () => browser.waitFor("typeof connected !== 'undefined' && connected && !busy && document.querySelector('#herald .herald')");

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode, modifiers});
  }
}
async function enter(source, loseReply = false) {
  await ready();
  await browser.evaluate("showActivity('listener')");
  const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
  await browser.click('#source');
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text: source});
  if (loseReply) await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'start-listener' && request.arguments.source === ${quote(source)}) {
        window.fetch = original;
        if (!response.ok) return response;
        window.discardedReply = await response.json();
        throw new TypeError('Herald test discarded a successful reply after dispatch');
      }
      return response;
    };
  })()`);
  await key('Enter', 'Enter', 13);
  let name;
  if (loseReply) {
    await browser.waitFor(`state.pending.some(item => item.arguments?.source === ${quote(source)} && item.status === 'outcome unknown')`);
    const record = await browser.evaluate(`state.pending.find(item => item.arguments?.source === ${quote(source)})`);
    name = record.arguments.name;
    owned.push(name);
    const accepted = await browser.evaluate('window.discardedReply.value');
    await writeFile(join(output, 'lost-' + name.slice(0, 12) + '.json'), JSON.stringify({record, accepted}, null, 2));
    await browser.send('Page.reload', {ignoreCache: true});
    await ready();
    assert.equal(await browser.evaluate('state.session'), record.session);
    await browser.evaluate("showActivity('requests'); renderPending()");
    await browser.waitFor("[...document.querySelectorAll('#pending button')].some(button => button.textContent === 'Repeat Original Request')");
    await browser.evaluate(`(() => {
      const record = state.pending.find(item => item.id === ${quote(record.id)});
      if (!record) throw new Error('Original request identity disappeared');
      const row = [...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${quote(source)}));
      const button = [...row.querySelectorAll('button')].find(button => button.textContent === 'Repeat Original Request');
      button.click();
    })()`);
    await browser.waitFor(`!busy && !state.pending.some(item => item.id === ${quote(record.id)}) && state.jobs[${quote(name)}]?.token`);
    assert.deepEqual(await browser.evaluate(`state.jobs[${quote(name)}].token`), accepted);
    await browser.evaluate("showActivity('listener')");
  } else {
    const expression = `state.inputHistory.find(item => item.source === ${quote(source)} && !${quote(previous)}.includes(item.name))`;
    await browser.waitFor(expression);
    name = (await browser.evaluate(expression)).name;
    owned.push(name);
  }
  await browser.waitFor(`!busy && views.get(${quote(name)})?.info.state === ':returned'`);
  await writeFile(join(output, 'owned-jobs.json'), JSON.stringify(owned, null, 2));
  return name;
}
async function herald(name) {
  return browser.evaluate(`(() => {
    const view = views.get(${quote(name)});
    const result = view.info['listener-result'];
    return {result, text: view.text, count: view.output.querySelectorAll('.herald').length,
      tables: view.output.querySelectorAll('.herald-systems table').length,
      rows: [...view.output.querySelectorAll('.herald-systems tr')].map(row => [...row.cells].map(cell => cell.textContent))};
  })()`);
}

try {
  await browser.send('Emulation.setDeviceMetricsOverride', {width: 1024, height: 768, deviceScaleFactor: 1, mobile: false});
  await ready();
  const initial = await browser.evaluate('({session: state.session, jobs: Object.keys(state.jobs)})');
  const payload = await browser.evaluate("api('listener-information').then(value => value.herald)");
  assert.equal(payload['detailed-p'], true);
  const rows = await browser.evaluate("[...document.querySelectorAll('#herald .herald-systems tr')].map(row => [...row.cells].map(cell => cell.textContent))");
  assert.deepEqual(rows, (payload.systems || []).map(system => [system.name, system.version ?? '-']));
  const versionRows = await browser.evaluate("[...document.querySelectorAll('#herald .herald-systems tr')].filter(row => row.cells[1].textContent === '3.3.3.3').map(row => ({name: row.cells[0].textContent, height: row.getBoundingClientRect().height}))");
  assert(versionRows.length > 0, 'Expected loaded ASDF version 3.3.3.3');
  assert(versionRows.every(row => row.height === 13), 'Version 3.3.3.3 must fit one line at 1024 pixels');
  await writeFile(join(output, 'version-rows.json'), JSON.stringify(versionRows, null, 2));
  assert.equal(await browser.evaluate("document.querySelector('#herald').hidden"), false);
  await screenshot('startup');
  await browser.send('Page.reload', {ignoreCache: true});
  await ready();
  assert.equal(await browser.evaluate('state.session'), initial.session);
  assert.equal(await browser.evaluate("document.querySelectorAll('#herald .herald').length"), 1);
  const reloadedJobs = await browser.evaluate('Object.keys(state.jobs)');
  for (const name of initial.jobs) assert(reloadedJobs.includes(name));
  console.log('PASS startup systems, retained jobs, and reload');

  const rendering = await browser.evaluate(`(() => {
    const output = document.createElement('div');
    const prefix = '🚀 before ';
    const replacement = 'plain herald output';
    const suffix = ' after 🚀';
    const payload = {title: '<img src=x onerror=alert(1)>', facts: [[{kind: ':text', text: '<b>fact</b>'}]],
      help: [[{kind: ':key', text: 'HELP'}]], 'detailed-p': true,
      systems: [{name: '<script>bad</script>', version: null}]};
    const view = {output, text: prefix + replacement + suffix};
    const presentation = {type: ':herald', start: Array.from(prefix).length,
      end: Array.from(prefix + replacement).length, herald: payload};
    renderOutput(view, [presentation]);
    const before = output.firstChild.textContent;
    const after = output.lastChild.textContent;
    let unknown = false;
    try { renderOutput(view, [{...presentation, type: ':unknown'}]); }
    catch (error) { unknown = error.message.includes('Unknown Listener presentation'); }
    return {before, after, title: output.querySelector('h1').textContent,
      text: output.textContent, unsafe: Boolean(output.querySelector('img, script, b')), unknown};
  })()`);
  assert.equal(rendering.before, '🚀 before ');
  assert.equal(rendering.after, ' after 🚀');
  assert.equal(rendering.title, '<img src=x onerror=alert(1)>');
  assert.equal(rendering.unsafe, false);
  assert.equal(rendering.unknown, true);
  console.log('PASS Unicode presentation range, surrounding text, and untrusted text fixture');

  const plain = await enter('Show Herald');
  const plainResult = await herald(plain);
  assert.equal(plainResult.count, 1);
  assert.equal(plainResult.tables, 0);
  assert.equal(plainResult.result.presentations[0].herald['detailed-p'], null);
  await browser.evaluate(`views.get(${quote(plain)}).output.scrollIntoView({block:'start'})`);
  await screenshot('plain');
  const textOnly = await enter('(write-line "Show Herald 🚀")');
  assert.equal((await herald(textOnly)).count, 0);
  assert.equal((await herald(textOnly)).text, 'Show Herald 🚀\n');
  console.log('PASS plain command and ordinary Lisp output');

  const detailed = await enter('Show Herald :Detailed', true);
  const detailedResult = await herald(detailed);
  assert.equal(detailedResult.count, 1);
  assert.equal(detailedResult.tables, 2);
  const retainedPayload = detailedResult.result.presentations[0].herald;
  assert.equal(retainedPayload['detailed-p'], true);
  assert.deepEqual(detailedResult.rows, retainedPayload.systems.map(system => [system.name, system.version ?? '-']));
  await browser.send('Page.reload', {ignoreCache: true});
  await ready();
  await browser.waitFor(`!busy && views.get(${quote(detailed)})?.info.state === ':returned'`);
  assert.deepEqual((await herald(detailed)).result, detailedResult.result);
  assert.equal((await herald(detailed)).count, 1);
  await browser.evaluate(`views.get(${quote(detailed)}).output.scrollIntoView({block:'start'})`);
  await screenshot('detailed');
  console.log('PASS detailed command, discarded reply, same-token replay, and retained presentation reload');

  await browser.evaluate("showActivity('help')");
  await browser.send('Emulation.setDeviceMetricsOverride', {width: 640, height: 768, deviceScaleFactor: 1, mobile: false});
  await browser.evaluate("showActivity('listener'); document.querySelector('#page').scrollTop = 0");
  await browser.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
  const narrow = await browser.evaluate(`({overflow: document.documentElement.scrollWidth > innerWidth,
    columns: [...document.querySelectorAll('.herald-systems')].map(element => ({width: element.clientWidth,
      first: element.firstElementChild.getBoundingClientRect().width, right: element.getBoundingClientRect().right})),
    paths: [...document.querySelectorAll('.herald-key path')].map(element => element.getAttribute('d'))})`);
  assert.equal(narrow.overflow, false);
  assert(narrow.columns.every(column => column.first > 0 && column.right <= 640));
  assert(narrow.paths.every(path => path && !path.includes('H-')));
  await screenshot('narrow');
  console.log('PASS hidden-activity resize and 640-pixel layout');

  await enter('Clear Output History', true);
  await browser.waitFor("document.querySelector('#herald').hidden && state.initialHerald.hidden");
  for (const name of [plain, textOnly, detailed]) assert.equal(await browser.evaluate(`state.jobs[${quote(name)}].hidden`), true);
  const retainedAfterClear = await browser.evaluate('Object.keys(state.jobs)');
  for (const name of [...initial.jobs, ...owned]) assert(retainedAfterClear.includes(name));
  await browser.send('Page.reload', {ignoreCache: true});
  await ready();
  assert.equal(await browser.evaluate("document.querySelector('#herald').hidden"), true);
  assert.equal(await browser.evaluate('state.initialHerald.hidden'), true);
  assert.equal(await browser.evaluate('state.pending.length'), 0);
  await screenshot('clear-after-reload');
  console.log('PASS Clear Output History discarded reply, replay, retained jobs, and reload');

  await browser.evaluate(`run(async () => {
    for (const name of ${quote(owned)}) await mutate('release-job', {job: state.jobs[name].token});
    await refresh();
  })`);
  assert.equal(await browser.evaluate('state.pending.length'), 0);
  const finalJobs = await browser.evaluate('Object.keys(state.jobs)');
  for (const name of initial.jobs) assert(finalJobs.includes(name));
  for (const name of owned) assert(!finalJobs.includes(name));
  await browser.evaluate("run(() => mutate('release-session', {}))");
  assert.equal(await browser.evaluate('connected'), false);
  assert.deepEqual(browser.errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({initialJobs: initial.jobs, releasedJobs: owned,
    sessionReleased: true, errors: browser.errors, narrow}, null, 2));
  console.log('PASS owned jobs/session released, unrelated jobs retained, zero browser errors');
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({error: error.stack, owned,
    state: await browser.evaluate('state'), errors: browser.errors}, null, 2));
  await screenshot('failure');
  throw error;
} finally {
  await browser.close();
}
