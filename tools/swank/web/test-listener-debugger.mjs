import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/listener-debugger-test');
const protectedStop = process.env.PROTECTED_STOP === undefined ? null : Number(process.env.PROTECTED_STOP);
assert(protectedStop === null || Number.isSafeInteger(protectedStop));
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const marker = 'LISTENER-DEBUG-' + randomBytes(6).toString('hex').toUpperCase();
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
async function proceed() {
  await clickText('#listener-debugger .restarts', 'CONTINUE');
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
async function inspectCondition() {
  await browser.click('#window-label');
  await clickText('#debugger-menu', 'Inspect Condition');
}
async function save(name) {
  await browser.screenshot(join(output, name + '.png'));
}

try {
  await browser.waitFor('connected && !busy');
  evidence.session = await browser.evaluate('state.session');
  originalStops = await browser.evaluate('stops.map(stop => ({id: stop.info.id, state: stop.info.state, next: stop.info["next-command-id"]}))');
  if (protectedStop !== null) assert(originalStops.some(stop => stop.id === protectedStop), 'Protected stop was not found');
  await browser.evaluate('document.querySelector("#interactive").checked = true');
  const ordinaryDraft = '(+ 90 9)';
  const normal = await start(`(progn (read-line) (cerror "Continue owned Listener test." "${marker} ordinary") 42)`);
  const input = '[data-job="' + normal + '"] .input-form';
  await browser.waitFor(`views.get(${text(normal)})?.info['input-waiting-p']`);
  await fill('#source', ordinaryDraft);
  await browser.evaluate('document.querySelector("#source").setSelectionRange(3, 6); storeEditorDraft(document.querySelector("#source"))');
  await fill(input + ' textarea', 'go');
  await clickText(input, 'Send Input');
  const first = await stopped(normal);
  assert.equal(await browser.evaluate('activity'), 'listener');
  assert.equal(await browser.evaluate('document.querySelector("#source").value'), '');
  await fill('#source', ':He');
  await key('Tab', 'Tab', 9);
  await browser.waitFor('document.querySelector("#source").value.startsWith(":Help")');
  await key('F12', 'F12', 123);
  await browser.waitFor('document.querySelector("#listener-assistance").textContent.length > 0');
  await command(':Help');
  await browser.waitFor('document.querySelector("#listener-debugger .debugger-help")?.textContent.includes("Abort")');
  const spanningClick = await browser.evaluate(`(() => {
    window.spanningButton = views.get(${text(normal)}).operations.querySelector('button');
    spanningButton.scrollIntoView({block: 'center'});
    const bounds = spanningButton.getBoundingClientRect();
    return {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  })()`);
  await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...spanningClick});
  await browser.evaluate('run(refresh)');
  assert(await browser.evaluate('spanningButton.isConnected'));
  await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...spanningClick});
  await browser.waitFor('activity === "debugger" && !busy');
  evidence.checks.push('Native Debugger button click spanning refresh retains its target and selects the activity');
  assert.equal(await browser.evaluate('document.querySelector("#debugger-prompt").textContent'), first.prompt);
  await browser.evaluate('run(() => new Promise(resolve => { window.releaseActionQueue = resolve; })); true');
  await browser.waitFor('typeof releaseActionQueue === "function"');
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Show Proceed Options');
  assert.equal(await browser.evaluate('document.querySelector("#system-menu").open'), false);
  await browser.evaluate('releaseActionQueue(); delete window.releaseActionQueue');
  await browser.waitFor('!busy');
  evidence.checks.push('Debugger menu closes when selected while its guest action waits in the queue');
  await command(':Help', '#debugger-command');
  await browser.waitFor('document.querySelector("#debugger .debugger-help")?.textContent.includes("Abort")');
  await switchActivity('listener');
  const rejected = await browser.evaluate(`(async () => {
    const before = await api('information', {stop: ${text(first.stop)}});
    const replies = [];
    for (const [command, argument] of [['abort', 0], ['condition', 0], ['help', 0], ['proceed', 0], ['invoke-restart-interactively', '0']]) {
      const response = await fetch('/api', {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Mezzano-Request': '1'},
        body: JSON.stringify({session: state.session, operation: 'submit',
          arguments: {stop: ${text(first.stop)}, id: before['next-command-id'], command, argument}})});
      replies.push({status: response.status, reply: await response.json()});
    }
    const after = await api('information', {stop: ${text(first.stop)}});
    return {replies, before: before['next-command-id'], after: after['next-command-id']};
  })()`);
  assert(rejected.replies.every(reply => reply.status === 400));
  assert.equal(rejected.before, rejected.after);
  evidence.rejectedArguments = rejected;
  await save('ordinary-stop-help');
  await frame(0);
  const lastFrame = await browser.evaluate('returnedResult("frames").length - 1');
  assert(lastFrame > 2);
  await fill('#source', ':Next Fr');
  await key(' ', 'Space', 32);
  await browser.waitFor('document.querySelector("#source").value === ":Next Frame " && !busy');
  await key('Enter', 'Enter', 13);
  await frame(1);
  await command(':Next Frame :Nframes 0');
  await frame(1);
  await command(':Previous Frame');
  await frame(0);
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Bottom Of Stack');
  await frame(lastFrame);
  evidence.rejectedFrames = [];
  for (const source of [':Next Frame', ':Set Current Frame ' + (lastFrame + 1)]) {
    const before = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]');
    await fill('#source', source);
    await key('Enter', 'Enter', 13);
    await browser.waitFor(`state.pending.some(record => record.operation === 'submit' && record.source === ${text(source)} && record.arguments.id === ${before} && record.status === 'rejected') && !busy`);
    const after = await browser.evaluate('({session: state.session, connected, info: stops.find(stop => same(stop.token, selectedStop)).info, pending: stopCommandPending(selectedStop), draft: document.querySelector("#source").value})');
    assert.equal(after.session, evidence.session);
    assert.equal(after.connected, true);
    assert.equal(after.info['current-frame'], lastFrame);
    assert.equal(after.info['next-command-id'], before);
    assert.equal(after.pending, false);
    assert.equal(after.draft, source);
    evidence.rejectedFrames.push({source, before, after});
  }
  await command(':Top Of Stack');
  await frame(0);
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments.command === 'next-frame') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted frame-motion reply');
      }
      return response;
    };
  })()`);
  await fill('#source', ':Next Frame');
  await key('Enter', 'Enter', 13);
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "next-frame" && record.status === "outcome unknown")');
  const motionReceipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "next-frame" && record.status === "outcome unknown")');
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(motionReceipt.arguments))})).querySelector('button').dataset.focusedTest = 'motion-replay'`);
  await browser.click('[data-focused-test="motion-replay"]');
  await browser.waitFor(`!state.pending.some(record => record.id === ${text(motionReceipt.id)}) && !busy`);
  await switchActivity('listener');
  await frame(1);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), motionReceipt.arguments.id + 1);
  evidence.motionReplay = motionReceipt;
  const motionOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${motionOrigin} && document.readyState === 'complete'`);
  await browser.waitFor('connected && !busy');
  await frame(1);
  assert.equal(await browser.evaluate('state.session'), evidence.session);
  assert(await browser.evaluate('Object.values(state.drafts).every(draft => !("frame" in draft))'));
  const externalSelectionId = await browser.evaluate(`(async () => {
    const info = await api('information', {stop: ${text(first.stop)}});
    await api('submit', {stop: ${text(first.stop)}, id: info['next-command-id'], command: 'select-frame', argument: 2});
    return info['next-command-id'];
  })()`);
  await browser.waitFor('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"] === 2 && !busy');
  await browser.evaluate('run(refresh)');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), externalSelectionId + 1);
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame.selected")?.textContent.split("  ")[0]'), '2');
  assert(await browser.evaluate('document.querySelector("#stop-detail").textContent.includes("Frame 2 selected. Use :Show Frame to inspect its locals.")'));
  await command(':Show Frame');
  await frame(2);
  await save('frame-motion-restored');
  evidence.checks.push('Frame completion, relative and endpoint motion, zero movement, rejected bounds without ID advance, once-only lost-reply replay, selection across reconnect/reload, and external selection without automatic inspection followed by explicit Show Frame');
  const defaultRestart = await browser.evaluate('returnedResult("restarts").filter(restart => restart["default-p"])');
  assert.equal(defaultRestart.length, 1);
  assert.equal(defaultRestart[0].name, 'CONTINUE');
  assert(await browser.evaluate(`document.querySelector('#listener-debugger .restarts').textContent.includes(${text('CONTINUE: [' + defaultRestart[0].index + ', Default]')})`));
  await fill('#source', ':Pro');
  await key(' ', 'Space', 32);
  await browser.waitFor('document.querySelector("#source").value === ":Proceed " && !busy');
  await key('Enter', 'Enter', 13);
  assert.deepEqual((await completed(normal)).values, ['42']);
  assert.deepEqual(await browser.evaluate('({text: document.querySelector("#source").value, start: document.querySelector("#source").selectionStart, end: document.querySelector("#source").selectionEnd})'), {text: ordinaryDraft, start: 3, end: 6});
  evidence.checks.push('Inline/standalone Help, completion, rejected argument validation, ordinary draft and selection restoration');
  evidence.checks.push('SPACE completes Proceed; omitted selector invokes the marked default and returns 42');

  const abort = await start(`(unwind-protect (cerror "Continue owned test." "${marker} abort") (write-string "${marker} abort cleanup"))`);
  await stopped(abort);
  const abortButton = await browser.evaluate(`(() => {
    window.restartAcrossRefresh = [...document.querySelectorAll('#listener-debugger .restarts button')].find(button => button.textContent.startsWith('ABORT:'));
    window.listenerAcrossRefresh = document.querySelector('#listener-state button');
    restartAcrossRefresh.scrollIntoView({block: 'center'});
    const bounds = restartAcrossRefresh.getBoundingClientRect();
    return {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  })()`);
  await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...abortButton});
  await browser.evaluate(`run(async () => {
    await refresh();
    const pending = {stop: selectedStop, id: Number.MAX_SAFE_INTEGER, command: 'restarts'};
    state.commands.push(pending);
    commandResults.set(commandKey(pending), {state: ':running'});
    renderStops();
    if (!restartAcrossRefresh.isConnected || !restartAcrossRefresh.disabled) {
      throw new Error('Pending restart query removed its completed list or left its action enabled.');
    }
    state.commands.pop();
    commandResults.delete(commandKey(pending));
    const fixture = {token: [':stop', state.session, Number.MAX_SAFE_INTEGER],
      info: {id: Number.MAX_SAFE_INTEGER, thread: 'Unrelated stop render fixture', state: ':stopped'}};
    stops.push(fixture);
    renderStops();
    fixture.info.state = ':closed';
    renderStops();
    renderListenerState();
  })`);
  assert(await browser.evaluate('restartAcrossRefresh.isConnected && listenerAcrossRefresh === document.querySelector("#listener-state button")'));
  await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...abortButton});
  await completed(abort, ':aborted');
  assert(await browser.evaluate(`views.get(${text(abort)}).text.includes(${text(marker + ' abort cleanup')})`));
  evidence.checks.push('Restart click spanning refresh and an unrelated stop-row change preserves controls and unwinds the owned evaluation');

  const typedAbort = await start(`(unwind-protect (cerror "Continue typed Abort test." "${marker} typed abort") (write-string "${marker} typed abort cleanup"))`);
  await stopped(typedAbort);
  await command(':Abort');
  await completed(typedAbort, ':aborted');
  assert(await browser.evaluate(`views.get(${text(typedAbort)}).text.includes(${text(marker + ' typed abort cleanup')})`));
  evidence.checks.push('Typed Abort unwinds the owned evaluation and runs cleanup');

  const printedClass = marker + '-PRINTED';
  const printedFunction = marker + '-FRAME';
  const printed = await start(`(defclass ${printedClass} () ()) (defmethod print-object ((object ${printedClass}) stream) (declare (ignore object stream)) (error "${marker} frame printer")) (defun ${printedFunction} (object) (declare (optimize (debug 3) (safety 3))) (cerror "Continue frame printer test." "${marker} frame") (typep object '${printedClass})) (unwind-protect (${printedFunction} (make-instance '${printedClass})) (remove-method #'print-object (find-method #'print-object nil (list (find-class '${printedClass}) (find-class 't)))) (setf (find-class '${printedClass}) nil) (fmakunbound '${printedFunction}) (unintern '${printedClass}) (unintern '${printedFunction}))`);
  const printedParent = await stopped(printed);
  await frame(0);
  const printedIndex = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(printedFunction)}))`);
  assert(printedIndex > 0);
  await clickText('#stop-detail', printedFunction);
  await stopped(printed, 2);
  await frame(0);
  assert.equal(await browser.evaluate(`stops.find(stop => same(stop.token, ${text(printedParent.stop)})).info['current-frame']`), printedIndex);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(printedParent.stop)}) && !busy`);
  const failedFrameId = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]');
  await browser.evaluate('run(refresh)');
  await browser.evaluate('run(refresh)');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), failedFrameId);
  assert.equal(await browser.evaluate('returnedFrameInspection()'), null);
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .current-function")'), null);
  assert.equal(await browser.evaluate('commandResults.get(commandKey(latestCommand("select-frame"))).state'), ':unwound');
  await command(':Top Of Stack');
  await frame(0);
  const externalPrinterId = await browser.evaluate(`(async () => {
    const info = await api('information', {stop: ${text(printedParent.stop)}});
    await api('submit', {stop: ${text(printedParent.stop)}, id: info['next-command-id'], command: 'select-frame', argument: ${printedIndex}});
    return info['next-command-id'];
  })()`);
  await stopped(printed, 2);
  await frame(0);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(printedParent.stop)}) && !busy`);
  await browser.evaluate('run(refresh)');
  await browser.evaluate('run(refresh)');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), externalPrinterId + 1);
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .current-function")'), null);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), printedIndex);
  await command(':Top Of Stack');
  await frame(0);
  await proceed();
  assert.deepEqual((await completed(printed)).values, ['T']);
  evidence.checks.push('Mouse and external-controller frame selection with a failing local printer enter children; Abort preserves parent selection without repeating printing or showing another frame; explicit Top recovers');

  const condition = marker + '-CONDITION';
  const count = marker + '-REPORTS';
  const nested = await start(`(defparameter ${count} 0) (define-condition ${condition} (error) () (:report (lambda (condition stream) (declare (ignore condition)) (if (zerop (prog1 ${count} (incf ${count}))) (write-string "${marker} outer" stream) (error "${marker} debugger operation error"))))) (unwind-protect (progn (cerror "Continue outer computation." '${condition}) 333) (setf (find-class '${condition}) nil) (makunbound '${count}) (unintern '${condition}) (unintern '${count}))`);
  const outer = await stopped(nested);
  await browser.waitFor(`document.querySelector('#listener-debugger .condition')?.textContent.includes(${text(marker + ' outer')})`);
  await command(':Next Frame');
  await frame(1);
  const parentDraft = ':Show Frame';
  await fill('#source', parentDraft);
  await browser.evaluate('document.querySelector("#source").setSelectionRange(2, 7); storeEditorDraft(document.querySelector("#source"))');
  await inspectCondition();
  const child = await stopped(nested, 2);
  await frame(0);
  assert.equal(await browser.evaluate(`stops.find(stop => same(stop.token, ${text(outer.stop)})).info['current-frame']`), 1);
  assert.notDeepEqual(child.stop, outer.stop);
  assert.equal(await browser.evaluate('document.querySelector("#listener-prompt").textContent'), child.prompt);
  assert(await browser.evaluate('(() => { const input = document.querySelector("#source").getBoundingClientRect(); const page = document.querySelector("#page").getBoundingClientRect(); return document.activeElement.id === "source" && input.top >= page.top && input.bottom <= page.bottom; })()'));
  await save('nested-operation-error');
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete'`);
  await browser.waitFor(`connected && !busy && listenerDebugger?.depth === 2 && same(listenerDebugger.stop, ${text(child.stop)})`);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(outer.stop)}) && !busy`);
  await frame(1);
  assert.deepEqual(await browser.evaluate('({text: document.querySelector("#source").value, start: document.querySelector("#source").selectionStart, end: document.querySelector("#source").selectionEnd})'), {text: parentDraft, start: 2, end: 7});
  assert.equal(await browser.evaluate(`views.get(${text(nested)}).info.state`), ':running');
  await save('outer-stop-restored');
  await command(':Proceed Default');
  assert.deepEqual((await completed(nested)).values, ['333']);
  evidence.checks.push('Debugger operation error -> child Abort -> original outer stop/draft -> continuation ->333, including reload');

  const interactive = await start(`(restart-case (error "${marker} interactive restart") (use-value (value) :report "Use an entered value." :interactive (lambda () (format *query-io* "${marker} replacement: ") (list (read *query-io*))) (+ value 7)))`);
  const noDefaultStop = await stopped(interactive);
  await browser.waitFor('returnedResult("restarts") && !stopCommandPending(listenerDebugger.stop) && !busy');
  assert.equal(await browser.evaluate('returnedResult("restarts").some(restart => restart["default-p"])'), false);
  const nextBeforeRejection = await browser.evaluate('stops.find(stop => same(stop.token, listenerDebugger.stop)).info["next-command-id"]');
  await fill('#source', ':Proceed');
  await key('Enter', 'Enter', 13);
  await browser.waitFor('state.pending.some(record => record.operation === "submit" && record.arguments.command === "proceed" && record.status === "rejected") && !busy');
  await browser.waitFor('[...document.querySelectorAll("#listener-debugger .restarts button")].every(button => !button.disabled) && !busy');
  const rejection = await browser.evaluate(`({session: state.session, connected, stop: listenerDebugger.stop,
    info: stops.find(stop => same(stop.token, listenerDebugger.stop)).info,
    pending: stopCommandPending(listenerDebugger.stop), draft: document.querySelector('#source').value,
    accepted: state.commands.some(command => same(command.stop, listenerDebugger.stop) && command.id === ${nextBeforeRejection}),
    message: document.body.innerText.includes('No default CONTINUE restart. Choose a restart or use :Proceed N.'),
    buttons: [...document.querySelectorAll('#listener-debugger .restarts button')].every(button => !button.disabled)})`);
  assert.equal(rejection.session, evidence.session);
  assert.equal(rejection.connected, true);
  assert.deepEqual(rejection.stop, noDefaultStop.stop);
  assert.equal(rejection.info.state, ':stopped');
  assert.equal(rejection.info.child, null);
  assert.equal(rejection.info['next-command-id'], nextBeforeRejection);
  assert.equal(rejection.pending, false);
  assert.equal(rejection.accepted, false);
  assert.equal(rejection.draft, ':Proceed');
  assert.equal(rejection.message, true);
  assert.equal(rejection.buttons, true);
  evidence.rejectedDefault = rejection;
  await save('no-default');
  const useValue = await browser.evaluate('returnedResult("restarts").find(restart => restart.name === "USE-VALUE")');
  await command(':Proceed ' + useValue.index);
  assert.equal(await browser.evaluate('latestCommand("invoke-restart-interactively").argument'), useValue.index);
  await browser.waitFor(`views.get(${text(interactive)})?.info['input-waiting-p']`);
  const interactiveParent = await browser.evaluate('listenerDebugger.stop');
  await browser.waitFor(`views.get(${text(interactive)})?.info['interruptible-p']
    && commandResults.get(commandKey(latestCommand('invoke-restart-interactively')))?.state === ':running'`);
  await clickText('[data-job="' + interactive + '"] .command-row', 'Interrupt');
  await stopped(interactive, 2);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(interactiveParent)}) && !busy`);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('invoke-restart-interactively'))).state"), ':unwound');
  await command(':Proceed ' + useValue.index);
  await browser.waitFor(`views.get(${text(interactive)})?.info['input-waiting-p']
    && commandResults.get(commandKey(latestCommand('invoke-restart-interactively')))?.state === ':running'`);
  const restartInput = '[data-job="' + interactive + '"] .input-form';
  await fill(restartInput + ' textarea', '35');
  await clickText(restartInput, 'Send Input');
  assert.deepEqual((await completed(interactive)).values, ['42']);
  evidence.checks.push('Blocked restart reader interrupt -> child Abort -> same condition stop -> retry reader and entered argument');
  evidence.checks.push('Missing default preserves stop, command ID, connection, draft, and enabled controls; explicit Proceed selects an interactive restart');

  const returningProceed = await start(`(restart-bind ((continue (lambda (value) (values value :continued)) :report-function (lambda (stream) (write-string "Return the entered value to this debugger." stream)) :interactive-function (lambda () (format *query-io* "${marker} proceed replacement: ") (list (read *query-io*))))) (error "${marker} returning Proceed"))`);
  const returningProceedStop = await stopped(returningProceed);
  await clickText('#listener-debugger .restarts', ':Proceed');
  await browser.waitFor(`views.get(${text(returningProceed)})?.info['input-waiting-p']`);
  const proceedInput = '[data-job="' + returningProceed + '"] .input-form';
  await fill(proceedInput + ' textarea', '81');
  await clickText(proceedInput, 'Send Input');
  await browser.waitFor(`document.querySelector('#listener-debugger .restart-values')?.textContent === ${text('Restart returned:\n81\n:CONTINUED')} && !busy`);
  assert.deepEqual(await browser.evaluate('listenerDebugger.stop'), returningProceedStop.stop);
  assert.equal(await browser.evaluate(`views.get(${text(returningProceed)}).info.state`), ':running');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, listenerDebugger.stop)).info.state'), ':stopped');
  assert.deepEqual(await browser.evaluate('commandResults.get(commandKey(latestCommand("proceed"))).result'), ['81', ':CONTINUED']);
  await save('returning-proceed');
  await command(':Abort');
  await completed(returningProceed, ':aborted');
  const afterProceed = await start('(+ 19 23)');
  assert.deepEqual((await completed(afterProceed)).values, ['42']);
  evidence.checks.push('Proceed button reads an argument and displays two returned values at the same stop; Abort and subsequent Listener evaluation succeed');

  const explicitArguments = await start(`(restart-case (error "${marker} explicit arguments") (use-value (value) :report "Use a value without an interactive reader." (+ value 7)))`);
  const explicitParent = await stopped(explicitArguments);
  await browser.waitFor('returnedResult("restarts") && !stopCommandPending(listenerDebugger.stop) && !busy');
  const explicitIndex = await browser.evaluate('returnedResult("restarts").find(restart => restart.name === "USE-VALUE").index');
  const explicitInput = '[data-job="' + explicitArguments + '"] .input-form';
  const explicitButton = ':Proceed ' + explicitIndex + ' :Arguments';
  await clickText('#listener-debugger .restarts', explicitButton);
  await browser.waitFor(`views.get(${text(explicitArguments)})?.info['input-waiting-p']`);
  const argumentsOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${argumentsOrigin} && document.readyState === 'complete'`);
  await browser.waitFor(`connected && !busy
    && same(listenerDebugger?.stop, ${text(explicitParent.stop)})
    && views.get(${text(explicitArguments)})?.info['input-waiting-p']`);
  await clickText('[data-job="' + explicitArguments + '"] .command-row', 'Interrupt');
  await stopped(explicitArguments, 2);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(explicitParent.stop)}) && !busy`);
  assert.equal(await browser.evaluate('commandResults.get(commandKey(latestCommand("invoke-restart-with-arguments"))).state'), ':unwound');
  await command(explicitButton + ' Yes');
  await browser.waitFor(`views.get(${text(explicitArguments)})?.info['input-waiting-p']`);
  await fill(explicitInput + ' textarea', `(error "${marker} argument expression error")`);
  await clickText(explicitInput, 'Send Input');
  await stopped(explicitArguments, 2);
  await browser.waitFor(`document.querySelector('#listener-debugger .condition')?.textContent.includes(${text(marker + ' argument expression error')})`);
  await save('argument-expression-error');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(explicitParent.stop)}) && !busy`);
  assert.equal(await browser.evaluate('commandResults.get(commandKey(latestCommand("invoke-restart-with-arguments"))).state'), ':unwound');
  await clickText('#listener-debugger .restarts', explicitButton);
  await browser.waitFor(`views.get(${text(explicitArguments)})?.info['input-waiting-p']`);
  await fill(explicitInput + ' textarea', '(list (+ 30 5))');
  await clickText(explicitInput, 'Send Input');
  assert.deepEqual((await completed(explicitArguments)).values, ['42']);
  evidence.checks.push('Required argument without interactive reader: Arguments button, reload during read, interrupt and child Abort, expression error and child Abort, then explicit argument exit');

  const argumentEvaluations = marker + '-ARGUMENT-EVALUATIONS';
  const restartInvocations = marker + '-RESTART-INVOCATIONS';
  const replayArguments = await start(`(let ((${argumentEvaluations} 0) (${restartInvocations} 0) (replacement 0)) (declare (special ${argumentEvaluations} ${restartInvocations})) (unwind-protect (catch :explicit-arguments-done (restart-bind ((continue (lambda (value) (incf ${restartInvocations}) (setf replacement value) (values replacement ${argumentEvaluations} ${restartInvocations})) :report-function (lambda (stream) (write-string "Return explicit arguments and invocation counts." stream))) (finish (lambda () (throw :explicit-arguments-done (list replacement ${argumentEvaluations} ${restartInvocations}))) :report-function (lambda (stream) (write-string "Finish with the retained argument and counters." stream)))) (error "${marker} argument replay"))) (unintern '${argumentEvaluations}) (unintern '${restartInvocations})))`);
  const replayParent = await stopped(replayArguments);
  await fill('#source', ':Proceed :Arg');
  await key(' ', 'Space', 32);
  await browser.waitFor('document.querySelector("#source").value === ":Proceed Default :Arguments " && !busy');
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments.command === 'invoke-restart-with-arguments') {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the accepted argument-command reply');
      }
      return response;
    };
  })()`);
  await key('Enter', 'Enter', 13);
  await browser.waitFor('!connected && !busy && state.pending.some(record => record.arguments.command === "invoke-restart-with-arguments" && record.status === "outcome unknown")');
  const argumentReceipt = await browser.evaluate('state.pending.find(record => record.arguments.command === "invoke-restart-with-arguments" && record.status === "outcome unknown")');
  assert.equal(argumentReceipt.arguments.argument, null);
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await browser.waitFor(`connected && !busy && views.get(${text(replayArguments)})?.info['input-waiting-p']`);
  assert.equal(await browser.evaluate('state.session'), argumentReceipt.session);
  const replayInput = '[data-job="' + replayArguments + '"] .input-form';
  await fill(replayInput + ' textarea', `(locally (declare (special ${argumentEvaluations})) (incf ${argumentEvaluations}) (list (* 6 7)))`);
  await clickText(replayInput, 'Send Input');
  await browser.waitFor(`!views.get(${text(replayArguments)})?.info['input-waiting-p'] && !busy`);
  await switchActivity('requests');
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row => row.textContent.includes(${text(JSON.stringify(argumentReceipt.arguments))})).querySelector('button').dataset.focusedTest = 'argument-replay'`);
  await browser.click('[data-focused-test="argument-replay"]');
  await browser.waitFor(`!state.pending.some(record => record.id === ${text(argumentReceipt.id)}) && !busy`);
  await switchActivity('listener');
  await browser.waitFor(`document.querySelector('#listener-debugger .restart-values')?.textContent === ${text('Restart returned:\n42\n1\n1')} && !busy`);
  assert.deepEqual(await browser.evaluate('listenerDebugger.stop'), replayParent.stop);
  assert.equal(await browser.evaluate(`state.commands.filter(command => same(command.stop, ${text(replayParent.stop)}) && command.id === ${argumentReceipt.arguments.id}).length`), 1);
  evidence.argumentReplay = argumentReceipt;
  await browser.evaluate('document.querySelector("#listener-debugger .restart-values").scrollIntoView({block: "center"})');
  await save('argument-replay-returned');
  await clickText('#listener-debugger .restarts', 'FINISH:');
  assert.deepEqual((await completed(replayArguments)).values, ['(42 1 1)']);
  const afterArguments = await start('(+ 20 22)');
  assert.deepEqual((await completed(afterArguments)).values, ['42']);
  evidence.checks.push('SPACE completes Arguments; default selection evaluates a dynamically bound expression once and invokes once across lost accepted reply and exact-request replay; returned values, exit, and subsequent Listener succeed');

  const returning = await start(`(let ((replacement 0) (abort-returned nil) (job-abort (find-restart 'abort))) (restart-bind ((use-value (lambda (value) (setf replacement value)) :report-function (lambda (stream) (write-string "Set the replacement and return to this debugger." stream)) :interactive-function (lambda () (format *query-io* "${marker} returning replacement: ") (list (read *query-io*)))) (no-values (lambda () (values)) :report-function (lambda (stream) (write-string "Return no values to this debugger." stream))) (abort (lambda () (if abort-returned (invoke-restart job-abort) (progn (setf abort-returned t) (values :abort-returned 9)))) :report-function (lambda (stream) (write-string "Return from the captured ABORT restart." stream)))) (cerror "Continue after returning restart." "${marker} returning restart")) replacement)`);
  const returningStop = await stopped(returning);
  await clickText('#listener-debugger .restarts', 'USE-VALUE');
  await browser.waitFor(`views.get(${text(returning)})?.info['input-waiting-p']`);
  const returningInput = '[data-job="' + returning + '"] .input-form';
  await fill(returningInput + ' textarea', '81');
  await clickText(returningInput, 'Send Input');
  await browser.waitFor("commandResults.get(commandKey(latestCommand('invoke-restart-interactively')))?.state === ':returned' && !busy");
  assert.deepEqual(await browser.evaluate('listenerDebugger.stop'), returningStop.stop);
  assert.equal(await browser.evaluate(`views.get(${text(returning)}).info.state`), ':running');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, listenerDebugger.stop)).info.state'), ':stopped');
  evidence.returningRestart = await browser.evaluate("commandResults.get(commandKey(latestCommand('invoke-restart-interactively')))");
  await browser.waitFor(`document.querySelector('#listener-debugger .restart-values')?.textContent === ${text('Restart returned:\n81')}`);
  await clickText('#listener-debugger .restarts', 'NO-VALUES');
  await browser.waitFor(`document.querySelector('#listener-debugger .restart-values')?.textContent === ${text('Restart returned:\n(No values)')}`);
  assert.deepEqual(await browser.evaluate('listenerDebugger.stop'), returningStop.stop);
  await command(':Abort');
  await browser.waitFor(`document.querySelector('#listener-debugger .restart-values')?.textContent === ${text('Restart returned:\n:ABORT-RETURNED\n9')}`);
  assert.deepEqual(await browser.evaluate('listenerDebugger.stop'), returningStop.stop);
  await proceed();
  assert.deepEqual((await completed(returning)).values, ['81']);
  evidence.checks.push('Returning interactive and typed Abort values, including zero values, are visible at the same stop; subsequent CONTINUE observes the entered value');
  const interrupted = await start(`(restart-bind ((use-value (lambda (value) (values value)) :report-function (lambda (stream) (write-string "Read a value inside the interruption debugger." stream)) :interactive-function (lambda () (format *query-io* "${marker} nested interrupt replacement: ") (list (read *query-io*))))) (read-line) 444)`);
  await browser.waitFor(`views.get(${text(interrupted)})?.info['input-waiting-p']`);
  await clickText('[data-job="' + interrupted + '"] .command-row', 'Interrupt');
  const interruptParent = await stopped(interrupted);
  const interruptId = await browser.evaluate(`views.get(${text(interrupted)}).info['interrupt-id']`);
  assert.equal(interruptId, 0);
  await clickText('#listener-debugger .restarts', 'USE-VALUE');
  await browser.waitFor(`views.get(${text(interrupted)})?.info['input-waiting-p']
    && views.get(${text(interrupted)}).info['interruptible-p']
    && commandResults.get(commandKey(latestCommand('invoke-restart-interactively')))?.state === ':running'`);
  await clickText('[data-job="' + interrupted + '"] .command-row', 'Interrupt');
  const nestedInterrupt = await stopped(interrupted, 2);
  assert.notDeepEqual(nestedInterrupt.stop, interruptParent.stop);
  assert.equal(await browser.evaluate(`views.get(${text(interrupted)}).info['interrupt-id']`), 1);
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(interruptParent.stop)}) && !busy`);
  assert.equal(await browser.evaluate(`views.get(${text(interrupted)}).info['interrupt-id']`), interruptId);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('invoke-restart-interactively'))).state"), ':unwound');
  await proceed();
  await browser.waitFor(`!listenerDebugger && views.get(${text(interrupted)})?.info['input-waiting-p']`);
  const originalInput = '[data-job="' + interrupted + '"] .input-form';
  await fill(originalInput + ' textarea', 'finish');
  await clickText(originalInput, 'Send Input');
  assert.deepEqual((await completed(interrupted)).values, ['444']);
  evidence.checks.push('Restart reader inside interrupt 0 -> interrupt 1 -> child Abort -> interrupt 0 -> CONTINUE and original input');
  await save('completed');
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
    const expected = browser.errors.filter(error => error.source === 'network' && error.url === new URL('/api', url).href && error.text.includes('status of 400'));
    assert.equal(expected.length, evidence.rejectedArguments ? 5 : 0);
    const missingDefault = browser.errors.filter(error => error.source === 'network' && error.url === new URL('/api', url).href && error.text.includes('status of 409'));
    assert.equal(missingDefault.length, (evidence.rejectedDefault ? 1 : 0) + (evidence.rejectedFrames?.length || 0));
    assert.deepEqual(browser.errors.filter(error => !expected.includes(error) && !missingDefault.includes(error)), []);
  } catch (cleanupError) {
    evidence.cleanupFailure = cleanupError.stack;
    throw cleanupError;
  } finally {
    evidence.jobs = jobs;
    evidence.stops = [...ownedStops.entries()];
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
