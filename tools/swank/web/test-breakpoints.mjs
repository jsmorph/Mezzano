import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2];
assert(url,'An isolated Web server URL is required');
const output=process.argv[3]??'/tmp/mezzano-breakpoints';
const protectedIds=(process.env.PROTECTED_STOPS??process.env.PROTECTED_STOP??'').split(',').filter(Boolean).map(Number);
assert(protectedIds.every(id=>Number.isSafeInteger(id)&&id>=0));
await mkdir(output,{recursive:false});
const browser=await openBrowser('about:blank');
const q=JSON.stringify;
const marker='WEB-BREAKPOINT-'+randomBytes(6).toString('hex').toUpperCase();
const names=Object.fromEntries(['a','b','touch-a','touch-b','controller','setter','int3'].map(name=>[name,marker+'-'+name.toUpperCase()]));
const stateName='*'+marker+'-STATE*';
const jobs=[], owned=new Map();
const evidence={marker,checks:[],protected:[],initialFrames:[]};
let setupStarted=false, controller;
const ready=()=>browser.waitFor('connected && !busy');
const request=(operation,args={})=>browser.evaluate(`api(${q(operation)},${q(args)})`);
const editor=()=>browser.evaluate('activity==="listener"?"#source":"#debugger-command"');
async function key(key,code,keyCode) {
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:keyCode,text:key==='Enter'?'\r':key===' '?' ':undefined});
  await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:keyCode});
}
async function fill(selector,source) {
  await ready();
  await browser.evaluate(`(()=>{const input=document.querySelector(${q(selector)});input.focus();input.value=${q(source)};
    input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
}
async function background(source) {
  const name=randomBytes(32).toString('hex');
  jobs.push(name);
  await browser.evaluate(`mutate('start-evaluation',${q({name,source,package:'CL-USER'})})`);
  return name;
}
async function completed(name,values) {
  await browser.waitFor(`views.get(${q(name)})?.info.state===':returned' && !busy`,60);
  const info=await browser.evaluate(`views.get(${q(name)}).info`);
  if(values) assert.deepEqual(info.values,values);
  return info;
}
async function evaluate(source,values) {
  return completed(await background(source),values);
}
async function startListener(source) {
  await browser.evaluate("showActivity('listener')");
  const before=await browser.evaluate('state.inputHistory.map(item=>item.name)');
  await fill('#source',source);
  await key('Enter','Enter',13);
  const query=`state.inputHistory.find(item=>item.source===${q(source)}&&!${q(before)}.includes(item.name))`;
  await browser.waitFor(query);
  const name=await browser.evaluate(query+'.name');
  jobs.push(name);
  return name;
}
async function listenerCommand(source,expected) {
  const name=await startListener(source);
  await completed(name);
  const job=await browser.evaluate(`state.jobs[${q(name)}].token`);
  const result=await request('job-output',{job,start:0});
  assert(result.text.includes(expected),result.text);
}
async function remember(token) {
  const info=await request('information',{stop:token});
  owned.set(info.id,token);
  if(info.child) await remember(info.child);
  return info;
}
async function select(token,name,{initial=false,selectFrame=true}={}) {
  const info=await remember(token);
  await browser.evaluate(`void run(()=>selectStop(${q(token)}))`);
  await browser.waitFor(`same(selectedStop,${q(token)}) && !nextStopInspection(selectedStop) && !busy`,60);
  if(name) {
    const index=await browser.evaluate(`returnedResult('frames').findIndex(frame=>frame.function.includes(${q(name)}))`);
    assert(index>=0,'Owned function missing from retained frames: '+name);
    if(initial) {
      assert.equal(info['current-frame'],index,'Initial guest frame must be the interrupted program frame');
      assert.equal((await request('information',{stop:token}))['current-frame'],index);
      const view=await browser.evaluate(`({inspection:returnedFrameInspection(),
        function:document.querySelector('#stop-detail .current-function')?.textContent,
        selected:[...document.querySelectorAll('#stop-detail .frame.selected')].map(node=>node.textContent),
        frameCommands:state.commands.filter(command=>same(command.stop,${q(token)})&&frameCommands.includes(command.command))})`);
      assert.equal(view.inspection.command.command,'current-frame');
      assert.equal(view.inspection.result.index,index);
      assert(view.inspection.result.function.includes(name));
      assert.equal(view.function,view.inspection.result.function);
      assert.deepEqual(view.selected,[index+'  '+view.inspection.result.function]);
      assert.deepEqual(view.frameCommands.map(command=>command.command),['current-frame']);
      evidence.initialFrames.push({token,name,index,view});
      await browser.screenshot(output+'/initial-'+(name===names.int3?'int3':name===names.a?'a':'b-'+evidence.initialFrames.length)+'.png');
    }
    if(selectFrame) await returned(await command(':Set Current Frame '+index),token);
  }
}
async function stopped(name) {
  await browser.waitFor(`views.get(${q(name)})?.info.stops?.length && !busy`,60);
  const token=await browser.evaluate(`views.get(${q(name)}).info.stops[0]`);
  await remember(token);
  return token;
}
async function command(source) {
  const token=await browser.evaluate('selectedStop');
  const id=(await request('information',{stop:token}))['next-command-id'];
  await fill(await editor(),source);
  await key('Enter','Enter',13);
  await browser.waitFor(`state.commands.some(command=>same(command.stop,${q(token)})&&command.id===${id}) && !busy`,60);
  return id;
}
async function returned(id,token) {
  token??=await browser.evaluate('selectedStop');
  await browser.waitFor(`commandResults.get(commandKey({stop:${q(token)},id:${id}}))?.state===':returned' && !busy`,60);
  return browser.evaluate(`commandResults.get(commandKey({stop:${q(token)},id:${id}})).result`);
}
async function menu(name) {
  await browser.evaluate("document.querySelector('#system-menu').showModal()");
  await browser.evaluate(`[...document.querySelectorAll('#debugger-menu button')].find(button=>button.textContent===${q(name)}).click()`);
  await ready();
}
async function locations(expected) {
  const pairs=expected.map(([name,offset])=>`(list #'${names[name]} ${offset})`).join(' ');
  await evaluate(`(let ((actual (mezzano.debug:breakpoints)) (expected (list ${pairs})))
    (assert (= (length actual) (length expected)))
    (dolist (pair expected) (assert (member pair actual :test #'equal))) :checked)`,[':CHECKED']);
}
async function show(expected,fromMenu=false) {
  const id=(await request('information',{stop:await browser.evaluate('selectedStop')}))['next-command-id'];
  if(fromMenu) await menu(':Show Breakpoints');
  else await command(':Show Breakpoints');
  const text=await returned(id);
  assert.equal(typeof text,'string');
  if(expected.length) {
    assert(text.startsWith('Breakpoints:'));
    for(const [name,offset] of expected) {
      assert(text.split('\n').some(line=>line.includes(names[name])&&line.toUpperCase().includes('#X'+offset.toString(16).toUpperCase())));
    }
  } else assert.equal(text,'No breakpoints.');
  await locations(expected);
  return text;
}
async function rejected(source,phrase) {
  const parent=await browser.evaluate('selectedStop');
  const id=await command(source);
  await browser.waitFor(`stops.find(stop=>same(stop.token,${q(parent)}))?.info.child && !busy`,60);
  const child=(await remember(parent)).child;
  await select(child);
  const condition=await browser.evaluate("returnedResult('condition')");
  assert(condition.toLowerCase().includes(phrase.toLowerCase()),condition);
  const abort=await command(':Abort');
  await browser.waitFor(`commandResults.get(commandKey({stop:${q(child)},id:${abort}}))?.state===':unwound' && !busy`,60);
  await select(parent);
  assert.equal((await request('result',{stop:parent,id})).state,':unwound');
}
async function finishStop(token) {
  for(let attempt=0;attempt<12;attempt++) {
    const info=await remember(token);
    if(info.state===':closed') {
      if(info['thread-stop']) await finishStop(info['thread-stop']);
      return;
    }
    if(info.child) {await finishStop(info.child);continue;}
    const id=info['next-command-id']-1;
    const last=id>=0?await request('result',{stop:token,id}):null;
    assert(!last||![':pending',':running'].includes(last.state),'Owned command is still running during cleanup');
    await request('submit',{stop:token,id:info['next-command-id'],command:'abort'});
    await browser.waitFor(`api('information',{stop:${q(token)}}).then(info=>info.state===':closed'||info.child)`,60);
  }
  throw Error('Owned stop did not close: '+q(token));
}
async function cleanup() {
  if(setupStarted) await evaluate(`(progn
    (dolist (name '(${names.a} ${names.b} (setf ${names.setter})))
      (when (fboundp name) (mezzano.debug:clear-all-breakpoints (fdefinition name)))) :cleared)`,[':CLEARED']);
  for(const name of [...jobs]) {
    const token=await browser.evaluate(`state.jobs[${q(name)}]?.token`);
    assert(token,'Owned job token missing during cleanup');
    const info=await request('job-information',{job:token});
    for(const stop of info.stops??[]) await finishStop(stop);
    assert.notEqual((await request('job-information',{job:token})).state,':running');
  }
  if(setupStarted) await evaluate(`(progn (assert (null (mezzano.debug:breakpoints)))
    (dolist (name '(${Object.values(names).filter(name=>name!==names.setter).join(' ')} (setf ${names.setter})))
      (fmakunbound name))
    (makunbound '${stateName})
    (dolist (name '(${Object.values(names).join(' ')} ${stateName})) (unintern name)) 42)`,['42']);
  for(const token of [...owned.values()].reverse()) {
    assert.equal((await request('information',{stop:token})).state,':closed');
    await request('release-stop',{stop:token});
  }
  for(const name of jobs) {
    const token=await browser.evaluate(`state.jobs[${q(name)}]?.token`);
    await request('release-job',{job:token});
  }
  for(const prior of evidence.protected) {
    const info=await request('information',{stop:prior.token});
    assert.deepEqual([info.state,info.generation,info['next-command-id']],prior.state);
  }
  for(const token of await request('stops',{include_closed:true})??[]) {
    assert(!owned.has((await request('information',{stop:token})).id));
  }
  await request('release-session');
  evidence.cleaned=true;
  evidence.jobs=[...jobs];
  evidence.stops=[...owned.keys()];
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const original=window.fetch;
    window.fetch=async(...args)=>{
      const response=await original(...args);
      if(!response.ok) {
        const failures=JSON.parse(sessionStorage.getItem('breakpoint-http-failures')||'[]');
        failures.push({request:args[1]?.body,status:response.status,response:await response.clone().text()});
        sessionStorage.setItem('breakpoint-http-failures',JSON.stringify(failures));
      }
      return response;
    };
  })()`});
  await browser.send('Page.navigate',{url});
  await browser.waitFor("document.readyState==='complete' && typeof connected!=='undefined'");
  await ready();
  evidence.session=await browser.evaluate('state.session');
  for(const id of protectedIds) {
    const stop=await browser.evaluate(`stops.find(stop=>stop.info.id===${id})`);
    assert(stop,'Protected stop absent: '+id);
    evidence.protected.push({id,token:stop.token,state:[stop.info.state,stop.info.generation,stop.info['next-command-id']]});
  }
  await locations([]);
  setupStarted=true;
  const setup=`(progn
    (defvar ${stateName} (vector 0 0))
    (defun ${names['touch-a']} (marker state)
      (declare (optimize (debug 3) (safety 3) (speed 1))) (incf (aref state 0)) (values marker 42))
    (defun ${names['touch-b']} (marker state)
      (declare (optimize (debug 3) (safety 3) (speed 1))) (incf (aref state 1)) (values marker 43))
    (defun ${names.controller} ()
      (declare (optimize (debug 3) (safety 3) (speed 1))) (break "${marker} controller") 42)
    (defun (setf ${names.setter}) (value object)
      (declare (optimize (debug 3) (safety 3) (speed 1)) (ignore object)) value)
    ${['a','b'].map(name=>`(mezzano.internals::define-lap-function ${names[name]} ((marker state))
      (:gc :no-frame :layout #*0) (mezzano.lap.x86:push :rbp)
      (:gc :no-frame :layout #*00) (mezzano.lap.x86:mov64 :rbp :rsp)
      (:gc :frame) (mezzano.lap.x86:push :r8)
      (:gc :frame :layout #*1) (mezzano.lap.x86:push :r9)
      (:gc :frame :layout #*11) (mezzano.lap.x86:nop)
      (mezzano.lap.x86:call (:named-call ${names['touch-'+name]}))
      (mezzano.lap.x86:leave) (:gc :no-frame :layout #*0 :multiple-values 0) (mezzano.lap.x86:ret))`).join('\n')}
    (mezzano.internals::define-lap-function ${names.int3} ((marker))
      (:gc :no-frame :layout #*0) (mezzano.lap.x86:push :rbp)
      (:gc :no-frame :layout #*00) (mezzano.lap.x86:mov64 :rbp :rsp)
      (:gc :frame) (mezzano.lap.x86:push :r8)
      (:gc :frame :layout #*1) (mezzano.lap.x86:int 3)
      (mezzano.lap.x86:mov64 :r8 (:rbp -8)) (mezzano.lap.x86:leave)
      (:gc :no-frame :layout #*0)
      (mezzano.lap.x86:mov32 :ecx #.(ash 1 mezzano.internals::+n-fixnum-bits+))
      (mezzano.lap.x86:ret))
    (dolist (name '(${names['touch-a']} ${names['touch-b']} ${names.controller} (setf ${names.setter})))
      (multiple-value-bind (function warnings failure) (compile name)
        (declare (ignore function)) (assert (not warnings)) (assert (not failure))))
    (dolist (function (list #'${names.a} #'${names.b}))
      (let ((map (mezzano.internals::debug-info-instruction-starts (mezzano.internals::function-debug-info function))))
        (assert (= (sbit map 16) 1)) (assert (= (sbit map 18) 0))
        (assert (= (sbit map 24) 1)) (assert (= (sbit map 25) 1)))) :ready)`;
  await writeFile(output+'/setup.lisp',setup+'\n');
  await evaluate(setup,[':READY']);
  await browser.evaluate('state.interactive=true;save()');
  const controlJob=await startListener(`(${names.controller})`);
  controller=await stopped(controlJob);
  await browser.waitFor(`listenerDebugger && same(listenerDebugger.stop,${q(controller)}) && !busy`,60);
  await browser.waitFor('!nextStopInspection(selectedStop) && !busy',60);
  await fill('#source',':Set Break');
  await key(' ','Space',32);
  await browser.waitFor("document.querySelector('#source').value===':Set Breakpoint ' && !busy");
  await key('F12','F12',123);
  await browser.waitFor("document.querySelector('#listener-assistance').textContent.includes('Set a breakpoint in a compiled function at a decimal or #x hexadecimal byte offset.') && !busy");
  await menu(':Set Breakpoint');
  assert.equal(await browser.evaluate("document.querySelector('#source').value"),':Set Breakpoint ');
  const before=(await request('information',{stop:controller}))['next-command-id'];
  const incomplete=':Set Breakpoint '+names.a;
  await browser.evaluate("message('')");
  await fill('#source',incomplete);
  await key('Enter','Enter',13);
  await browser.waitFor("document.querySelector('#message').textContent==='Set Breakpoint requires (nonnegative decimal or #x hexadecimal byte offset).' && !busy");
  assert.equal((await request('information',{stop:controller}))['next-command-id'],before);
  assert.equal(await browser.evaluate("document.querySelector('#source').value"),incomplete);
  await select(controller,names.controller);
  evidence.controllerFrame=(await request('information',{stop:controller}))['current-frame'];
  await menu(':Clear Breakpoint');
  assert.equal(await browser.evaluate("document.querySelector('#debugger-command').value"),':Clear Breakpoint ');
  evidence.checks.push('Guest completion/help and both debugger editors; operand menus prefill; incomplete Set preserves input and command counter');

  let expected=[['a',24],['a',25],['b',16]];
  for(const [name,offset] of expected) {
    const pc=name==='a'?'#x'+offset.toString(16):String(offset);
    const result=await returned(await command(':Set Breakpoint '+names[name]+' '+pc));
    assert(result.includes('Breakpoint set in')&&result.includes(names[name]));
  }
  await browser.evaluate(`(()=>{const original=window.fetch;window.fetch=async(...args)=>{
    const response=await original(...args);const request=args[1]?.body&&JSON.parse(args[1].body);
    if(request?.operation==='submit'&&request.arguments.command==='set-breakpoint') {
      window.fetch=original;await response.arrayBuffer();throw new TypeError('Discarded accepted breakpoint reply');
    } return response;
  }})()`);
  await fill('#debugger-command',':Set Breakpoint '+names.b+' 24');
  await key('Enter','Enter',13);
  await browser.waitFor("!connected && !busy && state.pending.some(record=>record.operation==='submit'&&record.status==='outcome unknown')");
  const receipt=await browser.evaluate("state.pending.find(record=>record.operation==='submit'&&record.status==='outcome unknown')");
  await browser.click('#window-label');
  await browser.click('#resume-session');
  await ready();
  await browser.evaluate("showActivity('requests')");
  await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row=>row.textContent.includes(${q(JSON.stringify(receipt.arguments))})).querySelector('button').dataset.breakpointReplay='true'`);
  await browser.click('[data-breakpoint-replay="true"]');
  await browser.waitFor(`!busy && !state.pending.some(record=>record.operation==='submit'&&record.arguments.id===${receipt.arguments.id}&&same(record.arguments.stop,${q(controller)}))`,60);
  expected.push(['b',24]);
  await select(controller);
  await show(expected,true);
  assert.equal((await request('information',{stop:controller}))['current-frame'],evidence.controllerFrame);
  evidence.replay=receipt;
  await browser.screenshot(output+'/four-locations.png');
  evidence.checks.push('Decimal/hex Set, global Show, four locations and exact original-request replay after a discarded accepted reply');

  await rejected(':Set Breakpoint '+names.a+' 18','not-instruction-start');
  const setter=q('(setf '+names.setter+')');
  await rejected(':Set Breakpoint '+setter+' 16','four');
  await show(expected);
  await browser.screenshot(output+'/rejected-locations.png');
  const clear=await returned(await command(':Clear Breakpoint '+names.b));
  assert(clear.includes('Breakpoint cleared in')&&clear.includes('#x10'));
  expected=expected.filter(([name,offset])=>name!=='b'||offset!==16);
  await show(expected);
  const retained=await browser.evaluate(`state.commands.filter(command=>same(command.stop,${q(controller)})&&
    ['set-breakpoint','clear-breakpoint','clear-all-breakpoints','breakpoints'].includes(command.command)).map(({id,command})=>({id,command}))`);
  await browser.evaluate(`state.commands=state.commands.filter(command=>!same(command.stop,${q(controller)}));save()`);
  await browser.send('Page.reload');
  await browser.waitFor("typeof connected!=='undefined' && connected && !busy");
  await select(controller);
  await browser.waitFor(`state.commands.filter(command=>same(command.stop,${q(controller)})&&commandResults.has(commandKey(command))).length===stops.find(stop=>same(stop.token,${q(controller)})).info['next-command-id'] && !busy`,60);
  assert.equal((await request('information',{stop:controller}))['current-frame'],evidence.controllerFrame);
  assert.deepEqual(await browser.evaluate(`state.commands.filter(command=>same(command.stop,${q(controller)})&&
    ['set-breakpoint','clear-breakpoint','clear-all-breakpoints','breakpoints'].includes(command.command)).map(({id,command})=>({id,command}))`),retained);
  for(const caption of [':Set Breakpoint',':Clear Breakpoint',':Show Breakpoints']) {
    assert(await browser.evaluate(`[...document.querySelectorAll('#stop-detail .debugger-transcript')].some(node=>node.textContent==='→ '+${q(caption)})`));
  }
  await browser.screenshot(output+'/recovered-results.png');
  evidence.checks.push('Invalid instruction/capacity children and typed Abort; default Clear PC16; recovered results and canonical captions after reload');

  const aJob=await background(`(${names.a} :a ${stateName})`), a=await stopped(aJob);
  await select(a,names.a,{initial:true});
  const clearAllId=(await request('information',{stop:a}))['next-command-id'];
  await menu(':Clear All Breakpoints');
  assert((await returned(clearAllId,a)).includes('Cleared 2 breakpoints in'));
  expected=[['b',24]];
  await show(expected);
  await browser.screenshot(output+'/selected-function-cleared.png');
  const proceedA=await command(':Proceed');
  await completed(aJob,[':A','42']);
  assert.equal((await request('result',{stop:a,id:proceedA})).state,':unwound');
  await evaluate(`(aref ${stateName} 0)`,['1']);
  evidence.checks.push('Default Clear All uses selected executing A, preserves B and permits continuation of the already captured A hit');

  for(let iteration=0;iteration<2;iteration++) {
    const bJob=await background(`(${names.b} :b ${stateName})`), b=await stopped(bJob);
    await select(b,names.b,{initial:true});
    await returned(await command(':Show Instruction'));
    if(iteration===1) {
      assert((await returned(await command(':Clear Breakpoint '+names.b+' #x18'))).includes('Breakpoint cleared in'));
      await show([]);
      await browser.screenshot(output+'/removed-retained-hit.png');
    }
    await command(':Proceed');
    await completed(bJob,[':B','43']);
  }
  await evaluate(`(aref ${stateName} 1)`,['2']);
  await select(controller);
  assert((await returned(await command(':Set Breakpoint '+setter+' 16'))).includes('Breakpoint set in'));
  assert((await returned(await command(':Clear Breakpoint '+setter))).includes('Breakpoint cleared in'));
  assert((await returned(await command(':Clear Breakpoint '+setter))).includes('No breakpoint in'));
  assert((await returned(await command(':Clear All Breakpoints '+names.b))).includes('Cleared 0 breakpoints in'));
  await show([],true);
  await browser.screenshot(output+'/no-breakpoints.png');
  await command(':Proceed');
  await completed(controlJob,['42']);
  await listenerCommand('Set Breakpoint '+names.a+' #x18','Breakpoint set in');
  await listenerCommand('Show Breakpoints',names.a);
  await listenerCommand('Clear Breakpoint '+names.a+' 24','Breakpoint cleared in');
  await listenerCommand('Set Breakpoint '+names.a+' 24','Breakpoint set in');
  await listenerCommand('Clear All Breakpoints '+names.a,'Cleared 1 breakpoint in');
  await listenerCommand('Show Breakpoints','No breakpoints.');
  await locations([]);
  await browser.screenshot(output+'/listener-commands.png');
  const listener=await startListener('(+ 20 22)');
  await completed(listener,['42']);
  evidence.checks.push('Repeated B hits, retained hit after individual removal, quoted SETF name, absent Clear, explicit Clear All, empty global list and Listener reuse');
  evidence.checks.push('Ordinary Listener Set, Show, Clear and explicit-function Clear All use guest commands and leave no locations');
  const int3Job=await background(`(${names.int3} :int3)`), int3=await stopped(int3Job);
  await select(int3,names.int3,{initial:true,selectFrame:false});
  assert.equal(await browser.evaluate("returnedResult('condition')"),'Breakpoint instruction.');
  const instruction=await returned(await command(':Show Instruction'));
  assert(instruction.startsWith('Interrupted program counter in '),instruction);
  assert(instruction.includes(names.int3),instruction);
  const offset=instruction.match(/at byte offset #x([0-9A-F]+) \(instruction starts at #x([0-9A-F]+)\):/i);
  assert(offset,instruction);
  assert.equal(offset[1],offset[2]);
  await evaluate(`(assert (= (mezzano.internals::function-code-byte #'${names.int3} ${parseInt(offset[1],16)-1}) #xCC))`,['NIL']);
  evidence.int3={token:int3,instruction};
  await browser.screenshot(output+'/int3-instruction.png');
  const proceedInt3=await command(':Proceed');
  await completed(int3Job,[':INT3']);
  assert.equal((await request('result',{stop:int3,id:proceedInt3})).state,':unwound');
  assert.equal((await request('information',{stop:int3})).state,':closed');
  await locations([]);
  evidence.checks.push('INT3 preserves condition text, initially selects its interrupted frame, shows the instruction after INT3 and continues with its marker');
  await cleanup();
  evidence.httpFailures=await browser.evaluate("JSON.parse(sessionStorage.getItem('breakpoint-http-failures')||'[]')");
  assert.deepEqual(evidence.httpFailures,[]);
  assert.deepEqual(browser.errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({...evidence,errors:browser.errors},null,2));
  console.log('PASS breakpoint browser: '+evidence.checks.length+' groups; owned state released');
} catch(error) {
  evidence.error=error.stack;
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({...evidence,state:await browser.evaluate('state'),errors:browser.errors},null,2));
  try {await cleanup();} catch(cleanupError) {evidence.cleanupError=cleanupError.stack;}
  await writeFile(output+'/cleanup.json',JSON.stringify(evidence,null,2));
  throw error;
} finally {await browser.close();}
