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
  const index = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(name + ' ')}))`);
  assert(index >= 0, 'Compiled target frame was not found');
  await command(':Set Current Frame ' + index, selector);
  await frame(index);
  return index;
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
