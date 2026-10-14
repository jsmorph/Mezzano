import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join, resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'session-recovery-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
const q = JSON.stringify;
const marker = 'RECOVERY-' + randomBytes(6).toString('hex').toUpperCase();
const counter = 'cl-user::*' + marker + '*';
const owned = [];
let stopJob;
let restartBeforeClick;
const ready = () => browser.waitFor("typeof connected !== 'undefined' && connected && !busy", 45);

async function key(key, code, windowsVirtualKeyCode, modifiers = 0, text) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode, modifiers,
      ...(type === 'keyDown' && text ? {text} : {})
    });
  }
}

async function fill(source) {
  await ready();
  await browser.evaluate("showActivity('listener')");
  await browser.click('#source');
  await key('a', 'KeyA', 65, 2);
  await browser.send('Input.insertText', {text: source});
}

async function command(source, lose = false) {
  const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
  await fill(source);
  if (lose) await arm('drop', 'start-listener', source);
  await key('Enter', 'Enter', 13);
  if (lose) {
    await browser.waitFor(`state.pending.some(item => item.arguments.source === ${q(source)} && item.status === 'outcome unknown')`);
    const record = await browser.evaluate(`state.pending.find(item => item.arguments.source === ${q(source)})`);
    owned.push(record.arguments.name);
    return record;
  }
  const expression = `state.inputHistory.find(item => item.source === ${q(source)} && !${q(previous)}.includes(item.name))`;
  await browser.waitFor(expression, 40);
  const {name} = await browser.evaluate(expression);
  owned.push(name);
  await browser.waitFor(`!busy && views.get(${q(name)})?.info.state === ':returned'`, 40);
  return browser.evaluate(`({name: ${q(name)}, info: views.get(${q(name)}).info, text: views.get(${q(name)}).text})`);
}

async function arm(type, operation, source) {
  await browser.evaluate(`window.recoveryFault = ${q({type, operation, source})}`);
}

async function newIdentity(previous) {
  await browser.waitFor(`typeof connected !== 'undefined' && connected && !busy && state.session !== ${q(previous)}`, 45);
  assert((await browser.evaluate("document.querySelector('#message').textContent"))
    .startsWith('Session expired. Connected with a new session.'));
  return browser.evaluate('state.session');
}

async function expiryStep(label, operation, action) {
  const previous = await browser.evaluate('state.session');
  await arm('expire', operation);
  await action();
  await newIdentity(previous);
  await browser.screenshot(join(output, label + '.png'));
  return previous;
}

async function checkSpace() {
  await fill('Se');
  await key(' ', 'Space', 32, 0, ' ');
  await browser.waitFor("document.querySelector('#source').value === 'Set '");
  await ready();
}

async function clickText(selector, text) {
  await browser.waitFor(`[...document.querySelectorAll(${q(selector)})].some(item => item.textContent === ${q(text)})`);
  await browser.evaluate(`(() => {
    const item = [...document.querySelectorAll(${q(selector)})].find(item => item.textContent === ${q(text)});
    item.dataset.recoveryTarget = 'yes';
  })()`);
  await browser.click('[data-recovery-target="yes"]');
  await browser.evaluate("document.querySelector('[data-recovery-target=yes]')?.removeAttribute('data-recovery-target')");
}

try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.recoveryRequests = [];
    window.recoveryFault = null;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const request = args[1]?.body && JSON.parse(args[1].body);
      const record = {request, started: performance.now()};
      window.recoveryRequests.push(record);
      try {
        const fault = window.recoveryFault;
        const matches = fault && request?.operation === fault.operation
          && (fault.source === undefined || request.arguments?.source === fault.source);
        if (matches) {
          window.recoveryFault = null;
          if (fault.type === 'expire') {
            const expired = await originalFetch('/api', {
              method: 'POST',
              headers: {'Content-Type': 'application/json', 'X-Mezzano-Request': '1'},
              body: JSON.stringify({session: request.session, operation: 'release-session', arguments: {}})
            });
            if (!expired.ok) throw new Error('Fixture could not release its session');
          }
          if (fault.type === 'transport') {
            record.fixture = 'transport';
            throw new TypeError('Recovery fixture transport failure');
          }
          if (fault.type === 'other') {
            record.fixture = 'other rejection';
            return new Response(JSON.stringify({error: ':released-stop', uncertain: false}), {
              status: 409, headers: {'Content-Type': 'application/json'}
            });
          }
        }
        const response = await originalFetch(...args);
        record.status = response.status;
        if (!response.ok) record.error = await response.clone().json();
        if (matches && fault.type === 'drop' && response.ok) {
          await response.clone().arrayBuffer();
          record.fixture = 'discarded successful reply';
          throw new TypeError('Recovery fixture discarded successful reply');
        }
        return response;
      } finally {
        record.elapsed = performance.now() - record.started;
      }
    };
    document.addEventListener('DOMContentLoaded', () => {
      window.recoveryRefreshes = [];
      const originalRefresh = refresh;
      refresh = async (...args) => {
        const record = {started: performance.now()};
        window.recoveryRefreshes.push(record);
        try { return await originalRefresh(...args); }
        finally { record.elapsed = performance.now() - record.started; }
      };
    });
  `});
  await browser.send('Page.navigate', {url});
  await ready();
  console.log('Fixture', marker);
  await command(`(defparameter ${counter} 0)`);
  await browser.evaluate("showActivity('examiner')");
  await ready();
  await clickText('#examiner-candidates button', 'Mezzano user guide');
  await ready();
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Mezzano user guide')");
  const viewerBefore = await browser.evaluate('state.examiner');
  await browser.evaluate("showActivity('listener')");
  stopJob = await browser.evaluate(`(() => {
    const name = freshName();
    run(() => mutate('start-evaluation', {
      name, source: '(cerror "Continue recovery fixture." "${marker}")', package: 'CL-USER'
    }));
    return name;
  })()`);
  owned.push(stopJob);
  await browser.waitFor(`views.get(${q(stopJob)})?.info.stops?.length`, 45);
  await browser.evaluate(`void run(async () => {
    const stop = views.get(${q(stopJob)}).info.stops[0];
    await selectStop(stop);
    await submit(stop, 'condition');
  })`);
  await browser.waitFor("!busy && state.commands.length === 4 && state.commands.every(command => commandResults.get(commandKey(command))?.state === ':returned')", 90);
  assert.deepEqual(await browser.evaluate('state.commands.map(command => command.command).sort()'),
    ['condition', 'current-frame', 'frames', 'restarts']);
  console.log('Prepared retained debugger command');
  const oldCommands = await browser.evaluate('state.commands');
  const historyBefore = await browser.evaluate('state.inputHistory');
  const increment = `(incf ${counter})`;
  const uncertain = await command(increment, true);
  const oldSession = await browser.evaluate('state.session');
  const beforeReload = await browser.evaluate('window.recoveryRequests');
  const vanished = owned.shift();
  await browser.evaluate(`api('release-job', {job: state.jobs[${q(vanished)}].token})`);
  await browser.evaluate("api('release-session')");
  await browser.send('Page.reload', {ignoreCache: true});
  await newIdentity(oldSession);
  const archived = await browser.evaluate(`state.history.find(item => item.session === ${q(oldSession)})`);
  assert.deepEqual(archived.pending, [uncertain]);
  assert.deepEqual(archived.commands, oldCommands);
  assert.deepEqual(await browser.evaluate('state.inputHistory'), historyBefore);
  assert.deepEqual(await browser.evaluate('state.examiner'), viewerBefore);
  assert.equal(await browser.evaluate('state.commands.length'), 0);
  assert.equal(await browser.evaluate('state.pending.length'), 0);
  assert.equal(await browser.evaluate(`Boolean(state.jobs[${q(vanished)}])`), false);
  const rebound = await browser.evaluate(`({job: state.jobs[${q(uncertain.arguments.name)}], stop: views.get(${q(stopJob)}).info.stops[0]})`);
  assert.notEqual(rebound.job.token[1], oldSession);
  assert.notEqual(rebound.stop[1], oldSession);
  assert.equal(await browser.evaluate("window.recoveryRequests.filter(r => ['start-listener', 'start-evaluation', 'submit'].includes(r.request?.operation)).length"), 0);
  await checkSpace();
  assert.deepEqual((await command(counter)).info.values, ['1']);
  assert.deepEqual((await command('(+ 1 2)')).info.values, ['3']);
  await browser.screenshot(join(output, 'startup-recovery.png'));
  console.log('PASS expired startup, uncertain request and command archives, new tokens, histories, and no replay');
  const beforeRejection = await browser.evaluate('state.session');
  await fill(increment);
  await arm('expire', 'start-listener', increment);
  await key('Enter', 'Enter', 13);
  await newIdentity(beforeRejection);
  const rejected = await browser.evaluate(`state.history.find(item => item.session === ${q(beforeRejection)}).pending[0]`);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.error, ':expired-session');
  assert.equal(await browser.evaluate(`Boolean(state.jobs[${q(rejected.arguments.name)}])`), false);
  assert.equal(await browser.evaluate("document.querySelector('#source').value"), increment);
  assert.deepEqual((await command(counter)).info.values, ['1']);
  await browser.evaluate("showActivity('requests')");
  assert((await browser.evaluate("document.querySelector('#pending').textContent")).includes(rejected.id));
  await browser.screenshot(join(output, 'rejected-request-history.png'));
  console.log('PASS expired evaluation is archived as rejected and never evaluated');
  await fill('Sh');
  const beforeCompletion = await browser.evaluate('state.session');
  await arm('expire', 'listener-assistance');
  await key(' ', 'Space', 32, 0,' ');
  await newIdentity(beforeCompletion);
  await checkSpace();
  console.log('PASS active Listener expiration and subsequent SPACE completion');
  await browser.evaluate(`
    state.examiner.viewers.push({name: 'Recovery Viewer', sections: [], bookmarks: [],
      candidates: [], candidateIndex: -1, current: null, scroll: 0});
    state.examiner.current = 'Recovery Viewer';
    save();
  `);
  await expiryStep('examiner-recovery', 'document-query', () => browser.evaluate("showActivity('examiner')"));
  await browser.waitFor("document.querySelectorAll('#examiner-candidates button').length > 0");
  await clickText('#examiner-candidates button', 'Mezzano user guide');
  await ready();
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Mezzano user guide')");
  assert((await browser.evaluate('state.examiner.viewers')).some(viewer => viewer.name === 'Default Viewer' && viewer.bookmarks.length));
  console.log('PASS visible Examiner recovery, catalog/topic display, and preserved earlier viewer bookmarks');
  await expiryStep('peek-recovery', 'processes', async () => {
    await browser.evaluate("showActivity('peek')");
    await browser.click('[data-peek-mode="processes"]');
  });
  await browser.waitFor("document.querySelector('#peek-sample-status').dataset.state === 'sampled' && document.querySelectorAll('#process-rows tr').length > 0");
  console.log('PASS visible Peek recovers and resamples');
  await browser.evaluate("showActivity('listener')");
  const liveSession = await browser.evaluate('state.session');
  await arm('transport', 'monitor-state');
  await browser.evaluate('void run(refresh)');
  await browser.waitFor('!connected && !busy');
  assert.equal(await browser.evaluate('connected'), false);
  assert.equal(await browser.evaluate('state.session'), liveSession);
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await ready();
  assert.equal(await browser.evaluate('state.session'), liveSession);
  await arm('other', 'monitor-state');
  await browser.evaluate('void run(refresh)');
  await browser.waitFor("document.querySelector('#message').textContent === ':released-stop' && !busy");
  assert.equal(await browser.evaluate('state.session'), liveSession);
  assert.equal(await browser.evaluate('connected'), true);
  assert.equal(await browser.evaluate("document.querySelector('#message').textContent"), ':released-stop');
  console.log('PASS transport failure resumes the same session and other rejections do not replace it');
  await browser.evaluate(`void run(async () => {
    const stop = views.get(${q(stopJob)}).info.stops[0];
    await selectStop(stop);
    await submit(stop, 'restarts');
  })`);
  await browser.waitFor("[...document.querySelectorAll('.restarts button')].some(button => button.textContent.includes('Continue recovery fixture.'))");
  restartBeforeClick = await browser.evaluate(`(() => {
    const button = [...document.querySelectorAll('#debugger .restarts button')]
      .find(button => button.textContent.includes('Continue recovery fixture.'));
    return {disabled: button.disabled, text: button.textContent, pending: stopCommandPending(selectedStop)};
  })()`);
  await browser.waitFor('!busy && !stopCommandPending(selectedStop)');
  assert(await browser.evaluate(`[...document.querySelectorAll('#debugger .restarts button')]
    .some(button => button.textContent === ${q(restartBeforeClick.text)} && !button.disabled)`));
  await clickText('#debugger .restarts button', restartBeforeClick.text);
  await browser.waitFor(`!busy && views.get(${q(stopJob)})?.info.state === ':returned'`, 45);
  await browser.evaluate("run(()=>mutate('release-stop', {stop:selectedStop}))");
  await command(`(progn (makunbound '${counter}) (unintern '${counter} "CL-USER") (values))`);
  await browser.evaluate(`void run(async () => {
    for (const name of ${q(owned)}) await mutate('release-job', {job: state.jobs[name].token});
    await mutate('release-session', {});
  })`);
  await browser.waitFor('!connected && !busy');
  assert.equal(await browser.evaluate('connected'), false);
  const requests = await browser.evaluate('window.recoveryRequests');
  const conflicts = browser.errors.filter(error => error.source === 'network' && error.url === new URL('/api', url).href && error.text.includes('status of 409'));
  assert.equal(conflicts.length, 5);
  assert.deepEqual(browser.errors.filter(error => !conflicts.includes(error)), []);
  await writeFile(join(output, 'result.json'), JSON.stringify({
    marker, owned, oldSession, archived, rejected, rebound, beforeReload, requests, restartBeforeClick,
    refreshes: await browser.evaluate('window.recoveryRefreshes'),
    errors: browser.errors, cleaned: true
  }, null, 2));
  console.log('PASS side-effect counter, retained stop/jobs, and final session cleaned; five expected expired-session responses');
} catch (error) {
  await browser.screenshot(join(output, 'failure.png'));
  await writeFile(join(output, 'failure.json'), JSON.stringify({
    error: error.stack, marker, counter, owned, stopJob, restartBeforeClick,
    state: await browser.evaluate('state'),
    requests: await browser.evaluate('window.recoveryRequests'),
    refreshes: await browser.evaluate('window.recoveryRefreshes'),
    errors: browser.errors
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}
