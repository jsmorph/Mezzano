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
const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const browser = await openBrowser('about:blank');
const symbol = '*WEB-RESTORE-' + randomBytes(6).toString('hex').toUpperCase() + '*';
const prefix = symbol.slice(1,-1);
const maker = prefix+'-MAKER', ancestor = prefix+'-ANCESTOR', current = prefix+'-CURRENT';
const helper = prefix+'-HELPER', reader = prefix+'-READER', cleanups = prefix+'-CLEANUPS';
const cell = prefix+'-CELL', values = prefix+'-VALUES';
const before = prefix+'-BEFORE';
const names = [maker,ancestor,current,helper,reader,cleanups,cell,values,before];
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
async function selectOwnedStop(id) {
  await ready();
  await browser.click('#window-label');
  const action = `[...document.querySelectorAll('#debugger-menu button')].find(button=>button.textContent.startsWith(${q('Stop '+id+'  ')}))`;
  await browser.waitFor(action,120);
  await browser.evaluate(`${action}.dataset.restoreStop='target'`);
  await browser.click('[data-restore-stop="target"]');
  await browser.waitFor(`stops.find(stop=>same(stop.token,selectedStop))?.info.id===${id} && !busy`,120);
  await browser.evaluate("document.querySelector('[data-restore-stop]')?.removeAttribute('data-restore-stop')");
}
async function openDebugger(name, id) {
  await browser.waitFor(`views.get(${q(name)})?.info.state===':running' && views.get(${q(name)}).info.stops?.length>0 && !busy`,120);
  await browser.evaluate("showActivity('listener')");
  await browser.evaluate(`(() => {
    const view=views.get(${q(name)});
    const index=${id === undefined ? '0' : `view.info.stops.findIndex(token=>stops.some(stop=>same(stop.token,token)&&stop.info.id===${id}))`};
    if(index<0) throw Error('Owned debugger stop is absent from its job');
    view.operations.querySelectorAll('button')[index].dataset.restoreDebugger='target';
  })()`);
  await browser.click('[data-restore-debugger="target"]');
  await browser.evaluate("document.querySelector('[data-restore-debugger]')?.removeAttribute('data-restore-debugger')");
  if(id !== undefined) await browser.waitFor(`stops.find(stop=>same(stop.token,selectedStop))?.info.id===${id} && !busy`,120);
}
async function rejected(operation, arguments_, reason, stop) {
  await ready();
  const result=await browser.evaluate(`(async()=>{
    const before=await api('information',{stop:${q(stop)}});
    let error;
    try {await api(${q(operation)},${q(arguments_)});}
    catch(condition) {error={reason:condition.reason,uncertain:condition.uncertain};}
    const after=await api('information',{stop:${q(stop)}});
    return {error,before:before['next-command-id'],after:after['next-command-id']};
  })()`);
  assert.deepEqual(result.error,{reason,uncertain:false});
  assert.equal(result.after,result.before);
  return result;
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
    const original=window.fetch;
    window.fetch=async(...args)=>{
      const response=await original(...args);
      if(!response.ok) {
        const failures=JSON.parse(sessionStorage.getItem('restore-http-failures')||'[]');
        failures.push({request:args[1]?.body,status:response.status,response:await response.clone().text()});
        sessionStorage.setItem('restore-http-failures',JSON.stringify(failures));
      }
      return response;
    };
  })()`});
  await browser.send('Page.navigate',{url});
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
  await historyComplete();
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
  const parentId=sameBoot.selected.info.id;
  const parentSource=`(LET ((${before} ${ancestor})) (INCF ${ancestor}) (CERROR "RESUME PARENT EVALUATION" "${prefix} SAVED CHILD") (INCF ${current}) (VALUES ${before} ${ancestor} ${current} (FUNCALL ${reader})))`;
  await enter('#debugger-command',parentSource);
  await browser.waitFor(`stops.some(stop=>same(stop.info.parent,${q(sameBoot.selected.token)})&&stop.info.state===':stopped') && !busy`,120);
  const suspended=await browser.evaluate(`(() => {
    const command=state.commands.find(command=>same(command.stop,${q(sameBoot.selected.token)})&&command.source===${q(parentSource)});
    return {command,result:command&&commandResults.get(commandKey(command))};
  })()`);
  assert.equal(suspended.command.id,sameBoot.selected.info['next-command-id']);
  assert.equal(suspended.result.state,':running');
  assert.equal(suspended.result.source,parentSource);
  const selected=await browser.evaluate(`stops.find(stop=>stop.info.id===${parentId})`);
  const child=await browser.evaluate(`stops.find(stop=>same(stop.info.parent,${q(selected.token)})&&stop.info.state===':stopped')`);
  assert.equal(selected.info['next-command-id'],suspended.command.id+1);
  assert.deepEqual(selected.info.child,child.token);
  await browser.evaluate(`document.querySelector('.debugger-evaluation[data-command-id="${suspended.command.id}"]').scrollIntoView({block:'center'})`);
  await browser.screenshot(output+'/parent-running-before.png');
  await selectOwnedStop(child.info.id);
  await historyComplete();
  const childBefore=await browser.evaluate(`({selected:stops.find(stop=>same(stop.token,selectedStop)),
    commands:state.commands.filter(command=>same(command.stop,selectedStop)).map(command=>({command,result:commandResults.get(commandKey(command))}))})`);
  assert.equal(childBefore.selected.info.depth,2);
  assert(await browser.evaluate(`returnedResult('condition').includes(${q(prefix+' SAVED CHILD')})`));
  const commandIds=[...sameBoot.commands.map(record=>record.command.id),suspended.command.id];
  evidence.before={active,frame,selected,child:childBefore,inspection,write,lexical,commandIds,suspended,parentSource};
  await browser.screenshot(output+'/before-restoration.png');
  assert.deepEqual(browser.errors, []);
  const session = await browser.evaluate('state.session');
  await browser.evaluate('connected=false; updateStatus()');
  await writeFile(output+'/ready.json',JSON.stringify({session,initial,symbol,owned,names,browserTrafficPaused:true,...evidence.before},null,2));
  console.log('READY retained counter and parent frame evaluation suspended in its continuable child');
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
  const recoveryFailures=await browser.evaluate("JSON.parse(sessionStorage.getItem('restore-http-failures')||'[]')");
  assert(recoveryFailures.some(failure=>JSON.parse(failure.request).operation==='resume-session'
    && JSON.parse(failure.request).session===session && failure.status===409
    && JSON.parse(failure.response).error===':expired-session'));
  assert.equal(await browser.evaluate(`Boolean(views.get(${q(initial)}).info['current-boot-p'])`),false);
  assert.equal(await browser.evaluate(`state.inputHistory.some(item=>item.name === ${q(initial)})`),true);
  await openDebugger(active,child.info.id);
  await historyComplete();
  const restoredChild=await browser.evaluate(`({selected:stops.find(stop=>same(stop.token,selectedStop)),
    commands:state.commands.filter(command=>same(command.stop,selectedStop)).map(command=>({command,result:commandResults.get(commandKey(command))}))})`);
  assert.notDeepEqual(restoredChild.selected.token,child.token);
  assert.equal(restoredChild.selected.info['current-frame'],childBefore.selected.info['current-frame']);
  assert.equal(restoredChild.selected.info.depth,2);
  assert.deepEqual(restoredChild.commands.filter(record=>record.command.id>=childBefore.selected.info['next-command-id']).map(record=>record.command.command),['frames','restarts','condition','current-frame']);
  assert(await browser.evaluate(`returnedResult('condition').includes(${q(prefix+' SAVED CHILD')})`));
  await browser.screenshot(output+'/restored-child.png');
  await selectOwnedStop(parentId);
  await browser.waitFor(`state.commands.some(command=>same(command.stop,selectedStop)&&command.id===${suspended.command.id}
    && commandResults.get(commandKey(command))?.state===':running') && !busy`,120);
  const running=await browser.evaluate(`(() => {
    const command=state.commands.find(command=>same(command.stop,selectedStop)&&command.id===${suspended.command.id});
    return {selected:stops.find(stop=>same(stop.token,selectedStop)),command,result:commandResults.get(commandKey(command)),
      text:document.querySelector('.debugger-evaluation[data-command-id="${suspended.command.id}"]').textContent};
  })()`);
  assert.equal(running.selected.info['current-frame'],frame);
  assert.notDeepEqual(running.selected.token,selected.token);
  assert.deepEqual(running.selected.info.child,restoredChild.selected.token);
  assert.equal(running.result.source,parentSource);
  assert.equal(running.result['current-boot-p'],null);
  assert(running.text.includes('→ '+parentSource));
  assert(running.text.includes('running'));
  assert(running.text.includes('Recorded before this boot.'));
  await browser.evaluate(`document.querySelector('.debugger-evaluation[data-command-id="${suspended.command.id}"]').scrollIntoView({block:'center'})`);
  await browser.screenshot(output+'/restored-parent-running.png');
  const oldToken=await rejected('information',{stop:selected.token},'Invalid session token.',running.selected.token);
  const replay=await rejected('submit',{stop:running.selected.token,id:suspended.command.id,command:'evaluate',argument:parentSource},':request-conflict',running.selected.token);
  await selectOwnedStop(child.info.id);
  await enter('#debugger-command',':Proceed');
  await browser.waitFor(`stops.find(stop=>stop.info.id===${child.info.id})?.info.state===':closed'
    && commandResults.get(commandKey(state.commands.find(command=>same(command.stop,${q(running.selected.token)})&&command.id===${suspended.command.id})))?.state===':returned' && !busy`,120);
  await selectOwnedStop(parentId);
  await historyComplete();
  const restored = await browser.evaluate(`({selected:stops.find(stop=>same(stop.token,selectedStop)),
    commands:state.commands.filter(command=>same(command.stop,selectedStop)).map(command=>({command,result:commandResults.get(commandKey(command))})),
    lexical:document.querySelector('.debugger-lexical-environment[data-command-id="${lexical.command.id}"]')?.textContent,
    source:document.querySelector('.debugger-evaluation[data-command-id="${write.command.id}"] .debugger-transcript')?.textContent,
    inspectorDisabled:[...document.querySelectorAll('.inspection-pane button,.inspector-history button')].every(button=>button.disabled)})`);
  assert.equal(restored.selected.info.id,selected.info.id);
  assert.equal(restored.selected.info.state,':stopped');
  assert.equal(restored.selected.info.child,null);
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
  const resumed=restored.commands.find(record=>record.command.id===suspended.command.id);
  assert.equal(resumed.result.source,parentSource);
  assert.equal(resumed.command.source,parentSource);
  assert.equal(resumed.result.state,':returned');
  assert.equal(resumed.result['current-boot-p'],null);
  assert.deepEqual(resumed.result.result,['38','39','42','43']);
  assert.deepEqual(await browser.evaluate(`stops.filter(stop=>views.get(${q(active)})?.info.stops?.some(token=>same(token,stop.token))).map(stop=>stop.info.id)`),[parentId]);
  evidence.restored = restored;
  evidence.continuation={child:restoredChild,running,resumed};
  const oldFrame=restored.commands.find(record=>record.command.command==='frames'&&record.command.id<selected.info['next-command-id']).result.result[frame].frame;
  const expiredFrame=await rejected('submit',{stop:restored.selected.token,id:restored.selected.info['next-command-id'],command:'locals',argument:oldFrame},':expired-stop',restored.selected.token);
  evidence.rejections={oldToken,replay,expiredFrame};
  await browser.evaluate(`document.querySelector('.debugger-evaluation[data-command-id="${suspended.command.id}"]').scrollIntoView({block:'center'})`);
  await browser.screenshot(output+'/restored-parent-result.png');
  await browser.evaluate(`document.querySelector('.debugger-lexical-environment[data-command-id="${lexical.command.id}"]').scrollIntoView({block:'center'})`);
  await browser.screenshot(output+'/restored-command-history.png');
  const fresh = await command(':Inspect','inspect','#debugger-command');
  assert(fresh.result['current-boot-p']);
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.inspection-pane[data-command-id="${fresh.command.id}"] button')].find(button=>button.textContent==='Refresh').disabled`),false);
  await evaluate('(values * + ++ +++ ** *** / // ///)',
    ['38',parentSource,'(VALUES 31 32)','(VALUES 21 22)','31','21','(38 39 42 43)','(31 32)','(21 22)'],'#debugger-command');
  const freshLexical = await command(':Show Lexical Environment','lexical-environment','#debugger-command');
  assert.match(freshLexical.result.result,new RegExp(ancestor+': 39'));
  assert(!freshLexical.result.result.includes(current+':'));
  await evaluate(`(values ${ancestor} ${current})`,['39','43'],'#debugger-command');
  await enter('#debugger-command',':Proceed');
  await browser.waitFor(`views.get(${q(active)})?.info.state===':returned' && !busy`,120);
  assert.deepEqual(await browser.evaluate(`views.get(${q(active)}).info.values`),['39','44','39','1']);
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
    for(const id of ${q([child.info.id,parentId])}) {
      const stop=stops.find(stop=>stop.info.id===id);
      if(!stop || stop.info.state!==':closed') throw Error('Owned restored stop did not close');
      await mutate('release-stop',{stop:stop.token});
    }
    for (const name of ${q(owned)}) await mutate('release-job',{job:state.jobs[name].token});
    await mutate('release-session',{});
  })`);
  await browser.waitFor('!connected && !busy',120);
  const httpFailures=await browser.evaluate("JSON.parse(sessionStorage.getItem('restore-http-failures')||'[]')");
  assert.deepEqual(httpFailures.slice(recoveryFailures.length).map(failure=>({status:failure.status,...JSON.parse(failure.response)})),[
    {status:400,error:'Invalid session token.',uncertain:false},
    {status:409,error:':request-conflict',uncertain:false},
    {status:409,error:':expired-stop',uncertain:false}]);
  assert.equal(browser.errors.length,recoveryErrorCount+3);
  assert(browser.errors.slice(recoveryErrorCount).every(error=>error.source==='network'&&/status of (400|409)/.test(error.text)));
  await writeFile(output+'/result.json',JSON.stringify({session,replacement,initial,active,listener,checked,cleanup,owned,symbol,names,evidence,httpFailures,errors:browser.errors,cleaned:true},null,2));
  console.log('PASS real image restore: same running parent command resumes through retained lexical bindings after child Proceed; visible history, expired client tokens/replay/Inspector actions, fresh controls, histories, once-only writes/cleanup, Listener, counter, docs/Peek, owned cleanup');
} catch(error) {
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,state:await browser.evaluate('state'),owned,symbol,names,evidence,httpFailures:await browser.evaluate("JSON.parse(sessionStorage.getItem('restore-http-failures')||'[]')"),errors:browser.errors},null,2));
  throw error;
} finally {await browser.close();}
