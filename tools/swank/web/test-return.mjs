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
const reinvokeNames=Object.fromEntries(['target','caller','entry','state','required','optional','optional-p','rest','key','key-p']
  .map(name=>[name,marker+'-REINVOKE-'+name.toUpperCase()]));
const reinvokeState='*'+marker+'-REINVOKE-STATE*', reinvokeProbe='*'+marker+'-REINVOKE-PROBE*';
const reinvokeSymbols=[...Object.values(reinvokeNames),reinvokeState,reinvokeProbe];
const jobs=[], owned=new Map();
const evidence={marker,checks:[],protected:[]};
let parent, setupStarted=false, reinvokeStarted=false;
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
        (when (boundp name) (makunbound name)) (unintern name))
      ${reinvokeStarted?`(dolist (name '(${reinvokeSymbols.join(' ')}))
        (when (fboundp name) (fmakunbound name))
        (when (boundp name) (makunbound name)) (unintern name))`:''} 42)`);
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
  await browser.click('#package-label');
  await browser.click('#release-session');
  await browser.waitFor('!busy && !connected && state.session === null');
  evidence.cleaned=true;
  evidence.jobs=[...jobs];
  evidence.stops=[...owned.keys()];

}
async function selectTarget(token,name=target) {
  parent=token;
  parents.push(token);
  await stopInfo(token);
  await select(token);
  const index=await browser.evaluate(`returnedResult('frames').findIndex(frame=>frame.function.includes(${q(name)}))`);
  assert(index>=0,'Owned compiled target missing');
  await result(await command(':Set Current Frame '+index));
  return index;
}
async function commandPrompt(source,prompt,menu=false) {
  let id;
  if(menu) {
    id=(await request('information',{stop:parent}))['next-command-id'];
    await browser.evaluate("document.querySelector('#system-menu').showModal()");
    await browser.evaluate(`[...document.querySelectorAll('#debugger-menu button')].find(button=>button.textContent===${q(source)}).click()`);
  } else id=await command(source);
  await waiting(id);
  await browser.waitFor(`commandIOViews.get(commandKey({stop:${q(parent)},id:${id}}))?.text.includes(${q(prompt)})`);
  return id;
}
const returnPrompt=menu=>commandPrompt(':Return','Return values (Lisp expression): ',menu);
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
  const before=await request('information',{stop:parent});
  const prior=await request('result',{stop:parent,id});
  await browser.evaluate(`(()=>{const input=document.querySelector(${q(inputSelector(id))});input.value=${q(text)};
    input.setSelectionRange(${start},${end});input.dispatchEvent(new Event('input'));input.focus()})()`);
  const origin=await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${origin} && typeof connected!=='undefined' && connected && !busy`);
  await select(parent);
  await waiting(id);
  await browser.waitFor(`state.commands.filter(command=>same(command.stop,${q(parent)})
    && commandResults.has(commandKey(command))).length===${before['next-command-id']} && !busy && !nextCommandOutput()`,30);
  const after=await request('information',{stop:parent});
  const restored=await request('result',{stop:parent,id});
  assert.deepEqual([after['current-frame'],after['next-command-id']],
    [before['current-frame'],before['next-command-id']]);
  assert.equal(restored.state,':running');
  assert.equal(restored['input-length'],prior['input-length']);
  assert.equal(await browser.evaluate("document.querySelector('#stop-detail').textContent.includes('Receiving result.')"),false);
  evidence.reloads??=[];
  evidence.reloads.push({stop:parent,id,frame:after['current-frame'],next:after['next-command-id'],inputLength:restored['input-length']});
  assert.deepEqual(await browser.evaluate(`(()=>{const input=document.querySelector(${q(inputSelector(id))});
    return [input.value,input.selectionStart,input.selectionEnd]})()`),[text,start,end]);
}
async function capture(name,id) {
  await browser.evaluate(`document.querySelector(${q('.command-io[data-command-id="'+id+'"]')}).scrollIntoView({block:'end'})`);
  await browser.screenshot(output+'/'+name+'.png');
}
function reinvokeSetupSource() {
  const n=reinvokeNames;
  return `(progn
    (defvar ${reinvokeState} nil) (defvar ${reinvokeProbe} 0)
    (defun ${n.entry} ()
      (declare (optimize (debug 3) (safety 3) (speed 1)))
      (let ((${reinvokeProbe} 33)) (break "${marker} Reinvoke")))
    (defun ${n.target} (${n.state} ${n.required}
      &optional (${n.optional} (progn (incf (aref ${n.state} 1)) :optional-default) ${n['optional-p']})
      &rest ${n.rest}
      &key ((:key ${n.key}) (progn (incf (aref ${n.state} 1)) :key-default) ${n['key-p']})
      &allow-other-keys)
      (declare (optimize (debug 3) (safety 3) (speed 1)) (notinline ${n.entry}))
      (if (aref ${n.state} 0)
          (values (list ${n.required} ${n.optional} ${n['optional-p']} (copy-list ${n.rest})
                        ${n.key} ${n['key-p']} ${reinvokeProbe}) :reinvoked)
          (let ((${reinvokeProbe} 22))
            (unwind-protect
                (progn
                  (setf ${n.required} (aref ${n.state} 6)
                        ${n.optional} :current-optional ${n['optional-p']} nil
                        ${n.rest} (list :unknown :kept :key :stale :key :later)
                        ${n.key} :current-key ${n['key-p']} nil
                        (aref ${n.state} 9) ${n.rest} (aref ${n.state} 0) t)
                  (${n.entry})
                  (error "Owned Reinvoke target resumed."))
              (assert (= ${reinvokeProbe} 22))
              (incf (aref ${n.state} 2))
              (when (aref ${n.state} 7)
                (cerror "Continue owned Reinvoke cleanup." "${marker} Reinvoke cleanup"))
              (mezzano.extensions:gc :full t)))))
    (defun ${n.caller} ()
      (declare (optimize (debug 3) (safety 3) (speed 1)) (notinline ${n.target}))
      (let ((${reinvokeProbe} 11))
        (setf (aref ${reinvokeState} 3)
              (multiple-value-list (${n.target} ${reinvokeState} :original-required)))
        (assert (= ${reinvokeProbe} 11))
        (setf (aref ${reinvokeState} 4) :continued)
        (values-list (aref ${reinvokeState} 3))))
    (dolist (name '(${n.entry} ${n.target} ${n.caller}))
      (multiple-value-bind (function warnings failure) (compile name)
        (declare (ignore function)) (assert (not warnings)) (assert (not failure)))) :ready)`;
}
async function reinvokeCase(cleanup=false) {
  assert.deepEqual((await listener(`(progn
    (setf ${reinvokeState} (vector nil 0 0 nil nil 0 (vector :heap) ${cleanup?'t':'nil'} nil nil)) :ready)`)).values,[':READY']);
  const name=await startJob(`(${reinvokeNames.caller})`);
  await browser.waitFor(`views.get(${q(name)})?.info.stops?.length && !busy`,60);
  const token=await browser.evaluate(`views.get(${q(name)}).info.stops[0]`);
  const index=await selectTarget(token,reinvokeNames.target);
  return {name,index,token};
}
async function reinvokePreview(id,source,count) {
  await confirmation(id);
  const text=await browser.evaluate(`commandIOViews.get(commandKey({stop:${q(parent)},id:${id}})).text`);
  assert(text.includes('Callable: '));
  assert(text.includes(`${source} arguments (${count}):\n`));
  assert.deepEqual([...text.matchAll(/^  (\d+): /gm)].map(match=>Number(match[1])),Array.from({length:count},(_,index)=>index));
  evidence.reinvokePreviews??=[];
  evidence.reinvokePreviews.push({stop:parent,id,source,count,text});
  return text;
}
async function reinvokeCompleted(test,id,expected) {
  await browser.waitFor(`views.get(${q(test.name)})?.info.state===':returned' && !busy`,60);
  const values=await browser.evaluate(`views.get(${q(test.name)}).info.values`);
  if(expected) assert.deepEqual(values,expected);
  assert.equal((await result(id,test.token)).state,':unwound');
  assert.equal((await request('information',{stop:test.token})).state,':closed');
  assert.deepEqual((await listener(`(values (aref ${reinvokeState} 2) (aref ${reinvokeState} 4) ${reinvokeProbe})`)).values,
    ['1',':CONTINUED','0']);
}
async function background(source) {
  const name=randomBytes(32).toString('hex');
  jobs.push(name);
  await browser.evaluate(`mutate('start-evaluation',${q({name,source,package:'CL-USER'})})`);
  await browser.waitFor(`views.get(${q(name)})?.info.state===':returned' && !busy`,60);
  return browser.evaluate(`views.get(${q(name)}).info`);
}
async function runReinvokeTests() {
  const n=reinvokeNames;
  const setup=reinvokeSetupSource();
  reinvokeStarted=true;
  await writeFile(output+'/reinvoke-setup.lisp',setup+'\n');
  assert.deepEqual((await listener(setup)).values,[':READY']);
  let test=await reinvokeCase();
  await browser.evaluate("(()=>{const input=document.querySelector('#debugger-command');input.focus();input.value=':Rei';input.setSelectionRange(4,4);input.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await key(' ','Space',32);
  await browser.waitFor("document.querySelector('#debugger-command').value===':Reinvoke ' && !busy");
  await evaluate('(values 37 38)',['37','38']);
  let id=await commandPrompt(':Reinvoke','Current arguments (9):',true);
  const current=await reinvokePreview(id,'Current',9);
  for(const row of ['  2: :CURRENT-OPTIONAL','  3: :UNKNOWN','  4: :KEPT','  5: :KEY','  6: :CURRENT-KEY','  7: :KEY','  8: :LATER'])
    assert(current.includes(row));
  await send(id,'n');
  assert.equal((await result(id)).result,'Reinvoke cancelled.');
  assert.equal((await request('information',{stop:parent}))['current-frame'],test.index);
  await evaluate('(values * /)',['37','(37 38)']);
  await evaluate(`(values ${n['optional-p']} ${n['key-p']} (aref ${n.state} 1) (aref ${n.state} 2))`,['NIL','NIL','2','0']);
  id=await commandPrompt(':Reinvoke','Current arguments (9):');
  await reinvokePreview(id,'Current',9);
  await capture('reinvoke-current-preview',id);
  await send(id,'y');
  await reinvokeCompleted(test,id,['(#(:HEAP) :CURRENT-OPTIONAL T (:UNKNOWN :KEPT :KEY :CURRENT-KEY :KEY :LATER) :CURRENT-KEY T 11)',':REINVOKED']);
  assert.deepEqual((await listener(`(values (aref ${reinvokeState} 1)
    (eq (first (first (aref ${reinvokeState} 3))) (aref ${reinvokeState} 6))
    (aref ${reinvokeState} 9))`)).values,['2','T','(:UNKNOWN :KEPT :KEY :STALE :KEY :LATER)']);
  evidence.checks.push('Reinvoke Current completion/menu, cancellation/history, current rest/key precedence, copied spine, heap identity and recomputed supplied flags without rerunning defaults');

  test=await reinvokeCase();
  id=await commandPrompt(':Reinvoke :Original Args','Original arguments (2):',true);
  await reinvokePreview(id,'Original',2);
  await send(id,'y');
  await reinvokeCompleted(test,id,['(:ORIGINAL-REQUIRED :OPTIONAL-DEFAULT NIL NIL :KEY-DEFAULT NIL 11)',':REINVOKED']);
  assert.deepEqual((await listener(`(aref ${reinvokeState} 1)`)).values,['4']);
  evidence.checks.push('Reinvoke Original preserves original omissions, reruns both defaults and derives false supplied flags');

  test=await reinvokeCase();
  for(const source of [`#.(incf (aref ${n.state} 5))`,'(error "Owned Reinvoke expression failure.")',"(cons 1 2)"]) {
    id=await commandPrompt(':Reinvoke :New Args','Reinvoke arguments (Lisp expression returning a list): ');
    await send(id,source);
    await abortChild(id);
    await evaluate(`(values (aref ${n.state} 5) (aref ${n.state} 2))`,['0','0']);
  }
  id=await commandPrompt(':Reinvoke :New Args','Reinvoke arguments (Lisp expression returning a list): ',true);
  const cancelled=`(progn (incf (aref ${n.state} 5)) (values (list ${n.state} :cancelled) (list :history ${reinvokeProbe})))`;
  await send(id,cancelled);
  await reinvokePreview(id,'New',2);
  await send(id,'n');
  assert.equal((await result(id)).result,'Reinvoke cancelled.');
  await evaluate(`(values (eq (first *) ${n.state}) (second (second /)) (aref ${n.state} 5) (aref ${n.state} 2))`,['T','22','1','0']);
  evidence.checks.push('Reinvoke New reader/evaluator/list failures enter children; typed Abort returns to parent; lexical cancellation retains expression history without cleanup');

  id=await commandPrompt(':Reinvoke :New Args','Reinvoke arguments (Lisp expression returning a list): ');
  const extra=Array.from({length:12},(_,index)=>`:extra ${index}`).join(' ');
  const long=`(progn (incf (aref ${n.state} 5)) (setf (aref ${n.state} 8) ${reinvokeProbe})
    (values (list ${n.state} (aref ${n.state} 6) :new-optional :key :new-key ${extra}) (list :history ${reinvokeProbe})))`;
  await reloadAtReader(id,long,1,8);
  await send(id,long);
  const preview=await reinvokePreview(id,'New',29);
  assert(preview.includes('  28: 11\n'));
  const inputEnd=(await request('result',{stop:parent,id}))['input-length'];
  assert.equal(await request('command-input',{stop:parent,id,offset:0,text:long+'\n'}),inputEnd);
  assert.equal(await request('submit',{stop:parent,id,command:'reinvoke',argument:[null,true]}),id);
  await reloadAtReader(id,'y',0,1);
  assert.equal(await reinvokePreview(id,'New',29),preview);
  await capture('reinvoke-long-preview-reloaded',id);
  await send(id,'y');
  await reinvokeCompleted(test,id);
  assert.equal(await request('submit',{stop:test.token,id,command:'reinvoke',argument:[null,true]}),id);
  assert.deepEqual((await listener(`(let ((result (first (aref ${reinvokeState} 3))))
    (values (eq (first result) (aref ${reinvokeState} 6))
      (second result) (third result) (length (fourth result)) (car (last (fourth result)))
      (fifth result) (sixth result) (seventh result)
      (aref ${reinvokeState} 1) (aref ${reinvokeState} 5) (aref ${reinvokeState} 8)))`)).values,
    ['T',':NEW-OPTIONAL','T','26','11',':NEW-KEY','T','11','2','2','22']);
  evidence.checks.push('Reinvoke New lexical 29-argument preview preserves every index; reader/confirmation reload and input/command replay execute one expression and transfer once');

  test=await reinvokeCase();
  await result(await command(':Use Dynamic Environment'));
  id=await commandPrompt(':Reinvoke :New Args','Reinvoke arguments (Lisp expression returning a list): ');
  await send(id,`(progn (incf (aref ${reinvokeState} 5)) (setf (aref ${reinvokeState} 8) ${reinvokeProbe})
    (values (list ${reinvokeState} (aref ${reinvokeState} 6) :dynamic-optional :key :dynamic-key)
      (list :history ${reinvokeProbe})))`);
  await reinvokePreview(id,'New',5);
  await send(id,'y');
  await reinvokeCompleted(test,id,['(#(:HEAP) :DYNAMIC-OPTIONAL T (:KEY :DYNAMIC-KEY) :DYNAMIC-KEY T 11)',':REINVOKED']);
  assert.deepEqual((await listener(`(values (aref ${reinvokeState} 5) (aref ${reinvokeState} 8))`)).values,['1','33']);
  evidence.checks.push('Reinvoke New dynamic expression observes point-of-error special 33 while replacement executes in caller special 11');

  test=await reinvokeCase(true);
  const replacement=version=>`(progn
    (defun ${n.target} (&rest arguments)
      (declare (optimize (debug 3) (safety 3) (speed 1)))
      (values ${version} (length arguments)
        (eq (second arguments) (aref (first arguments) 6)) ${reinvokeProbe}
        (copy-list (nthcdr 3 arguments))))
    (multiple-value-bind (function warnings failure) (compile '${n.target})
      (declare (ignore function)) (assert (not warnings)) (assert (not failure))) :ready)`;
  assert.deepEqual((await background(replacement(':captured'))).values,[':READY']);
  id=await commandPrompt(':Reinvoke','Current arguments (9):');
  await reinvokePreview(id,'Current',9);
  assert.deepEqual((await background(`(progn ${replacement(':later')}
    (setf (first (aref ${reinvokeState} 9)) :mutated (second (aref ${reinvokeState} 9)) :changed) :ready)`)).values,[':READY']);
  await reloadAtReader(id,'y',0,1);
  await capture('reinvoke-captured-definition',id);
  await send(id,'y');
  await browser.waitFor(`stops.find(stop=>same(stop.token,${q(test.token)}))?.info.state===':closed'
    && stops.find(stop=>same(stop.token,${q(test.token)}))?.info['thread-stop'] && !busy`,60);
  const cleanup=(await stopInfo(test.token))['thread-stop'];
  await stopInfo(cleanup);
  assert.equal((await request('information',{stop:cleanup})).parent,null);
  await browser.evaluate("[...document.querySelectorAll('#stop-detail button')].find(button=>button.textContent==='Current Stop').click()");
  await browser.waitFor(`same(selectedStop,${q(cleanup)}) && returnedResult('condition')?.includes('Reinvoke cleanup') && !nextStopInspection(selectedStop) && !busy`,60);
  await browser.screenshot(output+'/reinvoke-cleanup-current-stop.png');
  const proceed=await command(':Proceed');
  assert.equal((await result(proceed,cleanup)).state,':unwound');
  await reinvokeCompleted(test,id,[':CAPTURED','9','T','11','(:UNKNOWN :KEPT :KEY :CURRENT-KEY :KEY :LATER)']);
  evidence.checks.push('Reinvoke captures the replacement callable and copied candidate before confirmation; later redefinition/rest mutation do not replace them; Current Stop and typed Proceed finish cleanup');
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
  await runReinvokeTests();
  assert.deepEqual((await listener('(+ 20 22)')).values,['42']);
  await releaseOwned();
  assert.deepEqual(browser.errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({...evidence,errors:browser.errors},null,2));
  console.log('PASS Return/Reinvoke browser: '+evidence.checks.length+' groups; owned state released');
} catch(error) {
  evidence.error=error.stack;
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({...evidence,state:await browser.evaluate('state'),errors:browser.errors},null,2));
  try {await releaseOwned();} catch(cleanupError) {evidence.cleanupError=cleanupError.stack;}
  await writeFile(output+'/cleanup.json',JSON.stringify(evidence,null,2));
  throw error;
} finally {await browser.close();}
