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
const browser = await openBrowser('about:blank');
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
async function selectTarget(selector = '#source', name = marker + '-TARGET') {
  const index = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(name + ' ')}))`);
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
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.ok) {
        const failures = JSON.parse(sessionStorage.getItem('frame-evaluation-http-failures') || '[]');
        failures.push({request:args[1]?.body, status:response.status, response:await response.clone().text()});
        sessionStorage.setItem('frame-evaluation-http-failures', JSON.stringify(failures));
      }
      return response;
    };
  })()`});
  await browser.send('Page.navigate', {url});
  await browser.waitFor("document.readyState === 'complete' && connected && !busy");
  evidence.session = await browser.evaluate('state.session');
  evidence.rejections = [];
  originalStops = await browser.evaluate('stops.map(stop => ({id: stop.info.id, state: stop.info.state, next: stop.info["next-command-id"]}))');
  if (protectedStop !== null) assert(originalStops.some(stop => stop.id === protectedStop));
  const setup = await start('(progn (load (compile-file "SYS:SOURCE;TOOLS;SWANK;TEST-DESCRIBE.LISP")) :description-fixture-loaded)');
  assert.deepEqual((await completed(setup)).values, [':DESCRIPTION-FIXTURE-LOADED']);
  await browser.evaluate('document.querySelector("#interactive").checked = true');
  const target = marker + '-TARGET', caller = marker + '-CALLER';
  const binding = '*' + marker + '-BINDING*', nilBinding = '*' + marker + '-NIL*';
  const unbound = '*' + marker + '-UNBOUND*', printer = '*' + marker + '-PRINTER*';
  const symbols = [target, caller, binding, nilBinding, unbound, printer];
  targetJob = await start(`(unwind-protect (progn
    (defun ${target} (required &optional optional &key key)
      (declare (ignore required optional key) (optimize (debug 3) (safety 3) (speed 1)))
      (let ((${binding} 22)) (declare (special ${binding}))
        (let ((${binding} 33) (${nilBinding} nil) (${unbound} 77) (${printer} nil))
          (declare (special ${binding} ${nilBinding} ${unbound} ${printer}))
          (makunbound '${unbound})
          (let ((x 37)) (declare (type fixnum x))
            (let ((outer (lambda () x)))
              (let ((x 38)) (declare (type fixnum x))
                (flet ((x () x) (bump () (incf x)))
                  (symbol-macrolet ((alias x))
                    (macrolet ((twice (value) (list '+ value value)))
                      (break "${marker} lexical evaluation")
                      (assert (and (= ${binding} 33) (null ${nilBinding})
                                   (not (boundp '${unbound})) (null ${printer})))
                      (values x (x) alias (funcall outer)))))))))))
    (defun ${caller} ()
      (declare (notinline ${target}) (optimize (debug 3) (safety 3) (speed 1)))
      (let ((${binding} 11)) (declare (special ${binding}))
        (multiple-value-prog1 (${target} 1 2 :key 3) (assert (= ${binding} 11)))))
    (assert (and (compiled-function-p (symbol-function '${target}))
                 (compiled-function-p (symbol-function '${caller}))))
    (${caller}))
    (dolist (name '(${target} ${caller})) (when (fboundp name) (fmakunbound name)))
    (dolist (name '(${binding} ${nilBinding} ${unbound} ${printer})) (assert (not (boundp name))))
    (dolist (name '(${symbols.join(' ')})) (unintern name)))`);
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

  await evaluation('(values 70 71)', ['70', '71']);
  const ownBindingRows = value => value.split('\n').filter(line => line.startsWith('  *' + marker));
  const repeatedBindings = value => ownBindingRows(value).filter(line => line.startsWith('  ' + binding + ': '));
  async function bindingResultAfter(previous) {
    await browser.waitFor(`latestCommand('bindings')?.id > ${previous} && commandResults.get(commandKey(latestCommand('bindings')))?.state === ':returned' && !busy`);
    const result = await browser.evaluate("commandResults.get(commandKey(latestCommand('bindings'))).result");
    assert.equal(await browser.evaluate("[...document.querySelectorAll('.bindings-result')].at(-1).textContent"), result);
    assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), evidence.frame);
    return result;
  }
  async function showBindings(source) {
    const previous = await browser.evaluate("latestCommand('bindings')?.id ?? -1");
    await command(source);
    return bindingResultAfter(previous);
  }
  await fill('#source', ':Show Bind');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value.startsWith(':Show Bindings') && !busy");
  await key('Enter', 'Enter', 13);
  evidence.bindings = {selected: await bindingResultAfter(-1)};
  assert.deepEqual(repeatedBindings(evidence.bindings.selected), ['  ' + binding + ': 33', '  ' + binding + ': 22']);
  assert.deepEqual(ownBindingRows(evidence.bindings.selected).sort(), [
    '  ' + binding + ': 33', '  ' + binding + ': 22', '  ' + nilBinding + ': NIL',
    '  ' + unbound + ': [unbound]', '  ' + printer + ': NIL'].sort());
  assert(evidence.bindings.selected.startsWith('Frame ' + evidence.frame + ' '));
  const menuPrevious = await browser.evaluate("latestCommand('bindings').id");
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Show Bindings');
  assert.deepEqual(ownBindingRows(await bindingResultAfter(menuPrevious)), ownBindingRows(evidence.bindings.selected));
  evidence.bindings.all = await showBindings(':Show Bindings :All :Matching "' + marker + '"');
  assert.deepEqual(repeatedBindings(evidence.bindings.all), [
    '  ' + binding + ': 33', '  ' + binding + ': 22', '  ' + binding + ': 11']);
  assert.equal(ownBindingRows(evidence.bindings.all).length, 6);
  const callerIndex = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(caller + ' ')}))`);
  assert(callerIndex > evidence.frame);
  assert(evidence.bindings.all.includes('Frame ' + callerIndex + ' '));
  evidence.checks.push('Show Bindings completion/menu and selected/all-frame output preserve repeated inner-to-outer values and distinguish bound NIL from unbound');

  const explicit = await showBindings(':Show Bindings :All No :Matching ""');
  assert.deepEqual(ownBindingRows(explicit), ownBindingRows(evidence.bindings.selected));
  evidence.bindings.filtered = await showBindings(':Show Bindings :All Yes :Matching "' + binding + '"');
  assert.deepEqual(ownBindingRows(evidence.bindings.filtered), repeatedBindings(evidence.bindings.all));
  evidence.bindings.noMatch = await showBindings(':Show Bindings :Matching "' + marker.toLowerCase() + '"');
  assert.equal(ownBindingRows(evidence.bindings.noMatch).length, 0);
  assert(evidence.bindings.noMatch.endsWith('  No matching bindings.\n'));
  await evaluation('(values * / + -)', ['70', '(70 71)', '(VALUES 70 71)', '(VALUES * / + -)']);
  evidence.checks.push('Bindings accepts explicit All Yes/No and empty matching string, matches literal case-sensitive symbol names, and preserves selected frame and nonempty evaluation history');
  await browser.evaluate("[...document.querySelectorAll('.bindings-result')].find(element => element.textContent.includes(': 11')).scrollIntoView({block:'center'})");
  await save('dynamic-bindings');

  const printerFailure = marker + ' binding printer';
  await evaluation(`(progn (setq ${printer} (make-instance 'lispm-describe-test:probe :failure (make-condition 'simple-error :format-control "${printerFailure}"))) (values))`, []);
  await command(':Show Bindings :Matching "' + printer + '"');
  await stopped(targetJob, 2);
  assert.equal(await browser.evaluate("returnedResult('condition')"), printerFailure);
  await save('binding-printer-error');
  await command(':Abort');
  await stopped(targetJob);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('bindings'))).state"), ':unwound');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.bindings-result')].at(-1).textContent"), 'unwound');
  await evaluation(`(progn (setq ${printer} nil) (values))`, []);
  const recovered = await showBindings(':Show Bindings :Matching "' + printer + '"');
  assert.deepEqual(ownBindingRows(recovered), ['  ' + printer + ': NIL']);
  evidence.bindings.retained = await browser.evaluate("[...document.querySelectorAll('.bindings-result')].map(element => element.textContent)");
  evidence.checks.push('Binding value printer errors enter a child; typed Abort returns to the parent, retains the unwound result, and permits inspection after replacement');

  await evaluation('(values 10 20)', ['10', '20']);
  const expectedArglist = `The argument list for ${target} is (REQUIRED &OPTIONAL OPTIONAL &KEY KEY).`;
  await fill('#source', ':Show Arg');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value.startsWith(':Show Arglist') && !busy");
  await key('Enter', 'Enter', 13);
  await browser.waitFor("latestCommand('arglist') && commandResults.get(commandKey(latestCommand('arglist')))?.state === ':returned' && !busy");
  assert.equal(await browser.evaluate("document.querySelector('.arglist-result').textContent"), expectedArglist);
  const firstArglist = await browser.evaluate("latestCommand('arglist').id");
  const replacementJob = randomBytes(32).toString('hex');
  jobs.push(replacementJob);
  await browser.evaluate(`mutate('start-evaluation', ${text({name:replacementJob,
    source:`(progn (defun ${target} (replacement) replacement) :definition-replaced)`,package:'CL-USER'})})`);
  assert.deepEqual((await completed(replacementJob)).values, [':DEFINITION-REPLACED']);
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Show Arglist');
  await browser.waitFor(`latestCommand('arglist')?.id > ${firstArglist} && commandResults.get(commandKey(latestCommand('arglist')))?.state === ':returned' && !busy`);
  evidence.arglists = await browser.evaluate("[...document.querySelectorAll('.arglist-result')].map(element => element.textContent)");
  assert.deepEqual(evidence.arglists, [expectedArglist, expectedArglist]);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), evidence.frame);
  await browser.evaluate("[...document.querySelectorAll('.arglist-result')].at(-1).scrollIntoView({block:'center'})");
  await save('arglist-active-definition');
  await evaluation('(values * / + -)', ['10', '(10 20)', '(VALUES 10 20)', '(VALUES * / + -)']);
  evidence.checks.push('Show Arglist completion and typed/menu commands report the active compiled signature after global redefinition without changing selected frame or evaluation history');
  await evaluation('(values)', []);
  await evaluation('(values * /)', ['NIL', 'NIL']);
  const beforeReload = await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)");
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)"), beforeReload);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.arglist-result')].map(element => element.textContent)"), evidence.arglists);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.bindings-result')].map(element => element.textContent)"), evidence.bindings.retained);
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
  const handlerTarget = marker + '-HANDLER-TARGET';
  const applicationError = marker + ' application error';
  targetJob = await start(`(unwind-protect (progn
    (defun ${handlerTarget} ()
      (declare (optimize (debug 3) (safety 3) (speed 1)))
      (let ((application-handler-calls 0) (application-cleanups 0))
        (handler-case
            (unwind-protect
                (progn (break "${marker} application handler") (error "${applicationError}"))
              (incf application-cleanups))
          (error (condition)
            (incf application-handler-calls)
            (values :application-handler application-handler-calls application-cleanups
                    (princ-to-string condition))))))
    (assert (compiled-function-p (symbol-function '${handlerTarget})))
    (${handlerTarget}))
    (when (fboundp '${handlerTarget}) (fmakunbound '${handlerTarget}))
    (unintern '${handlerTarget}))`);
  evidence.handlerParent = await stopped(targetJob);
  await selectTarget('#source', handlerTarget);
  await evaluation('(values application-handler-calls application-cleanups)', ['0', '0']);
  const debuggerError = marker + ' debugger error';
  await rejected('(error "' + debuggerError + '")', new RegExp(debuggerError));
  await evaluation('(values application-handler-calls application-cleanups)', ['0', '0']);
  await evaluation('(handler-case (error "Handled inside the debugger.") (error () (values :inner-handler application-handler-calls application-cleanups)))', [':INNER-HANDLER', '0', '0']);
  await save('application-handler-preserved');
  evidence.checks.push('Debugger ERROR enters a child and typed Abort preserves the application handler and cleanup counters; handlers established inside evaluated expressions still work');
  const handlerPrinterError = marker + ' protected printer error';
  await rejected(`(describe (make-instance 'lispm-describe-test:probe :failure (make-condition 'simple-error :format-control "${handlerPrinterError}")))`, new RegExp(handlerPrinterError));
  await evaluation('(values application-handler-calls application-cleanups)', ['0', '0']);
  await command(':Proceed');
  evidence.handlerContinued = await completed(targetJob);
  assert.deepEqual(evidence.handlerContinued.values, [':APPLICATION-HANDLER', '1', '1', text(applicationError)]);
  await save('application-handler-restored');
  evidence.checks.push('Debugger printer failure also preserves the application handler; Proceed restores it and application ERROR returns through that handler after one unwind cleanup');
  const next = await start(`(progn (dolist (name '(${[...symbols, handlerTarget].map(name => '"' + name + '"').join(' ')})) (assert (null (find-symbol name "CL-USER")))) (+ 20 22))`);
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
    evidence.httpFailures = await browser.evaluate("JSON.parse(sessionStorage.getItem('frame-evaluation-http-failures') || '[]')");
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
