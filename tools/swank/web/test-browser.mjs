import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://minideb2:8765/';
const output = resolve(process.argv[3] ?? 'browser-test-results');
await mkdir(output, { recursive: true });
const browser = await openBrowser(url);
const marker = 'BROWSER-TEST-' + randomBytes(6).toString('hex').toUpperCase();
const text = JSON.stringify;
const screenshot = name => browser.screenshot(join(output, name + '.png'));

async function clickText(container, value) {
  await browser.waitFor(`[...document.querySelectorAll(${text(container + ' button')})].filter(button => button.textContent.includes(${text(value)}) && button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0 && !button.disabled).length === 1`);
  const selector = await browser.evaluate(`(() => {
    const buttons = [...document.querySelectorAll(${text(container + ' button')})];
    const matches = buttons.filter(button => button.textContent.includes(${text(value)}) && button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0 && !button.disabled);
    if (matches.length !== 1) throw new Error('Expected one button: ' + ${text(value)} + ', found ' + matches.length);
    matches[0].setAttribute('data-browser-test', 'target');
    return '[data-browser-test="target"]';
  })()`);
  await browser.click(selector);
  await browser.evaluate("document.querySelector('[data-browser-test=target]')?.removeAttribute('data-browser-test')");
}

async function enter(selector, input, append = false) {
  await browser.waitFor('connected && !busy');
  await browser.click(selector);
  await browser.waitFor(`document.activeElement === document.querySelector(${text(selector)})`);
  if (!append) await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', { text: input });
  await key('Enter', 'Enter', 13);
}

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  const generatedText = key === 'Enter' ? '\r' : undefined;
  await browser.send('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers,
    text: generatedText, unmodifiedText: generatedText});
  await browser.send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers});
}
async function fill(selector, input) {
  await browser.waitFor('connected && !busy');
  await browser.click(selector);
  await browser.waitFor(`document.activeElement === document.querySelector(${text(selector)})`);
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text: input});
}
async function accept(command, endKey = false) {
  const previous = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).inputHistory.map(item => item.name)");
  await fill('#source', command);
  await key(endKey ? 'F11' : 'Enter', endKey ? 'F11' : 'Enter', endKey ? 122 : 13, endKey ? 8 : 0);
  const expression = `JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).inputHistory.find(item => item.source === ${text(command)} && !${text(previous)}.includes(item.name))`;
  await browser.waitFor(expression);
  const {name} = await browser.evaluate(expression);
  const selector = '[data-job="' + name + '"]';
  await waitText(selector, 'returned');
  return {name, selector};
}
async function releaseAccepted(job) {
  await clickText(job.selector, 'Release');
  await browser.waitFor(`!document.querySelector(${text(job.selector)})`);
}

async function waitText(selector, value) {
  await browser.waitFor(`document.querySelector(${text(selector)})?.textContent.includes(${text(value)})`);
}

async function selectJob(tag) {
  const key = marker + '-' + tag;
  await browser.waitFor(`[...document.querySelectorAll('#transcript article')].some(article => article.querySelector('pre')?.textContent.includes(${text(key)}))`);
  await browser.evaluate(`(() => {
    document.querySelectorAll('[data-test-job]').forEach(element => element.removeAttribute('data-test-job'));
    const jobs = [...document.querySelectorAll('#transcript article')].filter(article => article.querySelector('pre')?.textContent.includes(${text(key)}));
    if (jobs.length !== 1) throw new Error('Expected one retained job: ' + ${text(key)});
    jobs[0].setAttribute('data-test-job', 'selected');
  })()`);
  return '[data-test-job="selected"]';
}

async function openMenu() {
  if (!await browser.evaluate("document.querySelector('#system-menu').open")) await browser.click('#window-label');
  await browser.waitFor("document.querySelector('#system-menu').open");
}

async function discardNextReply(operation) {
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === ${text(operation)}) {
        window.fetch = original;
        await response.arrayBuffer();
        throw new TypeError('Browser test discarded the response after server dispatch');
      }
      return response;
    };
  })()`);
}

async function preventNextDispatch(operation) {
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = (...args) => {
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === ${text(operation)}) {
        window.fetch = original;
        throw new TypeError('Browser test prevented dispatch before a transport failure');
      }
      return original(...args);
    };
  })()`);
}

async function unknownReply() {
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.some(record => record.status === 'outcome unknown')");
  await openMenu();
  await browser.click('[data-activity="requests"]');
}

async function repeatUnknown(operation) {
  await unknownReply();
  const record = await browser.evaluate(`state.pending.find(item => item.operation === ${text(operation)})`);
  assert.equal(record.status, 'outcome unknown');
  await openMenu();
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  assert.equal(await browser.evaluate('state.session'), record.session);
  await openMenu();
  await browser.click('[data-activity="requests"]');
  await clickText('#pending', 'Repeat Original Request');
  await browser.waitFor(`!state.pending.some(item => item.id === ${text(record.id)}) && !busy`);
  return record;
}

async function listener() {
  await browser.click('#window-label');
  await browser.click('[data-activity="listener"]');
}

async function debuggerAction(name) {
  await browser.waitFor("!document.querySelector('#debugger').hidden && !document.querySelector('#debug-command').hidden");
  await browser.click('#window-label');
  await clickText('#debugger-menu', name);
}

async function releaseJob(tag) {
  const selector = await selectJob(tag);
  await clickText(selector, 'Release');
  await browser.waitFor(`![...document.querySelectorAll('#transcript article')].some(article => article.querySelector('pre')?.textContent.includes(${text(marker + '-' + tag)}))`);
}

try {
  console.log('Fixture marker', marker);
  await browser.waitFor("document.querySelector('#message').textContent.startsWith('Session ') && document.querySelector('#process-state').textContent !== 'Disconnected'");
  await browser.waitFor('connected && !busy');
  const effectStates = await browser.evaluate(`(() => {
    const before = freshName();
    const after = freshName();
    const job = {listener: true, clearBefore: [before]};
    state.jobs[before] = {hidden: false};
    state.jobs[after] = {hidden: false};
    try {
      applyListenerEffects(job, {state: ':running', 'listener-result': {kind: ':command', effects: null}});
      const running = {applied: Boolean(job.effectsApplied), hidden: state.jobs[before].hidden};
      const returned = {state: ':returned', 'listener-result': {kind: ':command', effects: [{operation: ':clear-output-history'}]}};
      applyListenerEffects(job, returned);
      const terminal = {applied: job.effectsApplied, before: state.jobs[before].hidden, after: state.jobs[after].hidden};
      state.jobs[before].hidden = false;
      applyListenerEffects(job, returned);
      return {running, terminal, replayHidden: state.jobs[before].hidden};
    } finally {
      delete state.jobs[before];
      delete state.jobs[after];
    }
  })()`);
  assert.deepEqual(effectStates, {running: {applied: false, hidden: false}, terminal: {applied: true, before: true, after: false}, replayHidden: false});
  console.log('PASS browser running-to-terminal clear-effect fixture and replay guard');
  await screenshot('listener-ready');
  await browser.click('#window-label');
  await screenshot('system-menu');
  await browser.click('#close-menu');
  const rightClick = await browser.evaluate(`(() => {
    const source = document.querySelector('#source');
    source.scrollIntoView({block: 'center'});
    const rect = source.getBoundingClientRect();
    return {x: rect.left + 5, y: rect.top + 5};
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {type, button: 'right', clickCount: 1, ...rightClick});
  }
  await browser.waitFor("document.querySelector('#system-menu').open");
  await browser.click('#close-menu');
  console.log('PASS browser Mouse-Right System Menu');
  await fill('#source', 'Se');
  await browser.send('Input.insertText', {text: ' '});
  await browser.waitFor("document.querySelector('#source').value === 'Set '");
  await browser.send('Input.insertText', {text: 'P'});
  await key('Tab', 'Tab', 9);
  await browser.waitFor("document.querySelector('#source').value === 'Set Package '");
  await waitText('#listener-assistance', 'default COMMON-LISP-USER');
  await key('F12', 'F12', 123);
  await waitText('#listener-assistance', "Select this Listener's Lisp package");
  await browser.waitFor("[...document.querySelectorAll('#listener-assistance button')].some(button => button.textContent === 'COMMON-LISP-USER')");
  await screenshot('listener-context-help');
  await browser.send('Input.insertText', {text: ' '});
  await browser.waitFor("document.querySelector('#source').value.includes('COMMON-LISP-USER')");
  const defaultCommand = await browser.evaluate("document.querySelector('#source').value");
  let commandJob = await accept(defaultCommand, true);
  await releaseAccepted(commandJob);
  await fill('#source', 'Set P');
  await key('F11', 'F11', 122);
  await browser.waitFor("document.querySelector('#source').value === 'Set Package ' && !busy");
  await fill('#source', 'Compile File ');
  await key('?', 'Slash', 191, 10);
  await waitText('#listener-assistance', 'Compile a guest Lisp file');
  await waitText('#listener-assistance', 'Binary File');
  assert.equal(await browser.evaluate("document.querySelector('#source').value"), 'Compile File ');
  console.log('PASS browser SPACE/Tab/F11 completion, F12/Control-? help, Shift-F11 submission, and explicit default');

  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.assistanceRequests = [];
    window.fetch = (...args) => {
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'listener-assistance') window.assistanceRequests.push(request.arguments);
      return original(...args);
    };
  })()`);
  const unicodeInput = '(list "🚀") suffix';
  const unicodePrefix = '(list "🚀")';
  await fill('#source', unicodeInput);
  await browser.evaluate(`document.querySelector('#source').setSelectionRange(${unicodePrefix.length}, ${unicodePrefix.length})`);
  await key('F12', 'F12', 123);
  await browser.waitFor(`window.assistanceRequests.some(request => request.source === ${text(unicodeInput)} && request.action === 'help')`);
  const unicodeRequest = await browser.evaluate(`window.assistanceRequests.findLast(request => request.source === ${text(unicodeInput)} && request.action === 'help')`);
  assert.equal(unicodeRequest.cursor, Array.from(unicodePrefix).length);
  await browser.waitFor('!busy');
  assert.equal(await browser.evaluate("document.querySelector('#source').value"), unicodeInput);
  assert.equal(await browser.evaluate("document.querySelector('#source').selectionStart"), unicodePrefix.length);
  const presentationRendering = await browser.evaluate(`(() => {
    const prefix = '🚀 ';
    const pathname = '/guest/🚀.lisp';
    const output = document.createElement('pre');
    const view = {output, text: prefix + pathname + ' suffix'};
    renderOutput(view, [{start: Array.from(prefix).length, end: Array.from(prefix + pathname).length,
      type: ':pathname', value: pathname}]);
    return {text: output.textContent, pathname: output.querySelector('button').textContent};
  })()`);
  assert.deepEqual(presentationRendering, {text: '🚀 /guest/🚀.lisp suffix', pathname: '/guest/🚀.lisp'});
  console.log('PASS browser Unicode assistance cursor/suffix and renderer presentation-offset fixture');

  await fill('#source', 'Set P');
  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'listener-assistance'
          && request.arguments.action === 'complete' && request.arguments.source === 'Set P') {
        window.fetch = original;
        await new Promise(resolve => { window.releaseAssistanceReply = resolve; });
      }
      return response;
    };
  })()`);
  await key('Tab', 'Tab', 9);
  await browser.waitFor('typeof window.releaseAssistanceReply === "function"');
  await key('a', 'KeyA', 65, 2);
  const revisedInput = '(values :edited-while-completing)';
  await browser.send('Input.insertText', {text: revisedInput});
  await browser.evaluate('window.releaseAssistanceReply()');
  await browser.waitFor('!busy');
  assert.equal(await browser.evaluate('document.querySelector("#source").value'), revisedInput);
  assert.equal(await browser.evaluate('document.querySelector("#source").selectionStart'), revisedInput.length);
  console.log('PASS delayed command-completion reply preserves newer input and cursor');

  commandJob = await accept('Help :Format Detailed');
  await waitText(commandJob.selector, 'Compile File');
  await waitText(commandJob.selector, 'guest Lisp file');
  await releaseAccepted(commandJob);
  commandJob = await accept('Show Herald :Detailed');
  await waitText(commandJob.selector, 'Mezzano');
  await releaseAccepted(commandJob);
  commandJob = await accept('Show Command Processor Status');
  await waitText(commandJob.selector, 'Command-Preferred');
  await releaseAccepted(commandJob);

  const packageName = marker + '-PACKAGE';
  commandJob = await accept(`(defpackage ${JSON.stringify(packageName)} (:use :cl))`);
  await releaseAccepted(commandJob);
  await openMenu();
  await browser.click('#set-package');
  await browser.waitFor("activity === 'listener' && document.querySelector('#source').value === 'Set Package '");
  assert.equal(await browser.evaluate('document.activeElement.id'), 'source');
  commandJob = await accept('Set Package ' + packageName);
  await waitText('#package-label', packageName);
  await releaseAccepted(commandJob);
  commandJob = await accept('(defparameter help 17) (defparameter browser-variable 29)');
  await releaseAccepted(commandJob);
  commandJob = await accept('browser-variable');
  await waitText(commandJob.selector, '29');
  await releaseAccepted(commandJob);
  commandJob = await accept(',help');
  await waitText(commandJob.selector, '17');
  await releaseAccepted(commandJob);
  commandJob = await accept('Help');
  await waitText(commandJob.selector, 'Set Package');
  await releaseAccepted(commandJob);
  commandJob = await accept('Set Package CL-USER');
  await releaseAccepted(commandJob);
  commandJob = await accept(`(delete-package ${JSON.stringify(packageName)})`);
  await releaseAccepted(commandJob);
  console.log('PASS browser command dispatch, package state, known variable, and forced Lisp');

  const leaf = 'browser-listener-' + marker.toLowerCase() + '-🚀';
  const binaryLeaf = leaf + '-explicit.llf';
  commandJob = await accept(`(let ((base (translate-logical-pathname "SYS:HOME;"))) (values (namestring (merge-pathnames ${JSON.stringify(leaf + '.lisp')} base)) (namestring (merge-pathnames ${JSON.stringify(leaf + '-second.lisp')} base)) (namestring (merge-pathnames ${JSON.stringify(leaf + '*.lisp')} base)) (namestring (merge-pathnames ${JSON.stringify(binaryLeaf)} base)) (namestring base)))`);
  const [pathname, secondPathname, wildcard, binaryPathname, directoryPathname] = (await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .returned-values')}).textContent`)).split('\n').map(value => JSON.parse(value));
  assert(pathname.includes('🚀'));
  await releaseAccepted(commandJob);
  const variableName = '*' + marker + '-FILE*';
  const fileBody = `(in-package :cl-user) (defparameter ${variableName} "🚀 browser file")`;
  commandJob = await accept(`(dolist (path '(${JSON.stringify(pathname)} ${JSON.stringify(secondPathname)})) (with-open-file (stream path :direction :output :if-exists :error) (write-string ${JSON.stringify(fileBody)} stream)))`);
  await releaseAccepted(commandJob);
  const directoryJob = await accept('Show Directory ' + wildcard);
  await browser.waitFor(`document.querySelectorAll(${text(directoryJob.selector + ' .presentation')}).length === 2`);
  const presented = await browser.evaluate(`[...document.querySelectorAll(${text(directoryJob.selector + ' .presentation')})].map(element => element.textContent)`);
  assert.deepEqual(presented.sort(), [pathname, secondPathname].sort());
  await fill('#source', 'Show File ');
  await clickText(directoryJob.selector, pathname);
  await browser.waitFor(`document.querySelector('#source').value.includes(${text(pathname)})`);
  const showFile = await browser.evaluate("document.querySelector('#source').value");
  commandJob = await accept(showFile);
  await waitText(commandJob.selector, fileBody);
  await screenshot('listener-pathname');
  await releaseAccepted(commandJob);
  await releaseAccepted(directoryJob);
  commandJob = await accept('Show File');
  await waitText(commandJob.selector, fileBody);
  await releaseAccepted(commandJob);
  commandJob = await accept('Load File ' + pathname);
  await releaseAccepted(commandJob);
  commandJob = await accept(variableName);
  await waitText(commandJob.selector, '🚀 browser file');
  await releaseAccepted(commandJob);
  commandJob = await accept('Compile File ' + pathname + ' :Load Yes');
  const defaultBinaryPathname = await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .presentation')}).textContent`);
  await releaseAccepted(commandJob);
  for (const command of ['Show Directory', 'Show Directory ' + directoryPathname]) {
    commandJob = await accept(command);
    const entries = await browser.evaluate(`[...document.querySelectorAll(${text(commandJob.selector + ' .presentation')})].map(element => element.textContent)`);
    assert(entries.includes(pathname));
    assert(entries.includes(secondPathname));
    await releaseAccepted(commandJob);
  }
  commandJob = await accept(`(setf ${variableName} :not-loaded)`);
  await releaseAccepted(commandJob);
  commandJob = await accept('Compile File ' + leaf + '.lisp');
  assert.equal(await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .presentation')}).textContent`), defaultBinaryPathname);
  await releaseAccepted(commandJob);
  commandJob = await accept(variableName);
  assert.equal(await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .returned-values')}).textContent`), ':NOT-LOADED');
  await releaseAccepted(commandJob);
  commandJob = await accept('Compile File :Binary File ' + binaryLeaf + ' :Load No');
  assert.equal(await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .presentation')}).textContent`), binaryPathname);
  await releaseAccepted(commandJob);
  commandJob = await accept(`(values ${variableName} (not (null (probe-file ${JSON.stringify(binaryPathname)}))))`);
  assert.equal(await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .returned-values')}).textContent`), ':NOT-LOADED\nT');
  await releaseAccepted(commandJob);
  commandJob = await accept('Load File ' + binaryLeaf);
  await releaseAccepted(commandJob);
  commandJob = await accept(variableName);
  await waitText(commandJob.selector + ' .returned-values', '🚀 browser file');
  await releaseAccepted(commandJob);
  commandJob = await accept(`(setf ${variableName} :not-loaded)`);
  await releaseAccepted(commandJob);
  commandJob = await accept('Load File');
  await releaseAccepted(commandJob);
  commandJob = await accept(variableName);
  await waitText(commandJob.selector + ' .returned-values', '🚀 browser file');
  await releaseAccepted(commandJob);
  commandJob = await accept(`(setf ${variableName} :not-loaded)`);
  await releaseAccepted(commandJob);
  commandJob = await accept('Compile File ' + leaf + '.lisp :Load');
  await releaseAccepted(commandJob);
  commandJob = await accept(variableName);
  await waitText(commandJob.selector + ' .returned-values', '🚀 browser file');
  await releaseAccepted(commandJob);
  commandJob = await accept(`(delete-file ${JSON.stringify(binaryPathname)}) (delete-file ${JSON.stringify(pathname)}) (delete-file (compile-file-pathname ${JSON.stringify(pathname)})) (delete-file ${JSON.stringify(secondPathname)}) (makunbound '${variableName}) (values)`);
  assert.equal(await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .returned-values')}).textContent`), '(No values)');
  await releaseAccepted(commandJob);
  console.log('PASS browser Unicode physical pathname presentation/insertion/default, contents, relative/default file arguments, directory defaults, :Binary File, omitted/No/implicit-Yes :Load, and file cleanup');

  const historySource = `(progn "${marker}-HISTORY" (values :history))`;
  const firstHistory = await accept(historySource);
  await key('y', 'KeyY', 89, 3);
  await browser.waitFor(`document.querySelector('#source').value === ${text(historySource)}`);
  assert.equal(await browser.evaluate(`JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).inputHistory.filter(item => item.source === ${text(historySource)}).length`), 1);
  const secondHistory = await accept(historySource);
  assert.notEqual(firstHistory.name, secondHistory.name);
  await releaseAccepted(firstHistory);
  await releaseAccepted(secondHistory);
  console.log('PASS browser input recall and fresh request identity on execution');

  const mainSession = await browser.evaluate('state.session');
  const {targetId: independentTarget} = await browser.send('Target.createTarget', {url: 'about:blank'});
  const {sessionId: independentConnection} = await browser.send('Target.attachToTarget', {targetId: independentTarget, flatten: true});
  const independentValue = async expression => {
    const reply = await browser.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, independentConnection);
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  try {
    await browser.send('Runtime.enable', {}, independentConnection);
    await browser.send('Log.enable', {}, independentConnection);
    await browser.send('Page.navigate', {url}, independentConnection);
    const deadline = Date.now() + 30000;
    while (!await independentValue("typeof connected !== 'undefined' && connected && !busy")) {
      assert(Date.now() < deadline, 'Independent tab did not connect');
      await delay(100);
    }
    const independent = await independentValue('({session: state.session, inputHistory: state.inputHistory})');
    await writeFile(join(output, 'independent-tab.json'), JSON.stringify(independent, null, 2));
    assert.notEqual(independent.session, mainSession);
    assert.deepEqual(independent.inputHistory, []);
    assert((await browser.evaluate('state.inputHistory.length')) > 0);
    assert.equal(await independentValue("(async () => {await mutate('release-session', {}); return connected;})()"), false);
    assert.equal(await browser.evaluate("api('resume-session')"), mainSession);
    await writeFile(join(output, 'independent-tab.json'), JSON.stringify({...independent, sessionReleased: true}, null, 2));
    console.log('PASS independent tabs in one browser profile keep distinct sessions and input histories');
  } finally {
    await browser.send('Target.closeTarget', {targetId: independentTarget});
  }

  const valuesPrefix = `(format t "${marker}-VALUES~%")`;
  await fill('#source', valuesPrefix);
  const inputCount = await browser.evaluate('state.inputHistory.length');
  await key('Enter', 'Enter', 13, 8);
  assert.equal(await browser.evaluate('document.querySelector("#source").value'), valuesPrefix + '\n');
  assert.equal(await browser.evaluate('state.inputHistory.length'), inputCount);
  await enter('#source', '(values (+ 20 22) :done)', true);
  let job = await selectJob('VALUES');
  await waitText(job, '42\n:DONE');
  await waitText(job, 'returned');
  await screenshot('listener-result');
  console.log('PASS browser Shift-Return, evaluation, output, and multiple values');

  await browser.send('Page.reload');
  job = await selectJob('VALUES');
  await waitText(job, '42\n:DONE');
  await browser.waitFor('connected && !busy');
  console.log('PASS browser reload and retained result');
  await writeFile(join(output, 'font-metrics.json'), JSON.stringify(await browser.evaluate(`(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = '12px CPTFONT, monospace';
    return {font: getComputedStyle(document.documentElement).fontFamily,
      bodyColor: getComputedStyle(document.documentElement).color,
      bodyBackground: getComputedStyle(document.documentElement).backgroundColor,
      helloWidth: context.measureText('Hello').width,
      fonts: [...document.fonts].map(font => ({family: font.family, style: font.style, weight: font.weight, status: font.status}))};
  })()`), null, 2));

  await browser.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 768, deviceScaleFactor: 1, mobile: false });
  await screenshot('listener-640');
  assert(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'The document overflows the narrow viewport');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false });

  await browser.click('#window-label');
  await browser.click('#interactive');
  await browser.click('#close-menu');
  await enter('#source', `(progn "${marker}-INPUT" (read-line))`);
  job = await selectJob('INPUT');
  await waitText(job, 'awaiting input');
  const inputJobName = await browser.evaluate(`document.querySelector(${text(job)}).dataset.job`);
  const inputToken = await browser.evaluate(`state.jobs[${text(inputJobName)}].token`);
  await discardNextReply('job-input');
  await enter(job + ' .input-form textarea', 'Browser input');
  const inputReplay = await repeatUnknown('job-input');
  assert.deepEqual(inputReplay.arguments, {job: inputToken, offset: 0, text: 'Browser input\n', eof: false});
  await listener();
  job = await selectJob('INPUT');
  await waitText(job, '"Browser input"\nNIL');
  assert.equal(await browser.evaluate(`views.get(${text(inputJobName)}).info['input-length']`), 'Browser input\n'.length);
  await releaseJob('INPUT');
  await enter('#source', `(progn "${marker}-EOF" (read-line *standard-input* nil :eof))`);
  job = await selectJob('EOF');
  await waitText(job, 'awaiting input');
  await clickText(job + ' .input-form', 'EOF');
  await waitText(job, 'returned');
  assert.equal(await browser.evaluate(`document.querySelector(${text(job + ' .returned-values')}).textContent`), ':EOF\nT');
  assert.equal(await browser.evaluate(`views.get(document.querySelector(${text(job)}).dataset.job).info['input-eof-p']`), true);
  await releaseJob('EOF');
  await browser.click('#window-label');
  await browser.click('#interactive');
  await browser.click('#close-menu');
  console.log('PASS browser interactive text, EOF, and returned values');

  await enter('#source', `(unwind-protect (loop (sleep 0.01)) (format t "${marker}-INTERRUPT-CLEANUP"))`);
  job = await selectJob('INTERRUPT');
  await waitText(job, 'running');
  const interruptJobName = await browser.evaluate(`document.querySelector(${text(job)}).dataset.job`);
  const interruptToken = await browser.evaluate(`state.jobs[${text(interruptJobName)}].token`);
  await discardNextReply('interrupt-job');
  await clickText(job, 'Interrupt');
  const interruptReplay = await repeatUnknown('interrupt-job');
  assert.deepEqual(interruptReplay.arguments.job, interruptToken);
  assert.equal(await browser.evaluate(`views.get(${text(interruptJobName)}).info['next-interrupt-id']`), interruptReplay.arguments.id + 1);
  await listener();
  job = await selectJob('INTERRUPT');
  await waitText(job, 'Debugger');
  await clickText(job, 'Debugger');
  await debuggerAction(':Show Proceed Options');
  await clickText('.restarts', 'ABORT:');
  await debuggerAction('Release Stop');
  await listener();
  job = await selectJob('INTERRUPT');
  await waitText(job, 'aborted');
  assert.equal(await browser.evaluate(`document.querySelector(${text(job + ' .job-output')}).textContent`), marker + '-INTERRUPT-CLEANUP');
  assert.equal((await browser.evaluate(`api('job-interrupt-result', ${text(interruptReplay.arguments)})`)).state, ':unwound');
  await releaseJob('INTERRUPT');
  console.log('PASS browser Interrupt, ABORT, unwind cleanup, and stop/job release');

  await discardNextReply('start-listener');
  await enter('#source', `(format t "${marker}-REPLAY~%") (values :replayed)`);
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.some(record => record.status === 'outcome unknown')");
  const originalRequest = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending[0]");
  assert.equal(originalRequest.operation, 'start-listener');
  await browser.send('Page.reload');
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy && document.querySelector('#message')?.textContent.startsWith('Session ')");
  await browser.click('#window-label');
  await browser.click('[data-activity="requests"]');
  await waitText('#pending', 'Repeat Original Request');
  await screenshot('requests-uncertain');
  await clickText('#pending', 'Repeat Original Request');
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.length === 0");
  assert.equal(await browser.evaluate(`JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).jobs[${text(originalRequest.arguments.name)}].name`), originalRequest.arguments.name);
  await listener();
  job = await selectJob('REPLAY');
  await waitText(job, ':REPLAYED');
  await releaseJob('REPLAY');
  console.log('PASS browser recovery after discarding an accepted evaluation reply');

  await browser.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = args[1]?.body && JSON.parse(args[1].body);
      if (request?.operation === 'submit' && request.arguments?.command === 'frames') {
        window.fetch = original;
        await new Promise(resolve => { window.releaseInitialInspection = resolve; });
      }
      return response;
    };
  })()`);
  const functionName = marker + '-DEBUG';
  await enter('#source', `(defun ${functionName} (a b) (declare (optimize (debug 3) (safety 3))) (cerror "Continue browser test." "${marker} debugger") (+ a b)) (unwind-protect (${functionName} 111 222) (fmakunbound '${functionName}))`);
  job = await selectJob('DEBUG');
  await waitText(job, 'Debugger');
  await browser.waitFor('typeof releaseInitialInspection === "function"');
  const initialDebuggerPosition = await browser.evaluate(`(() => {
    window.initialDebuggerAction = [...document.querySelectorAll(${text(job + ' button')})]
      .find(button => button.textContent === 'Debugger');
    initialDebuggerAction.scrollIntoView({block: 'center'});
    const bounds = initialDebuggerAction.getBoundingClientRect();
    return {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  })()`);
  await browser.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...initialDebuggerPosition});
  await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...initialDebuggerPosition});
  await browser.evaluate('releaseInitialInspection(); delete window.releaseInitialInspection');
  await browser.waitFor('!busy');
  assert(await browser.evaluate('initialDebuggerAction.isConnected && document.activeElement === initialDebuggerAction'));
  assert(await browser.evaluate(`document.elementFromPoint(${initialDebuggerPosition.x}, ${initialDebuggerPosition.y}) === initialDebuggerAction`));
  await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...initialDebuggerPosition});
  await browser.waitFor('!busy');
  const debugStop = await browser.evaluate('selectedStop');
  await waitText('#stop-detail .condition', marker + ' debugger');
  await waitText('.restarts', 'Continue browser test.');
  await waitText('#stop-detail', functionName);
  assert.equal(await browser.evaluate("document.activeElement === document.querySelector('#debugger-command')"), true);
  const activeJob = await browser.evaluate('activeListenerJob');
  assert(activeJob);
  await browser.waitFor('returnedFrameInspection() && !stopCommandPending(selectedStop) && !busy');
  const initialInspections = await browser.evaluate(`state.commands.filter(command => same(command.stop, ${text(debugStop)}))`);
  const stoppedSession = await browser.evaluate('state.session');
  await browser.send('Page.reload');
  await browser.waitFor('typeof connected !== "undefined" && connected && !busy');
  assert.equal(await browser.evaluate('state.session'), stoppedSession);
  assert.equal(await browser.evaluate('activeListenerJob'), activeJob);
  await waitText('#listener-state', 'stopped in the debugger');
  await clickText('#listener-state', 'Debugger');
  await waitText('#stop-detail .condition', marker + ' debugger');
  assert.deepEqual(await browser.evaluate(`state.commands.filter(command => same(command.stop, ${text(debugStop)}))`), initialInspections);
  console.log('PASS reload preserves Listener ownership and reuses completed debugger inspections');
  await listener();
  await waitText('#listener-state', 'stopped in the debugger');
  const jobCount = await browser.evaluate('Object.keys(state.jobs).length');
  await enter('#source', ':Help');
  await waitText('#listener-debugger .debugger-help', 'Abort');
  assert.equal(await browser.evaluate('Object.keys(state.jobs).length'), jobCount);
  assert.equal(await browser.evaluate('activeListenerJob'), activeJob);
  assert.equal(await browser.evaluate('connected'), true);
  assert.equal(await browser.evaluate("document.querySelector('#process-state').textContent"), 'Debugger');
  await clickText('#listener-state', 'Debugger');
  await browser.waitFor(`same(selectedStop, ${text(debugStop)}) && !busy`);
  console.log('PASS owning Listener routes typed Help to its retained debugger stop');
  await discardNextReply('submit');
  await debuggerAction('Inspect Condition');
  const conditionReplay = await repeatUnknown('submit');
  assert.deepEqual(conditionReplay.arguments.stop, debugStop);
  assert.equal(conditionReplay.arguments.command, 'condition');
  assert.equal(await browser.evaluate(`state.commands.filter(command => same(command.stop, ${text(debugStop)}) && command.id === ${conditionReplay.arguments.id}).length`), 1);
  assert.equal((await browser.evaluate(`api('information', {stop: ${text(debugStop)}})`))['next-command-id'], conditionReplay.arguments.id + 1);
  await openMenu();
  await browser.click('[data-activity="debugger"]');
  await waitText('#stop-detail .condition', marker + ' debugger');
  await debuggerAction(':Show Backtrace');
  await waitText('#stop-detail', functionName);
  const frameIndex = await browser.evaluate(`returnedResult('frames').findIndex(frame => frame.function.includes(${text(functionName)}))`);
  assert(frameIndex >= 0);
  await enter('#debugger-command', ':Set Current Frame ' + frameIndex);
  await browser.waitFor(`returnedFrameInspection()?.result.index === ${frameIndex} && !busy`);
  await waitText('.locals', '111');
  await waitText('.locals', '222');
  async function displayedCommand(source, operation, argument) {
    await browser.waitFor('!busy && !stopCommandPending(selectedStop) && !nextStopInspection(selectedStop)');
    const before = await browser.evaluate(`api('information', {stop: ${text(debugStop)}})`);
    const id = before['next-command-id'];
    await enter('#debugger-command', source);
    const commandExpression = `state.commands.find(command => same(command.stop, ${text(debugStop)}) && command.id === ${id})`;
    const resultExpression = `commandResults.get(commandKey({stop: ${text(debugStop)}, id: ${id}}))`;
    await browser.waitFor(`${commandExpression} && ${resultExpression}?.state === ':returned' && !busy`);
    const command = await browser.evaluate(commandExpression);
    const result = await browser.evaluate(resultExpression);
    assert.equal(command.command, operation);
    assert.deepEqual(command.argument, argument);
    assert.equal(result.operation, ':' + operation);
    assert.equal(result.generation, before.generation);
    return {command, result, before};
  }
  const listenerHistory = await browser.evaluate('state.inputHistory');
  const showFrame = await displayedCommand(':Show Frame', 'current-frame', null);
  await browser.waitFor(`returnedFrameInspection()?.command.id === ${showFrame.command.id} && !busy`);
  assert.equal(showFrame.command.display, ':frame');
  assert.equal(showFrame.result.result.index, frameIndex);
  const frame = showFrame.result.result;
  assert.equal(frame.locals.length, 2);
  const localA = frame.locals.find(local => /(?:^|:)A$/.test(local.name));
  const localB = frame.locals.find(local => /(?:^|:)B$/.test(local.name));
  assert(localA && localB && localA['available-p'] && localB['available-p']);
  assert.equal(localA.value, '111');
  assert.equal(localB.value, '222');
  assert.equal(frame.arguments, `Original supplied arguments (2):\n  Arg 0: 111\n  Arg 1: 222\nCurrent source parameters:\n  Arg 0 (Required ${localA.name}): 111\n  Arg 1 (Required ${localB.name}): 222\n`);
  assert.equal(await browser.evaluate("document.querySelector('#stop-detail .frame-arguments').textContent"), frame.arguments);
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), frameIndex);
  assert((await browser.evaluate("document.querySelector('.current-function').textContent")).includes(functionName));
  const frameRows = await browser.evaluate("[...document.querySelectorAll('#stop-detail .locals tr')].map(row => row.textContent)");
  assert.equal(frameRows.length, 2);
  const localCommands = [];
  for (const [source, argument, expected] of [
    [':Show Local ' + localA.index, localA.index, `Local ${localA.index} (${localA.name}) = 111.`],
    [':Show Local All', null, `Locals for frame ${frameIndex} ${frame.function}:\n` + frame.locals.map(local => `  Local ${local.index} (${local.name}): ${local.value}\n`).join('')]
  ]) {
    const entry = await displayedCommand(source, 'local', argument);
    assert.equal(entry.result.result, expected);
    assert.equal(entry.result.generation, showFrame.result.generation);
    assert.equal(await browser.evaluate(`document.querySelector('.debugger-local[data-command-id="${entry.command.id}"] .local-result').textContent`), expected);
    assert.deepEqual(await browser.evaluate('returnedFrameInspection().result'), frame);
    assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#stop-detail .locals tr')].map(row => row.textContent)"), frameRows);
    assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), frameIndex);
    assert.deepEqual(await browser.evaluate('state.inputHistory'), listenerHistory);
    localCommands.push(entry);
  }
  const [indexed, all] = localCommands;
  await writeFile(join(output, 'frame-local-commands.json'), JSON.stringify({showFrame, indexed, all, frameRows}, null, 2));
  await clickText('#stop-detail', functionName);
  await browser.waitFor(`returnedFrameInspection()?.result.index === ${frameIndex} && !busy`);
  const unavailable = await browser.evaluate(`(() => {
    const key = commandKey(returnedFrameInspection().command);
    const original = commandResults.get(key);
    try {
      commandResults.set(key, {...original, result: {...original.result, locals: [
        {index: 0, name: 'unavailable-fixture', 'available-p': false, value: 'MUST-NOT-BE-DISPLAYED'}
      ]}});
      renderStops();
      return [...document.querySelectorAll('.locals td')].map(cell => cell.textContent);
    } finally {
      commandResults.set(key, original);
      renderStops();
    }
  })()`);
  assert.deepEqual(unavailable, ['Local 0 (unavailable-fixture):', '<unavailable>']);
  console.log('PASS fixture-only unavailable-local rendering ignores the value field');
  await debuggerAction(':Show Proceed Options');
  await waitText('.restarts', 'Continue browser test.');
  await screenshot('debugger');
  console.log('PASS browser condition, stack, typed/mouse frame selection, Show Frame, locals, and restart list');
  await clickText('.restarts', 'Continue browser test.');
  await waitText('#debugger-menu', 'Release Stop');
  await waitText('#stop-detail .recorded-frame', 'Recorded frame ' + frameIndex + ' from this closed stop.');
  await waitText('.locals', '111');
  await waitText('.locals', '222');
  assert.equal(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info["current-frame"]'), null);
  assert.equal(await browser.evaluate('document.querySelectorAll("#stop-detail .frame.selected").length'), 0);
  await screenshot('debugger-closed');
  console.log('PASS closed stop retains labelled printed frame locals and clears live frame selection');
  await debuggerAction('Release Stop');
  await listener();
  job = await selectJob('DEBUG');
  await waitText(job, '333');
  console.log('PASS browser restart and returned evaluation');
  await browser.waitFor("document.querySelector('#listener-state').hidden && !activeListenerJob && !busy");
  assert.equal(await browser.evaluate("document.querySelector('#process-state').textContent"), 'User Input');
  await enter('#source', '(+ 20 22)');
  await browser.waitFor("state.inputHistory.at(-1)?.source === '(+ 20 22)'");
  const resumedName = await browser.evaluate('state.inputHistory.at(-1).name');
  const resumedSelector = '[data-job="' + resumedName + '"]';
  await waitText(resumedSelector + ' .returned-values', '42');
  await releaseAccepted({selector: resumedSelector});
  console.log('PASS ordinary Listener input evaluates after CONTINUE');

  await releaseJob('DEBUG');

  const conditionName = marker + '-CHILD';
  await enter('#source', `(define-condition ${conditionName} (error) () (:report (lambda (condition stream) (declare (ignore condition)) (cerror "Resume browser printer." "${marker} child printer") (write-string "${marker} parent condition" stream)))) (unwind-protect (error '${conditionName}) (setf (find-class '${conditionName}) nil))`);
  job = await selectJob('CHILD');
  await waitText(job, 'Debugger');
  await clickText(job, 'Debugger');
  await browser.waitFor('!busy');
  const parentStop = await browser.evaluate('({token: selectedStop, id: stops.find(stop => same(stop.token, selectedStop)).info.id})');
  await waitText('#stop-detail', 'condition: running');
  await clickText('#stop-detail', 'Child Stop');
  await browser.waitFor('!busy');
  const childStop = await browser.evaluate('({token: selectedStop, id: stops.find(stop => same(stop.token, selectedStop)).info.id})');
  assert.notDeepEqual(childStop.token, parentStop.token);
  assert.deepEqual(await browser.evaluate('stops.find(stop => same(stop.token, selectedStop)).info.parent'), parentStop.token);
  await clickText('#stop-detail', 'Parent Stop');
  await browser.waitFor(`same(selectedStop, ${text(parentStop.token)}) && !busy`);
  await waitText('#stop-detail', 'condition: running');
  await clickText('#stop-detail', 'Child Stop');
  await browser.waitFor(`same(selectedStop, ${text(childStop.token)}) && !busy`);
  await waitText('#stop-detail .condition', marker + ' child printer');
  await debuggerAction(':Show Proceed Options');
  await clickText('.restarts', 'Resume browser printer.');
  await browser.waitFor("stops.find(stop => same(stop.token, selectedStop))?.info.state === ':closed' && !busy");
  await waitText('#stop-detail .condition', marker + ' child printer');
  await clickText('#stop-detail', 'Parent Stop');
  await browser.waitFor(`same(selectedStop, ${text(parentStop.token)}) && !busy`);
  await waitText('#stop-detail .condition', marker + ' parent condition');
  await debuggerAction('Stop ' + childStop.id + ' ');
  await browser.waitFor(`same(selectedStop, ${text(childStop.token)}) && !busy`);
  await debuggerAction('Release Stop');
  await clickText('#stops', 'Stop ' + parentStop.id + ' ');
  await debuggerAction(':Show Proceed Options');
  await clickText('.restarts', 'ABORT:');
  await browser.waitFor("stops.find(stop => same(stop.token, selectedStop))?.info.state === ':closed' && !busy");
  await waitText('#stop-detail .condition', marker + ' parent condition');
  await debuggerAction('Release Stop');
  await listener();
  job = await selectJob('CHILD');
  await waitText(job, 'aborted');
  await releaseJob('CHILD');
  console.log('PASS browser Parent/Child Stop navigation, printer continuation, closed-stop cached results, and owned fixture cleanup');

  const retainedJob = await accept(`(progn "${marker}-RETAINED" (values :retained))`);
  const retainedToken = await browser.evaluate(`state.jobs[${text(retainedJob.name)}].token`);
  await preventNextDispatch('release-job');
  await clickText(retainedJob.selector, 'Release');
  await unknownReply();
  const retainedRelease = await browser.evaluate("state.pending.find(record => record.operation === 'release-job')");
  await openMenu();
  await browser.click('#release-session');
  await waitText('#message', 'Resolve the recorded requests before releasing the session.');
  assert.equal(await browser.evaluate('state.session'), retainedRelease.session);
  assert.equal(await browser.evaluate('state.pending[0].id'), retainedRelease.id);
  await browser.click('#close-menu');
  await clickText('#pending', 'Check Release Outcome');
  await waitText('#pending', 'retained at last check; original release outcome unknown');
  assert.deepEqual(await browser.evaluate(`state.jobs[${text(retainedJob.name)}].token`), retainedToken);
  await clickText('#pending', 'Keep in History');
  await browser.waitFor('state.pending.length === 0');
  const archivedRelease = await browser.evaluate(`state.history.flatMap(item => item.pending).find(record => record.id === ${text(retainedRelease.id)})`);
  assert.equal(archivedRelease.status, 'retained at last check; original release outcome unknown');
  assert.deepEqual(archivedRelease.arguments.job, retainedToken);
  await openMenu();
  await browser.click('#resume-session');
  await browser.waitFor('connected && !busy');
  await listener();
  await releaseAccepted(retainedJob);
  assert.equal(await browser.evaluate(`state.history.flatMap(item => item.pending).filter(record => record.id === ${text(retainedRelease.id)}).length`), 1);
  console.log('PASS unresolved-request release guard, still-retained observation, Keep in History, and a separate release');

  await discardNextReply('start-listener');
  await enter('#source', 'Clear Output History');
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.some(record => record.status === 'outcome unknown')");
  const clearRecord = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending[0]");
  await browser.send('Page.reload');
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy && document.querySelector('#message')?.textContent.startsWith('Session ')");
  const laterJob = await accept(`(progn "${marker}-AFTER-CLEAR" (values :later))`);
  await openMenu();
  await browser.click('[data-activity="requests"]');
  await clickText('#pending', 'Repeat Original Request');
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.length === 0");
  await browser.waitFor(`JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).jobs[${text(clearRecord.arguments.name)}]?.effectsApplied`);
  const oldJob = await selectJob('VALUES');
  assert(await browser.evaluate(`document.querySelector(${text(oldJob)}).hidden`));
  assert.equal(await browser.evaluate(`document.querySelector(${text(laterJob.selector)}).hidden`), false);
  assert.equal(await browser.evaluate(`JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).inputHistory.filter(item => item.name === ${text(clearRecord.arguments.name)}).length`), 1);
  const inputOrder = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).inputHistory.map(item => item.name)");
  assert(inputOrder.indexOf(clearRecord.arguments.name) < inputOrder.indexOf(laterJob.name));
  await listener();
  await releaseAccepted(laterJob);
  await releaseAccepted({selector: '[data-job="' + clearRecord.arguments.name + '"]'});
  await openMenu();
  await browser.click('[data-activity="evaluations"]');
  const oldName = await browser.evaluate(`document.querySelector(${text(oldJob)}).dataset.job`);
  await clickText('#jobs', oldName.slice(0, 12));
  console.log('PASS browser Clear Output History replay preserves later output, retained jobs, and input history');

  job = await selectJob('VALUES');
  await discardNextReply('release-job');
  await clickText(job, 'Release');
  await unknownReply();
  await clickText('#pending', 'Check Release Outcome');
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.length === 0");
  await waitText('#pending', 'object released');
  await openMenu();
  await browser.click('#resume-session');
  await browser.waitFor("document.querySelector('#message').textContent.startsWith('Session ') && document.querySelector('#process-state').textContent !== 'Disconnected'");
  console.log('PASS browser reconciliation after discarding a job-release reply');

  await discardNextReply('release-session');
  await openMenu();
  await browser.click('#release-session');
  await unknownReply();
  await clickText('#pending', 'Check Release Outcome');
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.length === 0");
  await waitText('#pending', 'reference expired; original release outcome unknown');
  await browser.waitFor("connected && !busy && document.querySelector('#message').textContent.startsWith('Session expired. Connected with a new session.')");
  console.log('PASS automatic session recovery after a discarded release reply');
  const replacedSession = await browser.evaluate('state.session');
  const replacedInput = await browser.evaluate('state.inputHistory');
  await preventNextDispatch('monitor-state');
  await openMenu();
  await browser.click('#refresh');
  await browser.waitFor('!connected && !busy');
  assert.equal(await browser.evaluate('state.session'), replacedSession);
  await openMenu();
  await browser.click('#new-session');
  await browser.waitFor(`connected && !busy && state.session !== ${text(replacedSession)}`);
  assert.deepEqual(await browser.evaluate('state.inputHistory'), replacedInput);
  assert(await browser.evaluate(`state.history.some(item => item.session === ${text(replacedSession)})`));
  await browser.evaluate(`(async () => {
    const response = await fetch('/api', {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Mezzano-Request': '1'},
      body: JSON.stringify({session: ${text(replacedSession)}, operation: 'release-session', arguments: {}})});
    const reply = await response.json();
    if (!response.ok) throw new Error('Could not release replaced test session: ' + reply.error);
  })()`);
  console.log('PASS explicit New Session while disconnected preserves history; replaced owned session released');
  await openMenu();
  await browser.click('#release-session');
  await waitText('#message', 'Session released');
  console.log('PASS browser release of test jobs, stop, and session');
  const expectedConflicts = browser.errors.filter(error => error.source === 'network'
    && error.url === new URL('/api', url).href && error.text.includes('status of 409'));
  assert.equal(expectedConflicts.length, 2, 'Expected released-job and expired-session HTTP responses');
  assert.deepEqual(browser.errors.filter(error => !expectedConflicts.includes(error)), []);
  console.log('PASS no unexpected browser errors (two expected HTTP 409 responses)');
  console.log('Screenshots:', output);
} catch (error) {
  await browser.evaluate('window.releaseInitialInspection?.()');
  await screenshot('failure');
  await writeFile(join(output, 'failure-session.json'), await browser.evaluate('JSON.stringify(sessionStorage)'));
  await writeFile(join(output, 'failure.txt'), await browser.evaluate('document.body.innerText'));
  await writeFile(join(output, 'failure-editor.json'), JSON.stringify(await browser.evaluate('({active: document.activeElement?.outerHTML, source: document.querySelector("#source").value, busy, activity})'), null, 2));
  console.error('Retained fixture identities:', join(output, 'failure-session.json'));
  console.error(JSON.stringify(browser.errors));
  throw error;
} finally {
  await browser.close();
}
