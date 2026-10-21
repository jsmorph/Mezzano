import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2];
assert(url, 'An explicit test Web server URL is required');
const output = resolve(process.argv[3] ?? '/tmp/find-frame-test');
const protectedStops = (process.env.PROTECTED_STOPS ?? process.env.PROTECTED_STOP ?? '')
  .split(',').filter(Boolean).map(Number);
assert(protectedStops.every(id => Number.isSafeInteger(id) && id >= 0));
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
const marker = 'FIND-FRAME-' + randomBytes(6).toString('hex').toUpperCase();
const functionName = marker + '-DESCEND';
const text = JSON.stringify;
const lispString = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const jobs = [];
const ownedStops = new Map();
const evidence = {marker, url, checks: [], cleanupActions: []};
let originalStops = [];
let passed = false;
let failure;
const finalizationErrors = [];

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
async function command(source, selector = '#source') {
  await fill(selector, source);
  await key('Enter', 'Enter', 13);
  await browser.waitFor(`document.querySelector(${text(selector)}).value !== ${text(source)} && !busy`, 60);
}
async function start(source) {
  const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
  await command(source);
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
async function idle() {
  await browser.waitFor('connected && !busy && !stopCommandPending(selectedStop) && !nextStopInspection(selectedStop)', 60);
}
async function stopped(name, depth = 1) {
  await browser.waitFor(`activeListenerJob === ${text(name)} && listenerDebugger?.depth === ${depth} && !busy`, 60);
  await idle();
  await rememberStops();
  return browser.evaluate('({stop: listenerDebugger.stop, prompt: listenerDebugger.prompt, depth: listenerDebugger.depth})');
}
async function completed(name) {
  await browser.waitFor(`views.get(${text(name)})?.info.state === ':returned' && activeListenerJob !== ${text(name)} && !busy`, 60);
  await rememberStops();
  return browser.evaluate(`views.get(${text(name)}).info`);
}
async function frame(index) {
  await browser.waitFor(`returnedFrameInspection()?.result.index === ${index} && !stopCommandPending(selectedStop) && !busy`);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), index);
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame.selected")?.textContent.split("  ")[0]'), String(index));
}
async function evaluation(source, expected) {
  const previous = await browser.evaluate("latestCommand('evaluate')?.id ?? -1");
  await command(source);
  await browser.waitFor(`latestCommand('evaluate')?.id > ${previous} && latestCommand('evaluate').argument === ${text(source)}
    && commandResults.get(commandKey(latestCommand('evaluate')))?.state === ':returned' && !busy`, 60);
  const result = await browser.evaluate("returnedResult('evaluate')");
  assert.deepEqual(result || [], expected);
}
async function findResult(previous, name) {
  await browser.waitFor(`latestCommand('find-frame')?.id > ${previous}
    && commandResults.get(commandKey(latestCommand('find-frame')))?.state === ':returned' && !busy`, 60);
  const request = await browser.evaluate("latestCommand('find-frame')");
  const result = await browser.evaluate("returnedResult('find-frame')");
  assert.equal(request.display, ':frame');
  assert.equal(request.argument[0], name);
  await frame(result.index);
  if (result.message) {
    assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame-message")?.textContent'), result.message);
    assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame-code, #stop-detail .locals, #stop-detail .frame-arguments")'), null);
  } else {
    assert.match(result.function, new RegExp(functionName));
    assert.match(result.arguments, /Original supplied arguments/);
    assert.match(result.arguments, /#<FIND-FRAME-PROBE>/);
    assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame-arguments")?.textContent'), result.arguments);
    assert.equal(await browser.evaluate('document.querySelector("#stop-detail .current-function")?.textContent'), result.function);
    assert.equal(Boolean(result['brief-p']), !Boolean(request.argument[1]));
    if (result['brief-p']) {
      assert(!result.locals?.length);
      assert(!result.code);
      assert.equal(await browser.evaluate('document.querySelector("#stop-detail .locals, #stop-detail .frame-code")'), null);
    }
  }
  return {request, result};
}
async function find(name = functionName, options = '', selector = '#source') {
  const previous = await browser.evaluate("latestCommand('find-frame')?.id ?? -1");
  await command(':Find Frame ' + text(name) + options, selector);
  return findResult(previous, name);
}
async function save(name) {
  await browser.screenshot(join(output, name + '.png'));
}
async function scrollCode(selector, expected, name) {
  const viewport = await browser.evaluate('({width: innerWidth, height: innerHeight})');
  await browser.send('Emulation.setDeviceMetricsOverride', {width: 360, height: viewport.height, deviceScaleFactor: 1, mobile: false});
  await browser.waitFor('innerWidth === 360 && !busy');
  const measurements = evidence[name] = {};
  measurements.before = await browser.evaluate(`(() => {
    const code = document.querySelector(${text(selector)});
    const style = getComputedStyle(code);
    const lines = code.textContent.split('\\n');
    const longest = lines.reduce((best, line, index) => line.length > lines[best].length ? index : best, 0);
    const start = lines.slice(0, longest).reduce((total, line) => total + line.length + 1, 0);
    const range = document.createRange();
    range.setStart(code.firstChild, start);
    range.setEnd(code.firstChild, start + lines[longest].length);
    window.findFrameCodeProbe = {element: code, range};
    code.scrollIntoView({block: 'start', inline: 'nearest'});
    code.scrollLeft = 0;
    const before = range.getBoundingClientRect();
    const rectangles = range.getClientRects().length;
    const maximum = code.scrollWidth - code.clientWidth;
    code.scrollLeft = maximum;
    const after = range.getBoundingClientRect();
    return {whiteSpace: style.whiteSpace, overflowX: style.overflowX,
      compiledCodeClass: code.classList.contains('compiled-code-result'),
      text: code.textContent, clientWidth: code.clientWidth, scrollWidth: code.scrollWidth,
      maximum, scrollLeft: code.scrollLeft, rectangles,
      lineShift: before.left - after.left, lineWidthBefore: before.width, lineWidthAfter: after.width};
  })()`);
  assert.equal(await browser.evaluate('(() => { let complete = false; return run(async () => { await refresh(); complete = true; }, {background: true}).then(() => complete); })()'), true);
  measurements.after = await browser.evaluate(`(() => {
    const code = document.querySelector(${text(selector)});
    const probe = window.findFrameCodeProbe;
    return {sameElement: code === probe.element, text: code.textContent,
      scrollLeft: code.scrollLeft, clientWidth: code.clientWidth, scrollWidth: code.scrollWidth,
      rectangles: probe.range.getClientRects().length, lineWidth: probe.range.getBoundingClientRect().width};
  })()`);
  await save(name);
  const {before, after} = measurements;
  assert.equal(before.compiledCodeClass, true);
  assert.equal(before.whiteSpace, 'pre');
  assert.equal(before.overflowX, 'auto');
  assert.equal(before.text, expected);
  assert.equal(before.rectangles, 1, 'A disassembly line wrapped into multiple layout rectangles');
  assert(before.clientWidth > 0 && before.clientWidth < 360);
  assert(before.maximum > 0, 'Expected the disassembly to overflow the narrow pane');
  assert.equal(before.scrollLeft, before.maximum);
  assert(Math.abs(before.lineShift - before.scrollLeft) < 1);
  assert.equal(before.lineWidthBefore, before.lineWidthAfter);
  assert.equal(after.sameElement, true, 'Refresh replaced the scrolled code element');
  assert.equal(after.text, expected);
  assert.equal(after.scrollLeft, before.scrollLeft, 'Refresh reset horizontal scrolling');
  assert.equal(after.clientWidth, before.clientWidth);
  assert.equal(after.scrollWidth, before.scrollWidth);
  assert.equal(after.rectangles, 1);
  assert.equal(after.lineWidth, before.lineWidthAfter);
  await browser.evaluate(`document.querySelector(${text(selector)}).scrollLeft = 0`);
  await save(name + '-left-edge');
  await browser.evaluate(`document.querySelector(${text(selector)}).scrollLeft = ${after.scrollLeft}`);
  await browser.send('Emulation.setDeviceMetricsOverride', {...viewport, deviceScaleFactor: 1, mobile: false});
  await browser.waitFor(`innerWidth === ${viewport.width} && innerHeight === ${viewport.height} && !busy`);
}
async function switchActivity(name) {
  await browser.click('#window-label');
  await browser.click('[data-activity="' + name + '"]');
  await browser.waitFor(`activity === ${text(name)} && !busy`);
}

try {
  await browser.send('Network.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.ok) {
        const failures = JSON.parse(sessionStorage.getItem('find-frame-http-failures') || '[]');
        failures.push({request: args[1]?.body, status: response.status, response: await response.clone().text()});
        sessionStorage.setItem('find-frame-http-failures', JSON.stringify(failures));
      }
      return response;
    };
  })()`});
  await browser.send('Page.navigate', {url});
  await browser.waitFor("document.readyState === 'complete' && typeof connected !== 'undefined' && connected && !busy");
  evidence.session = await browser.evaluate('state.session');
  originalStops = await browser.evaluate('stops.map(stop => ({id: stop.info.id, state: stop.info.state, generation: stop.info.generation, next: stop.info["next-command-id"]}))');
  for (const id of protectedStops) assert(originalStops.some(stop => stop.id === id), 'Protected stop missing: ' + id);
  const fixture = `(let ((cleanup (list 0)) (answer nil))
    (declaim (notinline ${functionName}))
    (defvar *fail-print* nil)
    (defclass probe () ())
    (defmethod print-object ((object probe) stream)
      (declare (special *fail-print*))
      (when *fail-print*
        (setf *fail-print* nil)
        (error "${marker} argument printer"))
      (write-string "#<FIND-FRAME-PROBE>" stream) object)
    (compile (defun ${functionName} (depth probe)
      (declare (optimize (debug 3) (safety 3) (speed 1)) (notinline ${functionName}))
      (if (zerop depth)
          (progn (cerror "Return from the owned frame search fixture." "${marker} fixture")
                 (assert (typep probe 'probe)) 0)
          (let ((answer (${functionName} (1- depth) probe)))
            (assert (typep probe 'probe)) (+ depth answer)))))
    (assert (compiled-function-p (symbol-function '${functionName})))
    (unwind-protect (setf answer (${functionName} 3 (make-instance 'probe)))
      (incf (car cleanup)))
    (assert (= (car cleanup) 1))
    (values answer (car cleanup)))`;
  const setup = `(progn
    (assert (null (find-package "${marker}")))
    (let ((package (make-package "${marker}" :use '("CL"))))
      (unwind-protect
           (let ((*package* package)) (eval (read-from-string ${lispString(fixture)})))
        (let* ((name (find-symbol "PROBE" package)) (class (and name (find-class name nil))))
          (when class
            (let ((method (find-method #'print-object nil (list class (find-class 't)) nil)))
              (when method (remove-method #'print-object method)))
            (setf (find-class name) nil)))
        (let ((name (find-symbol "${functionName}" package)))
          (when (and name (fboundp name)) (fmakunbound name)))
        (let ((name (find-symbol "*FAIL-PRINT*" package)))
          (when (and name (boundp name)) (makunbound name)))
        (delete-package package))))`;
  const targetJob = await start(setup);
  const parent = await stopped(targetJob);
  await browser.waitFor(`views.get(${text(targetJob)}).end === views.get(${text(targetJob)}).info['output-length'] && !busy`);
  evidence.fixtureOutput = await browser.evaluate(`views.get(${text(targetJob)}).text`);
  assert.doesNotMatch(evidence.fixtureOutput, /Style-Warning:/i, 'Owned fixture compilation emitted a style warning');
  evidence.parent = parent;
  const indices = await browser.evaluate(`returnedResult('frames').map((frame, index) => ({index, function: frame.function}))
    .filter(frame => frame.function.includes(${text(functionName)})).map(frame => frame.index)`);
  assert.equal(indices.length, 4, 'Expected four distinct compiled recursive activations');
  assert(indices[0] > 0);
  assert(indices.every((index, position) => position === 0 || index > indices[position - 1]));
  evidence.indices = indices;
  await command(':Top Of Stack');
  await frame(0);
  for (const value of [11, 21, 31]) await evaluation(`(values ${value} ${value + 1})`, [String(value), String(value + 1)]);
  const nextBeforeHelp = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]');
  await fill('#source', ':Find Fra');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value === ':Find Frame ' && !busy");
  await key('F12', 'F12', 123);
  await browser.waitFor("document.querySelector('#listener-assistance .argument-prompt')?.dataset.expectedType === ':string' && document.querySelector('#listener-assistance').textContent.includes('case-sensitive') && !busy");
  await fill('#source', ':Find Frame ' + functionName + ' :');
  await key('F12', 'F12', 123);
  await browser.waitFor("['Detailed', 'Invisible', 'Reverse'].every(name => [...document.querySelectorAll('#listener-assistance button')].some(button => button.textContent.includes(name))) && !busy");
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), nextBeforeHelp);
  await save('command-assistance');
  evidence.checks.push('SPACE completes Find Frame; F12 supplies string help and all Boolean keywords without accepting an ID');

  const lowercase = await find(functionName.toLowerCase());
  assert.equal(lowercase.result.index, 0);
  assert.match(lowercase.result.message, /No older frame name contains/);
  const forward = [];
  for (const [depth, index] of indices.entries()) {
    const match = await find();
    assert.equal(match.result.index, index);
    assert.deepEqual(match.request.argument.slice(1).map(Boolean), [false, false, false]);
    forward.push({index, arguments: match.result.arguments});
    await evaluation('depth', [String(depth)]);
  }
  const end = await find();
  assert.equal(end.result.index, indices.at(-1));
  assert.match(end.result.message, /No older frame name contains/);
  for (const index of indices.slice(0, -1).reverse()) assert.equal((await find(functionName, ' :Reverse')).result.index, index);
  const beginning = await find(functionName, ' :Reverse');
  assert.equal(beginning.result.index, indices[0]);
  assert.match(beginning.result.message, /No newer frame name contains/);
  const missing = await find(marker + '-ABSENT', ' :Reverse Yes');
  assert.equal(missing.result.index, indices[0]);
  evidence.forward = forward;
  evidence.checks.push('Four repeated executing names search older/newer, exclude the selected activation, preserve distinct arguments, match case, and stop at either boundary without wrapping');

  await command(':Top Of Stack');
  for (const value of [11, 21, 31]) await evaluation(`(values ${value} ${value + 1})`, [String(value), String(value + 1)]);
  const detailed = await find(functionName, ' :Detailed :Invisible No');
  assert.equal(detailed.result.index, indices[0]);
  assert.deepEqual(detailed.request.argument.slice(1).map(Boolean), [true, false, false]);
  assert(detailed.result.locals.some(local => local.name === 'DEPTH' && local['available-p'] && local.value === '0'));
  assert.match(detailed.result.code, /=> /);
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame-code")?.textContent'), detailed.result.code);
  assert(await browser.evaluate('[...document.querySelectorAll("#stop-detail .locals tr")].some(row => row.textContent.includes("DEPTH") && row.textContent.endsWith("0"))'));
  await browser.evaluate("document.querySelector('#stop-detail .current-function').scrollIntoView({block:'start'})");
  await save('detailed-frame');
  await scrollCode('#stop-detail .frame-code', detailed.result.code, 'detailed-frame-narrow-scrolled');
  await frame(indices[0]);
  const previousCode = await browser.evaluate("latestCommand('compiled-code')?.id ?? -1");
  await command(':Show Compiled Code');
  await browser.waitFor(`latestCommand('compiled-code')?.id > ${previousCode} && commandResults.get(commandKey(latestCommand('compiled-code')))?.state === ':returned' && !busy`, 60);
  const compiledCode = await browser.evaluate("returnedResult('compiled-code')");
  assert.equal(typeof compiledCode, 'string');
  await scrollCode('#stop-detail .compiled-code-result:not(.frame-code)', compiledCode, 'compiled-code-narrow-scrolled');
  await frame(indices[0]);
  evidence.checks.push('At 360 pixels, Detailed and ordinary compiled code preserve their element, text, horizontal scroll, and line layout across a real refresh; both checks restore the viewport');
  const commandIds = await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)');
  const recovery = await browser.evaluate(`(() => {
    const command = state.commands.find(command => same(command.stop, ${text(detailed.request.stop)}) && command.id === ${detailed.request.id});
    if (!command) throw new Error('Owned Detailed command descriptor is missing before the recovery test');
    const snapshot = {session: state.session, job: state.jobs[${text(targetJob)}].token,
      stop: selectedStop, next: stops.find(stop => same(stop.token, selectedStop)).info['next-command-id']};
    state.commands = state.commands.filter(item => item !== command);
    save();
    return snapshot;
  })()`);
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && typeof connected !== 'undefined' && connected && !busy`);
  await idle();
  await browser.waitFor("!nextHistoricalCommand() && !document.querySelector('#stop-detail .history-progress') && !busy", 60);
  await frame(indices[0]);
  assert.deepEqual(await browser.evaluate("returnedResult('find-frame')"), detailed.result);
  const recovered = await browser.evaluate("latestCommand('find-frame')");
  assert.equal(recovered.id, detailed.request.id);
  assert.equal(Object.hasOwn(recovered, 'display'), false);
  assert.equal(await browser.evaluate('state.session'), recovery.session);
  assert.deepEqual(await browser.evaluate(`state.jobs[${text(targetJob)}].token`), recovery.job);
  assert.deepEqual(await browser.evaluate('selectedStop'), recovery.stop);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), recovery.next);
  assert.deepEqual(await browser.evaluate('state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)'), commandIds);
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame-arguments")?.textContent'), detailed.result.arguments);
  assert(await browser.evaluate('[...document.querySelectorAll("#stop-detail .locals tr")].some(row => row.textContent.includes("DEPTH") && row.textContent.endsWith("0"))'));
  assert.equal(await browser.evaluate('document.querySelector("#stop-detail .frame-code")?.textContent'), detailed.result.code);
  await save('recovered-frame-without-client-metadata');
  evidence.recovery = {before: recovery, recoveredCommand: recovered};
  await evaluation('(values * + ++ +++ ** *** / // ///)', ['31', '(VALUES 31 32)', '(VALUES 21 22)', '(VALUES 11 12)', '21', '11', '(31 32)', '(21 22)', '(11 12)']);
  evidence.checks.push('Reload recovers the removed owned command descriptor from its original guest ID, restores arguments/locals/code without client display metadata, and preserves session/job/selection/IDs/next-ID and all nine histories');

  const beforeReject = await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]');
  const rejectedSource = ':Find Frame ' + functionName + ' :Invisible';
  await fill('#source', rejectedSource);
  await key('Enter', 'Enter', 13);
  await browser.waitFor("!busy && state.pending.some(record => record.arguments.command === 'find-frame' && record.status === 'rejected')");
  assert.equal(await browser.evaluate('connected'), true);
  assert.equal(await browser.evaluate('document.querySelector("#source").value'), rejectedSource);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), beforeReject);
  await frame(indices[0]);
  await find(functionName, ' :Detailed No :Invisible No');
  await frame(indices[1]);
  evidence.checks.push('Invisible mentioned alone reports unsupported, preserves connection/editor/selection, accepts no ID, and permits a supported search');

  await switchActivity('debugger');
  const beforeMenu = await browser.evaluate('({next: stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"], draft: document.querySelector("#source").value})');
  const previousMenuSearch = await browser.evaluate("latestCommand('find-frame')?.id ?? -1");
  await browser.click('#window-label');
  const menuEntry = "[...document.querySelectorAll('#debugger-menu button')].find(button => button.textContent === ':Find Frame' && !button.disabled && button.getClientRects().length)";
  await browser.waitFor(menuEntry);
  await browser.evaluate(`${menuEntry}.dataset.findFrameTest = 'menu'`);
  await browser.click('[data-find-frame-test="menu"]');
  await browser.evaluate("document.querySelector('[data-find-frame-test=menu]')?.removeAttribute('data-find-frame-test')");
  await browser.waitFor("document.querySelector('#debugger-command').value === ':Find Frame ' && document.activeElement.id === 'debugger-command' && document.querySelector('#debugger-assistance .argument-prompt')?.dataset.expectedType === ':string' && document.querySelector('#debugger-assistance').textContent.includes('case-sensitive') && !busy");
  assert.equal(await browser.evaluate('document.querySelector("#source").value'), beforeMenu.draft);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["next-command-id"]'), beforeMenu.next);
  await browser.send('Input.insertText', {text: functionName});
  assert.equal(await browser.evaluate('document.querySelector("#debugger-command").value'), ':Find Frame ' + functionName);
  await key('Enter', 'Enter', 13);
  const menuSearch = await findResult(previousMenuSearch, functionName);
  assert.deepEqual(menuSearch.request.argument.slice(1).map(Boolean), [false, false, false]);
  assert.equal(menuSearch.result.index, indices[2]);
  assert.equal(await browser.evaluate('document.querySelector("#debugger-command").value'), '');
  await save('standalone-search');
  evidence.checks.push('The actual Find Frame menu prefills and focuses the standalone editor with guest assistance, preserves the Listener draft/command ID, and submits a default forward search');
  await switchActivity('listener');
  await command(':Top Of Stack');
  await frame(0);
  await evaluation('(setq *fail-print* t)', ['T']);
  const beforePrinter = await browser.evaluate("latestCommand('find-frame')?.id ?? -1");
  await command(':Find Frame ' + functionName);
  const child = await stopped(targetJob, 2);
  assert.match(await browser.evaluate("returnedResult('condition')"), new RegExp(marker + ' argument printer'));
  assert.equal(await browser.evaluate(`stops.find(stop => same(stop.token, ${text(parent.stop)})).info['current-frame']`), indices[0]);
  await save('argument-printer-child');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(parent.stop)}) && !busy`, 60);
  await idle();
  const failedSearch = await browser.evaluate("latestCommand('find-frame')");
  assert(failedSearch.id > beforePrinter);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('find-frame'))).state"), ':unwound');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), indices[0]);
  await command(':Top Of Stack');
  await find();
  await frame(indices[0]);
  await save('argument-printer-recovered');
  evidence.child = child;
  evidence.checks.push('The standalone editor uses the same search; an argument printer enters a child, typed Abort preserves the matched parent selection, and retry succeeds');

  const lastFrame = await browser.evaluate('returnedFrameInspection()');
  await command(':Proceed');
  evidence.continued = await completed(targetJob);
  assert.deepEqual(evidence.continued.values, ['6', '1']);
  await switchActivity('debugger');
  await browser.waitFor(`same(selectedStop, ${text(parent.stop)}) && stops.find(stop => same(stop.token, selectedStop))?.info.state === ':closed' && !busy`);
  const closed = await browser.evaluate(`({frame: returnedFrameInspection(),
    recorded: document.querySelector('#stop-detail .recorded-frame')?.textContent,
    arguments: document.querySelector('#stop-detail .frame-arguments')?.textContent,
    function: document.querySelector('#stop-detail .current-function')?.textContent,
    code: document.querySelector('#stop-detail .compiled-code-result:not(.frame-code)')?.textContent,
    editorDisabled: document.querySelector('#debugger-command').disabled,
    framesDisabled: [...document.querySelectorAll('#stop-detail .frame')].map(button => button.disabled),
    liveMenu: [...document.querySelectorAll('#debugger-menu button')].filter(button =>
      [':Find Frame', ':Next Frame', ':Previous Frame', ':Top Of Stack', ':Bottom Of Stack'].includes(button.textContent)).map(button => button.textContent)})`);
  assert.deepEqual(closed.frame, lastFrame);
  assert.equal(closed.recorded, 'Recorded frame ' + lastFrame.result.index + ' from this closed stop.');
  assert.equal(closed.arguments, lastFrame.result.arguments);
  assert.equal(closed.function, lastFrame.result.function);
  assert.equal(closed.code, compiledCode);
  assert.equal(closed.editorDisabled, true);
  assert(closed.framesDisabled.length > 0 && closed.framesDisabled.every(Boolean));
  assert.deepEqual(closed.liveMenu, []);
  evidence.closedStop = closed;
  await save('recorded-closed-frame');
  await switchActivity('listener');
  evidence.checks.push('The same retained closed stop labels its last frame as recorded, preserves argument/function/code text, disables frame buttons/editor, and omits live navigation');
  const next = await start(`(progn (assert (null (find-package "${marker}"))) (+ 20 22))`);
  assert.deepEqual((await completed(next)).values, ['42']);
  await save('continued-listener');
  evidence.checks.push('Proceed returns 6 after one cleanup, removes the owned package/definitions, and the next Listener evaluation returns 42');
  const failures = await browser.evaluate("JSON.parse(sessionStorage.getItem('find-frame-http-failures') || '[]')");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].status, 409);
  assert.deepEqual(JSON.parse(failures[0].response), {error: ':unsupported-invisible-frames', uncertain: false});
  assert.equal(browser.errors.length, 1);
  assert.match(browser.errors[0].text, /409/);
  await browser.evaluate('connected = false; activity = "requests"');
  for (const name of jobs) {
    const token = await browser.evaluate(`state.jobs[${text(name)}].token`);
    const info = await browser.evaluate(`api('job-information', {job: ${text(token)}})`);
    assert.equal(info.state, ':returned');
    assert(!info.stops?.length, 'Completed owned job still has an active stop');
    await browser.evaluate(`api('release-job', {job: ${text(token)}})`);
    evidence.cleanupActions.push({operation: 'release-job', name});
  }
  for (const [id, token] of ownedStops) {
    const detail = await browser.evaluate(`api('information', {stop: ${text(token)}})`);
    assert.equal(detail.id, id);
    assert.equal(detail.state, ':closed');
    await browser.evaluate(`api('release-stop', {stop: ${text(token)}})`);
    evidence.cleanupActions.push({operation: 'release-stop', id});
  }
  const remaining = await browser.evaluate("api('stops', {include_closed: true})");
  const protectedAfter = [];
  for (const token of remaining || []) {
    const detail = await browser.evaluate(`api('information', {stop: ${text(token)}})`);
    if (protectedStops.includes(detail.id)) protectedAfter.push({id: detail.id, state: detail.state, generation: detail.generation, next: detail['next-command-id']});
  }
  for (const id of protectedStops) assert.deepEqual(protectedAfter.find(stop => stop.id === id), originalStops.find(stop => stop.id === id));
  await browser.evaluate("api('release-session')");
  evidence.cleanupActions.push({operation: 'release-session'});
  evidence.protectedStops = protectedAfter;
  evidence.cleanup = 'Owned jobs, closed stops, and session released';
  passed = true;
} catch (error) {
  failure = error;
  evidence.failure = error.stack;
  const captures = await Promise.allSettled([
    save('failure'),
    browser.evaluate('JSON.stringify(sessionStorage)').then(value => writeFile(join(output, 'failure-state.json'), value)),
    browser.evaluate('document.body.innerText').then(value => writeFile(join(output, 'failure.txt'), value)),
    rememberStops(),
  ]);
  finalizationErrors.push(...captures.filter(result => result.status === 'rejected').map(result => result.reason));
  evidence.cleanup = 'Stopped after failure; no further guest cleanup attempted';
} finally {
  evidence.jobs = jobs;
  evidence.stops = [...ownedStops.entries()];
  evidence.errors = browser.errors;
  evidence.network = browser.network;
  evidence.chromium = browser.processEvents;
  try {
    evidence.httpFailures = await browser.evaluate("JSON.parse(sessionStorage.getItem('find-frame-http-failures') || '[]')");
  } catch (error) {
    finalizationErrors.push(error);
  }
  try {
    await browser.close();
  } catch (error) {
    finalizationErrors.push(error);
  }
  evidence.finalizationFailures = finalizationErrors.map(error => error.stack || String(error));
  evidence.passed = passed && !failure && finalizationErrors.length === 0;
  try {
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  } catch (error) {
    finalizationErrors.push(error);
  }
}
if (failure && finalizationErrors.length) {
  throw new AggregateError([failure, ...finalizationErrors], 'Find Frame test and evidence collection failed', {cause: failure});
}
if (failure) throw failure;
if (finalizationErrors.length) throw new AggregateError(finalizationErrors, 'Find Frame evidence collection failed');
console.log(JSON.stringify(evidence, null, 2));
