import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

async function openBrowser(url) {
  const profile = await mkdtemp(join(tmpdir(), 'lispm-chromium-'));
  const process = spawn(globalThis.process.env.CHROMIUM ?? 'chromium', ['--headless', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--no-first-run',
    `--user-data-dir=${profile}`, '--window-size=1280,1024', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  let processError;
  process.stderr.on('data', data => { diagnostics += data; });
  process.on('error', error => { processError = error; });
  const exited = new Promise(resolve => process.on('exit', resolve));
  const pending = new Map();
  const errors = [];
  let socket;
  let nextId = 0;

  async function close() {
    if (socket) socket.close();
    if (process.pid && process.exitCode === null && process.signalCode === null) {
      process.kill('SIGTERM');
      const ended = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
      if (!ended) { process.kill('SIGKILL'); await exited; }
    }
    await rm(profile, { recursive: true, force: true });
  }

  try {
    let port;
    const deadline = Date.now() + 15000;
    while (!port) {
      if (processError) throw processError;
      if (process.exitCode !== null) throw new Error(`Chromium exited: ${diagnostics}`);
      try {
        port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error(`Chromium startup timed out: ${diagnostics}`);
      if (!port) await delay(50);
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    assert(page, 'Chromium did not create a page');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails);
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        errors.push(message.params.entry);
      }
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Chromium debugging connection closed'));
      }
      pending.clear();
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chromium command timed out: ${method}`));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function waitFor(expression, seconds = 30) {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(100);
      }
      throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
    }
    async function click(selector) {
      const position = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) throw new Error('Invisible element');
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
    }
    async function screenshot(path) {
      await evaluate('document.fonts.ready.then(() => true)');
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path, Buffer.from(result.data, 'base64'));
    }
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false });
    const navigation = await send('Page.navigate', { url });
    if (navigation.errorText) throw new Error(navigation.errorText);
    await waitFor("document.readyState === 'complete'");
    return { send, evaluate, waitFor, click, screenshot, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}

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

async function enter(selector, input) {
  await browser.waitFor('connected && !busy');
  await browser.click(selector);
  await browser.waitFor(`document.activeElement === document.querySelector(${text(selector)})`);
  await browser.send('Input.insertText', { text: input });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await browser.send('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers});
  await browser.send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers});
}
async function fill(selector, input) {
  await browser.waitFor('connected && !busy');
  await browser.click(selector);
  await browser.waitFor(`document.activeElement === document.querySelector(${text(selector)})`);
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text: input});
}
async function accept(command) {
  const previous = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).inputHistory.map(item => item.name)");
  await fill('#source', command);
  await key('Enter', 'Enter', 13);
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

async function unknownReply() {
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.some(record => record.status === 'outcome unknown')");
  await openMenu();
  await browser.click('[data-activity="requests"]');
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
  let commandJob = await accept(defaultCommand);
  await releaseAccepted(commandJob);
  console.log('PASS browser SPACE/COMPLETE, argument prompt, HELP, and explicit default');

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
  commandJob = await accept(`(let ((base (translate-logical-pathname "SYS:HOME;"))) (values (namestring (merge-pathnames ${JSON.stringify(leaf + '.lisp')} base)) (namestring (merge-pathnames ${JSON.stringify(leaf + '-second.lisp')} base)) (namestring (merge-pathnames ${JSON.stringify(leaf + '*.lisp')} base))))`);
  const [pathname, secondPathname, wildcard] = (await browser.evaluate(`document.querySelector(${text(commandJob.selector + ' .returned-values')}).textContent`)).split('\n').map(value => JSON.parse(value));
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
  await releaseAccepted(commandJob);
  commandJob = await accept(`(delete-file ${JSON.stringify(pathname)}) (delete-file (compile-file-pathname ${JSON.stringify(pathname)})) (delete-file ${JSON.stringify(secondPathname)}) (makunbound '${variableName}) (values)`);
  await releaseAccepted(commandJob);
  console.log('PASS browser Unicode physical pathname presentation/insertion/default, contents, Show/Load/Compile File, and file cleanup');

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

  await enter('#source', `(format t "${marker}-VALUES~%") (values (+ 20 22) :done)`);
  let job = await selectJob('VALUES');
  await waitText(job, '42\n:DONE');
  await waitText(job, 'returned');
  await screenshot('listener-result');
  console.log('PASS browser evaluation, output, and multiple values');

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
  await enter(job + ' .input-form textarea', 'Browser input');
  await waitText(job, '"Browser input"\nNIL');
  await releaseJob('INPUT');
  await browser.click('#window-label');
  await browser.click('#interactive');
  await browser.click('#close-menu');
  console.log('PASS browser interactive input and returned values');

  await discardNextReply('start-listener');
  await enter('#source', `(format t "${marker}-REPLAY~%") (values :replayed)`);
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.some(record => record.status === 'outcome unknown')");
  const originalRequest = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending[0]");
  assert.equal(originalRequest.operation, 'start-listener');
  await browser.send('Page.reload');
  await browser.waitFor("document.querySelector('#message').textContent.startsWith('Session ') && connected && !busy");
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

  const functionName = marker + '-DEBUG';
  await enter('#source', `(defun ${functionName} (a b) (declare (optimize (debug 3) (safety 3))) (cerror "Continue browser test." "${marker} debugger") (+ a b)) (unwind-protect (${functionName} 111 222) (fmakunbound '${functionName}))`);
  job = await selectJob('DEBUG');
  await waitText(job, 'Debugger');
  await clickText(job, 'Debugger');
  await debuggerAction('Inspect Condition');
  await waitText('#stop-detail .condition', marker + ' debugger');
  await debuggerAction(':Show Backtrace');
  await waitText('#stop-detail', functionName);
  await clickText('#stop-detail', functionName);
  await waitText('.locals', '111');
  await waitText('.locals', '222');
  assert(await browser.evaluate("document.querySelector('#stop-detail').textContent.includes('Original caller arguments are unavailable')"));
  await enter('#debugger-command', ':Show Local 0');
  await browser.waitFor("document.querySelectorAll('.locals tr').length === 1 && document.querySelector('.locals').textContent.includes('111')");
  await enter('#debugger-command', ':Show Local All');
  await browser.waitFor("document.querySelectorAll('.locals tr').length === 2");
  await debuggerAction(':Show Proceed Options');
  await waitText('.restarts', 'Continue browser test.');
  await screenshot('debugger');
  console.log('PASS browser condition, stack, locals, and restart list');
  await clickText('.restarts', 'Continue browser test.');
  await waitText('#debugger-menu', 'Release Stop');
  await debuggerAction('Release Stop');
  await listener();
  job = await selectJob('DEBUG');
  await waitText(job, '333');
  console.log('PASS browser restart and returned evaluation');

  await releaseJob('DEBUG');
  await discardNextReply('start-listener');
  await enter('#source', 'Clear Output History');
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.some(record => record.status === 'outcome unknown')");
  const clearRecord = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending[0]");
  await browser.send('Page.reload');
  await browser.waitFor("document.querySelector('#message').textContent.startsWith('Session ') && connected && !busy");
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
  await openMenu();
  await browser.click('#new-session');
  await browser.waitFor("document.querySelector('#message').textContent.startsWith('Session ') && document.querySelector('#process-state').textContent !== 'Disconnected'");
  console.log('PASS browser recovery from an expired session after a discarded release reply');
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
