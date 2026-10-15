import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/evaluation-environments-test');
const protectedStops = (process.env.PROTECTED_STOPS ?? process.env.PROTECTED_STOP ?? '')
  .split(',').filter(Boolean).map(Number);
assert(protectedStops.every(id => Number.isSafeInteger(id) && id >= 0));
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
const marker = 'ENVIRONMENT-' + randomBytes(6).toString('hex').toUpperCase();
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
  const index = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(name)}))`);
  assert(index >= 0, 'Compiled target frame was not found');
  await command(':Set Current Frame ' + index, selector);
  await frame(index);
  return index;
}

async function special(name, environment, expected) {
  const previous = await browser.evaluate("latestCommand('special')?.id ?? -1");
  await command(':Show Special ' + name + ' :Environment ' + environment);
  await browser.waitFor(`latestCommand('special')?.id > ${previous}
    && commandResults.get(commandKey(latestCommand('special')))?.state === ':returned' && !busy`, 60);
  const result = await browser.evaluate("returnedResult('special')");
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .special-result')].at(-1)?.textContent"), result);
  if (expected !== undefined) assert(result.endsWith(': ' + expected + '.'), 'Unexpected special display: ' + result);
  return result;
}

async function idle() {
  await browser.waitFor('connected && !busy && !stopCommandPending(selectedStop) && !nextStopInspection(selectedStop)', 60);
}
async function mode(expected, depth = 1) {
  await browser.waitFor(`stops.find(stop => same(stop.token, selectedStop))?.info['evaluation-environment'] === ${text(':' + expected)} && !busy`, 60);
  assert.equal(await browser.evaluate('listenerDebugger?.["evaluation-environment"]'), ':' + expected);
  const prompt = expected === 'lexical' ? 'Eval (program): ' : 'Eval (debugger): ';
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["evaluation-prompt"]'), prompt);
  assert.equal(await browser.evaluate('listenerDebugger["evaluation-prompt"]'), prompt);
  assert.equal(await browser.evaluate('listenerDebugger.depth'), depth);
}
async function toggle() {
  await key('x', 'KeyX', 88, 2);
  await key('i', 'KeyI', 73);
}
async function prompt(selector, expected) {
  const label = selector === '#source' ? '#listener-prompt' : '#debugger-prompt';
  assert.equal(await browser.evaluate(`document.querySelector(${text(label)}).textContent`), expected);
}
async function visible(selector) {
  const bounds = await browser.evaluate(`(() => {
    const e = document.querySelector(${text(selector)}).getBoundingClientRect();
    const p = document.querySelector('#page').getBoundingClientRect();
    return {top:e.top, bottom:e.bottom, pageTop:p.top, pageBottom:p.bottom};
  })()`);
  assert(bounds.top >= bounds.pageTop && bounds.bottom <= bounds.pageBottom,
    'Editor is outside the visible pane: ' + JSON.stringify(bounds));
  return bounds;
}
async function draft(selector) {
  return browser.evaluate(`(() => { const e = document.querySelector(${text(selector)}); return [e.value, e.selectionStart, e.selectionEnd, e.selectionDirection]; })()`);
}
async function setSelection(selector, start, end, direction) {
  await browser.evaluate(`document.querySelector(${text(selector)}).setSelectionRange(${start}, ${end}, ${text(direction)})`);
  await key('Shift', 'ShiftLeft', 16);
}
let targetJob;
const target = marker + '-TARGET', binding = marker + '-X';
const names = [target, binding];
const inner = marker + '-INNER', outer = marker + '-OUTER';
const reader = marker + '-READ', writer = marker + '-WRITE', fail = marker + '-FAIL';
const historical = '*' + marker + '-SPECIAL*', nilValue = '*' + marker + '-NIL*';
const unboundValue = '*' + marker + '-UNBOUND*', globalValue = '*' + marker + '-GLOBAL*';
const writes = '*' + marker + '-WRITES*';
const specialNames = [historical, nilValue, unboundValue, globalValue, writes];
const historicalNames = [inner, outer, reader, writer, fail, ...specialNames];
const historicalSetup = `(let ((cleanup (list 0)) (answer nil))
  (declare (special ${specialNames.join(' ')}))
  (unwind-protect
       (progn
         (setf (symbol-value '${historical}) 0
               (symbol-value '${nilValue}) t
               (symbol-value '${unboundValue}) 77
               (symbol-value '${globalValue}) 7
               (symbol-value '${writes}) 0)
         (compile (defun ${reader} ()
           (declare (optimize (debug 3) (safety 3) (speed 1)) (special ${historical}))
           ${historical}))
         (compile (defun ${writer} (value)
           (declare (optimize (debug 3) (safety 3) (speed 1)) (special ${historical} ${writes}))
           (incf ${writes})
           (setq ${historical} value)))
         (compile (defun ${fail} ()
           (declare (optimize (debug 3) (safety 3) (speed 1)))
           (error "${marker} historical child")))
         (compile (defun ${inner} (cleanup)
           (declare (optimize (debug 3) (safety 3) (speed 1)))
           (let ((${historical} 22) (${nilValue} t) (${unboundValue} 88))
             (declare (special ${historical} ${nilValue} ${unboundValue}))
             (unwind-protect
                  (progn
                    (assert (= (symbol-value '${historical}) 22))
                    (break "${marker} historical-special stop")
                    (assert (= ${historical} 24))
                    (assert (and ${nilValue} (= ${unboundValue} 88)))
                    ${historical})
               (incf (car cleanup))))))
         (compile (defun ${outer} (cleanup)
           (declare (optimize (debug 3) (safety 3) (speed 1))
                    (notinline ${inner}) (special ${globalValue} ${writes}))
           (let ((${historical} 11) (${nilValue} nil) (${unboundValue} t)
                 (*print-base* 16) (- :program-minus))
             (declare (special ${historical} ${nilValue} ${unboundValue} -))
             (makunbound '${unboundValue})
             (assert (= (symbol-value '${historical}) 11))
             (let ((inner-value (${inner} cleanup)))
               (assert (= ${historical} 14))
               (assert (and (null ${nilValue}) (not (boundp '${unboundValue}))))
               (assert (and (= *print-base* 16) (eq - :program-minus)))
               (values 42 inner-value ${historical} ${globalValue} ${writes})))))
         (dolist (name '(${[inner, outer, reader, writer, fail].join(' ')}))
           (assert (compiled-function-p (fdefinition name))))
         (setf answer (multiple-value-list (${outer} cleanup)))
         (assert (and (zerop ${historical}) ${nilValue} (= ${unboundValue} 77)
                      (= ${globalValue} 8) (= ${writes} 6))))
    (dolist (name '(${historicalNames.map(name => '"' + name + '"').join(' ')}))
      (let ((symbol (find-symbol name "CL-USER")))
        (when symbol
          (when (fboundp symbol) (fmakunbound symbol))
          (when (boundp symbol) (makunbound symbol))
          (unintern symbol "CL-USER")))))
  (assert (= (car cleanup) 1))
  (values-list (append answer (list (car cleanup)))))`;
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.ok) {
        const failures = JSON.parse(sessionStorage.getItem('environment-http-failures') || '[]');
        failures.push({request:args[1]?.body, status:response.status, response:await response.clone().text()});
        sessionStorage.setItem('environment-http-failures', JSON.stringify(failures));
      }
      return response;
    };
  })()`});
  await browser.send('Page.navigate', {url});
  await browser.waitFor("document.readyState === 'complete' && connected && !busy");
  evidence.session = await browser.evaluate('state.session');
  originalStops = await browser.evaluate('stops.map(stop => ({id: stop.info.id, state: stop.info.state, generation: stop.info.generation, next: stop.info["next-command-id"]}))');
  for (const id of protectedStops) assert(originalStops.some(stop => stop.id === id), 'Protected stop missing: ' + id);
  targetJob = await start(`(let ((cleanup 0))
    (multiple-value-prog1
      (unwind-protect
          (progn
            (setf (symbol-value '${binding}) 7)
            (defun ${target} (${binding})
              (declare (optimize (debug 3) (safety 3) (speed 1)))
              (break "${marker} environment stop")
              (values ${binding} (symbol-value '${binding})))
            (funcall '${target} 37))
        (incf cleanup)
        (fmakunbound '${target})
        (makunbound '${binding})
        (dolist (name '(${names.join(' ')})) (unintern name)))
      (assert (= cleanup 1))))`);
  const parent = await stopped(targetJob);
  await idle();
  evidence.frame = await selectTarget('#source', target);
  await mode('lexical');
  await prompt('#source', '→ ');
  await evaluation(binding, ['37']);
  await fill('#source', '(' + binding);
  await prompt('#source', '→ Eval (program): ');
  await fill('#source', ':Use Dynamic Env');
  await prompt('#source', '→ ');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value.trim() === ':Use Dynamic Environment' && !busy");
  await key('Enter', 'Enter', 13);
  await idle();
  await mode('dynamic');
  assert.equal(await browser.evaluate("returnedResult('use-dynamic-environment')"), 'Eval (debugger): ');
  await prompt('#source', '→ ');
  await evaluation(binding, ['7']);
  await evaluation(`(setq ${binding} 8)`, ['8']);
  await command(':Use Lexical Environment');
  await idle();
  await mode('lexical');
  await evaluation(binding, ['37']);
  await evaluation(`(setq ${binding} 38)`, ['38']);
  evidence.checks.push('Typed mode commands and SPACE completion select distinct lexical/global bindings; writes affect their chosen cells');

  await fill('#source', '(values ' + binding + ')');
  await setSelection('#source', 3, 9, 'backward');
  const listenerDraft = await draft('#source');
  const previousToggle = await browser.evaluate("latestCommand('toggle-evaluation-environment')?.id ?? -1");
  await toggle();
  await idle();
  await mode('dynamic');
  assert.deepEqual(await draft('#source'), listenerDraft);
  await prompt('#source', '→ Eval (debugger): ');
  assert(await browser.evaluate("latestCommand('toggle-evaluation-environment').id") > previousToggle);
  evidence.listenerBounds = await visible('#source');
  await save('listener-dynamic-draft');
  const commandsBefore = await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)');
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && typeof connected !== 'undefined' && connected && !busy`);
  await stopped(targetJob);
  await idle();
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  await frame(evidence.frame);
  await mode('dynamic');
  assert.deepEqual(await draft('#source'), listenerDraft);
  await prompt('#source', '→ Eval (debugger): ');
  assert.deepEqual(await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)'), commandsBefore);
  evidence.checks.push('Control-X I preserves the Listener draft/cursor; reload preserves dynamic mode, selection, and command IDs');

  await clickText('[data-job="' + targetJob + '"]', 'Debugger');
  await browser.waitFor('activity === "debugger" && !busy');
  await fill('#debugger-command', '(values ' + binding + ')');
  await setSelection('#debugger-command', 2, 8, 'forward');
  const debuggerDraft = await draft('#debugger-command');
  await toggle();
  await idle();
  await mode('lexical');
  assert.deepEqual(await draft('#debugger-command'), debuggerDraft);
  await prompt('#debugger-command', '→ Eval (program): ');
  evidence.standaloneBounds = await visible('#debugger-command');
  await save('standalone-lexical-draft');
  await evaluation(binding, ['38'], '#debugger-command');
  await prompt('#debugger-command', '→ ');
  await switchActivity('listener');
  await fill('#source', '');
  await prompt('#source', '→ ');
  evidence.checks.push('Standalone debugger prompt and shortcut use the same guest mode; submission and clearing restore arrows');

  for (const value of [11, 21, 31]) await evaluation(`(values ${value} ${value + 1})`, [String(value), String(value + 1)]);
  await command(':Use Dynamic Environment');
  await idle();
  await toggle();
  await idle();
  await mode('lexical');
  await evaluation('(values * + ++ +++ ** *** / // ///)', ['31', '(VALUES 31 32)', '(VALUES 21 22)', '(VALUES 11 12)', '21', '11', '(31 32)', '(21 22)', '(11 12)']);
  await frame(evidence.frame);
  evidence.checks.push('Explicit and toggle operations preserve all nine evaluation-history slots and selected frame');

  await command(':Use Dynamic Environment');
  await idle();
  const childError = marker + ' child';
  await command(`(error "${childError}")`);
  const child = await stopped(targetJob, 2);
  await idle();
  await mode('dynamic', 2);
  assert.match(await browser.evaluate("returnedResult('condition')"), new RegExp(childError));
  await fill('#source', '(values 1)');
  await prompt('#source', '→→ Eval (debugger): ');
  await command(':Use Lexical Environment');
  await idle();
  await mode('lexical', 2);
  await fill('#source', '(values 1)');
  await prompt('#source', '→→ Eval (program): ');
  await save('child-independent-mode');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(parent.stop)}) && !busy`);
  await idle();
  await mode('dynamic');
  await frame(evidence.frame);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('evaluate'))).state"), ':unwound');
  await evaluation(binding, ['8']);
  evidence.child = child;
  evidence.checks.push('Child inherits dynamic mode, changes independently, and typed Abort restores the dynamic parent and its selected frame');

  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments.command === 'toggle-evaluation-environment') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted toggle reply');
      }
      return response;
    };
  })()`);
  await fill('#source', '(' + binding + ')');
  const replayDraft = await draft('#source');
  await toggle();
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "toggle-evaluation-environment" && record.status === "outcome unknown")');
  const receipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "toggle-evaluation-environment" && record.status === "outcome unknown")');
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(receipt.arguments))})).querySelector('button').dataset.focusedTest = 'toggle-replay'`);
  await browser.click('[data-focused-test="toggle-replay"]');
  await browser.waitFor(`!state.pending.some(record => record.id === ${text(receipt.id)}) && !busy`);
  await switchActivity('listener');
  await idle();
  await mode('lexical');
  assert.deepEqual(await draft('#source'), replayDraft);
  assert.equal(await browser.evaluate("returnedResult('toggle-evaluation-environment')"), 'Eval (program): ');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), receipt.arguments.id + 1);
  evidence.replay = receipt;
  await evaluation(binding, ['38']);
  evidence.checks.push('Lost accepted toggle reply replays its original ID once and preserves the mode, session, and draft');

  await command(':Proceed');
  evidence.continued = await completed(targetJob);
  assert.deepEqual(evidence.continued.values, ['38', '8']);
  const next = await start(`(progn (dolist (name '(${names.map(name => '"' + name + '"').join(' ')})) (assert (null (find-symbol name "CL-USER")))) (+ 20 22))`);
  assert.deepEqual((await completed(next)).values, ['42']);
  await save('continued-listener');
  evidence.checks.push('Proceed observes lexical/global writes, cleanup runs once and removes fixture symbols, and the next Listener returns 42');

  targetJob = await start(historicalSetup);
  const historicalParent = await stopped(targetJob);
  await idle();
  const outerFrame = await selectTarget('#source', outer);
  await mode('lexical');
  await evaluation(`(progn (setq *package* (find-package "CL-USER") *read-base* #10r10
    *print-base* #10r10 *read-default-float-format* 'single-float)
    (values (eq *package* (find-package "CL-USER")) *read-base* *print-base* *read-default-float-format*))`,
    ['T', '10', '10', 'SINGLE-FLOAT']);
  await evaluation(`(values ${historical} (${reader}) (symbol-value '${historical}))`, ['11', '11', '11']);
  await special(historical, 'Program', '11');
  await special(historical, 'Debugger', '22');
  await evaluation(`(setq ${historical} 12)`, ['12']);
  await evaluation(`(${writer} 13)`, ['13']);
  await special(historical, 'Program', '13');
  await special(historical, 'Debugger', '22');
  await command(':Use Dynamic Environment');
  await mode('dynamic');
  await evaluation(`(values ${historical} (${reader}))`, ['22', '22']);
  await evaluation(`(setq ${historical} 23)`, ['23']);
  await evaluation(`(${writer} 24)`, ['24']);
  await special(historical, 'Program', '13');
  await special(historical, 'Debugger', '24');
  await command(':Use Lexical Environment');
  await mode('lexical');
  const innerFrame = await selectTarget('#source', inner);
  await evaluation(`(values ${historical} (${reader}))`, ['24', '24']);
  await command(':Set Current Frame ' + outerFrame);
  await frame(outerFrame);
  await evaluation(`(values ${historical} (${reader}))`, ['13', '13']);
  evidence.historical = {job: targetJob, parent: historicalParent, outerFrame, innerFrame};
  await special(historical, 'Program', '13');
  await special(historical, 'Debugger', '24');
  await save('historical-program-and-debugger');
  evidence.checks.push('Lexical direct/compiled reads and writes use the selected outer or inner original cell; dynamic mode uses the point-of-error cell, as Show Special confirms');

  await evaluation(`(values ${nilValue} (boundp '${unboundValue}) ${globalValue})`, ['NIL', 'NIL', '7']);
  await special(nilValue, 'Program', 'NIL');
  await special(unboundValue, 'Program', '[unbound]');
  await special(unboundValue, 'Debugger', '88');
  await evaluation(`(setq ${globalValue} 8)`, ['8']);
  await evaluation(`(let ((${historical} 91)) (declare (special ${historical}))
    (values (${reader}) (${writer} 92) ${historical}))`, ['91', '92', '92']);
  await evaluation(`(progv '(${historical}) '(93) (values (${reader}) (${writer} 94) ${historical}))`, ['93', '94', '94']);
  await evaluation(`(progv '(${historical}) nil
    (values (boundp '${historical}) (progn (set '${historical} 95) (${reader}))))`, ['NIL', '95']);
  await evaluation(`(${reader})`, ['13']);
  await evaluation(`(progn (makunbound '${historical}) (boundp '${historical}))`, ['NIL']);
  await special(historical, 'Program', '[unbound]');
  await special(historical, 'Debugger', '24');
  await command(`(${reader})`);
  const unboundChild = await stopped(targetJob, 2);
  await idle();
  const unboundCondition = await browser.evaluate("returnedResult('condition')");
  assert.match(unboundCondition, /unbound/i);
  assert(unboundCondition.includes(historical), 'Unbound condition names another symbol: ' + unboundCondition);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(historicalParent.stop)}) && !busy`);
  await idle();
  await frame(outerFrame);
  await mode('lexical');
  await evaluation(`(${writer} 13)`, ['13']);
  await special(historical, 'Program', '13');
  await special(historical, 'Debugger', '24');
  evidence.historical.unboundChild = unboundChild;
  evidence.checks.push('LET/PROGV bindings shadow original cells and unwind independently; NIL, unbound, global writes, and typed Abort after an unbound compiled read preserve the other cells');

  for (const value of [11, 21, 31]) await evaluation(`(values ${value} ${value + 1})`, [String(value), String(value + 1)]);
  const history = [['*', '31'], ['+', '(VALUES 31 32)'], ['++', '(VALUES 21 22)'], ['+++', '(VALUES 11 12)'],
    ['**', '21'], ['***', '11'], ['/', '(31 32)'], ['//', '(21 22)'], ['///', '(11 12)']];
  for (const [name, value] of history) await special(name, 'Debugger', value);
  await special('*print-base*', 'Program', '16');
  await special('*print-base*', 'Debugger', '10');
  await special('*read-base*', 'Debugger', '10');
  await special('*read-default-float-format*', 'Debugger', 'SINGLE-FLOAT');
  await special('-', 'Debugger', ':PROGRAM-MINUS');
  const nestedSource = `(let ((${historical} 55)) (declare (special ${historical})) (${fail}))`;
  await command(nestedSource);
  const historicalChild = await stopped(targetJob, 2);
  await idle();
  await mode('lexical', 2);
  const errorFrame = await selectTarget('#source', fail);
  await evaluation(`(values ${historical} (${reader}))`, ['55', '55']);
  await special(historical, 'Program', '55');
  await special('-', 'Debugger', nestedSource.toUpperCase());
  await command(':Use Dynamic Environment');
  await mode('dynamic', 2);
  await evaluation(`(${reader})`, ['55']);
  await command(':Use Lexical Environment');
  await mode('lexical', 2);
  await selectTarget('#source', inner);
  await evaluation(`(values ${historical} (${reader}))`, ['24', '24']);
  await selectTarget('#source', outer);
  await evaluation(`(values ${historical} (${reader}))`, ['13', '13']);
  await command(':Set Current Frame ' + errorFrame);
  await frame(errorFrame);
  await command(':Use Dynamic Environment');
  await mode('dynamic', 2);
  await evaluation('(setq *read-base* #10r16)', ['16']);
  await special('*read-base*', 'Debugger', '16');
  await special(historical, 'Debugger', '55');
  await save('historical-child-context');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(historicalParent.stop)}) && !busy`);
  await idle();
  await frame(outerFrame);
  await mode('lexical');
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('evaluate'))).state"), ':unwound');
  for (const [name, value] of history) await special(name, 'Debugger', value);
  await special('*print-base*', 'Program', '16');
  await special('*print-base*', 'Debugger', '10');
  await special('*read-base*', 'Debugger', '10');
  await special('*read-default-float-format*', 'Debugger', 'SINGLE-FLOAT');
  await special('-', 'Debugger', ':PROGRAM-MINUS');
  evidence.historical.child = historicalChild;
  evidence.checks.push('A child sees its evaluation-time binding and original inner/outer frames; independent child mode/control edits and Abort preserve parent selection, all nine histories, controls, and current-form binding');

  const mutation = `(progn (${writer} (1+ ${historical})) (values ${historical} ${writes}))`;
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments.command === 'evaluate'
          && request.arguments.argument === ${text(mutation)}) {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted historical-write reply');
      }
      return response;
    };
  })()`);
  await fill('#source', mutation);
  await key('Enter', 'Enter', 13);
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "evaluate" && record.status === "outcome unknown")');
  const mutationReceipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "evaluate" && record.status === "outcome unknown")');
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(mutationReceipt.arguments))})).querySelector('button').dataset.focusedTest = 'historical-replay'`);
  await browser.click('[data-focused-test="historical-replay"]');
  await browser.waitFor(`!state.pending.some(record => record.id === ${text(mutationReceipt.id)}) && !busy`);
  await switchActivity('listener');
  await idle();
  await browser.waitFor(`latestCommand('evaluate')?.argument === ${text(mutation)} && commandResults.get(commandKey(latestCommand('evaluate')))?.state === ':returned' && !busy`);
  assert.deepEqual(await browser.evaluate("returnedResult('evaluate')"), ['14', '6']);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), mutationReceipt.arguments.id + 1);
  await fill('#source', `(values ${historical})`);
  const historicalDraft = await draft('#source');
  const historicalCommands = await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)');
  const historicalOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${historicalOrigin} && document.readyState === 'complete' && typeof connected !== 'undefined' && connected && !busy`);
  await stopped(targetJob);
  await idle();
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  await frame(outerFrame);
  await mode('lexical');
  assert.deepEqual(await draft('#source'), historicalDraft);
  assert.deepEqual(await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)'), historicalCommands);
  assert.deepEqual(await browser.evaluate("returnedResult('evaluate')"), ['14', '6']);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .evaluation-values')].at(-1)?.textContent"), '14\n6');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation .debugger-transcript')].at(-1)?.textContent"), '→ ' + mutation);
  await special(writes, 'Debugger', '6');
  await special(historical, 'Program', '14');
  await special(historical, 'Debugger', '24');
  await save('historical-replayed-write');
  evidence.historical.replay = mutationReceipt;
  await command(':Proceed');
  evidence.historical.continued = await completed(targetJob);
  assert.deepEqual(evidence.historical.continued.values, ['42', '24', '14', '8', '6', '1']);
  const historicalNext = await start(`(progn (dolist (name '(${historicalNames.map(name => '"' + name + '"').join(' ')})) (assert (null (find-symbol name "CL-USER")))) (+ 20 22))`);
  assert.deepEqual((await completed(historicalNext)).values, ['42']);
  await save('historical-continued-listener');
  evidence.checks.push('A discarded historical-write reply replays once, reload preserves visible source/results/order, Proceed observes original-cell writes and one cleanup, and Listener reuse returns 42');
  assert.deepEqual(await browser.evaluate("JSON.parse(sessionStorage.getItem('environment-http-failures') || '[]')"), []);
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
    evidence.httpFailures = await browser.evaluate("JSON.parse(sessionStorage.getItem('environment-http-failures') || '[]')");
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
