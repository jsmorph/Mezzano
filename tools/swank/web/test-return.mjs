import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2]??'http://127.0.0.1:8766/';
const output=process.argv[3]??'/tmp/mezzano-return';
const protectedIds=(process.env.PROTECTED_STOPS??process.env.PROTECTED_STOP??'').split(',').filter(Boolean).map(Number);
assert(protectedIds.every(id=>Number.isSafeInteger(id)&&id>=0));
await mkdir(output,{recursive:true});
const browser=await openBrowser('about:blank');
const q=JSON.stringify;
const marker='WEB-RETURN-'+randomBytes(6).toString('hex').toUpperCase();
const target=marker+'-TARGET', caller=marker+'-CALLER', variable=marker+'-X';
const stateName='*'+marker+'-STATE*', threadName='*'+marker+'-THREAD*';
const jobs=[], owned=new Map();
const evidence={marker,checks:[],protected:[]};
let parent, setupStarted=false;
const parents=[];
const ready=()=>browser.waitFor('connected && !busy');
const request=(operation,args={})=>browser.evaluate(`api(${q(operation)},${q(args)})`);
async function key(key,code,keyCode) {
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,text:key==='Enter'?'\r':key===' '?' ':undefined});
  await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:keyCode});
}
async function enter(selector,source) {
  await ready();
  await browser.evaluate(`(()=>{const input=document.querySelector(${q(selector)});input.focus();input.value=${q(source)};
    input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await key('Enter','Enter',13);
}
async function startJob(source) {
  await browser.evaluate("showActivity('listener')");
  const previous=await browser.evaluate('state.inputHistory.map(item=>item.name)');
  await enter('#source',source);
  const query=`state.inputHistory.find(item=>item.source===${q(source)}&&!${q(previous)}.includes(item.name))`;
  await browser.waitFor(query);
  const name=await browser.evaluate(query+'.name');
  jobs.push(name);
  return name;
}
async function listener(source) {
  const name=await startJob(source);
  await browser.waitFor(`views.get(${q(name)})?.info.state!==':running' && views.get(${q(name)})?.info.state && !busy`,60);
  const info=await browser.evaluate(`views.get(${q(name)}).info`);
  assert.equal(info.state,':returned');
  return info;
}
async function select(token) {
  await browser.evaluate(`void run(()=>selectStop(${q(token)}))`);
  await browser.waitFor(`same(selectedStop,${q(token)}) && returnedResult('frames') && !nextStopInspection(selectedStop) && !busy`,60);
}
async function command(source) {
  const id=(await request('information',{stop:await browser.evaluate('selectedStop')}))['next-command-id'];
  await enter('#debugger-command',source);
  await browser.waitFor(`state.commands.some(command=>same(command.stop,selectedStop)&&command.id===${id}) && !busy`,60);
  return id;
}
function resultQuery(id,stop=parent) {
  return `commandResults.get(commandKey({stop:${q(stop)},id:${id}}))`;
}
async function result(id,stop=parent) {
  await browser.waitFor(`${resultQuery(id,stop)} && ![':pending',':running'].includes(${resultQuery(id,stop)}.state) && !busy`,60);
  return browser.evaluate(resultQuery(id,stop));
}
async function waiting(id,stop=parent) {
  await browser.waitFor(`${resultQuery(id,stop)}?.['input-waiting-p'] && !nextCommandOutput() && !busy`,60);
}
const inputSelector=id=>`.command-io[data-command-id="${id}"] textarea`;
async function send(id,text,eof=false) {
  await ready();
  await browser.evaluate(`(()=>{const input=document.querySelector(${q(inputSelector(id))});input.focus();input.value=${q(text)};
    input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input'))})()`);
  await browser.click(`.command-io[data-command-id="${id}"] button:nth-of-type(${eof?2:1})`);
}
async function stopInfo(token) {
  const info=await request('information',{stop:token});
  owned.set(info.id,token);
  if(info.child) await stopInfo(info.child);
  return info;
}
async function finishStop(token) {
  for(let attempt=0;attempt<12;attempt++) {
    const info=await stopInfo(token);
    if(info.state===':closed') {
      if(info['thread-stop']) await finishStop(info['thread-stop']);
      return;
    }
    if(info.child) {await finishStop(info.child);continue;}
    const id=info['next-command-id']-1;
    const last=id>=0?await request('result',{stop:token,id}):null;
    if(last && [':pending',':running'].includes(last.state)) {
      assert.equal(last['input-waiting-p'],true,'Owned command is running outside its input wait');
      await request('command-input',{stop:token,id,offset:last['input-length'],text:'',eof:true});
    } else {
      await request('submit',{stop:token,id:info['next-command-id'],command:'abort'});
    }
    await browser.waitFor(`api('information',{stop:${q(token)}}).then(async info=>info.state===':closed'||info.child||
      ![':pending',':running'].includes((await api('result',{stop:${q(token)},id:info['next-command-id']-1})).state))`,60);
  }
  throw Error('Owned stop did not close: '+q(token));
}
async function releaseOwned() {
  if(!parent && setupStarted) {
    for(const token of await request('stops',{include_closed:true})??[]) {
      if((await request('information',{stop:token})).thread===marker) {parent=token;break;}
    }
  }
  for(const token of parents) await finishStop(token);
  if(parent) await finishStop(parent);
  if(setupStarted) {
    for(const token of await request('stops',{include_closed:true})??[]) {
      if((await request('information',{stop:token})).thread===marker+' jobless') await finishStop(token);
    }
  }
  for(const name of [...jobs]) {
    const token=await browser.evaluate(`state.jobs[${q(name)}]?.token`);
    const info=await request('job-information',{job:token});
    for(const stop of info.stops??[]) await finishStop(stop);
  }
  await browser.evaluate('void run(refresh)');
  await ready();
  if(setupStarted) {
    const cleanup=await listener(`(progn (when (boundp '${threadName})
      (when ${threadName} (assert (eq (mezzano.supervisor:thread-state ${threadName}) :dead))))
      (fmakunbound '${target}) (fmakunbound '${caller})
      (dolist (name '(${target} ${caller} ${variable} ${stateName} ${threadName}))
        (when (boundp name) (makunbound name)) (unintern name)) 42)`);
    assert.deepEqual(cleanup.values,['42']);
  }
  for(const token of [...owned.values()].reverse()) {
    assert.equal((await request('information',{stop:token})).state,':closed');
    await request('release-stop',{stop:token});
  }
  for(const name of jobs) {
    const token=await browser.evaluate(`state.jobs[${q(name)}]?.token`);
    assert(token,'Owned job token unavailable during cleanup');
    await request('release-job',{job:token});
  }
  const records=await request('stops',{include_closed:true});
  for(const token of records??[]) assert(!owned.has((await request('information',{stop:token})).id));
  for(const prior of evidence.protected) {
    const info=await request('information',{stop:prior.token});
    assert.deepEqual([info.state,info.generation,info['next-command-id']],prior.state);
  }
  await request('release-session');
  evidence.cleaned=true;
  evidence.jobs=[...jobs];
  evidence.stops=[...owned.keys()];

}
async function selectTarget(token) {
  parent=token;
  parents.push(token);
  await stopInfo(token);
  await select(token);
  const index=await browser.evaluate(`returnedResult('frames').findIndex(frame=>frame.function.includes(${q(target)}))`);
  assert(index>=0,'Owned compiled target missing');
  await result(await command(':Set Current Frame '+index));
  return index;
}
async function returnPrompt(menu=false) {
  let id;
  if(menu) {
    id=(await request('information',{stop:parent}))['next-command-id'];
    await browser.evaluate("document.querySelector('#system-menu').showModal()");
    await browser.evaluate("[...document.querySelectorAll('#debugger-menu button')].find(button=>button.textContent===':Return').click()");
  } else id=await command(':Return');
  await waiting(id);
  await browser.waitFor(`commandIOViews.get(commandKey({stop:${q(parent)},id:${id}}))?.text.includes('Return values (Lisp expression): ')`);
  return id;
}
async function confirmation(id) {
  await waiting(id);
  await browser.waitFor(`commandIOViews.get(commandKey({stop:${q(parent)},id:${id}}))?.text.includes('(Y or N) ')`);
}
async function evaluate(source,expected) {
  const reply=await result(await command(source));
  assert.equal(reply.state,':returned');
  if(expected)assert.deepEqual(reply.result,expected);
  return reply.result;
}
async function abortChild(id) {
  await browser.waitFor(`stops.find(stop=>same(stop.token,${q(parent)}))?.info.child && !busy`,60);
  const child=(await stopInfo(parent)).child;
  await select(child);
  const abortId=await command(':Abort');
  assert.equal((await result(abortId,child)).state,':unwound');
  await select(parent);
  assert.equal((await result(id)).state,':unwound');
  assert.equal((await request('information',{stop:parent})).state,':stopped');
}
async function reloadAtReader(id,text,start,end) {
  await browser.evaluate(`(()=>{const input=document.querySelector(${q(inputSelector(id))});input.value=${q(text)};
    input.setSelectionRange(${start},${end});input.dispatchEvent(new Event('input'));input.focus()})()`);
  const origin=await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${origin} && typeof connected!=='undefined' && connected && !busy`);
  await select(parent);
  await waiting(id);
  assert.deepEqual(await browser.evaluate(`(()=>{const input=document.querySelector(${q(inputSelector(id))});
    return [input.value,input.selectionStart,input.selectionEnd]})()`),[text,start,end]);
}
async function capture(name,id) {
  await browser.evaluate(`document.querySelector(${q('.command-io[data-command-id="'+id+'"]')}).scrollIntoView({block:'end'})`);
  await browser.screenshot(output+'/'+name+'.png');
}
try {
  await browser.send('Page.navigate',{url});
  await browser.waitFor("document.readyState==='complete' && typeof connected!=='undefined'");
  await ready();
  evidence.session=await browser.evaluate('state.session');
  for(const id of protectedIds) {
    const stop=await browser.evaluate(`stops.find(stop=>stop.info.id===${id})`);
    assert(stop,'Protected stop absent');
    evidence.protected.push({token:stop.token,state:[stop.info.state,stop.info.generation,stop.info['next-command-id']]});
  }
  await browser.evaluate('state.interactive=false;save()');
  setupStarted=true;
  const setup=`(progn
    (defvar ${stateName} (vector 0 0 nil nil)) (defvar ${threadName} nil)
    (setf (symbol-value '${variable}) 100)
    (defun ${target} () (declare (optimize (debug 3) (safety 3) (speed 1)))
      (let ((${variable} 37))
        (unwind-protect
          (progn (break "${marker}") (error "Owned Return target resumed: ~D" ${variable}))
          (incf (aref ${stateName} 0))
          (when (aref ${stateName} 3)
            (cerror "Continue owned Return cleanup." "${marker} cleanup")))))
    (defun ${caller} () (declare (optimize (debug 3) (safety 3) (speed 1)) (notinline ${target}))
      (let ((returned (multiple-value-list (${target}))))
        (setf (aref ${stateName} 2) returned) (values-list returned)))
    (dolist (name '(${target} ${caller}))
      (multiple-value-bind (function warnings failure) (compile name)
        (declare (ignore function)) (assert (not warnings)) (assert (not failure)))) :ready)`;
  await writeFile(output+'/setup.lisp',setup+'\n');
  assert.deepEqual((await listener(setup)).values,[':READY']);
  const batch=await startJob(`(${caller})`);
  await browser.waitFor(`views.get(${q(batch)})?.info.stops?.length && !busy`,60);
  const initial=await browser.evaluate(`views.get(${q(batch)}).info`);
  assert.equal(initial['input-mode'],':batch');
  const index=await selectTarget(initial.stops[0]);
  await browser.evaluate("(()=>{const input=document.querySelector('#debugger-command');input.focus();input.value=':Ret';input.setSelectionRange(4,4);input.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await key(' ','Space',32);
  await browser.waitFor("document.querySelector('#debugger-command').value===':Return ' && !busy");
  await browser.evaluate("(()=>{const input=document.querySelector('#debugger-command');input.value='';input.dispatchEvent(new Event('input'))})()");
  evidence.checks.push('SPACE completion and batch selected compiled target');

  let id=await returnPrompt(true);
  const expression=`(progn (incf (aref ${stateName} 1)) (values ${variable} (+ ${variable} 1)))`;
  await reloadAtReader(id,expression,1,7);
  await send(id,expression);
  await confirmation(id);
  await capture('return-cancellation-prompt',id);
  await send(id,'n');
  assert.equal((await result(id)).result,'Return cancelled.');
  assert.equal((await request('information',{stop:parent}))['current-frame'],index);
  await evaluate('(values * (length /))',['37','2']);
  await evaluate(`(aref ${stateName} 1)`,['1']);
  evidence.checks.push('Menu Return, expression draft/cursor reload, lexical values, cancellation, history and selection');

  await result(await command(':Use Dynamic Environment'));
  id=await returnPrompt();
  await send(id,`(progn (incf (aref ${stateName} 1)) ${variable})`);
  await confirmation(id);
  assert(await browser.evaluate(`commandIOViews.get(commandKey({stop:${q(parent)},id:${id}})).text.includes('1 value: 100')`));
  await send(id,'n');
  assert.equal((await result(id)).result,'Return cancelled.');
  await result(await command(':Use Lexical Environment'));
  evidence.checks.push('Dynamic Return expression uses global value and retains cancellation');

  for(const source of [`#.(incf (aref ${stateName} 1))`,'(error "Owned Return expression failure.")']) {
    id=await returnPrompt();
    await send(id,source);
    await abortChild(id);
    await evaluate(`(aref ${stateName} 1)`,['2']);
  }
  evidence.checks.push('Reader/evaluator children and typed Abort preserve parent computation and reject read-time effects');

  id=await returnPrompt();
  const seven=`(progn (incf (aref ${stateName} 1)) (values ${variable} (+ ${variable} 1) 42 43 44 45 46))`;
  await send(id,seven);
  await confirmation(id);
  const offset=(await request('result',{stop:parent,id}))['input-length'];
  assert.equal(await request('command-input',{stop:parent,id,offset:0,text:seven+'\n'}),offset);
  assert.equal(await request('submit',{stop:parent,id,command:'return'}),id);
  await reloadAtReader(id,'y',0,1);
  await confirmation(id);
  await capture('return-confirmation-reloaded',id);
  await send(id,'y');
  await browser.waitFor(`views.get(${q(batch)})?.info.state===':returned' && !busy`,60);
  assert.deepEqual(await browser.evaluate(`views.get(${q(batch)}).info.values`),['37','38','42','43','44','45','46']);
  assert.equal((await result(id)).state,':unwound');
  assert.equal((await request('information',{stop:parent})).state,':closed');
  assert.deepEqual((await listener(`(values (aref ${stateName} 0) (aref ${stateName} 1) (aref ${stateName} 2))`)).values,
    ['1','3','(37 38 42 43 44 45 46)']);
  evidence.checks.push('Seven values, confirmation reload, exact input/command replay, one evaluation and cleanup, closed-stop result');

  assert.deepEqual((await listener(`(progn (setf ${stateName} (vector 0 0 nil t))
    (setf ${threadName} (mezzano.supervisor:make-thread
      (lambda () (let ((*package* (find-package :cl-user)))
        (mezzano.debug:call-with-debugger-service
          (lambda () (with-simple-restart (abort "Abort owned Return thread.") (${caller}))))))
      :name "${marker} jobless")) :ready)`)).values,[':READY']);
  await browser.waitFor(`stops.some(stop=>stop.info.thread===${q(marker+' jobless')}) && !busy`,60);
  const raw=await browser.evaluate(`stops.find(stop=>stop.info.thread===${q(marker+' jobless')}).token`);
  await selectTarget(raw);
  id=await returnPrompt();
  await send(id,'(values 42 43)');
  await confirmation(id);
  await send(id,'y');
  await browser.waitFor(`stops.find(stop=>same(stop.token,${q(raw)}))?.info.state===':closed'
    && stops.find(stop=>same(stop.token,${q(raw)}))?.info['thread-stop'] && !busy`,60);
  const cleanup=(await stopInfo(raw))['thread-stop'];
  await stopInfo(cleanup);
  assert.equal((await request('information',{stop:cleanup})).parent,null);
  await browser.evaluate("[...document.querySelectorAll('#stop-detail button')].find(button=>button.textContent==='Current Stop').click()");
  await browser.waitFor(`same(selectedStop,${q(cleanup)}) && returnedResult('condition')?.includes('cleanup') && !nextStopInspection(selectedStop) && !busy`,60);
  await browser.screenshot(output+'/return-cleanup-current-stop.png');
  const proceed=await command(':Proceed');
  assert.equal((await result(proceed,cleanup)).state,':unwound');
  await browser.waitFor(`api('information',{stop:${q(raw)}}).then(info=>info['thread-stop']===null)`,60);
  assert.deepEqual((await listener(`(values (aref ${stateName} 0) (aref ${stateName} 2)
    (mezzano.supervisor:thread-state ${threadName}))`)).values,['1','(42 43)',':DEAD']);
  evidence.checks.push('Jobless Return cleanup enters a new root; exact Current Stop navigation, Proceed, values and one cleanup');
  assert.deepEqual((await listener('(+ 20 22)')).values,['42']);
  await releaseOwned();
  assert.deepEqual(browser.errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({...evidence,errors:browser.errors},null,2));
  console.log('PASS Return browser: '+evidence.checks.length+' groups; owned state released');
} catch(error) {
  evidence.error=error.stack;
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({...evidence,state:await browser.evaluate('state'),errors:browser.errors},null,2));
  try {await releaseOwned();} catch(cleanupError) {evidence.cleanupError=cleanupError.stack;}
  await writeFile(output+'/cleanup.json',JSON.stringify(evidence,null,2));
  throw error;
} finally {await browser.close();}
