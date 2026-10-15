import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/show-special-test');
const protectedStops = (process.env.PROTECTED_STOPS ?? process.env.PROTECTED_STOP ?? '')
  .split(',').filter(Boolean).map(Number);
assert(protectedStops.every(id => Number.isSafeInteger(id) && id >= 0));
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
const marker = 'SHOW-SPECIAL-' + randomBytes(6).toString('hex').toUpperCase();
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
  const index = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(name)}))`);
  assert(index >= 0, 'Compiled target frame was not found');
  await command(':Set Current Frame ' + index, selector);
  await frame(index);
  return index;
}

async function idle() {
  await browser.waitFor('connected && !busy && !stopCommandPending(selectedStop) && !nextStopInspection(selectedStop)', 60);
}
let targetJob;
const inner = marker + '-INNER', outer = marker + '-OUTER', probeClass = marker + '-PROBE';
const failureSlot = marker + '-FAILURE', printsSlot = marker + '-PRINTS';
const variable = '*' + marker + '-VALUE*', nilVariable = '*' + marker + '-NIL*';
const unboundVariable = '*' + marker + '-UNBOUND*', objectVariable = '*' + marker + '-OBJECT*';
const readsVariable = '*' + marker + '-READS*', packageVariable = '*' + marker + '-PACKAGE-VALUE*';
const packageName = marker + '-PACKAGE';
const specialNames = [variable, nilVariable, unboundVariable, objectVariable, readsVariable, packageVariable];
const names = [inner, outer, probeClass, failureSlot, printsSlot, variable, nilVariable,
  unboundVariable, objectVariable, readsVariable, packageVariable];
const qualified = name => 'CL-USER::' + name;
const spelling = source => /\s|^:/.test(source) ? text(source) : source;
const specialCommand = (source, environment) => ':Show Special ' + spelling(source)
  + (environment === undefined ? '' : ':Environment' === environment ? ' :Environment' : ' :Environment ' + environment);
async function specialResult(after = -1) {
  await browser.waitFor(`latestCommand('special')?.id > ${after} && commandResults.get(commandKey(latestCommand('special')))?.state === ':returned' && !busy`, 60);
  const value = await browser.evaluate("returnedResult('special')");
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .special-result')].at(-1)?.textContent"), value);
  return value;
}
async function special(source, environment, expected, selector = '#source') {
  const previous = await browser.evaluate("latestCommand('special')?.id ?? -1");
  await command(specialCommand(source, environment), selector);
  const value = await specialResult(previous);
  if (expected !== undefined) assert(value.endsWith(': ' + expected + '.'), 'Unexpected special display: ' + value);
  return value;
}
async function showResult(name) {
  const bounds = await browser.evaluate(`(() => {
    const result = [...document.querySelectorAll('#stop-detail .special-result')].at(-1);
    result.scrollIntoView({block:'center'});
    const r=result.getBoundingClientRect(),p=document.querySelector('#page').getBoundingClientRect();
    return {top:r.top,bottom:r.bottom,paneTop:p.top,paneBottom:p.bottom};
  })()`);
  assert(bounds.top >= bounds.paneTop && bounds.bottom <= bounds.paneBottom);
  await save(name);
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.ok) {
        const failures = JSON.parse(sessionStorage.getItem('show-special-http-failures') || '[]');
        failures.push({request:args[1]?.body, status:response.status, response:await response.clone().text()});
        sessionStorage.setItem('show-special-http-failures', JSON.stringify(failures));
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
    (declare (special ${specialNames.join(' ')}))
    (unwind-protect
         (progn
           (defvar ${variable} 0) (defvar ${nilVariable} t)
           (defvar ${unboundVariable} 44) (defvar ${objectVariable} nil)
           (defvar ${readsVariable} 0) (defvar ${packageVariable} 66)
           (assert (null (find-package "${packageName}")))
           (let ((package (make-package "${packageName}" :use '("CL"))))
             (set (intern "${packageVariable}" package) 77)
             (set (intern "mixed name λ" package) 88))
           (defclass ${probeClass} () ((${failureSlot} :initform nil) (${printsSlot} :initform 0)))
           (defmethod print-object ((object ${probeClass}) stream)
             (incf (slot-value object '${printsSlot}))
             (when (slot-value object '${failureSlot}) (error "${marker} special-value printer"))
             (write-string "#<SPECIAL-VALUE-PROBE>" stream)
             object)
           (compile (defun ${inner} (probe cleanup)
             (declare (optimize (debug 3) (safety 3) (speed 1)) (special ${specialNames.join(' ')}))
             (unwind-protect
                  (let ((${variable} 22) (${nilVariable} nil) (${unboundVariable} t)
                        (${objectVariable} probe) (*print-base* 16) (- :program-minus))
                    (declare (special - ${variable} ${nilVariable} ${unboundVariable} ${objectVariable}))
                    (assert (= (symbol-value '${variable}) 22))
                    (makunbound '${unboundVariable})
                    (break "${marker} selected-special stop")
                    (assert (= ${variable} 22))
                    (assert (null ${nilVariable}))
                    (assert (not (boundp '${unboundVariable})))
                    (assert (= *print-base* 16))
                    (assert (eq - :program-minus))
                    (assert (eq ${objectVariable} probe))
                    42)
               (incf (car cleanup)))))
           (compile (defun ${outer} (probe cleanup)
             (declare (optimize (debug 3) (safety 3) (speed 1)) (notinline ${inner}) (special ${specialNames.join(' ')}))
             (let ((${variable} 11))
               (declare (special ${variable}))
               (assert (= (symbol-value '${variable}) 11))
               (prog1 (${inner} probe cleanup) (assert (= ${variable} 11))))))
           (setf answer (${outer} (make-instance '${probeClass}) cleanup))
           (assert (and (= ${variable} 0) ${nilVariable} (= ${unboundVariable} 44)
                        (null ${objectVariable}) (zerop ${readsVariable}))))
      (let ((class (find-class '${probeClass} nil)))
        (when class
          (let ((method (find-method #'print-object nil (list class (find-class 't)) nil)))
            (when method (remove-method #'print-object method)))
          (setf (find-class '${probeClass}) nil)))
      (let ((package (find-package "${packageName}"))) (when package (delete-package package)))
      (dolist (name '(${names.map(name => '"' + name + '"').join(' ')}))
        (let ((symbol (find-symbol name "CL-USER")))
          (when symbol
            (when (fboundp symbol) (fmakunbound symbol))
            (when (boundp symbol) (makunbound symbol))
            (unintern symbol "CL-USER")))))
    (assert (= (car cleanup) 1))
    (values answer (car cleanup)))`;
  targetJob = await start(setup);
  const parent = await stopped(targetJob);
  evidence.innerFrame = await selectTarget('#source', inner);
  await evaluation('(setq *print-base* 10)', ['10']);
  await fill('#source', ':Show Spe');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value === ':Show Special '");
  assert.match(await special(variable, undefined, '22'), new RegExp(' in Program frame ' + evidence.innerFrame + ' '));
  await special(variable, ':Environment', '22');
  await special(nilVariable, 'Program', 'NIL');
  await special(unboundVariable, 'Program', '[unbound]');
  await special(packageVariable, 'Program', '66');
  await special('*print-base*', 'Program', '16');
  await special('*print-base*', 'Debugger', '10');
  evidence.outerFrame = await selectTarget('#source', outer);
  await special(variable, 'Program', '11');
  await special(variable, 'Debugger', '22');
  await command(':Use Dynamic Environment');
  await special(variable, undefined, '11');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["evaluation-environment"]'), ':dynamic');
  await command(':Use Lexical Environment');
  await command(':Set Current Frame ' + evidence.innerFrame);
  await frame(evidence.innerFrame);
  await special(variable, 'Program', '22');
  await showResult('selected-and-debugger-specials');
  evidence.checks.push('SPACE completion, Program defaults, selected outer/inner bindings, NIL/unbound/global values, debugger controls, and mode independence');

  for (const value of [11,21,31]) await evaluation(`(values ${value} ${value+1})`, [String(value),String(value+1)]);
  for (const [name,value] of [['*','31'],['+','(VALUES 31 32)'],['++','(VALUES 21 22)'],['+++','(VALUES 11 12)'],
    ['**','21'],['***','11'],['/','(31 32)'],['//','(21 22)'],['///','(11 12)']]) await special(name, 'Debugger', value);
  await special('-', 'Debugger', ':PROGRAM-MINUS');
  await frame(evidence.innerFrame);
  await evaluation('(values * + ++ +++ ** *** / // ///)', ['31','(VALUES 31 32)','(VALUES 21 22)','(VALUES 11 12)','21','11','(31 32)','(21 22)','(11 12)']);
  await clickText('[data-job="' + targetJob + '"]', 'Debugger');
  await browser.waitFor('activity === "debugger" && !busy');
  const beforeMenu = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]');
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Show Special');
  await browser.waitFor("document.querySelector('#debugger-command').value === ':Show Special ' && document.querySelector('#debugger-assistance .argument-prompt')?.dataset.expectedType === ':symbol-source' && !busy");
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), beforeMenu);
  await special(variable, 'Debugger', '22', '#debugger-command');
  await showResult('show-special-menu-and-histories');
  await switchActivity('listener');
  evidence.checks.push('Nine debugger histories and current minus remain distinct; menu prompts for a symbol without submitting, and standalone input uses the same operation');

  await evaluation(`(setq *package* (find-package "${packageName}"))`);
  await special(packageVariable, 'Program', '77');
  await special(qualified(packageVariable), 'Program', '66');
  await special('|mixed name λ|', 'Debugger', '88');
  await special('NIL', 'Debugger', 'NIL');
  await special('T', 'Debugger', 'T');
  await special(':program', 'Debugger', ':PROGRAM');
  await evaluation('(setq *package* (find-package "CL-USER"))');
  evidence.checks.push('Symbol source resolves under the stop package and preserves qualification, escaped Unicode spelling, NIL, T, and keyword identity');

  const beforeReject = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]');
  const rejectedText = specialCommand(variable, 'Streams');
  await fill('#source', rejectedText);
  await key('Enter', 'Enter', 13);
  await browser.waitFor("!busy && state.pending.some(record => record.arguments.command === 'special' && record.status === 'rejected')");
  assert.equal(await browser.evaluate('connected'), true);
  assert.equal(await browser.evaluate('document.querySelector("#source").value'), rejectedText);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), beforeReject);
  assert.equal(await browser.evaluate(`state.commands.some(command => same(command.stop, selectedStop) && command.id === ${beforeReject})`), false);
  await special(variable, 'Program', '22');
  evidence.checks.push('Streams reports unsupported without accepting an ID or replacing the session; an explicit supported choice then succeeds');

  await special(objectVariable, 'Program', '#<SPECIAL-VALUE-PROBE>');
  const previousText = await specialResult();
  const before = await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)');
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && typeof connected !== 'undefined' && connected && !busy`);
  await idle();
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  await frame(evidence.innerFrame);
  assert.equal(await specialResult(), previousText);
  assert.deepEqual(await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)'), before);
  await showResult('retained-special-display');
  const prints = Number((await evaluation(`(slot-value probe '${printsSlot})`))[0]);
  await browser.evaluate(`(() => {
    const original=window.fetch;
    window.fetch=async (...args)=>{
      const response=await original(...args);
      const request=args[1]?.body && JSON.parse(args[1].body);
      if(request?.operation==='submit' && request.arguments.command==='special') {
        window.fetch=original;await response.arrayBuffer();throw new TypeError('Browser test discarded the accepted special reply');
      }
      return response;
    };
  })()`);
  await fill('#source', specialCommand(objectVariable, 'Program'));
  await key('Enter', 'Enter', 13);
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "special" && record.status === "outcome unknown")');
  const receipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "special" && record.status === "outcome unknown")');
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(receipt.arguments))})).querySelector('button').dataset.focusedTest='special-replay'`);
  await browser.click('[data-focused-test="special-replay"]');
  await browser.waitFor(`!state.pending.some(record=>record.id===${text(receipt.id)}) && !busy`);
  await switchActivity('listener');
  await idle();
  assert.equal(await specialResult(), previousText);
  assert.equal(await browser.evaluate('stops.find(stop=>same(stop.token,selectedStop)).info["next-command-id"]'),receipt.arguments.id+1);
  await evaluation(`(slot-value probe '${printsSlot})`,[String(prints+1)]);
  evidence.replay=receipt;
  evidence.checks.push('Reload retains visible results/order/selection, and discarded-reply replay prints the original object exactly once');

  await command(specialCommand(`#.(incf ${readsVariable})`, 'Program'));
  await stopped(targetJob, 2);
  await idle();
  assert(await browser.evaluate("returnedResult('condition').length > 0"));
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth===1 && same(listenerDebugger.stop,${text(parent.stop)}) && !busy`);
  await idle();
  await evaluation(readsVariable,['0']);
  const failingForm = `(error "${marker} current-minus")`;
  await command(failingForm);
  await stopped(targetJob,2);
  await idle();
  await special('-', 'Debugger', `(ERROR "${marker} current-minus")`);
  await showResult('child-current-form');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth===1 && same(listenerDebugger.stop,${text(parent.stop)}) && !busy`);
  await idle();
  await frame(evidence.innerFrame);
  await special('-', 'Debugger', ':PROGRAM-MINUS');
  evidence.checks.push('Read-time evaluation is rejected without effects; typed Abort recovers, and child minus reports its enclosing active form then restores');

  await evaluation(`(setf (slot-value probe '${failureSlot}) t)`,['T']);
  await command(specialCommand(objectVariable,'Program'));
  const child=await stopped(targetJob,2);
  await idle();
  assert.match(await browser.evaluate("returnedResult('condition')"),new RegExp(marker+' special-value printer'));
  await save('special-printer-error');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth===1 && same(listenerDebugger.stop,${text(parent.stop)}) && !busy`);
  await idle();
  await frame(evidence.innerFrame);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('special'))).state"),':unwound');
  await evaluation(`(setf (slot-value probe '${failureSlot}) nil)`,['NIL']);
  await special(objectVariable,'Program','#<SPECIAL-VALUE-PROBE>');
  await showResult('special-printer-repaired');
  evidence.child=child;
  evidence.checks.push('A value printer enters a child; typed Abort restores the selected parent, and repair permits fresh display');

  await command(':Proceed');
  evidence.continued=await completed(targetJob);
  assert.deepEqual(evidence.continued.values,['42','1']);
  const next=await start(`(progn (dolist (name '(${names.map(name=>'"'+name+'"').join(' ')})) (assert (null (find-symbol name "CL-USER")))) (assert (null (find-package "${packageName}"))) (+ 20 22))`);
  assert.deepEqual((await completed(next)).values,['42']);
  await save('continued-listener');
  evidence.checks.push('Proceed preserves program cells and runs one cleanup removing owned definitions/package; the next Listener returns 42');
  const failures=await browser.evaluate("JSON.parse(sessionStorage.getItem('show-special-http-failures') || '[]')");
  assert.equal(failures.length,1);
  assert.equal(failures[0].status,409);
  assert.deepEqual(JSON.parse(failures[0].response),{error:':unsupported-special-environment',uncertain:false});
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
    const expectedErrors = JSON.parse(await browser.evaluate("sessionStorage.getItem('show-special-http-failures') || '[]'"));
    assert.equal(browser.errors.length, expectedErrors.filter(item => item.status === 409).length);
    for (const error of browser.errors) assert.match(error.text, /409/);
  } catch (cleanupError) {
    evidence.cleanupFailure = cleanupError.stack;
    throw cleanupError;
  } finally {
    evidence.jobs = jobs;
    evidence.stops = [...ownedStops.entries()];
    evidence.errors = browser.errors;
    evidence.httpFailures = await browser.evaluate("JSON.parse(sessionStorage.getItem('show-special-http-failures') || '[]')");
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
