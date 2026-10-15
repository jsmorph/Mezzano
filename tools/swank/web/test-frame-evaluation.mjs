import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? '/tmp/frame-evaluation-test');
const protectedStops = (process.env.PROTECTED_STOPS ?? process.env.PROTECTED_STOP ?? '')
  .split(',').filter(Boolean).map(Number);
assert(protectedStops.every(id => Number.isSafeInteger(id) && id >= 0));
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
async function codeCommand(operation, label, completion, menu = false) {
  const previous = await browser.evaluate(`latestCommand(${text(operation)})?.id ?? -1`);
  if (menu) {
    await browser.click('#window-label');
    await clickText('#debugger-menu', label);
  } else {
    await fill('#source', completion);
    await key(' ', 'Space', 32);
    await browser.waitFor(`document.querySelector('#source').value.trim() === ${text(label)} && !busy`);
    await key('Enter', 'Enter', 13);
  }
  await browser.waitFor(`latestCommand(${text(operation)})?.id > ${previous}
    && commandResults.get(commandKey(latestCommand(${text(operation)})))?.state === ':returned' && !busy`, 60);
  const result = await browser.evaluate(`commandResults.get(commandKey(latestCommand(${text(operation)}))).result`);
  assert.equal(typeof result, 'string');
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.${operation}-result')].at(-1).textContent`), result);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), evidence.frame);
  return result;
}
async function seedHistory() {
  for (const value of [11, 21, 31]) await evaluation(`(values ${value} ${value + 1})`, [String(value), String(value + 1)]);
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
  originalStops = await browser.evaluate('stops.map(stop => ({id: stop.info.id, state: stop.info.state, generation: stop.info.generation, next: stop.info["next-command-id"]}))');
  for (const id of protectedStops) assert(originalStops.some(stop => stop.id === id), 'Protected stop missing: ' + id);
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
    (let* ((info (mezzano.internals::function-debug-info (symbol-function '${caller})))
           (scopes (nth 10 info)))
      (assert scopes)
      (unwind-protect
           (progn (setf (nth 10 info) nil) (${caller}))
        (setf (nth 10 info) scopes)
        (assert (eq (nth 10 info) scopes)))))
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
  const originalCode = await codeCommand('compiled-code', ':Show Compiled Code', ':Show Compiled C');
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
  const history = ['(VALUES 31 32)', '(VALUES 21 22)', '(VALUES 11 12)', '21', '11', '(31 32)', '(21 22)', '(11 12)'];
  await seedHistory();
  evidence.code = {compiled: [], instructions: [], functions: []};
  for (const menu of [false, true]) {
    const compiled = await codeCommand('compiled-code', ':Show Compiled Code', ':Show Compiled C', menu);
    assert(compiled.startsWith('Compiled code for '));
    assert(compiled.includes(target));
    assert.equal(compiled, originalCode, 'Global redefinition must preserve the selected executing function code');
    assert.match(compiled, /\n(?: L[0-9]+)? +#x0010: [0-9A-F]/);
    const labels = new Set([...compiled.matchAll(/^ L([0-9]+)\s+#x/gm)].map(match => match[1]));
    const branches = [...compiled.matchAll(/\(J[A-Z]+ L([0-9]+)\)/g)].map(match => match[1]);
    assert(branches.length > 0, 'The target must contain labelled branches');
    assert(branches.every(label => labels.has(label)), 'Every branch label must have a displayed definition');
    evidence.code.compiled.push(compiled);
    const instruction = await codeCommand('instruction', ':Show Instruction', ':Show Instr', menu);
    assert(instruction.startsWith('Saved caller location in '));
    assert(instruction.includes(target));
    assert.match(instruction, /at byte offset #x[0-9A-F]+ \(instruction starts at #x[0-9A-F]+\):\n(?: L[0-9]+)? +#x[0-9A-F]+: /);
    evidence.code.instructions.push(instruction);
  }
  await evaluation('(values * + ++ +++ ** *** / // ///)', ['31', ...history]);
  evidence.checks.push('Compiled Code and Instruction completion/menu actions display selected executing code and saved caller location after global redefinition, preserving selection and all nine history slots');

  await seedHistory();
  for (const menu of [false, true]) {
    const displayed = await codeCommand('function', ':Show Function', ':Show Fun', menu);
    assert(displayed.startsWith('Function = '));
    assert(displayed.includes(target));
    evidence.code.functions.push(displayed);
  }
  await evaluation(`(values (functionp *) (eq * (fdefinition '${target})) + ++ +++ ** *** / // ///)`, ['T', 'NIL', ...history]);
  await codeCommand('function', ':Show Function', ':Show Fun');
  await command(':Inspect');
  await browser.waitFor("commandResults.get(commandKey(latestCommand('inspect')))?.state === ':returned' && !busy");
  evidence.code.inspection = await browser.evaluate("commandResults.get(commandKey(latestCommand('inspect'))).result");
  assert(evidence.code.inspection.title.includes(target));
  assert.equal(await browser.evaluate("document.querySelector('.inspection-title').textContent"), evidence.code.inspection.title);
  evidence.checks.push('Show Function completion/menu assigns the old active function only to *, preserves the other eight history slots, and supplies that object to Inspect');
  await browser.send('Emulation.setDeviceMetricsOverride', {width: 640, height: 900, deviceScaleFactor: 1, mobile: false});
  evidence.code.layout = await browser.evaluate(`['compiled-code','instruction'].map(name => {
    const element = [...document.querySelectorAll('.' + name + '-result')].at(-1);
    const style = getComputedStyle(element);
    return {name, whitespace: style.whiteSpace, overflow: style.overflowX, client: element.clientWidth, scroll: element.scrollWidth};
  })`);
  for (const layout of evidence.code.layout) {
    assert.equal(layout.whitespace, 'pre');
    assert.equal(layout.overflow, 'auto');
    assert(layout.scroll > layout.client, layout.name + ' must scroll its long code line');
  }
  await browser.evaluate("[...document.querySelectorAll('.instruction-result')].at(-1).scrollIntoView({block:'center'})");
  await save('instruction-horizontal-scroll');
  await browser.send('Emulation.clearDeviceMetricsOverride');
  await browser.evaluate("[...document.querySelectorAll('.compiled-code-result')].at(-1).scrollIntoView({block:'start'})");
  await save('compiled-code');
  evidence.code.retained = await browser.evaluate("[...document.querySelectorAll('.compiled-code-result,.instruction-result,.function-result')].map(element => element.textContent)");
  evidence.code.commands = await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop) && ['function','compiled-code','instruction'].includes(command.command)).map(command => command.id)");
  await evaluation('(values)', []);
  await evaluation('(values * /)', ['NIL', 'NIL']);
  const beforeReload = await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)");
  const origin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#stop-detail .debugger-evaluation')].map(row => row.textContent)"), beforeReload);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.arglist-result')].map(element => element.textContent)"), evidence.arglists);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.bindings-result')].map(element => element.textContent)"), evidence.bindings.retained);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.compiled-code-result,.instruction-result,.function-result')].map(element => element.textContent)"), evidence.code.retained);
  assert.deepEqual(await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop) && ['function','compiled-code','instruction'].includes(command.command)).map(command => command.id)"), evidence.code.commands);
  evidence.checks.push('Multiple and zero values, per-stop history, and ordered retained form results survive browser reload');

  await rejected('(setq x "wrong")', /FIXNUM/, true);
  await evaluation('x', ['41']);
  await rejected('#.(setq x 99)', null);
  await evaluation('x', ['41']);
  await rejected('(setq x 99) 42', /EXPECTED-ONE-FORM/);
  await evaluation('x', ['41']);
  evidence.checks.push('Type and reader errors enter child stops; typed Abort preserves the parent, history, and unchanged binding');

  const unavailable = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.startsWith(${text('#<Compiled-Function ' + caller + ' ')}))`);
  assert(unavailable >= 0, 'Owned caller with missing scope metadata was not found');
  await command(':Set Current Frame ' + unavailable);
  await frame(unavailable);
  await rejected('42', /UNAVAILABLE-LEXICAL-SCOPE/);
  await selectTarget();
  await evaluation('x', ['41']);
  evidence.checks.push('Owned caller with cleared scope metadata rejects evaluation and permits recovery to the compiled target; unwind cleanup restores its metadata');

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
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.compiled-code-result,.instruction-result,.function-result')].map(element => element.textContent)"), evidence.code.retained);
  evidence.checks.push('Function/code/instruction results retain columns with horizontal scrolling, survive reload without another command, and remain printed after the stop closes');
  await save('closed-history');
  await switchActivity('listener');
  const codeTarget = marker + '-CODE-TARGET';
  targetJob = await start(`(unwind-protect
    (let ((probe (make-instance 'lispm-describe-test:probe :value 42)))
      (multiple-value-bind (name warnings failure)
          (compile '${codeTarget}
            \`(lambda ()
               (declare (mezzano.internals::lambda-name ${codeTarget})
                        (optimize (debug 3) (safety 3) (speed 1)))
               (let ((probe ',probe))
                 (break "${marker} code printer")
                 (values (slot-value probe 'lispm-describe-test::value) 43))))
        (declare (ignore name))
        (assert (not (or warnings failure))))
      (assert (compiled-function-p (fdefinition '${codeTarget})))
      (funcall (fdefinition '${codeTarget})))
    (when (fboundp '${codeTarget}) (fmakunbound '${codeTarget}))
    (unintern '${codeTarget}))`);
  const codeParent = await stopped(targetJob);
  const codeFrame = await selectTarget('#source', codeTarget);
  const codePrinterError = marker + ' code constant printer';
  await evaluation(`(progn (setf (slot-value probe 'lispm-describe-test::failure)
    (make-condition 'simple-error :format-control "${codePrinterError}")) (values))`, []);
  await command(':Show Compiled Code');
  await stopped(targetJob, 2);
  assert.equal(await browser.evaluate("returnedResult('condition')"), codePrinterError);
  await save('code-printer-error');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(codeParent.stop)}) && !busy`);
  await stopped(targetJob);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('compiled-code'))).state"), ':unwound');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.compiled-code-result')].at(-1).textContent"), 'unwound');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), codeFrame);
  await evaluation("(progn (setf (slot-value probe 'lispm-describe-test::failure) nil) (values))", []);
  await command(':Show Compiled Code');
  await browser.waitFor("commandResults.get(commandKey(latestCommand('compiled-code')))?.state === ':returned' && !busy");
  evidence.code.printerRecovered = await browser.evaluate("commandResults.get(commandKey(latestCommand('compiled-code'))).result");
  assert(evidence.code.printerRecovered.includes('DESCRIPTION-PROBE'));
  assert(evidence.code.printerRecovered.includes(codeTarget));
  await browser.evaluate("[...document.querySelectorAll('.compiled-code-result')].at(-1).scrollIntoView({block:'start'})");
  await save('code-printer-recovered');
  await command(':Proceed');
  assert.deepEqual((await completed(targetJob)).values, ['42', '43']);
  evidence.checks.push('Compiled constant printer error enters a child; typed Abort preserves the selected parent frame, repair permits code display, and Proceed returns 42/43');
  const largeTarget = marker + '-LARGE-TARGET', largeSink = marker + '-LARGE-SINK';
  const largeLast = '*' + marker + '-LARGE-LAST*';
  targetJob = await start(`(unwind-protect (progn
    (defparameter ${largeLast} nil)
    (defun ${largeSink} (value) (setq ${largeLast} value))
    (multiple-value-bind (name warnings failure)
        (compile '${largeTarget}
          \`(lambda ()
             (declare (mezzano.internals::lambda-name ${largeTarget})
                      (notinline ${largeSink})
                      (optimize (debug 3) (safety 3) (speed 1)))
             (break "${marker} large disassembly")
             ,@(loop for value below 1000 collect (list '${largeSink} value))
             (values 42 43)))
      (declare (ignore name))
      (assert (not (or warnings failure))))
    (multiple-value-prog1 (funcall (fdefinition '${largeTarget}))
      (assert (= ${largeLast} 999))))
    (dolist (name '(${largeTarget} ${largeSink})) (when (fboundp name) (fmakunbound name)))
    (when (boundp '${largeLast}) (makunbound '${largeLast}))
    (dolist (name '(${largeTarget} ${largeSink} ${largeLast})) (unintern name)))`);
  await stopped(targetJob);
  const largeFrame = await selectTarget('#source', largeTarget);
  const expectedLarge = `(let* ((context (mezzano.disassemble:make-disassembler-context (fdefinition '${largeTarget})))
    (instructions (mezzano.disassemble:context-instructions context)))
    (values (length instructions) (mezzano.disassemble:inst-offset (aref instructions (1- (length instructions))))))`;
  await command(expectedLarge);
  await browser.waitFor("commandResults.get(commandKey(latestCommand('evaluate')))?.state === ':returned' && !busy");
  const expectedRows = await browser.evaluate("commandResults.get(commandKey(latestCommand('evaluate'))).result.map(Number)");
  assert(expectedRows.every(value => Number.isSafeInteger(value) && value > 0));
  await evaluation('(values 81 82)', ['81', '82']);
  await command(':Show Compiled Code');
  await browser.waitFor("commandResults.get(commandKey(latestCommand('compiled-code')))?.state === ':returned' && !busy", 60);
  const largeCode = await browser.evaluate("commandResults.get(commandKey(latestCommand('compiled-code'))).result");
  assert(largeCode.length > 65536);
  const largeRows = largeCode.split('\n').filter(line => /^(?: L[0-9]+)? +#x[0-9A-F]+:/.test(line));
  assert.equal(largeRows.length, expectedRows[0]);
  assert(largeRows.at(-1).includes('#x' + expectedRows[1].toString(16).toUpperCase().padStart(4, '0') + ':'));
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.compiled-code-result')].at(-1).textContent"), largeCode);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), largeFrame);
  await evaluation(`(values * / + ${largeLast})`, ['81', '(81 82)', '(VALUES 81 82)', 'NIL']);
  const largeId = await browser.evaluate("latestCommand('compiled-code').id");
  const largeOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${largeOrigin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  assert.equal(await browser.evaluate("latestCommand('compiled-code').id"), largeId);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.compiled-code-result')].at(-1).textContent"), largeCode);
  await browser.evaluate("[...document.querySelectorAll('.compiled-code-result')].at(-1).scrollIntoView({block:'end'})");
  await save('large-code-terminal-instruction');
  await writeFile(join(output, 'large-code.txt'), largeCode);
  evidence.largeCode = {characters:largeCode.length, rows:largeRows.length, lastOffset:expectedRows[1],
    terminal:largeRows.at(-1), sha256:createHash('sha256').update(largeCode).digest('hex'), frame:largeFrame, commandId:largeId};
  await command(':Proceed');
  assert.deepEqual((await completed(targetJob)).values, ['42', '43']);
  evidence.checks.push('Disassembly above 64 KiB contains every decoded row and terminal instruction, preserves history and selection, survives reload without another command, and Proceed returns 42/43 after all 1000 sink calls');
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
  const controlTarget = marker + '-CONTROL-TARGET', controlBody = marker + '-CONTROL-BODY';
  const controlInner = marker + '-CONTROL-INNER', controlOuter = marker + '-CONTROL-OUTER';
  const controlCount = '*' + marker + '-CONTROL-COUNT*', controlCleanup = '*' + marker + '-CONTROL-CLEANUP*';
  const controlFunctions = [controlTarget, controlBody, controlInner, controlOuter];
  const controlSymbols = [...controlFunctions, controlCount, controlCleanup];
  targetJob = await start(`(unwind-protect (progn
    (defun ${controlOuter} (condition)
      (declare (ignore condition) (special ${controlCount})
               (optimize (debug 3) (safety 3) (speed 1)))
      (incf ${controlCount}))
    (defun ${controlInner} (condition)
      (declare (ignore condition) (optimize (debug 3) (safety 3) (speed 1)))
      (break "${marker} selected condition handler"))
    (defun ${controlBody} ()
      (declare (optimize (debug 3) (safety 3) (speed 1)))
      (break "${marker} condition handler body")
      (signal 'simple-warning :format-control "${marker} owned warning")
      42)
    (defun ${controlTarget} ()
      (declare (notinline ${controlBody}) (optimize (debug 3) (safety 3) (speed 1)))
      (let ((${controlCount} 0) (${controlCleanup} 0))
        (declare (special ${controlCount} ${controlCleanup}))
        (let ((value (unwind-protect
                       (handler-bind ((warning #'${controlOuter}))
                         (handler-bind ((simple-warning #'${controlInner}))
                           (${controlBody})))
                       (incf ${controlCleanup}))))
          (values value ${controlCount} ${controlCleanup}))))
    (assert (every (lambda (name) (compiled-function-p (symbol-function name)))
                   '(${controlFunctions.join(' ')})))
    (${controlTarget}))
    (dolist (name '(${controlFunctions.join(' ')})) (when (fboundp name) (fmakunbound name)))
    (dolist (name '(${controlCount} ${controlCleanup})) (assert (not (boundp name))))
    (dolist (name '(${controlSymbols.join(' ')})) (unintern name)))`);
  const controlParent = await stopped(targetJob);
  const bodyFrame = await selectTarget('#source', controlBody);
  evidence.handlerDisplay = {bodyStop:controlParent.stop, bodyFrame};
  await evaluation('(values 80 81)', ['80', '81']);
  async function handlersAfter(previous, expectedFrame) {
    await browser.waitFor(`latestCommand('handlers')?.id > ${previous} && commandResults.get(commandKey(latestCommand('handlers')))?.state === ':returned' && !busy`);
    const value = await browser.evaluate("commandResults.get(commandKey(latestCommand('handlers'))).result");
    assert.equal(await browser.evaluate("[...document.querySelectorAll('.handlers-result')].at(-1).textContent"), value);
    assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), expectedFrame);
    return value;
  }
  async function showHandlers(source, expectedFrame) {
    const previous = await browser.evaluate("latestCommand('handlers')?.id ?? -1");
    await command(source);
    return handlersAfter(previous, expectedFrame);
  }
  function ownHandlers(value) {
    return value.split(/(?=^Frame \d+ )/m).flatMap(block => {
      const heading = /^Frame (\d+) (.*):\n/.exec(block);
      return block.split('\n').filter(line => line.startsWith('  Handler for ')
        && (line.includes(controlInner) || line.includes(controlOuter)))
        .map(line => {
          assert(heading, 'Handler row has no frame heading');
          return {index:Number(heading[1]), owner:heading[2], line};
        });
    });
  }
  await fill('#source', ':Show Condition Hand');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value.startsWith(':Show Condition Handlers') && !busy");
  await key('Enter', 'Enter', 13);
  evidence.handlerDisplay.empty = await handlersAfter(-1, bodyFrame);
  assert(evidence.handlerDisplay.empty.startsWith('Frame ' + bodyFrame + ' '));
  assert(evidence.handlerDisplay.empty.endsWith('  No condition handlers.\n'));
  evidence.handlerDisplay.bodyAll = await showHandlers(':Show Condition Handlers :All', bodyFrame);
  assert.equal(await browser.evaluate("latestCommand('handlers').argument"), true);
  const bodyHandlers = ownHandlers(evidence.handlerDisplay.bodyAll);
  assert.equal(bodyHandlers.length, 2);
  assert(bodyHandlers[0].line.includes('Handler for SIMPLE-WARNING: ') && bodyHandlers[0].line.includes(controlInner));
  assert(bodyHandlers[1].line.includes('Handler for WARNING: ') && bodyHandlers[1].line.includes(controlOuter));
  assert(bodyHandlers.every(row => row.line.endsWith(' [active]') && row.owner.includes('%HANDLER-BIND')));
  assert(bodyHandlers[0].index < bodyHandlers[1].index);
  assert.equal(await showHandlers(':Show Condition Handlers :All Yes', bodyFrame), evidence.handlerDisplay.bodyAll);
  assert.equal(await showHandlers(':Show Condition Handlers :All No', bodyFrame), evidence.handlerDisplay.empty);
  for (const row of bodyHandlers) {
    await command(':Set Current Frame ' + row.index);
    await frame(row.index);
    assert.deepEqual(ownHandlers(await showHandlers(':Show Condition Handlers', row.index)), [row]);
  }
  const handlerMenuPrevious = await browser.evaluate("latestCommand('handlers').id");
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Show Condition Handlers');
  assert.deepEqual(ownHandlers(await handlersAfter(handlerMenuPrevious, bodyHandlers[1].index)), [bodyHandlers[1]]);
  evidence.handlerDisplay.bodyRows = bodyHandlers;
  evidence.checks.push('Show Condition Handlers completion/menu and All defaults display selected runtime owners, both active handlers, and an explicit empty-frame result');
  await command(':Set Current Frame ' + bodyFrame);
  await frame(bodyFrame);
  await evaluation('(values * / + -)', ['80', '(80 81)', '(VALUES 80 81)', '(VALUES * / + -)']);
  const handlerStrings = await browser.evaluate("[...document.querySelectorAll('.handlers-result')].map(element => element.textContent)");
  const handlerCommands = await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)");
  const handlerOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${handlerOrigin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  await frame(bodyFrame);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.handlers-result')].map(element => element.textContent)"), handlerStrings);
  assert.deepEqual(await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)"), handlerCommands);
  await browser.evaluate("[...document.querySelectorAll('.handlers-result')].find(element => element.textContent.includes('SIMPLE-WARNING:')).scrollIntoView({block:'center'})");
  await save('condition-handlers-active');
  evidence.checks.push('Handler inspection preserves selected frame and seeded evaluation history; reload retains its strings without another inspection command');
  await command(':Proceed');
  await browser.waitFor(`listenerDebugger?.depth === 1 && !same(listenerDebugger.stop, ${text(controlParent.stop)}) && !busy`, 60);
  evidence.handlerDisplay.invokedStop = (await stopped(targetJob)).stop;
  const invokedFrame = await selectTarget('#source', controlInner);
  evidence.handlerDisplay.invokedAll = await showHandlers(':Show Condition Handlers :All', invokedFrame);
  const invokedHandlers = ownHandlers(evidence.handlerDisplay.invokedAll);
  assert.equal(invokedHandlers.length, 2);
  assert(invokedHandlers[0].line.includes(controlInner) && invokedHandlers[0].line.endsWith(' [inactive]'));
  assert(invokedHandlers[1].line.includes(controlOuter) && invokedHandlers[1].line.endsWith(' [active]'));
  assert(invokedHandlers.every(row => row.owner.includes('%HANDLER-BIND')));
  for (const row of invokedHandlers) {
    await command(':Set Current Frame ' + row.index);
    await frame(row.index);
    assert.deepEqual(ownHandlers(await showHandlers(':Show Condition Handlers', row.index)), [row]);
  }
  await browser.evaluate("[...document.querySelectorAll('.handlers-result')].find(element => element.textContent.includes('[inactive]')).scrollIntoView({block:'center'})");
  await save('condition-handlers-invoked');
  await command(':Proceed');
  evidence.handlerDisplay.continued = await completed(targetJob);
  assert.deepEqual(evidence.handlerDisplay.continued.values, ['42', '1', '1']);
  evidence.checks.push('Inside an invoked handler, its cluster is inactive and the outer handler remains active; Proceed invokes the outer handler once and returns 42 after one cleanup');
  const catchTarget = marker + '-CATCH-TARGET', catchTag = marker + '-REPEATED-TAG';
  targetJob = await start(`(unwind-protect (progn
    (defun ${catchTarget} ()
      (declare (optimize (debug 3) (safety 3) (speed 1)))
      (let ((printer-tag (make-instance 'lispm-describe-test:probe))
            (catch-cleanups 0) (after-inner 0))
        (let ((answer
                (multiple-value-list
                  (catch printer-tag
                    (catch '${catchTag}
                      (multiple-value-prog1
                          (catch '${catchTag}
                            (unwind-protect
                                 (progn
                                   (break "${marker} catch display")
                                   (throw '${catchTag} (values 42 43)))
                              (incf catch-cleanups)))
                        (incf after-inner)))))))
          (values (first answer) (second answer) catch-cleanups after-inner))))
    (assert (compiled-function-p (symbol-function '${catchTarget})))
    (${catchTarget}))
    (when (fboundp '${catchTarget}) (fmakunbound '${catchTarget}))
    (unintern '${catchTarget})
    (unintern '${catchTag}))`);
  const catchParent = await stopped(targetJob);
  const catchFrame = await selectTarget('#source', catchTarget);
  evidence.catchDisplay = {stop:catchParent.stop, frame:catchFrame};
  await evaluation('(values 90 91)', ['90', '91']);
  async function catchesAfter(previous, expectedFrame) {
    await browser.waitFor(`latestCommand('catches')?.id > ${previous} && commandResults.get(commandKey(latestCommand('catches')))?.state === ':returned' && !busy`);
    const value = await browser.evaluate("commandResults.get(commandKey(latestCommand('catches'))).result");
    assert.equal(await browser.evaluate("[...document.querySelectorAll('.catches-result')].at(-1).textContent"), value);
    assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), expectedFrame);
    return value;
  }
  async function showCatches(source, expectedFrame) {
    const previous = await browser.evaluate("latestCommand('catches')?.id ?? -1");
    await command(source);
    return catchesAfter(previous, expectedFrame);
  }
  function ownCatches(value) {
    return value.split(/(?=^Frame \d+ )/m).flatMap(block => {
      const heading = /^Frame (\d+) (.*):\n/.exec(block);
      return block.split('\n').filter(line => line.startsWith('  Throwing to tag ')
        && (line.includes(catchTag) || line.includes('#<DESCRIPTION-PROBE>')))
        .map(line => {
          assert(heading, 'Catch row has no frame heading');
          assert(line.includes('returns to MEZZANO.INTERNALS::%CATCH '), 'Catch destination must identify the runtime exit target');
          assert.match(line, / at byte offset #x[0-9A-Fa-f]+$/);
          assert(block.includes('    with the values supplied to THROW.\n'));
          return {index:Number(heading[1]), owner:heading[2], line};
        });
    });
  }
  await fill('#source', ':Show Catch Blo');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value.startsWith(':Show Catch Blocks') && !busy");
  await key('Enter', 'Enter', 13);
  evidence.catchDisplay.selected = await catchesAfter(-1, catchFrame);
  assert.equal(await browser.evaluate("latestCommand('catches').argument"), null);
  assert(evidence.catchDisplay.selected.endsWith('  No catch blocks.\n'));
  evidence.catchDisplay.all = await showCatches(':Show Catch Blocks :All', catchFrame);
  assert.equal(await browser.evaluate("latestCommand('catches').argument"), true);
  const catchRows = ownCatches(evidence.catchDisplay.all);
  evidence.catchDisplay.rows = catchRows;
  assert.equal(catchRows.length, 3);
  assert.equal(catchRows.filter(row => row.line.includes(catchTag)).length, 2);
  assert(catchRows.every(row => row.owner.includes('%CATCH')));
  assert(catchRows[0].index < catchRows[1].index && catchRows[1].index < catchRows[2].index);
  assert.equal(await showCatches(':Show Catch Blocks :All Yes', catchFrame), evidence.catchDisplay.all);
  assert.equal(await showCatches(':Show Catch Blocks :All No', catchFrame), evidence.catchDisplay.selected);
  for (const row of catchRows) {
    await command(':Set Current Frame ' + row.index);
    await frame(row.index);
    assert.deepEqual(ownCatches(await showCatches(':Show Catch Blocks', row.index)), [row]);
  }
  const catchMenuPrevious = await browser.evaluate("latestCommand('catches').id");
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Show Catch Blocks');
  assert.deepEqual(ownCatches(await catchesAfter(catchMenuPrevious, catchRows[2].index)), [catchRows[2]]);
  evidence.checks.push('Show Catch Blocks completion/menu and All defaults preserve repeated tags and display destination names and byte offsets under the runtime owner frames');
  await command(':Set Current Frame ' + catchFrame);
  await frame(catchFrame);
  await evaluation('(values * / + -)', ['90', '(90 91)', '(VALUES 90 91)', '(VALUES * / + -)']);
  const catchStrings = await browser.evaluate("[...document.querySelectorAll('.catches-result')].map(element => element.textContent)");
  const catchCommands = await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)");
  const catchOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${catchOrigin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  await frame(catchFrame);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.catches-result')].map(element => element.textContent)"), catchStrings);
  assert.deepEqual(await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)"), catchCommands);
  await browser.evaluate("[...document.querySelectorAll('.catches-result')].find(element => element.textContent.includes('with the values supplied to THROW.')).scrollIntoView({block:'center'})");
  await save('catch-blocks');
  evidence.checks.push('Catch inspection preserves selected frame and evaluation history; reload retains its strings without another inspection command');
  const catchPrinterError = marker + ' catch tag printer error';
  await evaluation(`(progn (setf (slot-value printer-tag 'lispm-describe-test::failure)
    (make-condition 'simple-error :format-control "${catchPrinterError}")) (values))`, []);
  await command(':Show Catch Blocks :All');
  await stopped(targetJob, 2);
  evidence.catchDisplay.printerCondition = await browser.evaluate("returnedResult('condition')");
  assert.match(evidence.catchDisplay.printerCondition, new RegExp(catchPrinterError));
  await save('catch-printer-error');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(catchParent.stop)}) && !busy`);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('catches'))).state"), ':unwound');
  await evaluation("(progn (setf (slot-value printer-tag 'lispm-describe-test::failure) nil) (values))", []);
  assert.equal(await showCatches(':Show Catch Blocks :All', catchFrame), evidence.catchDisplay.all);
  await command(':Proceed');
  evidence.catchDisplay.continued = await completed(targetJob);
  assert.deepEqual(evidence.catchDisplay.continued.values, ['42', '43', '1', '1']);
  evidence.checks.push('Catch-tag printer error enters a child and typed Abort permits repair; Proceed throws 42 and 43 through the inner repeated tag with one cleanup and one post-catch execution');
  const lexicalMaker = marker + '-LEXICAL-MAKER';
  const ancestor = marker + '-ANCESTOR', inheritedProbe = marker + '-INHERITED-PROBE';
  const inheritedHelper = marker + '-INHERITED-HELPER', lexicalCleanups = marker + '-LEXICAL-CLEANUPS';
  const current = marker + '-CURRENT', currentReader = marker + '-CURRENT-READER';
  const cleanupCell = marker + '-CLEANUP-CELL', returnedValues = marker + '-RETURNED-VALUES';
  const lexicalSymbols = [lexicalMaker, ancestor, inheritedProbe, inheritedHelper, lexicalCleanups,
    current, currentReader, cleanupCell, returnedValues];
  targetJob = await start(`(unwind-protect (progn
    (defun ${lexicalMaker} (${ancestor} ${inheritedProbe} ${lexicalCleanups})
      (declare (optimize (debug 3) (safety 3) (speed 1)))
      (flet ((${inheritedHelper} () ${ancestor}))
        (lambda (${current})
          (declare (notinline ${inheritedHelper}))
          (let ((${currentReader} (lambda () (incf ${current}))))
            (unwind-protect
                 (progn
                   (break "${marker} inherited lexical environment")
                   (values ${ancestor} (funcall ${currentReader}) (${inheritedHelper})
                           (null (slot-value ${inheritedProbe} 'lispm-describe-test::failure))))
              (incf (car ${lexicalCleanups})))))))
    (assert (compiled-function-p (symbol-function '${lexicalMaker})))
    (let ((${cleanupCell} (list 0)))
      (multiple-value-call
          (lambda (&rest ${returnedValues})
            (values-list (append ${returnedValues} (list (car ${cleanupCell})))))
        (funcall (${lexicalMaker} 37 (make-instance 'lispm-describe-test:probe) ${cleanupCell}) 41))))
    (when (fboundp '${lexicalMaker}) (fmakunbound '${lexicalMaker}))
    (dolist (name '(${lexicalSymbols.join(' ')})) (unintern name)))`);
  const lexicalParent = await stopped(targetJob);
  const lexicalFrames = await browser.evaluate(`returnedResult('frames').map((frame, index) => ({frame, index}))
    .filter(item => item.frame.function.includes(${text(lexicalMaker)}))`);
  assert.equal(lexicalFrames.length, 1, 'Expected the returned closure activation after its maker exited');
  const lexicalFrame = lexicalFrames[0].index;
  await command(':Set Current Frame ' + lexicalFrame);
  await frame(lexicalFrame);
  const lexicalLocals = await browser.evaluate('returnedFrameInspection().result.locals');
  assert(lexicalLocals.some(local => local.name === current && local['available-p'] && local.value === '41'));
  evidence.lexicalEnvironment = {stop:lexicalParent.stop, frame:lexicalFrame, locals:lexicalLocals};
  async function lexicalEnvironmentAfter(previous) {
    await browser.waitFor(`latestCommand('lexical-environment')?.id > ${previous}
      && commandResults.get(commandKey(latestCommand('lexical-environment')))?.state === ':returned' && !busy`);
    const value = await browser.evaluate("commandResults.get(commandKey(latestCommand('lexical-environment'))).result");
    assert.equal(await browser.evaluate("[...document.querySelectorAll('.lexical-environment-result')].at(-1).textContent"), value);
    assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), lexicalFrame);
    assert.equal(await browser.evaluate("latestCommand('lexical-environment').argument"), null);
    assert(value.startsWith('Lexically inherited variables:\n'));
    const rows = value.split('\n');
    assert(rows.includes('  ' + ancestor + ': 37'));
    assert(rows.includes('  ' + inheritedProbe + ': #<DESCRIPTION-PROBE>'));
    assert(rows.some(row => row.startsWith('  (FUNCTION ' + inheritedHelper + '): ')));
    assert(!rows.some(row => row.startsWith('  ' + current + ': ') || row.startsWith('  ' + currentReader + ': ')));
    return value;
  }
  await seedHistory();
  await fill('#source', ':Show Lexical Env');
  await key(' ', 'Space', 32);
  await browser.waitFor("document.querySelector('#source').value.trim() === ':Show Lexical Environment' && !busy");
  await key('Enter', 'Enter', 13);
  evidence.lexicalEnvironment.typed = await lexicalEnvironmentAfter(-1);
  const lexicalPrevious = await browser.evaluate("latestCommand('lexical-environment').id");
  await browser.click('#window-label');
  await clickText('#debugger-menu', ':Show Lexical Environment');
  evidence.lexicalEnvironment.menu = await lexicalEnvironmentAfter(lexicalPrevious);
  evidence.checks.push('Show Lexical Environment completion and menu display inherited variables/functions while excluding a current captured parameter and reader');
  const lexicalStrings = await browser.evaluate("[...document.querySelectorAll('.lexical-environment-result')].map(element => element.textContent)");
  const lexicalCommands = await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)");
  const lexicalOrigin = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin !== ${lexicalOrigin} && document.readyState === 'complete' && connected && !busy`);
  await stopped(targetJob);
  await browser.waitFor("!document.querySelector('#stop-detail .history-progress') && !nextHistoricalCommand() && !busy");
  await frame(lexicalFrame);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('.lexical-environment-result')].map(element => element.textContent)"), lexicalStrings);
  assert.deepEqual(await browser.evaluate("state.commands.filter(command => same(command.stop, selectedStop)).map(command => command.id)"), lexicalCommands);
  await evaluation('(values * + ++ +++ ** *** / // ///)', ['31', ...history]);
  await browser.evaluate("[...document.querySelectorAll('.lexical-environment-result')].at(-1).scrollIntoView({block:'center'})");
  await save('lexically-inherited-bindings');
  evidence.checks.push('Lexical environment display preserves selected frame and all nine history slots; reload retains its text without another command');
  const lexicalPrinterError = marker + ' inherited printer error';
  await evaluation(`(progn (setf (slot-value ${inheritedProbe} 'lispm-describe-test::failure)
    (make-condition 'simple-error :format-control "${lexicalPrinterError}")) (values))`, []);
  await seedHistory();
  await command(':Show Lexical Environment');
  await stopped(targetJob, 2);
  evidence.lexicalEnvironment.printerCondition = await browser.evaluate("returnedResult('condition')");
  assert.match(evidence.lexicalEnvironment.printerCondition, new RegExp(lexicalPrinterError));
  await save('lexical-environment-printer-error');
  await command(':Abort');
  await browser.waitFor(`listenerDebugger?.depth === 1 && same(listenerDebugger.stop, ${text(lexicalParent.stop)}) && !busy`);
  await frame(lexicalFrame);
  assert.equal(await browser.evaluate("commandResults.get(commandKey(latestCommand('lexical-environment'))).state"), ':unwound');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.lexical-environment-result')].at(-1).textContent"), 'unwound');
  await evaluation('(values * + ++ +++ ** *** / // ///)', ['31', ...history]);
  await evaluation(`(progn (setf (slot-value ${inheritedProbe} 'lispm-describe-test::failure) nil) (values))`, []);
  const lexicalUnwound = await browser.evaluate("latestCommand('lexical-environment').id");
  await command(':Show Lexical Environment');
  evidence.lexicalEnvironment.repaired = await lexicalEnvironmentAfter(lexicalUnwound);
  await command(':Proceed');
  evidence.lexicalEnvironment.continued = await completed(targetJob);
  assert.deepEqual(evidence.lexicalEnvironment.continued.values, ['37', '42', '37', 'T', '1']);
  evidence.checks.push('Inherited printer failure enters a child; typed Abort preserves parent selection/history, repair succeeds, and Proceed observes captured values after one cleanup');
  const next = await start(`(progn (dolist (name '(${[...symbols, codeTarget, largeTarget, largeSink, largeLast, handlerTarget, ...controlSymbols, catchTarget, catchTag, ...lexicalSymbols].map(name => '"' + name + '"').join(' ')})) (assert (null (find-symbol name "CL-USER")))) (+ 20 22))`);
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
    evidence.httpFailures = await browser.evaluate("JSON.parse(sessionStorage.getItem('frame-evaluation-http-failures') || '[]')");
    await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
}
console.log(JSON.stringify(evidence, null, 2));
