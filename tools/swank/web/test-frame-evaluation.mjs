import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/frame-evaluation-test');
const protectedStop = process.env.PROTECTED_STOP === undefined ? null : Number(process.env.PROTECTED_STOP);
assert(protectedStop === null || Number.isSafeInteger(protectedStop));
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const marker = 'FRAME-EVAL-' + randomBytes(6).toString('hex').toUpperCase();
const text = JSON.stringify;
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
  assert.deepEqual(result || [], expected);
  const displayed = expected.length ? expected.join('\n') : '(No values)';
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
async function rejected(source, pattern, history = false) {
  const parent = await browser.evaluate('selectedStop');
  await command(source);
  await stopped(targetJob, 2);
  const condition = await browser.evaluate("returnedResult('condition')");
  assert(condition && condition.length);
  if (pattern) assert.match(condition, pattern);
  evidence.rejections.push({source, condition});
  if (history) {
    await selectTarget();
    await evaluation('(values * /)', ['NIL', 'NIL']);
    evidence.checks.push('Child evaluation starts with separate value history');
  }
  await save('rejected-' + evidence.rejections.length);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(parent)}) && !busy`);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('evaluate'))).state"), ':unwound');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .evaluation-values')].at(-1)?.textContent"), 'unwound');
}

let targetJob;
try {
  await browser.waitFor('connected && !busy');
  evidence.session = await browser.evaluate('state.session');
  evidence.rejections = [];
  originalStops = await browser.evaluate('stops.map(stop => ({id: stop.info.id, state: stop.info.state, next: stop.info["next-command-id"]}))');
  if (protectedStop !== null) assert(originalStops.some(stop => stop.id === protectedStop));
  const setup = await start('(progn (load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DESCRIBE.LISP")) :description-fixture-loaded)');
  assert.deepEqual((await completed(setup)).values, [':DESCRIPTION-FIXTURE-LOADED']);
  await browser.evaluate('document.querySelector("#interactive").checked = true');
  const target = marker + '-TARGET';
  targetJob = await start(`(unwind-protect (progn (defun ${target} () (declare (optimize (debug 3) (safety 3) (speed 1))) (let ((x 37)) (declare (type fixnum x)) (let ((outer (lambda () x))) (let ((x 38)) (declare (type fixnum x)) (flet ((x () x) (bump () (incf x))) (symbol-macrolet ((alias x)) (macrolet ((twice (value) (list '+ value value))) (break "${marker} lexical evaluation") (values x (x) alias (funcall outer))))))))) (assert (compiled-function-p (symbol-function '${target}))) (${target})) (when (fboundp '${target}) (fmakunbound '${target})) (unintern '${target}))`);
  const parent = await stopped(targetJob);
  evidence.parent = parent;
  evidence.frame = await selectTarget();
  await evaluation('(values x (x) alias (twice 21) (funcall outer))', ['38', '38', '38', '42', '37']);
  await evaluation('(setq alias 40)', ['40']);
  await evaluation('(bump)', ['41']);
  await command(':Show Frame');
  const locals = await browser.evaluate('returnedFrameInspection().result.locals');
  assert(locals.some(local => local.name === 'X' && local.value === '41' && local['available-p']));
  evidence.locals = locals;
  await save('lexical-values-and-write');
  evidence.checks.push('Selected compiled frame reads shadowed variables, same-name function, symbol macro, local macro, and captured outer binding; writes update the shared inner cell');

  await evaluation('(values 10 20)', ['10', '20']);
  await evaluation('(values * / + -)', ['10', '(10 20)', '(VALUES 10 20)', '(VALUES * / + -)']);
  await evaluation('(values)', []);
  await evaluation('(values * /)', ['NIL', 'NIL']);
  const beforeReload = await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)");
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)"), beforeReload);
  evidence.checks.push('Multiple and zero values, per-stop history, and ordered retained form results survive browser reload');

  await rejected('(setq x "wrong")', /FIXNUM/, true);
  await evaluation('x', ['41']);
  await rejected('#.(setq x 99)', null);
  await evaluation('x', ['41']);
  await rejected('(setq x 99) 42', /EXPECTED-ONE-FORM/);
  await evaluation('x', ['41']);
  evidence.checks.push('Type and reader errors enter child stops; typed Abort preserves the parent, history, and unchanged binding');

  const unavailable = await browser.evaluate("returnedResult('frames').findIndex(frame => /Compiled-Function BREAK /.test(frame.function))");
  assert(unavailable >= 0, 'BREAK frame was not found');
  await command(':Set Current Frame ' + unavailable);
  await frame(unavailable);
  await rejected('42', /UNAVAILABLE-LEXICAL-SCOPE/);
  await selectTarget();
  await evaluation('x', ['41']);
  evidence.checks.push('A frame without scope information rejects evaluation and permits recovery to the compiled target');

  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments.command === 'evaluate') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted frame-evaluation reply');
      }
      return response;
    };
  })()`);
  await fill('#source', '(incf alias)');
  await key('Enter', 'Enter', 13);
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "evaluate" && record.status === "outcome unknown")');
  const receipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "evaluate" && record.status === "outcome unknown")');
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(receipt.arguments))})).querySelector('button').dataset.focusedTest = 'evaluation-replay'`);
  await browser.click('[data-focused-test="evaluation-replay"]');
  await browser.waitFor(`!state.pending.some(record => record.id === ${text(receipt.id)}) && !busy`);
  await switchActivity('listener');
  await browser.waitFor("commandResults.get(commandKey(latestCommand('evaluate')))?.state === ':returned' && !busy");
  assert.deepEqual(await browser.evaluate("commandResults.get(commandKey(latestCommand('evaluate'))).result"), ['42']);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), receipt.arguments.id + 1);
  evidence.replay = receipt;
  await evaluation('x', ['42']);
  evidence.checks.push('Lost accepted reply replays the same source and ID once, preserving the connection identity and one binding increment');

  await rejected(`(describe (make-instance 'lispm-describe-test:probe :failure (make-condition 'simple-error :format-control "${marker} top description")))`, new RegExp(marker + ' top description'));
  await rejected(`(describe (make-instance 'lispm-describe-test:probe :value (make-instance 'lispm-describe-test:probe :failure (make-condition 'simple-error :format-control "${marker} slot description"))))`, new RegExp(marker + ' slot description'));
  await evaluation("(describe (make-instance 'lispm-describe-test:probe :value 42))", []);
  await browser.waitFor(`views.get(${text(targetJob)}).text.includes('VALUE <- 42') && !busy`);
  evidence.descriptionOutput = await browser.evaluate(`views.get(${text(targetJob)}).text`);
  assert(evidence.descriptionOutput.includes('DESCRIPTION-PROBE'));
  assert(!evidence.descriptionOutput.includes('<<error printing object>>'));
  await save('description-recovered');
  evidence.checks.push('DESCRIBE top-object and slot-value printer errors enter children; typed Abort restores the parent and successful description prints the slot and returns zero values');

  await clickText('[data-job="' + targetJob + '"]', 'Debugger');
  await browser.waitFor('activity === "debugger" && !busy');
  await evaluation('(values x (x) alias)', ['42', '42', '42'], '#debugger-command');
  const beforeProceed = await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)");
  await save('standalone-evaluation');
  await command(':Proceed', '#debugger-command');
  evidence.continued = await completed(targetJob);
  assert.deepEqual(evidence.continued.values, ['42', '42', '42', '37']);
  await browser.waitFor(`stops.find(stop => same(stop.token, ${text(parent.stop)}))?.info.state === ':closed' && !busy`);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)"), beforeProceed);
  await save('closed-history');
  await switchActivity('listener');
  const next = await start(`(progn (assert (null (find-symbol "${target}" "CL-USER"))) (+ 20 22))`);
  assert.deepEqual((await completed(next)).values, ['42']);
  evidence.checks.push('Standalone debugger evaluates forms; Proceed observes immediate writes and distinct outer cell, closed stop retains printed history, definition cleanup and next Listener succeed');

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
      if (originalStops.some(stop => stop.id === detail.id)) original.push({id: detail.id, state: detail.state, next: detail['next-command-id']});
    }
    await browser.evaluate("api('release-session')");
    evidence.cleanup = 'Owned jobs/stops/session released';
    if (protectedStop !== null) {
      assert.deepEqual(original.find(stop => stop.id === protectedStop), originalStops.find(stop => stop.id === protectedStop));
      evidence.protectedStop = original.find(stop => stop.id === protectedStop);
    }
    assert.deepEqual(browser.errors, []);
  } catch (cleanupError) {
    evidence.cleanupFailure = cleanupError.stack;
    throw cleanupError;
  } finally {
    evidence.jobs = jobs;
    evidence.stops = [...ownedStops.entries()];
    evidence.errors = browser.errors;
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
