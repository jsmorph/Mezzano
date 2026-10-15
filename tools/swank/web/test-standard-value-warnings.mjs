import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/standard-value-warnings-test');
const protectedStops = (process.env.PROTECTED_STOPS ?? process.env.PROTECTED_STOP ?? '')
  .split(',').filter(Boolean).map(Number);
assert(protectedStops.every(id => Number.isSafeInteger(id) && id >= 0));
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
const marker = 'STANDARD-VALUES-' + randomBytes(6).toString('hex').toUpperCase();
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
  if (expected !== undefined) assert.deepEqual(result || [], expected);
  const displayed = result?.length ? result.join('\n') : '(No values)';
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .evaluation-values')].at(-1)?.textContent"), displayed);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation .debugger-transcript')].at(-1)?.textContent"), '→ ' + source);
  return result;
}
async function selectTarget(selector = '#source', name = marker + '-TARGET') {
  const index = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(name + ' ')}))`);
  assert(index >= 0, 'Compiled target frame was not found');
  await command(':Set Current Frame ' + index, selector);
  await frame(index);
  return index;
}

async function idle() {
  await browser.waitFor('connected && !busy && !stopCommandPending(selectedStop) && !nextStopInspection(selectedStop)', 60);
}
let targetJob;
const target = marker + '-TARGET', probeClass = marker + '-PROBE';
const failureSlot = marker + '-FAILURE', printsSlot = marker + '-PRINTS';
const names = [target, probeClass, failureSlot, printsSlot];
const warningCommand = ':Show Standard Value Warnings';
async function warnings(after = -1) {
  await browser.waitFor(`latestCommand('standard-value-warnings')?.id > ${after} && commandResults.get(commandKey(latestCommand('standard-value-warnings')))?.state === ':returned' && !busy`, 60);
  const result = await browser.evaluate("returnedResult('standard-value-warnings')");
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .standard-value-warnings-result')].at(-1)?.textContent"), result);
  return result;
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.ok) {
        const failures = JSON.parse(sessionStorage.getItem('standard-values-http-failures') || '[]');
        failures.push({request:args[1]?.body, status:response.status, response:await response.clone().text()});
        sessionStorage.setItem('standard-values-http-failures', JSON.stringify(failures));
      }
      return response;
    };
  })()`});
  await browser.send('Page.navigate', {url});
  await browser.waitFor("document.readyState === 'complete' && typeof connected !== 'undefined' && connected && !busy");
  evidence.session = await browser.evaluate('state.session');
  originalStops = await browser.evaluate('stops.map(stop => ({id:stop.info.id, state:stop.info.state, generation:stop.info.generation, next:stop.info["next-command-id"]}))');
  for (const id of protectedStops) assert(originalStops.some(stop => stop.id === id), 'Protected stop missing: ' + id);
  const setup = `(let ((cleanup (list 0)) (answer nil))
    (unwind-protect
         (progn
           (defclass ${probeClass} ()
             ((${failureSlot} :initform nil) (${printsSlot} :initform 0)))
           (defmethod print-object ((object ${probeClass}) stream)
             (incf (slot-value object '${printsSlot}))
             (when (slot-value object '${failureSlot}) (error "${marker} original-value printer"))
             (write-string "#<STANDARD-VALUE-PROBE>" stream)
             object)
           (compile (defun ${target} (probe cleanup)
             (declare (optimize (debug 3) (safety 3) (speed 1)))
             (unwind-protect
                  (progv '(*package* *read-base* *print-base* *read-default-float-format*) '(nil)
                    (break "${marker} standard-value stop")
                    (list (boundp '*package*) (symbol-value '*package*)
                          (boundp '*read-base*) (boundp '*print-base*)
                          (boundp '*read-default-float-format*)
                          (slot-value probe '${printsSlot})))
               (incf (car cleanup)))))
           (setf answer (${target} (make-instance '${probeClass}) cleanup)))
      (let ((class (find-class '${probeClass} nil)))
        (when class
          (let ((method (find-method #'print-object nil (list class (find-class 't)) nil)))
            (when method (remove-method #'print-object method)))
          (setf (find-class '${probeClass}) nil)))
      (dolist (name '(${names.map(name => '"' + name + '"').join(' ')}))
        (let ((symbol (find-symbol name "CL-USER")))
          (when symbol
            (when (fboundp symbol) (fmakunbound symbol))
            (when (boundp symbol) (makunbound symbol))
            (unintern symbol "CL-USER")))))
    (assert (equal (subseq answer 0 5) '(t nil nil nil nil)))
    (assert (plusp (sixth answer)))
    (assert (= (car cleanup) 1))
    (values 42 (car cleanup)))`;
  targetJob = await start(setup);
  const parent = await stopped(targetJob);
  evidence.frame = await selectTarget();
  await idle();
  await evaluation('(values (eq *package* (find-package :cl-user)) *read-base* *print-base* *read-default-float-format*)', ['T','10','10','SINGLE-FLOAT']);
  await fill('#source', ':Show Sta');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value === ':Show Standard '");
  await command(warningCommand);
  const initial = await warnings();
  assert.match(initial, /The following standard values were bound:/);
  assert.match(initial, /Rebinding \*PACKAGE\* to [^\n]+\n    \(old value was NIL\)/);
  for (const name of ['READ-BASE','PRINT-BASE','READ-DEFAULT-FLOAT-FORMAT']) {
    assert.match(initial, new RegExp('Rebinding \\*' + name + '\\* to [^\\n]+\\n    \\(old value was \\[unbound\\]\\)'));
  }
  evidence.initialWarnings = initial;
  await save('standard-value-warnings');
  evidence.checks.push('Ordinary bound-NIL/unbound controls normalize before evaluation; SPACE completion and typed warnings distinguish original NIL from unbound');

  await evaluation('(setq *package* probe)', ['#<STANDARD-VALUE-PROBE>']);
  await command(warningCommand);
  const edited = await warnings();
  assert.equal((edited.match(/Rebinding \*PACKAGE\*/g) || []).length, 2);
  assert.match(edited, /old value was #<STANDARD-VALUE-PROBE>/);
  await evaluation('(eq *package* (find-package :cl-user))', ['T']);
  evidence.editedWarnings = edited;
  evidence.checks.push('An invalid debugger package edit is corrected before the next command and retained as another warning');

  for (const value of [11,21,31]) await evaluation(`(values ${value} ${value+1})`, [String(value),String(value+1)]);
  await clickText('[data-job="' + targetJob + '"]', 'Debugger');
  await browser.waitFor('activity === "debugger" && !busy');
  const previousWarning = await browser.evaluate("latestCommand('standard-value-warnings').id");
  await browser.click('#window-label');
  await clickText('#debugger-menu', warningCommand);
  assert.equal(await warnings(previousWarning), edited);
  await frame(evidence.frame);
  await evaluation('(values * + ++ +++ ** *** / // ///)', ['31','(VALUES 31 32)','(VALUES 21 22)','(VALUES 11 12)','21','11','(31 32)','(21 22)','(11 12)'], '#debugger-command');
  evidence.checks.push('The menu uses the retained text operation while preserving selected frame and all nine histories');

  const before = await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)');
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && typeof connected !== 'undefined' && connected && !busy`);
  await idle();
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  await frame(evidence.frame);
  assert.equal(await warnings(), edited);
  assert.deepEqual(await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)'), before);
  evidence.retainedBounds = await browser.evaluate(`(() => {
    const output = [...document.querySelectorAll('#stop-detail .standard-value-warnings-result')].at(-1);
    output.scrollIntoView({block: 'center'});
    const row = output.getBoundingClientRect(), pane = document.querySelector('#page').getBoundingClientRect();
    return {top:row.top, bottom:row.bottom, paneTop:pane.top, paneBottom:pane.bottom};
  })()`);
  assert(evidence.retainedBounds.top >= evidence.retainedBounds.paneTop
    && evidence.retainedBounds.bottom <= evidence.retainedBounds.paneBottom);
  await save('retained-standard-value-warnings');
  await switchActivity('listener');
  evidence.checks.push('Reload restores warning text in command order without another inspection or frame change');

  const prints = Number((await evaluation(`(slot-value probe '${printsSlot})`, undefined))[0]);
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments.command === 'standard-value-warnings') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted warning reply');
      }
      return response;
    };
  })()`);
  await fill('#source', warningCommand);
  await key('Enter', 'Enter', 13);
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "standard-value-warnings" && record.status === "outcome unknown")');
  const receipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "standard-value-warnings" && record.status === "outcome unknown")');
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(receipt.arguments))})).querySelector('button').dataset.focusedTest = 'warning-replay'`);
  await browser.click('[data-focused-test="warning-replay"]');
  await browser.waitFor(`!state.pending.some(record => record.id === ${text(receipt.id)}) && !busy`);
  await switchActivity('listener');
  await idle();
  assert.equal(await warnings(), edited);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), receipt.arguments.id+1);
  await evaluation(`(slot-value probe '${printsSlot})`, [String(prints+1)]);
  evidence.replay = receipt;
  evidence.checks.push('A discarded accepted warning reply replays its original command ID without printing the original value twice');

  await evaluation(`(setf (slot-value probe '${failureSlot}) t)`, ['T']);
  await command(warningCommand);
  const child = await stopped(targetJob, 2);
  await idle();
  assert.match(await browser.evaluate("returnedResult('condition')"), new RegExp(marker + ' original-value printer'));
  await command(warningCommand);
  assert.equal(await warnings(), 'There were no standard values which required binding');
  await save('original-value-printer-error');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(parent.stop)}) && !busy`);
  await idle();
  await frame(evidence.frame);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('standard-value-warnings'))).state"), ':unwound');
  await evaluation(`(setf (slot-value probe '${failureSlot}) nil)`, ['NIL']);
  await command(warningCommand);
  assert.equal(await warnings(), edited);
  await save('warning-printer-repaired');
  evidence.child = child;
  evidence.checks.push('An original-value printer error enters a child with valid independent controls; typed Abort restores the parent, and repair permits a new display');

  await command(':Proceed');
  evidence.continued = await completed(targetJob);
  assert.deepEqual(evidence.continued.values, ['42','1']);
  const next = await start(`(progn (dolist (name '(${names.map(name => '"' + name + '"').join(' ')})) (assert (null (find-symbol name "CL-USER")))) (+ 20 22))`);
  assert.deepEqual((await completed(next)).values, ['42']);
  await save('continued-listener');
  evidence.checks.push('Proceed restores the original program bindings, one unwind removes owned definitions, and the next Listener returns 42');
  assert.deepEqual(await browser.evaluate("JSON.parse(sessionStorage.getItem('standard-values-http-failures') || '[]')"), []);
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
    assert.deepEqual(browser.errors, []);
  } catch (cleanupError) {
    evidence.cleanupFailure = cleanupError.stack;
    throw cleanupError;
  } finally {
    evidence.jobs = jobs;
    evidence.stops = [...ownedStops.entries()];
    evidence.errors = browser.errors;
    evidence.httpFailures = await browser.evaluate("JSON.parse(sessionStorage.getItem('standard-values-http-failures') || '[]')");
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
