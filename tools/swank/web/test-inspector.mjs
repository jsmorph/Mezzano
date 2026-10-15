import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/inspector-test');
const protectedStops = (process.env.PROTECTED_STOPS ?? process.env.PROTECTED_STOP ?? '')
  .split(',').filter(Boolean).map(Number);
assert(protectedStops.every(id => Number.isSafeInteger(id) && id >= 0));
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const marker = 'INSPECTOR-' + randomBytes(6).toString('hex').toUpperCase();
const text = JSON.stringify;
const sameReference = (left, right) => text(left) === text(right);
const jobs = [];
const ownedStops = new Map();
const evidence = {marker, checks: []};
let originalStops = [];

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  const generatedText = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
  await browser.send('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode,
    modifiers, text: generatedText, unmodifiedText: generatedText});
  await browser.send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers});
}
async function fill(selector, value) {
  await browser.waitFor('connected && !busy');
  await browser.click(selector);
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text: value});
}
async function clickText(container, value) {
  const query = `[...document.querySelectorAll(${text(container + ' button')})].find(button => button.textContent.includes(${text(value)}) && !button.disabled && button.getClientRects().length)`;
  await browser.waitFor(query);
  await browser.evaluate(`${query}.dataset.focusedTest = 'target'`);
  await browser.click('[data-focused-test="target"]');
  await browser.evaluate("document.querySelector('[data-focused-test=target]')?.removeAttribute('data-focused-test')");
}
async function start(source) {
  const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
  await fill('#source', source);
  await key('Enter', 'Enter', 13);
  const query = `state.inputHistory.find(item => item.source === ${text(source)} && !${text(previous)}.includes(item.name))`;
  await browser.waitFor(query);
  const job = await browser.evaluate(query);
  jobs.push(job.name);
  return job.name;
}
async function rememberStops() {
  const current = await browser.evaluate(`stops.filter(stop => ${text(jobs)}.some(name => views.get(name)?.info.stops?.some(token => same(token, stop.token))))`);
  for (const stop of current) ownedStops.set(stop.info.id, stop.token);
}
async function stopped(name, depth = 1) {
  await browser.waitFor(`activeListenerJob === ${text(name)} && listenerDebugger?.depth === ${depth} && !busy`);
  await browser.waitFor('!stopCommandPending(listenerDebugger.stop) && !busy', 60);
  await rememberStops();
  return browser.evaluate('({stop: listenerDebugger.stop, prompt: listenerDebugger.prompt, depth: listenerDebugger.depth})');
}
async function command(value, selector = '#source') {
  await fill(selector, value);
  await key('Enter', 'Enter', 13);
  await browser.waitFor(`document.querySelector(${text(selector)}).value !== ${text(value)} && !busy`, 60);
}
async function frame(index) {
  await browser.waitFor(`returnedFrameInspection()?.result.index === ${index} && !stopCommandPending(selectedStop) && !busy`);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), index);
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame.selected")?.textContent.split("  ")[0]'), String(index));
}
async function completed(name, state = ':returned') {
  await browser.waitFor(`views.get(${text(name)})?.info.state === ${text(state)} && activeListenerJob !== ${text(name)} && !busy`, 60);
  await rememberStops();
  return browser.evaluate(`views.get(${text(name)}).info`);
}
async function switchActivity(name) {
  await browser.click('#window-label');
  await browser.click('[data-activity="' + name + '"]');
  await browser.waitFor(`activity === ${text(name)} && !busy`);
}
async function save(name) {
  await browser.screenshot(join(output, name + '.png'));
}

async function evaluation(source, expected, selector = '#source') {
  await command(source, selector);
  await browser.waitFor(`latestCommand('evaluate')?.argument === ${text(source)}
    && commandResults.get(commandKey(latestCommand('evaluate')))?.state === ':returned' && !busy`, 60);
  const result = await browser.evaluate("commandResults.get(commandKey(latestCommand('evaluate'))).result");
  if (expected !== null) assert.deepEqual(result || [], expected);
  const displayed = result?.length ? result.join('\n') : '(No values)';
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .evaluation-values')].at(-1)?.textContent"), displayed);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation .debugger-transcript')].at(-1)?.textContent"), '→ ' + source);
  return result;
}
async function selectTarget(selector = '#source') {
  const index = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(marker + '-TARGET ')}))`);
  assert(index >= 0, 'Compiled target frame was not found');
  await command(':Set Current Frame ' + index, selector);
  await frame(index);
  return index;
}

let targetJob;
const newest = 'returnedInspections().at(-1)?.result';
async function pageAfter(previous) {
  await browser.waitFor(`returnedInspections().at(-1)?.command.id > ${previous} && !stopCommandPending(selectedStop) && !busy`, 60);
  const result = await browser.evaluate(newest);
  assert.equal(await browser.evaluate('document.querySelectorAll(".inspection-pane").length'),
    Math.min(3, await browser.evaluate('returnedInspections().length')));
  return result;
}
async function inspect(source) {
  await evaluation(source, null);
  const previous = await browser.evaluate('returnedInspections().at(-1)?.command.id ?? -1');
  await command(':Inspect');
  return pageAfter(previous);
}
async function input(source) {
  await browser.waitFor(`views.get(${text(targetJob)})?.info['input-waiting-p'] && !busy`);
  await fill(`[data-job="${targetJob}"] .input-form textarea`, source);
  await clickText(`[data-job="${targetJob}"] .input-form`, 'Send Input');
}
async function modify(label, expression) {
  const previous = await browser.evaluate('returnedInspections().at(-1).command.id');
  const row = `[...document.querySelectorAll('.inspection-pane:last-child .inspection-parts tr')].find(row => row.querySelector('th').textContent === ${text(label)})`;
  await browser.evaluate(`${row}.querySelector('td:last-child button').dataset.focusedTest = 'modify'`);
  await browser.click('[data-focused-test="modify"]');
  await browser.evaluate("document.querySelector('[data-focused-test=modify]')?.removeAttribute('data-focused-test')");
  if (expression !== undefined) {
    await input(expression);
    return pageAfter(previous);
  }
  return previous;
}
async function abortChild(pattern) {
  await stopped(targetJob, 2);
  assert.deepEqual(await browser.evaluate('returnedInspections()'), []);
  const condition = await browser.evaluate("returnedResult('condition')");
  if (pattern) assert.match(condition, pattern);
  evidence.children.push(condition);
  await save('child-' + evidence.children.length);
  await command(':Abort');
  await stopped(targetJob);
}
async function replayReceipt(receipt) {
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(receipt.arguments))})).querySelector('button').dataset.focusedTest = 'replay'`);
  await browser.click('[data-focused-test="replay"]');
  await browser.waitFor(`!state.pending.some(record => record.id === ${text(receipt.id)}) && !busy`);
  await switchActivity('listener');
}
try {
  await browser.waitFor('connected && !busy');
  const captureFailures = `(() => {
    const originalFetch = window.fetch;
    window.fetch = async function(input, options) {
      const response = await originalFetch.call(this, input, options);
      if (!response.ok) {
        const responseBody = await response.clone().text();
        const failures = JSON.parse(sessionStorage.getItem('inspector-test-http-failures') || '[]');
        failures.push({request: options?.body, status: response.status, response: responseBody});
        sessionStorage.setItem('inspector-test-http-failures', JSON.stringify(failures));
      }
      return response;
    };
  })()`;
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: captureFailures});
  await browser.evaluate(captureFailures);
  evidence.session = await browser.evaluate('state.session');
  evidence.children = [];
  originalStops = await browser.evaluate('stops.map(stop => ({id: stop.info.id, state: stop.info.state, generation: stop.info.generation, next: stop.info["next-command-id"]}))');
  for (const id of protectedStops) assert(originalStops.some(stop => stop.id === id), 'Protected stop missing: ' + id);
  const setup = await start('(progn (load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DESCRIBE.LISP")) :description-fixture-loaded)');
  assert.deepEqual((await completed(setup)).values, [':DESCRIPTION-FIXTURE-LOADED']);
  await browser.evaluate('document.querySelector("#interactive").checked = true');
  const target = marker + '-TARGET', type = marker + '-OBJECT';
  targetJob = await start(`(unwind-protect (progn
    (defclass ${type} () ((empty :initform nil) (unset) (value :initform 0 :type fixnum)))
    (defun ${target} () (declare (optimize (debug 3) (safety 3) (speed 1)))
      (let ((x 40) (counter 0) (vector (make-array 70 :element-type '(unsigned-byte 8)))
            (circle (cons nil nil)) (object (make-instance '${type}))
            (probe (make-instance 'lispm-describe-test:probe :value 42))
            (adjustable (make-array 70 :adjustable t :initial-element 0)))
        (declare (type fixnum x counter))
        (dotimes (i 70) (setf (aref vector i) i))
        (setf (car circle) object (cdr circle) circle)
        (break "${marker} Inspector")
        (values (aref vector 64) counter (slot-value object 'unset)
                (slot-value probe 'lispm-describe-test::value))))
    (assert (compiled-function-p (symbol-function '${target}))) (${target}))
    (fmakunbound '${target}) (setf (find-class '${type}) nil)
    (unintern '${target}) (unintern '${type}))`);
  const parent = await stopped(targetJob);
  evidence.parent = parent;
  await selectTarget();
  evidence.localLayout = await browser.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.locals tr')];
    const labels = rows.map(row => {
      const cell = row.cells[0], range = document.createRange();
      range.selectNodeContents(cell);
      return {text:cell.textContent,width:cell.clientWidth,textWidth:range.getBoundingClientRect().width,
        lines:range.getClientRects().length};
    });
    const value = rows.find(row => row.cells[0].textContent.includes('(CIRCLE)')).cells[1];
    const range = document.createRange(); range.selectNodeContents(value);
    return {labels,valueLines:range.getClientRects().length,valueWidth:value.clientWidth,
      valueScrollWidth:value.scrollWidth,tableRight:value.closest('table').getBoundingClientRect().right,
      viewportWidth:innerWidth};
  })()`);
  assert(evidence.localLayout.labels.every(label => label.lines === 1 && label.width >= label.textWidth));
  assert(evidence.localLayout.valueLines > 1);
  assert(evidence.localLayout.valueWidth >= evidence.localLayout.valueScrollWidth);
  assert(evidence.localLayout.tableRight <= evidence.localLayout.viewportWidth);

  await evaluation('vector', null);
  await fill('#source', ':Ins');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value.startsWith(':Inspect') && !busy");
  await key('Enter', 'Enter', 13);
  let page = await pageAfter(-1);
  assert.deepEqual([page.start, page.end, page.count, page.total], [0, 32, 32, 70]);
  for (const bounds of [[32, 64], [64, 70]]) {
    const previous = await browser.evaluate('returnedInspections().at(-1).command.id');
    await clickText('.inspection-pane:last-child .inspection-toolbar', 'More Below');
    page = await pageAfter(previous);
    assert.deepEqual([page.start, page.end, page.count], [...bounds, 32]);
  }
  assert.equal(await browser.evaluate('document.querySelectorAll(".inspector-history button").length'), 3);
  assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".inspector-history button")].map(button => button.textContent.split(": ")[0])'),
    ['Components 0–31 of 70', 'Components 32–63 of 70', 'Components 64–69 of 70']);
  await browser.evaluate('document.querySelector(".inspector").scrollIntoView({block:"start"})');
  await save('three-panes');
  const beforeReload = await browser.evaluate('returnedInspections()');
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  await browser.waitFor('!document.querySelector("#stop-detail .history-progress") && !busy', 60);
  assert.deepEqual(await browser.evaluate('returnedInspections()'), beforeReload);
  evidence.checks.push('Typed completion, bounded pages, three inspection panes, history, and reload preserve retained observations');

  const previous = await modify('[64]');
  await browser.waitFor(`views.get(${text(targetJob)}).info['input-waiting-p'] && !busy`);
  const readerOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${readerOrigin} && document.readyState === 'complete' && connected && !busy`);
  await input('(+ x 2)');
  page = await pageAfter(previous);
  assert.deepEqual([page.start, page.end, page.count, page.parts[0].value], [64, 70, 32, '42']);
  await evaluation('(aref vector 64)', ['42']);
  await browser.waitFor('!document.querySelector("#stop-detail .history-progress") && !busy', 60);
  const historyPrevious = await browser.evaluate('returnedInspections().at(-1).command.id');
  await browser.click('.inspector-history button:nth-of-type(2)');
  page = await pageAfter(historyPrevious);
  assert.deepEqual([page.start, page.end, page.count], [32, 64, 32]);
  evidence.checks.push('Modify uses selected lexical bindings and retained input across reload, preserving a partial last page');

  page = await inspect('circle');
  assert.deepEqual(page.object, page.parts.find(part => part.label === 'CDR').object);
  evidence.componentLabels = await browser.evaluate(`(() => {
    return [...document.querySelectorAll('.inspection-pane:last-child th')].map(cell => {
      const range = document.createRange(); range.selectNodeContents(cell);
      return {text:cell.textContent,width:cell.clientWidth,textWidth:range.getBoundingClientRect().width,
        lines:range.getClientRects().length};
    });
  })()`);
  assert(evidence.componentLabels.every(label => label.lines === 1 && label.width >= label.textWidth));
  const objectReference = page.parts.find(part => part.label === 'CAR').object;
  const cyclePrevious = await browser.evaluate('returnedInspections().at(-1).command.id');
  await browser.click('.inspection-pane:last-child .inspection-parts tr:first-child td:nth-child(2) button');
  page = await pageAfter(cyclePrevious);
  assert.deepEqual(page.object, objectReference);
  const empty = page.parts.find(part => part.label === 'EMPTY');
  const unset = page.parts.find(part => part.label === 'UNSET');
  assert.equal(empty['bound-p'], true);
  assert.equal(empty.value, 'NIL');
  assert(empty.object);
  assert.equal(unset['bound-p'], null);
  assert.equal(unset.object, null);
  assert(unset.part);
  const displayedParts = await browser.evaluate("[...document.querySelectorAll('.inspection-pane:last-child .inspection-parts tr')].map(row => ({label:row.querySelector('th').textContent,value:row.querySelector('td').textContent,writable:Boolean(row.querySelector('td:last-child button'))}))");
  assert.deepEqual(displayedParts.find(part => part.label === 'EMPTY'), {label:'EMPTY',value:'NIL',writable:true});
  assert.deepEqual(displayedParts.find(part => part.label === 'UNSET'), {label:'UNSET',value:'<unbound>',writable:true});
  await browser.evaluate('document.querySelector(".inspection-pane:last-child").scrollIntoView({block:"center"})');
  await save('bound-and-unbound');
  page = await modify('UNSET', '99');
  assert.equal(page.parts.find(part => part.label === 'UNSET').value, '99');
  evidence.checks.push('Component navigation preserves cyclic identity and distinguishes writable unbound slots from bound NIL');

  await modify('VALUE');
  await input('"wrong"');
  await abortChild(/FIXNUM/);
  await modify('VALUE');
  await input('#.(incf counter)');
  await abortChild();
  await evaluation('counter', ['0']);
  await modify('VALUE');
  await browser.waitFor(`views.get(${text(targetJob)}).info['input-waiting-p'] && !busy`);
  await clickText(`[data-job="${targetJob}"]`, 'Interrupt');
  await abortChild();
  await modify('VALUE', '(+ x 2)');
  await evaluation("(values counter (slot-value object 'value))", ['0', '42']);
  evidence.checks.push('Type and reader errors and interrupted Modify input enter child debuggers; typed Abort permits a new modification');

  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments.command === 'modify') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted Modify reply');
      }
      return response;
    };
  })()`);
  await modify('VALUE');
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "modify" && record.status === "outcome unknown")');
  const modifyReceipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "modify" && record.status === "outcome unknown")');
  await replayReceipt(modifyReceipt);
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'job-input') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted Inspector input reply');
      }
      return response;
    };
  })()`);
  await input('(progn (incf counter) (+ x 3))');
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.operation === "job-input" && record.status === "outcome unknown")');
  const inputReceipt = await browser.evaluate('state.pending.find(record => record.operation === "job-input" && record.status === "outcome unknown")');
  await replayReceipt(inputReceipt);
  await pageAfter(modifyReceipt.arguments.id - 1);
  await evaluation("(values counter (slot-value object 'value))", ['1', '43']);
  evidence.replay = {modifyReceipt, inputReceipt};
  evidence.checks.push('Lost Modify and input replies recover through original request identities with one replacement evaluation');

  page = await inspect('probe');
  await modify(page.parts.find(part => part.label.endsWith('VALUE')).label);
  await input(`(progn (incf counter) (make-instance 'lispm-describe-test:probe :failure (make-condition 'simple-error :format-control "${marker} stored printer failure")))`);
  await abortChild(new RegExp(marker + ' stored printer failure'));
  const failedModify = await browser.evaluate("latestCommand('modify')");
  await browser.evaluate(`api('submit', {stop:${text(failedModify.stop)},id:${failedModify.id},command:'modify',argument:${text(failedModify.argument)}})`);
  await evaluation("(values counter (typep (slot-value probe 'lispm-describe-test::value) 'lispm-describe-test:probe))", ['2', 'T']);
  await evaluation("(progn (setf (slot-value probe 'lispm-describe-test::value) 42) nil)", ['NIL']);
  const refreshPrevious = await browser.evaluate('returnedInspections().at(-1).command.id');
  await clickText('.inspection-pane:last-child .inspection-toolbar', 'Refresh');
  page = await pageAfter(refreshPrevious);
  assert.equal(page.parts.find(part => part.label.endsWith('VALUE')).value, '42');
  await clickText('.inspection-pane:last-child .inspection-toolbar', 'Describe');
  await browser.waitFor("latestCommand('describe-object') && commandResults.get(commandKey(latestCommand('describe-object')))?.state === ':returned' && !busy");
  assert.match(await browser.evaluate("document.querySelector('.description-result').textContent"), /VALUE <- 42/);
  await evaluation('probe', null);
  await command(':Describe Last');
  await browser.waitFor("latestCommand('describe-object')?.source === ':Describe Last' && commandResults.get(commandKey(latestCommand('describe-object')))?.state === ':returned' && !busy");
  assert.match(await browser.evaluate("commandResults.get(commandKey(latestCommand('describe-object'))).result"), /VALUE <- 42/);
  evidence.checks.push('A completed store survives printer failure and same-ID replay; explicit Refresh and Describe recover');

  page = await inspect('adjustable');
  for (let i = 0; i < 2; i++) {
    const previous = await browser.evaluate('returnedInspections().at(-1).command.id');
    await clickText('.inspection-pane:last-child .inspection-toolbar', 'More Below');
    page = await pageAfter(previous);
  }
  await evaluation('(progn (adjust-array adjustable 2) nil)', ['NIL']);
  const shrinkPrevious = await browser.evaluate('returnedInspections().at(-1).command.id');
  await clickText('.inspection-pane:last-child .inspection-toolbar', 'Refresh');
  page = await pageAfter(shrinkPrevious);
  assert.deepEqual([page.start, page.end, page.count, page.total, page.parts], [2, 2, 32, 2, null]);
  const backward = await browser.evaluate('returnedInspections().at(-1).command.id');
  await clickText('.inspection-pane:last-child .inspection-toolbar', 'More Above');
  page = await pageAfter(backward);
  assert.deepEqual([page.start, page.end, page.total], [0, 2, 2]);
  evidence.checks.push('Refresh clamps a page after array shrink while preserving page size and backward navigation');

  const oldObject = page.object;
  await command(':Clear Inspector');
  await browser.waitFor('returnedInspections().length === 0 && !stopCommandPending(selectedStop) && !busy');
  assert.equal(await browser.evaluate('document.querySelectorAll(".inspection-pane").length'), 0);
  assert.equal(await browser.evaluate('document.querySelectorAll(".inspector-history button").length'), 0);
  const boundary = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]');
  const rejected = await browser.evaluate(`api('submit', {stop:selectedStop,id:${boundary},command:'inspect',argument:[${text(oldObject)},0,32]}).then(() => null,error => ({reason:error.reason,uncertain:error.uncertain}))`);
  evidence.stale = rejected;
  assert.deepEqual(rejected, {reason: ':released-inspection-reference', uncertain: false});
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  assert.equal(await browser.evaluate('connected'), true);
  assert.equal((await browser.evaluate('api("information", {stop:selectedStop})'))['next-command-id'], boundary);
  page = await inspect('adjustable');
  assert(!sameReference(page.object, oldObject));
  const retained = await browser.evaluate('returnedInspections()');
  await clickText(`[data-job="${targetJob}"]`, 'Debugger');
  await browser.waitFor('activity === "debugger" && !busy');
  await command(':Proceed', '#debugger-command');
  assert.deepEqual((await completed(targetJob)).values, ['42', '2', '99', '42']);
  assert.deepEqual(await browser.evaluate('returnedInspections()'), retained);
  assert.equal(await browser.evaluate('document.querySelectorAll(".inspector button:not(:disabled)").length'), 0);
  assert(await browser.evaluate('[...document.querySelectorAll(".inspection-parts td:nth-child(2) button, .inspector-history button")].every(button => getComputedStyle(button).textDecorationLine === "none")'));
  assert.match(await browser.evaluate('document.querySelector(".inspector > h3").textContent'), /recorded objects from this closed stop/);
  await browser.evaluate('document.querySelector(".inspector").scrollIntoView({block:"start"})');
  await save('closed-inspector');
  await switchActivity('requests');
  await browser.waitFor('state.commands.every(command => commandResults.has(commandKey(command))) && !busy');
  const requestHistory = await browser.evaluate(`({commands:state.commands,
    rows:[...document.querySelectorAll('#pending .command-row')].map(row => row.textContent),
    counters:stops.filter(stop => state.commands.some(command => same(command.stop,stop.token)))
      .map(stop => [stop.info.id,stop.info['next-command-id']])})`);
  const historyOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${historyOrigin} && document.readyState === 'complete' && connected && !busy`);
  assert.equal(await browser.evaluate('selectedStop'), null);
  await switchActivity('requests');
  await browser.waitFor('state.commands.every(command => commandResults.has(commandKey(command))) && !busy', 60);
  const recoveredHistory = await browser.evaluate(`({commands:state.commands,
    rows:[...document.querySelectorAll('#pending .command-row')].map(row => row.textContent),
    counters:stops.filter(stop => state.commands.some(command => same(command.stop,stop.token)))
      .map(stop => [stop.info.id,stop.info['next-command-id']])})`);
  assert.equal(await browser.evaluate('selectedStop'), null);
  assert.deepEqual(recoveredHistory, requestHistory);
  evidence.unselectedHistory = recoveredHistory;
  await save('unselected-request-history');
  evidence.checks.push('Reload with no selected stop recovers every known Request History result without changing visible rows, command identities, or guest command counters');
  await switchActivity('listener');
  const next = await start(`(progn (assert (null (find-symbol "${target}" "CL-USER"))) (assert (null (find-symbol "${type}" "CL-USER"))) (+ 20 22))`);
  assert.deepEqual((await completed(next)).values, ['42']);
  evidence.checks.push('Clear invalidates old references without consuming a command ID; fresh inspection, closed recorded panes, Proceed, and the next Listener succeed');
} catch (error) {
  evidence.failure = error.stack;
  await save('failure');
  await writeFile(join(output, 'failure-state.json'), await browser.evaluate('JSON.stringify(sessionStorage)'));
  await writeFile(join(output, 'failure.txt'), await browser.evaluate('document.body.innerText'));
  throw error;
} finally {
  try {
    await rememberStops();
    await browser.evaluate('connected = false; activity = "requests"');
    for (const name of jobs) {
      let info;
      for (let attempt = 0; attempt < 40; attempt++) {
        const token = await browser.evaluate(`state.jobs[${text(name)}]?.token`);
        if (!token) break;
        info = await browser.evaluate(`api('job-information', {job: ${text(token)}})`);
        if (info.state === ':running' && !info.stops?.length && info['interruptible-p']) {
          await browser.evaluate(`api('interrupt-job', {job: ${text(token)}, id: ${info['next-interrupt-id']}})`);
        }
        for (const stop of info.stops || []) {
          const detail = await browser.evaluate(`api('information', {stop: ${text(stop)}})`);
          ownedStops.set(detail.id, stop);
          if (!detail.child && detail.state === ':stopped') {
            const command = detail['next-command-id'] > 0 && await browser.evaluate(`api('result', {stop: ${text(stop)}, id: ${detail['next-command-id'] - 1}})`);
            if ([':pending', ':running'].includes(command?.state)) {
              if (info['interruptible-p']) await browser.evaluate(`api('interrupt-job', {job: ${text(token)}, id: ${info['next-interrupt-id']}})`);
            } else {
              await browser.evaluate(`api('submit', {stop: ${text(stop)}, id: ${detail['next-command-id']}, command: 'abort', argument: null})`);
            }
          }
        }
        if (info.state !== ':running') {
          await browser.evaluate(`api('release-job', {job: ${text(token)}})`);
          break;
        }
        await delay(100);
      }
      assert(!info || info.state !== ':running', 'Owned job did not finish cleanup: ' + name);
    }
    for (const token of ownedStops.values()) {
      await browser.evaluate(`api('release-stop', {stop: ${text(token)}})`);
    }
    const remaining = await browser.evaluate("api('stops', {include_closed: true})");
    const original = [];
    for (const token of remaining ?? []) {
      const detail = await browser.evaluate(`api('information', {stop: ${text(token)}})`);
      if (originalStops.some(stop => stop.id === detail.id)) original.push({id: detail.id, state: detail.state, generation: detail.generation, next: detail['next-command-id']});
    }
    await browser.evaluate("api('release-session')");
    evidence.cleanup = 'Owned jobs/stops/session released';
    for (const id of protectedStops) {
      assert.deepEqual(original.find(stop => stop.id === id), originalStops.find(stop => stop.id === id));
    }
    evidence.protectedStops = original.filter(stop => protectedStops.includes(stop.id));
    if (protectedStops.length === 1) evidence.protectedStop = evidence.protectedStops[0];
    assert.equal(browser.errors.length, evidence.stale ? 1 : 0);
    for (const error of browser.errors) assert.match(error.text, /409/);
  } catch (cleanupError) {
    evidence.cleanupFailure = cleanupError.stack;
    throw cleanupError;
  } finally {
    evidence.jobs = jobs;
    evidence.stops = [...ownedStops.entries()];
    evidence.errors = browser.errors;
    evidence.httpFailures = await browser.evaluate("JSON.parse(sessionStorage.getItem('inspector-test-http-failures') || '[]')");
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
