import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2]??'http://127.0.0.1:8766/';
const output=process.argv[3]??'/tmp/mezzano-command-io';
const protectedIds=(process.env.PROTECTED_STOPS??process.env.PROTECTED_STOP??'').split(',').filter(Boolean).map(Number);
assert(protectedIds.every(id=>Number.isSafeInteger(id)&&id>=0));
await mkdir(output,{recursive:true});
const browser=await openBrowser('about:blank');
const q=JSON.stringify;
const marker='WEB-COMMAND-IO-'+randomBytes(6).toString('hex').toUpperCase();
const target=marker+'-TARGET', stateName='*'+marker+'-STATE*', threadName='*'+marker+'-THREAD*';
const jobs=[], owned=new Map();
const evidence={marker,checks:[],protected:[]};
let parent, setupStarted=false;
const ready=()=>browser.waitFor('connected && !busy');
const request=(operation,args={})=>browser.evaluate(`api(${q(operation)},${q(args)})`);
async function key(key,code,keyCode) {
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,text:key==='Enter'?'\r':undefined});
  await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:keyCode});
}
async function enter(selector,source) {
  await ready();
  await browser.evaluate(`(()=>{const input=document.querySelector(${q(selector)});input.focus();input.value=${q(source)};
    input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await key('Enter','Enter',13);
}
async function listener(source) {
  await browser.evaluate("showActivity('listener')");
  const previous=await browser.evaluate('state.inputHistory.map(item=>item.name)');
  await enter('#source',source);
  const query=`state.inputHistory.find(item=>item.source===${q(source)}&&!${q(previous)}.includes(item.name))`;
  await browser.waitFor(query);
  const name=await browser.evaluate(query+'.name');
  jobs.push(name);
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
    if(info.state===':closed') return;
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
  if(parent) await finishStop(parent);
  for(const name of [...jobs]) {
    const token=await browser.evaluate(`state.jobs[${q(name)}]?.token`);
    const info=await request('job-information',{job:token});
    for(const stop of info.stops??[]) await finishStop(stop);
  }
  await browser.evaluate('void run(refresh)');
  await ready();
  if(setupStarted) {
    const cleanup=await listener(`(progn (when (boundp '${threadName})
      (assert (eq (mezzano.supervisor:thread-state ${threadName}) :dead)))
      (fmakunbound '${target})
      (dolist (name '(${target} ${stateName} ${threadName}))
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
  evidence.http=await browser.evaluate('commandIORequests');
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.commandIORequests=JSON.parse(sessionStorage.getItem('command-io-http')||'[]');
    const originalFetch=window.fetch;
    window.fetch=async (...args)=>{
      const request=args[1]?.body&&JSON.parse(args[1].body);
      const response=await originalFetch(...args);
      if(['command-output','command-input'].includes(request?.operation)) {
        commandIORequests.push({time:Date.now(),request,status:response.status,body:await response.clone().json()});
        sessionStorage.setItem('command-io-http',JSON.stringify(commandIORequests));
      }
      return response;
    };`});
  await browser.send('Page.navigate',{url});
  await browser.waitFor("document.readyState==='complete' && typeof connected!=='undefined'");
  await ready();
  evidence.session=await browser.evaluate('state.session');
  for(const id of protectedIds) {
    const stop=await browser.evaluate(`stops.find(stop=>stop.info.id===${id})`);
    assert(stop,'Protected stop absent');
    evidence.protected.push({token:stop.token,state:[stop.info.state,stop.info.generation,stop.info['next-command-id']]});
  }
  setupStarted=true;
  const setup=`(progn (defvar ${stateName} (vector 0 nil nil)) (defvar ${threadName})
    (defun ${target} () (declare (optimize (debug 3) (safety 3) (speed 1)))
      (unwind-protect (progn (break "${marker}") (setf (aref ${stateName} 2) 42))
        (incf (aref ${stateName} 0)) (setf (aref ${stateName} 1) t)))
    (multiple-value-bind (function warnings failure) (compile '${target})
      (declare (ignore function)) (assert (not warnings)) (assert (not failure)))
    (setf ${threadName} (mezzano.supervisor:make-thread
      (lambda () (let ((*package* (find-package :cl-user)))
        (mezzano.debug:call-with-debugger-service
          (lambda () (with-simple-restart (abort "Abort owned command I/O thread.") (${target}))))))
      :name "${marker}")) :ready)`;
  await writeFile(output+'/setup.lisp',setup+'\n');
  assert.deepEqual((await listener(setup)).values,[':READY']);
  await browser.waitFor(`stops.some(stop=>stop.info.thread===${q(marker)}) && !busy`,60);
  const record=await browser.evaluate(`stops.find(stop=>stop.info.thread===${q(marker)})`);
  parent=record.token;
  await stopInfo(parent);
  assert.equal(await browser.evaluate(`Object.values(state.jobs).some(job=>views.get(job.name)?.info.stops?.some(token=>same(token,${q(parent)})))`),false);
  await select(parent);
  const index=await browser.evaluate(`returnedResult('frames').findIndex(frame=>frame.function.includes(${q(target)}))`);
  assert(index>=0,'Owned compiled target frame missing');
  const selection=await command(':Set Current Frame '+index);
  assert.equal((await result(selection)).result.index,index);
  evidence.parent=record;
  evidence.checks.push('Owned standalone stop has no retained evaluation job');

  const readSource='(progn (write-line "Jobless input λ😀: " *query-io*) (finish-output *query-io*) (values (read-line *query-io*)))';
  const first=await command(readSource);
  await waiting(first);
  assert.equal(await browser.evaluate(`document.querySelector('.command-io[data-command-id="${first}"] .command-output').textContent`),'Jobless input λ😀: \n');
  await browser.evaluate(`(()=>{const input=document.querySelector(${q(inputSelector(first))});input.value='λ😀 draft';
    input.setSelectionRange(1,3);input.dispatchEvent(new Event('input'))})()`);
  const oldOrigin=await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${oldOrigin} && typeof connected!=='undefined' && connected && !busy`);
  await select(parent);
  await waiting(first);
  const draft=await browser.evaluate(`(()=>{const input=document.querySelector(${q(inputSelector(first))});return [input.value,input.selectionStart,input.selectionEnd]})()`);
  assert.deepEqual(draft,['λ😀 draft',1,3]);
  await send(first,'λ😀');
  assert.deepEqual((await result(first)).result,['"λ😀"']);
  assert.equal((await request('result',{stop:parent,id:first}))['input-length'],3);
  evidence.checks.push('Unicode command output/input and unsent draft/cursor survive reload');

  const nested=await command('(progn (cerror "Continue owned reader." "Owned nested command reader.") (read-line *query-io*))');
  await browser.waitFor(`stops.find(stop=>same(stop.token,${q(parent)}))?.info.child && !busy`,60);
  const child=(await stopInfo(parent)).child;
  await select(child);
  const mode=await command(':Use Dynamic Environment');
  assert.equal((await result(mode,child)).result,'Eval (debugger): ');
  const childRead=await command(readSource);
  await waiting(childRead,child);
  await send(childRead,'child');
  assert.deepEqual((await result(childRead,child)).result,['"child"']);
  await command(':Abort');
  await browser.waitFor(`stops.find(stop=>same(stop.token,${q(child)}))?.info.state===':closed' && !busy`,60);
  await select(parent);
  assert.equal((await result(nested)).state,':unwound');
  evidence.checks.push('Child command input is independent and typed Abort abandons the suspended parent command');

  const eof=await command('(values (read-line *query-io* nil :command-eof))');
  await waiting(eof);
  await send(eof,'',true);
  assert.deepEqual((await result(eof)).result,[':COMMAND-EOF']);
  const fresh=await command(readSource);
  await waiting(fresh);
  assert.equal((await request('result',{stop:parent,id:fresh}))['input-length'],0);
  await send(fresh,'fresh');
  assert.deepEqual((await result(fresh)).result,['"fresh"']);
  await browser.evaluate(`document.querySelector('.command-io[data-command-id="${fresh}"]').scrollIntoView({block:'center'})`);
  await browser.screenshot(output+'/jobless-command-input.png');
  evidence.checks.push('EOF affects one command and a later command receives fresh input');

  await command(':Proceed');
  await browser.waitFor(`stops.find(stop=>same(stop.token,${q(parent)}))?.info.state===':closed' && !busy`,60);
  assert.deepEqual((await listener(`(progn (assert (equalp ${stateName} #(1 t 42))) (+ 20 22))`)).values,['42']);
  evidence.checks.push('Proceed runs one cleanup and the next Listener returns 42');
  assert.deepEqual(browser.errors,[]);
  await releaseOwned();
  evidence.jobs=jobs;
  evidence.stops=[...owned.keys()];
  evidence.errors=browser.errors;
  await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));
  console.log('PASS jobless command I/O: '+evidence.checks.length+' groups; owned state released');
} catch(error) {
  evidence.error=error.stack;
  evidence.http=await browser.evaluate('commandIORequests');
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({...evidence,jobs,stops:[...owned],state:await browser.evaluate('state'),errors:browser.errors},null,2));
  try {await releaseOwned();} catch(cleanupError) {evidence.cleanupError=cleanupError.stack;}
  await writeFile(output+'/cleanup.json',JSON.stringify(evidence,null,2));
  throw error;
} finally {await browser.close();}
