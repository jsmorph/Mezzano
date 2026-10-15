import assert from 'node:assert/strict';
import {access, mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const output = process.argv[3] ?? '/tmp/mezzano-image-restore-test';
await mkdir(output, {recursive:true});
for (const name of ['ready.json','restored']) {
  try {
    await access(output+'/'+name);
    throw new Error('Use a fresh output directory for the image-restoration test');
  } catch (error) {if(error.code !== 'ENOENT') throw error;}
}
const browser = await openBrowser(process.argv[2] ?? 'http://127.0.0.1:8765/');
const symbol = '*WEB-RESTORE-' + randomBytes(6).toString('hex').toUpperCase() + '*';
const prefix = symbol.slice(1,-1);
const maker = prefix+'-MAKER', ancestor = prefix+'-ANCESTOR', current = prefix+'-CURRENT';
const helper = prefix+'-HELPER', reader = prefix+'-READER', cleanups = prefix+'-CLEANUPS';
const cell = prefix+'-CELL', values = prefix+'-VALUES';
const names = [maker,ancestor,current,helper,reader,cleanups,cell,values];
const owned = [];
const evidence = {};
const q = JSON.stringify;
const ready = () => browser.waitFor("typeof connected !== 'undefined' && connected && !busy",120);
async function enter(selector, source) {
  await ready();
  await browser.evaluate(`setEditor(document.querySelector(${q(selector)}),${q(source)},${Array.from(source).length}); document.querySelector(${q(selector)}).focus()`);
  for (const type of ['keyDown','keyUp']) {
    await browser.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  }
}
async function start(source) {
  await ready();
  const previous = await browser.evaluate('Object.keys(state.jobs)');
  await browser.evaluate("showActivity('listener')");
  await enter('#source',source);
  const match = `Object.values(state.jobs).find(job => job.source === ${q(source)} && !${q(previous)}.includes(job.name))`;
  await browser.waitFor(match,120);
  const name = await browser.evaluate(`${match}.name`);
  owned.push(name);
  return name;
}
async function submit(source) {
  const name = await start(source);
  await browser.waitFor(`views.get(${q(name)})?.info.state === ':returned' && !busy`,120);
  return name;
}
async function command(source, operation, selector='#source') {
  const prior = await browser.evaluate('stops.find(stop=>same(stop.token,selectedStop)).info["next-command-id"]');
  await enter(selector,source);
  await browser.waitFor(`state.commands.some(command=>same(command.stop,selectedStop)&&command.id>=${prior}&&command.command===${q(operation)}) && !busy`,120);
  await browser.waitFor(`commandResults.get(commandKey(latestCommand(${q(operation)})))?.state===':returned' && !busy`,120);
  return browser.evaluate(`({command:latestCommand(${q(operation)}),result:commandResults.get(commandKey(latestCommand(${q(operation)})))})`);
}
async function evaluate(source,expected,selector='#source') {
  const record = await command(source,'evaluate',selector);
  assert.deepEqual(record.result.result||[],expected);
  return record;
}
async function historyComplete() {
  await browser.waitFor(`connected && !busy && selectedStop && !nextStopInspection(selectedStop)
    && !stopCommandPending(selectedStop) && !nextHistoricalCommand()`,120);
}
async function openDebugger(name) {
  await browser.waitFor(`views.get(${q(name)})?.info.state===':running' && views.get(${q(name)}).info.stops?.length===1 && !busy`,120);
  await browser.evaluate("showActivity('listener')");
  await browser.evaluate(`views.get(${q(name)}).operations.querySelector('button').dataset.restoreDebugger='target'`);
  await browser.click('[data-restore-debugger="target"]');
  await historyComplete();
}
try {
  await ready();
  const initial = await submit(`(progn (defvar cl-user::${symbol} 0) (incf cl-user::${symbol}))`);
  assert.deepEqual(await browser.evaluate(`views.get(${q(initial)}).info.values`),['1']);
  const active = await start(`(unwind-protect (progn
    (defun ${maker} (${ancestor} ${cleanups})
      (declare (optimize (debug 3) (safety 3) (speed 1)))
      (flet ((${helper} () ${ancestor}))
        (lambda (${current})
          (declare (notinline ${helper}))
          (let ((${reader} (lambda () (incf ${current}))))
            (unwind-protect
                 (progn (break "${prefix} saved lexical stop")
                        (values ${ancestor} (funcall ${reader}) (${helper})))
              (incf (car ${cleanups})))))))
    (assert (compiled-function-p (symbol-function '${maker})))
    (let ((${cell} (list 0)))
      (multiple-value-call
          (lambda (&rest ${values}) (values-list (append ${values} (list (car ${cell})))))
        (funcall (${maker} 37 ${cell}) 41))))
    (when (fboundp '${maker}) (fmakunbound '${maker}))
    (dolist (name '(${names.join(' ')})) (unintern name)))`);
  await browser.waitFor(`activeListenerJob===${q(active)} && listenerDebugger?.depth===1 && !busy`,120);
  await historyComplete();
  const frames = await browser.evaluate(`returnedResult('frames').map((frame,index)=>({frame,index})).filter(item=>item.frame.function.includes(${q(maker)}))`);
  assert.equal(frames.length,1);
  const frame = frames[0].index;
  await command(':Set Current Frame '+frame,'select-frame');
  await evaluate(`(vector ${ancestor} ${current})`,['#(37 41)']);
  const inspection = await command(':Inspect','inspect');
  const write = await evaluate(`(incf ${ancestor})`,['38']);
  for(const n of [11,21,31]) await evaluate(`(values ${n} ${n+1})`,[String(n),String(n+1)]);
  const lexical = await command(':Show Lexical Environment','lexical-environment');
  assert.match(lexical.result.result,new RegExp(ancestor+': 38'));
  assert(lexical.result.result.includes('(FUNCTION '+helper+')'));
  assert(!lexical.result.result.includes(current+':'));
  const firstSession = await browser.evaluate('state.session');
  const originalSelection = await browser.evaluate('stops.find(stop=>same(stop.token,selectedStop))');
  await browser.click('#window-label');
  await browser.click('#release-session');
  await browser.waitFor('!connected && !busy',120);
  await browser.click('#window-label');
  await browser.click('#new-session');
  await ready();
  assert.notEqual(await browser.evaluate('state.session'),firstSession);
  await openDebugger(active);
  const sameBoot = await browser.evaluate(`({session:state.session,selected:stops.find(stop=>same(stop.token,selectedStop)),
    commands:state.commands.filter(command=>same(command.stop,selectedStop)).map(command=>({command,result:commandResults.get(commandKey(command))})),
    lexical:document.querySelector('.debugger-lexical-environment[data-command-id="${lexical.command.id}"] .lexical-environment-result')?.textContent,
    source:document.querySelector('.debugger-evaluation[data-command-id="${write.command.id}"] .debugger-transcript')?.textContent,
    inspectorEnabled:[...document.querySelectorAll('.inspection-pane[data-command-id="${inspection.command.id}"] button')].find(button=>button.textContent==='Refresh')?.disabled===false})`);
  assert.equal(sameBoot.selected.info.id,originalSelection.info.id);
  assert.equal(sameBoot.selected.info['current-frame'],frame);
  assert.equal(sameBoot.lexical,lexical.result.result);
  assert.equal(sameBoot.source,'→ '+write.command.argument);
  assert.equal(sameBoot.inspectorEnabled,true);
  assert(sameBoot.commands.every(record=>record.result['current-boot-p']));
  assert.deepEqual(sameBoot.commands.filter(record=>record.command.id>=originalSelection.info['next-command-id']).map(record=>record.command.command),['frames','restarts','condition','current-frame']);
  evidence.sameBoot={firstSession,...sameBoot};
  const selected = sameBoot.selected;
  const commandIds = sameBoot.commands.map(record=>record.command.id);
  evidence.before = {active,frame,selected,inspection,write,lexical,commandIds};
  await browser.screenshot(output+'/before-restoration.png');
  assert.deepEqual(browser.errors, []);
  const session = await browser.evaluate('state.session');
  await browser.evaluate('connected=false; updateStatus()');
  await writeFile(output+'/ready.json',JSON.stringify({session,initial,symbol,owned,names,browserTrafficPaused:true,...evidence.before},null,2));
  console.log('READY retained counter and active lexical debugger stop for image restoration');
  const deadline = Date.now() + 15 * 60 * 1000;
  while (true) {
    if (Date.now() >= deadline) throw new Error('Image restoration was not confirmed within 15 minutes');
    try {await access(output+'/restored'); break;} catch (error) {if(error.code !== 'ENOENT') throw error;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  await browser.send('Page.reload',{ignoreCache:true});
  await browser.waitFor(`typeof state !== 'undefined' && typeof connected !== 'undefined' && connected && !busy && state.session !== ${q(session)}`,120);
  const replacement = await browser.evaluate('state.session');
  assert.notEqual(replacement,session);
  await browser.waitFor(`views.get(${q(initial)})?.info.state === ':returned'`,120);
  const recoveryErrorCount = browser.errors.length;
  assert(browser.errors.every(error => error.source === 'network' && /status of (409|502|503)/.test(error.text)), JSON.stringify(browser.errors));
  assert.equal(await browser.evaluate(`Boolean(views.get(${q(initial)}).info['current-boot-p'])`),false);
  assert.equal(await browser.evaluate(`state.inputHistory.some(item=>item.name === ${q(initial)})`),true);
  await openDebugger(active);
  const restored = await browser.evaluate(`({selected:stops.find(stop=>same(stop.token,selectedStop)),
    commands:state.commands.filter(command=>same(command.stop,selectedStop)).map(command=>({command,result:commandResults.get(commandKey(command))})),
    lexical:document.querySelector('.debugger-lexical-environment[data-command-id="${lexical.command.id}"]')?.textContent,
    source:document.querySelector('.debugger-evaluation[data-command-id="${write.command.id}"] .debugger-transcript')?.textContent,
    inspectorDisabled:[...document.querySelectorAll('.inspection-pane button,.inspector-history button')].every(button=>button.disabled)})`);
  assert.equal(restored.selected.info.id,selected.info.id);
  assert.equal(restored.selected.info['current-frame'],frame);
  assert.notDeepEqual(restored.selected.token,selected.token);
  assert(restored.lexical.includes(lexical.result.result));
  assert(restored.lexical.includes('Recorded before this boot.'));
  assert.equal(restored.source,'→ '+write.command.argument);
  assert.equal(restored.inspectorDisabled,true);
  assert.deepEqual(restored.commands.map(record=>record.command.id),Array.from({length:selected.info['next-command-id']+4},(_,id)=>id));
  assert(restored.commands.filter(record=>record.command.id<selected.info['next-command-id']).every(record=>!record.result['current-boot-p']));
  assert.deepEqual(restored.commands.filter(record=>record.command.id>=selected.info['next-command-id']).map(record=>record.command.command),['frames','restarts','condition','current-frame']);
  assert.equal(await browser.evaluate("document.querySelector('#stop-detail .frame.selected').textContent.split('  ')[0]"),String(frame));
  evidence.restored = restored;
  await browser.evaluate(`document.querySelector('.debugger-lexical-environment[data-command-id="${lexical.command.id}"]').scrollIntoView({block:'center'})`);
  await browser.screenshot(output+'/restored-command-history.png');
  const fresh = await command(':Inspect','inspect','#debugger-command');
  assert(fresh.result['current-boot-p']);
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.inspection-pane[data-command-id="${fresh.command.id}"] button')].find(button=>button.textContent==='Refresh').disabled`),false);
  await evaluate('(values * + ++ +++ ** *** / // ///)',
    ['31','(VALUES 31 32)','(VALUES 21 22)','(VALUES 11 12)','21','11','(31 32)','(21 22)','(11 12)'],'#debugger-command');
  const freshLexical = await command(':Show Lexical Environment','lexical-environment','#debugger-command');
  assert.match(freshLexical.result.result,new RegExp(ancestor+': 38'));
  assert(!freshLexical.result.result.includes(current+':'));
  await enter('#debugger-command',':Proceed');
  await browser.waitFor(`views.get(${q(active)})?.info.state===':returned' && !busy`,120);
  assert.deepEqual(await browser.evaluate(`views.get(${q(active)}).info.values`),['38','42','38','1']);
  evidence.fresh = {inspection:fresh,lexical:freshLexical};
  const listener = await submit(`(progn (dolist (name '(${names.map(q).join(' ')})) (assert (null (find-symbol name "CL-USER")))) (+ 20 22))`);
  assert.deepEqual(await browser.evaluate(`views.get(${q(listener)}).info.values`),['42']);
  const checked = await submit(`cl-user::${symbol}`);
  assert.deepEqual(await browser.evaluate(`views.get(${q(checked)}).info.values`),['1']);
  await browser.evaluate("showActivity('examiner')");
  await browser.waitFor("[...document.querySelectorAll('#examiner-candidates .document-topic')].some(item=>item.textContent==='Lisp Command Processor')",120);
  await browser.evaluate("[...document.querySelectorAll('#examiner-candidates .document-topic')].find(item=>item.textContent==='Lisp Command Processor').click()");
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Clear All') && !busy",120);
  await browser.screenshot(output+'/restored-documentation.png');
  await browser.evaluate("showActivity('peek')");
  for (const type of ['keyDown','keyUp']) {
    await browser.send('Input.dispatchKeyEvent',{type,key:'p',code:'KeyP',windowsVirtualKeyCode:80});
  }
  await browser.waitFor("document.querySelectorAll('#process-rows tr').length>0 && !busy",120);
  await browser.screenshot(output+'/restored-peek.png');
  const cleanup = await submit(`(let ((symbol (find-symbol ${q(symbol)} "CL-USER"))) (assert symbol) (unintern symbol "CL-USER"))`);
  await browser.evaluate(`void run(async()=>{
    const stop=stops.find(stop=>stop.info.id===${selected.info.id});
    if(!stop || stop.info.state!==':closed') throw Error('Owned restored stop did not close');
    await mutate('release-stop',{stop:stop.token});
    for (const name of ${q(owned)}) await mutate('release-job',{job:state.jobs[name].token});
    await mutate('release-session',{});
  })`);
  await browser.waitFor('!connected && !busy',120);
  assert.equal(browser.errors.length, recoveryErrorCount);
  await writeFile(output+'/result.json',JSON.stringify({session,replacement,initial,active,listener,checked,cleanup,owned,symbol,names,evidence,errors:browser.errors,cleaned:true},null,2));
  console.log('PASS real image restore: visible lexical/evaluation history and source, expired Inspector actions, fresh controls, selection/nine histories, once-only write/cleanup, Proceed/Listener, unchanged counter, docs/Peek, owned cleanup');
} catch(error) {
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,state:await browser.evaluate('state'),owned,symbol,names,evidence,errors:browser.errors},null,2));
  throw error;
} finally {await browser.close();}
