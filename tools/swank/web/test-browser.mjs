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
  await browser.waitFor(`[...document.querySelectorAll(${text(container + ' button')})].filter(button => button.textContent.includes(${text(value)})).length === 1`);
  const selector = await browser.evaluate(`(() => {
    const buttons = [...document.querySelectorAll(${text(container + ' button')})];
    const matches = buttons.filter(button => button.textContent.includes(${text(value)}));
    if (matches.length !== 1) throw new Error('Expected one button: ' + ${text(value)} + ', found ' + matches.length);
    matches[0].setAttribute('data-browser-test', 'target');
    return '[data-browser-test="target"]';
  })()`);
  await browser.click(selector);
  await browser.evaluate("document.querySelector('[data-browser-test=target]')?.removeAttribute('data-browser-test')");
}

async function enter(selector, input) {
  await browser.click(selector);
  await browser.send('Input.insertText', { text: input });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
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
  await screenshot('listener-ready');
  await browser.click('#window-label');
  await screenshot('system-menu');
  await browser.click('#close-menu');
  await enter('#source', `(format t "${marker}-VALUES~%") (values (+ 20 22) :done)`);
  let job = await selectJob('VALUES');
  await waitText(job, '42\n:DONE');
  await waitText(job, 'returned');
  await screenshot('listener-result');
  console.log('PASS browser evaluation, output, and multiple values');

  await browser.send('Page.reload');
  job = await selectJob('VALUES');
  await waitText(job, '42\n:DONE');
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

  await discardNextReply('start-evaluation');
  await enter('#source', `(format t "${marker}-REPLAY~%") (values :replayed)`);
  await browser.waitFor("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending.some(record => record.status === 'outcome unknown')");
  const originalRequest = await browser.evaluate("JSON.parse(sessionStorage.getItem('mezzano-monitor-v1')).pending[0]");
  assert.equal(originalRequest.operation, 'start-evaluation');
  await browser.send('Page.reload');
  await browser.waitFor("document.querySelector('#message').textContent.startsWith('Session ')");
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
  await debuggerAction('Show Condition');
  await waitText('#stop-detail .condition', marker + ' debugger');
  await debuggerAction('Show Stack');
  await waitText('#stop-detail', functionName);
  await clickText('#stop-detail', functionName);
  await waitText('.locals', '111');
  await waitText('.locals', '222');
  await debuggerAction('Show Restarts');
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
  console.error('Retained fixture identities:', join(output, 'failure-session.json'));
  console.error(JSON.stringify(browser.errors));
  throw error;
} finally {
  await browser.close();
}
