import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function openBrowser(url) {
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

