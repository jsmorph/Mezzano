import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'clear-all-fixture-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser('about:blank');
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.fetch = async (url, options) => {
      if (url !== '/api') throw new Error('Unexpected fixture fetch ' + url);
      const request = JSON.parse(options.body);
      let value;
      switch (request.operation) {
        case 'open-session': case 'resume-session': value = {}; break;
        case 'jobs': case 'stops': value = []; break;
        case 'monitor-state': value = {listener: {package: 'COMMON-LISP-USER', prompt: 'Command: '}, jobs: [], stops: []}; break;
        case 'listener-information': value = {package: 'COMMON-LISP-USER', prompt: 'Command: '}; break;
        default: throw new Error('Unexpected fixture operation ' + request.operation);
      }
      return new Response(JSON.stringify({value, diagnostics: []}), {status: 200});
    };
  `});
  await browser.send('Page.navigate', {url});
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  const result = await browser.evaluate(`(async () => {
    connected = false;
    const old = '1'.repeat(64), receipt = '2'.repeat(64), later = '3'.repeat(64);
    const token = [':stop', state.session, 7];
    const command = {stop: token, id: 0, command: 'condition'};
    const oldRequest = {id: '4'.repeat(64)}, laterRequest = {id: '5'.repeat(64)};
    const clearState = {pending: [oldRequest.id], commands: [commandKey(command)], history: 1, inputSequence: 1};
    const ownRequest = {id: '6'.repeat(64), operation: 'start-listener',
      arguments: {name: receipt, source: 'Clear All'}, clearState};
    state.jobs = {[old]: {name: old}, [receipt]: {name: receipt}, [later]: {name: later}};
    state.pending = [oldRequest, ownRequest, laterRequest];
    state.history = [
      {session: 'earlier', pending: [oldRequest], commands: [command]},
      {session: state.session, pending: [oldRequest, laterRequest], commands: [command]}
    ];
    state.commands = [command];
    commandResults.set(commandKey(command), {state: ':returned'});
    stops = [{token, info: {id: 123, state: ':closed'}}];
    selectedStop = token;
    state.inputHistory = [{name: old, sequence: 0}, {name: receipt, sequence: 1}, {name: later, sequence: 2}];
    state.initialHerald = {session: state.session, hidden: false};
    createView(state.jobs[old]);
    createView(state.jobs[later]);
    const info = {state: ':running', 'output-length': 0, 'current-boot-p': true,
      'interrupt-id': null, 'listener-result': {kind: ':command', effects: []}};
    await updateJob(state.jobs[receipt], info, {start: 0, text: '', end: 0});
    applyListenerEffects(state.jobs[receipt], info);
    const running = {applied: Boolean(state.jobs[receipt].effectsApplied), source: state.jobs[receipt].source,
      metadata: state.jobs[receipt].clearState};
    info.state = ':returned';
    info['listener-result'].effects = [{operation: ':clear-all', jobs: [old], stops: [123]}];
    await updateJob(state.jobs[receipt], info, {start: 0, text: '', end: 0});
    applyListenerEffects(state.jobs[receipt], info);
    views.get(receipt).element.hidden = Boolean(state.jobs[receipt].hidden);
    const cleared = {jobs: Object.keys(state.jobs), pending: state.pending.map(item => item.id),
      history: state.history, inputs: state.inputHistory, commands: state.commands,
      results: commandResults.size, selectedStop, herald: state.initialHerald.hidden,
      hidden: views.get(receipt).element.hidden, receipt: state.jobs[receipt].receipt};
    state.pending.push({id: '7'.repeat(64)});
    await updateJob(state.jobs[receipt], info, {start: 0, text: '', end: 0});
    applyListenerEffects(state.jobs[receipt], info);
    applyMutation(ownRequest, [':job', state.session, 2]);
    state.initialHerald.hidden = false;
    const foreignHistory = JSON.stringify({inputs: state.inputHistory, history: state.history, pending: state.pending});
    const foreign = {name: '8'.repeat(64)};
    applyListenerEffects(foreign, {...info, 'listener-result': {kind: ':command',
      effects: [{operation: ':clear-output-history'}]}});
    const outputHistory = {herald: state.initialHerald.hidden, applied: Boolean(foreign.effectsApplied)};
    applyListenerEffects(foreign, {...info, 'listener-result': {kind: ':command',
      effects: [{operation: ':clear-all', jobs: [later], stops: []}]}});
    return {old, receipt, later, oldRequest, ownRequest, laterRequest, running, cleared,
      finalPending: state.pending.map(item => item.id), finalInputs: state.inputHistory,
      outputHistory, foreign: {hidden: foreign.hidden, receipt: foreign.receipt,
        herald: state.initialHerald.hidden,
        releasedTargetRemoved: !state.jobs[later],
        preserved: foreignHistory === JSON.stringify({inputs: state.inputHistory, history: state.history, pending: state.pending})}};
  })()`);
  assert.equal(result.running.applied, false);
  assert.equal(result.running.source, 'Clear All');
  assert.deepEqual(result.running.metadata, result.ownRequest.clearState);
  assert.deepEqual(result.cleared.jobs, [result.receipt, result.later]);
  assert.deepEqual(result.cleared.pending, [result.ownRequest.id, result.laterRequest.id]);
  assert.deepEqual(result.cleared.history.map(item => item.pending), [[result.laterRequest]]);
  assert.deepEqual(result.cleared.inputs, [{name: result.later, sequence: 2}]);
  assert.deepEqual(result.cleared.commands, []);
  assert.equal(result.cleared.results, 0);
  assert.equal(result.cleared.selectedStop, null);
  assert.equal(result.cleared.herald, true);
  assert.equal(result.cleared.hidden, true);
  assert.equal(result.cleared.receipt, true);
  assert.deepEqual(result.finalInputs, result.cleared.inputs);
  assert.deepEqual(result.finalPending, [...result.cleared.pending, '7'.repeat(64)]);
  assert.deepEqual(result.outputHistory, {herald: false, applied: false});
  assert.deepEqual(result.foreign, {hidden: true, receipt: true, herald: false, releasedTargetRemoved: true, preserved: true});
  assert.deepEqual(browser.errors, []);
  await browser.screenshot(join(output, 'typed-effect.png'));
  await writeFile(join(output, 'result.json'), JSON.stringify({fixtureOnly: true, guestRequests: 0, result, errors: browser.errors}, null, 2));
  console.log('PASS typed Clear All effect, running/terminal boundary, lost-start metadata, later records, once-only application, and receipt reconciliation; zero guest requests');
} catch (error) {
  await browser.screenshot(join(output, 'failure.png'));
  throw error;
} finally {
  await browser.close();
}
