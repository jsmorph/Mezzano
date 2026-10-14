import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/lazy-compilation-test');
await mkdir(output, {recursive:true});
const browser = await openBrowser(url);
const marker = 'WEB-LAZY-' + randomBytes(6).toString('hex').toUpperCase();
const names = ['TARGET', 'EXPAND', 'COUNT', 'FAIL'].map(suffix => marker + '-' + suffix);
const [target, macro, counter, flag] = names;
const text = JSON.stringify;
const jobs = [];
const ownedStops = new Map();
const evidence = {marker, names};
const cleanupSource = `(progn (dolist (name '(${names.join(' ')})) (when (fboundp name) (fmakunbound name)) (when (boundp name) (makunbound name)) (assert (unintern name "CL-USER"))) t)`;

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await browser.send('Input.dispatchKeyEvent', {type:'keyDown', key, code,
    windowsVirtualKeyCode, modifiers, text:key === 'Enter' ? '\r' : undefined});
  await browser.send('Input.dispatchKeyEvent', {type:'keyUp', key, code,
    windowsVirtualKeyCode, modifiers});
}
async function enter(selector, value) {
  await browser.waitFor('connected && !busy');
  await browser.click(selector);
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text:value});
  await key('Enter', 'Enter', 13);
}
async function start(source) {
  const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
  await enter('#source', source);
  const query = `state.inputHistory.find(item => item.source === ${text(source)} && !${text(previous)}.includes(item.name))`;
  await browser.waitFor(query);
  const job = await browser.evaluate(`state.jobs[(${query}).name]`);
  jobs.push(job);
  return job;
}
async function completed(job, state = ':returned') {
  await browser.waitFor(`views.get(${text(job.name)})?.info.state === ${text(state)} && !busy`, 60);
  return browser.evaluate(`({values:views.get(${text(job.name)}).info.values, output:views.get(${text(job.name)}).text})`);
}
async function clickText(container, value) {
  const query = `[...document.querySelectorAll(${text(container + ' button')})].find(button => button.textContent.includes(${text(value)}) && !button.disabled && button.getClientRects().length)`;
  await browser.waitFor(query);
  await browser.evaluate(`${query}.dataset.lazyTest = 'target'`);
  await browser.click('[data-lazy-test="target"]');
  await browser.evaluate("document.querySelector('[data-lazy-test=target]')?.removeAttribute('data-lazy-test')");
}
async function releaseOwned(job) {
  let info;
  for (let attempt = 0; attempt < 40; attempt++) {
    info = await browser.evaluate(`api('job-information', {job:${text(job.token)}})`);
    if (info.state !== ':running') break;
    if (!info.stops?.length && info['interruptible-p']) {
      await browser.evaluate(`api('interrupt-job', {job:${text(job.token)}, id:${info['next-interrupt-id']}})`);
    }
    for (const stop of info.stops || []) {
      const detail = await browser.evaluate(`api('information', {stop:${text(stop)}})`);
      ownedStops.set(detail.id, stop);
      if (!detail.child && detail.state === ':stopped') {
        const command = detail['next-command-id'] > 0 && await browser.evaluate(`api('result', {stop:${text(stop)}, id:${detail['next-command-id'] - 1}})`);
        if ([':pending', ':running'].includes(command?.state)) {
          if (info['interruptible-p']) await browser.evaluate(`api('interrupt-job', {job:${text(job.token)}, id:${info['next-interrupt-id']}})`);
        } else await browser.evaluate(`api('submit', {stop:${text(stop)}, id:${detail['next-command-id']}, command:'abort'})`);
      }
    }
    await delay(100);
  }
  assert(info.state !== ':running', 'Owned job did not finish cleanup');
  await browser.evaluate(`api('release-job', {job:${text(job.token)}})`);
}

try {
  await browser.waitFor('connected && !busy');
  evidence.session = await browser.evaluate('state.session');
  const setup = await start(`(progn (setf (symbol-value '${counter}) 0 (symbol-value '${flag}) t) (setf (macro-function '${macro}) (compile nil '(lambda (form environment) (declare (ignore form environment) (optimize (debug 3) (safety 3) (speed 1))) (incf (symbol-value '${counter})) (when (symbol-value '${flag}) (error "${marker} compiler failure")) 42))) (setf (symbol-value '${target}) (let ((mezzano.fast-eval:*lazy-lambda-evaluation* t)) (mezzano.fast-eval:eval-in-lexenv '(function (lambda () (${macro}))) nil))) (setf (fdefinition '${target}) (symbol-value '${target})) (values (typep (fdefinition '${target}) 'mezzano.fast-eval::lazy-eval-function) (symbol-value '${counter}) (slot-value (fdefinition '${target}) 'mezzano.fast-eval::function)))`);
  evidence.setup = await completed(setup);
  assert.deepEqual(evidence.setup.values, ['T', '0', 'NIL']);

  const failed = await start(`(funcall (symbol-function '${target}))`);
  await browser.waitFor(`activeListenerJob === ${text(failed.name)} && listenerDebugger && !busy && !stopCommandPending(listenerDebugger.stop)`, 60);
  await clickText('[data-job="' + failed.name + '"]', 'Debugger');
  await browser.waitFor("activity === 'debugger' && returnedResult('condition') && returnedResult('frames') && !stopCommandPending(selectedStop) && !busy");
  evidence.stop = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop))');
  ownedStops.set(evidence.stop.info.id, evidence.stop.token);
  evidence.condition = await browser.evaluate("returnedResult('condition')");
  evidence.frames = await browser.evaluate("returnedResult('frames')");
  assert(evidence.condition.includes(marker + ' compiler failure'));
  assert(evidence.frames.some(frame => frame.function.includes('EVAL-COMPILE')));
  assert(evidence.frames.some(frame => frame.function.includes('LAZY-EVAL-FUNCTION-FUNCTION')));
  await browser.screenshot(join(output, 'compiler-condition.png'));
  await enter('#debugger-command', ':Abort');
  evidence.aborted = await completed(failed, ':aborted');
  await browser.evaluate("showActivity('listener')");

  const reset = await start(`(values (symbol-value '${counter}) (slot-value (fdefinition '${target}) 'mezzano.fast-eval::function) (eq (fdefinition '${target}) (symbol-value '${target})))`);
  evidence.reset = await completed(reset);
  assert.deepEqual(evidence.reset.values, ['1', 'NIL', 'T']);
  const retried = await start(`(progn (setf (symbol-value '${flag}) nil) (values (funcall (symbol-function '${target})) (symbol-value '${counter}) (compiled-function-p (slot-value (fdefinition '${target}) 'mezzano.fast-eval::function)) (eq (fdefinition '${target}) (symbol-value '${target}))))`);
  evidence.retried = await completed(retried);
  assert.deepEqual(evidence.retried.values, ['42', '2', 'T', 'T']);
  const reused = await start(`(values (funcall (symbol-function '${target})) (symbol-value '${counter}) (compiled-function-p (slot-value (fdefinition '${target}) 'mezzano.fast-eval::function)))`);
  evidence.reused = await completed(reused);
  assert.deepEqual(evidence.reused.values, ['42', '2', 'T']);
  const arithmetic = await start('(+ 20 22)');
  assert.deepEqual((await completed(arithmetic)).values, ['42']);
  await browser.screenshot(join(output, 'compiled-retry.png'));
  assert.deepEqual(browser.errors, []);
} catch (error) {
  evidence.failure = error.stack;
  await browser.screenshot(join(output, 'failure.png'));
  await writeFile(join(output, 'failure-session.json'), await browser.evaluate('JSON.stringify(sessionStorage)'));
  throw error;
} finally {
  try {
    await browser.evaluate('connected = false; activity = "requests"');
    for (const job of jobs) await releaseOwned(job);
    const cleanupName = randomBytes(32).toString('hex');
    const token = await browser.evaluate(`api('start-evaluation', {name:${text(cleanupName)}, source:${text(cleanupSource)}})`);
    const cleanupJob = {name:cleanupName, token};
    jobs.push(cleanupJob);
    let cleanupInfo;
    for (let attempt = 0; attempt < 100; attempt++) {
      cleanupInfo = await browser.evaluate(`api('job-information', {job:${text(token)}})`);
      if (cleanupInfo.state !== ':running') break;
      await delay(100);
    }
    assert.equal(cleanupInfo.state, ':returned');
    assert.deepEqual(cleanupInfo.values, ['T']);
    await releaseOwned(cleanupJob);
    for (const token of ownedStops.values()) await browser.evaluate(`api('release-stop', {stop:${text(token)}})`);
    await browser.evaluate("api('release-session')");
    evidence.cleanup = 'Owned definitions, value bindings, jobs, stops, and session released';
  } catch (error) {
    evidence.cleanupFailure = error.stack;
    throw error;
  } finally {
    evidence.jobs = jobs;
    evidence.stops = [...ownedStops.entries()];
    evidence.errors = browser.errors;
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
