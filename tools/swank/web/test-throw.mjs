import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2]??'http://127.0.0.1:8765/';
const output=resolve(process.argv[3]??'/tmp/mezzano-throw');
await mkdir(output,{recursive:false});
const browser=await openBrowser('about:blank');
const q=JSON.stringify, marker='WEB-THROW-'+randomBytes(6).toString('hex').toUpperCase();
const names=[marker+'-INLINE',marker+'-STANDALONE',marker+'-INLINE-SOURCE'],jobs=[],owned=new Map();
const evidence={marker,checks:[]},secondary=[];
let failure,parent,job,frameIndex;
const ready=()=>browser.waitFor('connected && !busy');
const request=(operation,args={})=>browser.evaluate(`api(${q(operation)},${q(args)})`);
const editor=()=>browser.evaluate("activity==='listener'?'#source':'#debugger-command'");
const resultQuery=(id,stop=parent)=>`commandResults.get(commandKey({stop:${q(stop)},id:${id}}))`;
const ioQuery=id=>`commandIOViews.get(commandKey({stop:${q(parent)},id:${id}}))`;
const inputSelector=id=>`#stop-detail .command-io[data-command-id="${id}"] textarea`;
async function key(key,code,number,modifiers=0){
 const text=key==='Enter'?'\r':key===' '?' ':undefined;
 for(const type of ['keyDown','keyUp'])await browser.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:number,modifiers,...(type==='keyDown'?{text,unmodifiedText:text}:{})});
}
async function fill(selector,source){
 await ready();await browser.click(selector);await key('a','KeyA',65,2);
 await browser.send('Input.insertText',{text:source});
}
async function enter(selector,source){await fill(selector,source);await key('Enter','Enter',13);}
async function activity(name){
 if(await browser.evaluate('activity==='+q(name)))return;
 await browser.click('#window-label');await browser.click('[data-activity="'+name+'"]');
 await browser.waitFor('activity==='+q(name)+' && !busy');
}
async function select(stop){
 await activity('debugger');
 if(!await browser.evaluate(`same(selectedStop,${q(stop)})`)){
  const id=(await request('information',{stop})).id;
  const query=`[...document.querySelectorAll('#stops button')].find(b=>b.textContent.startsWith(${q('Stop ')}+${id}+' ')&&!b.disabled&&b.getClientRects().length)`;
  await browser.waitFor(query);await browser.evaluate(`${query}.dataset.throwTest='restore-stop'`);
  await browser.click('[data-throw-test="restore-stop"]');
 }
 await browser.waitFor(`same(selectedStop,${q(stop)}) && (stops.find(s=>same(s.token,${q(stop)}))?.info.state===':closed' || !nextStopInspection(selectedStop)) && !busy`,60);
}
async function shot(name,id){
 if(id!==undefined)await browser.evaluate(`document.querySelector(${q('#stop-detail .command-io[data-command-id="'+id+'"]')}).scrollIntoView({block:'end'})`);
 await browser.screenshot(join(output,name+'.png'));
}
async function remember(){
 for(const name of jobs){
  const token=await browser.evaluate(`state.jobs[${q(name)}]?.token`);if(!token)continue;
  const info=await request('job-information',{job:token});
  for(const stop of info.stops??[])await own(stop);
 }
}
async function own(token){
 const info=await request('information',{stop:token});owned.set(info.id,token);
 if(info.child)await own(info.child);return info;
}
async function start(source){
 await activity('listener');const previous=await browser.evaluate('state.inputHistory.map(v=>v.name)');
 await enter('#source',source);
 const query=`state.inputHistory.find(v=>v.source===${q(source)}&&!${q(previous)}.includes(v.name))`;
 await browser.waitFor(query);const name=await browser.evaluate(query+'.name');jobs.push(name);return name;
}
async function finished(name,expected){
 await browser.waitFor(`views.get(${q(name)})?.info.state===':returned' && activeListenerJob!==${q(name)} && !busy`,60);
 const info=await browser.evaluate(`views.get(${q(name)}).info`);assert.deepEqual(info.values,expected);await remember();return info;
}
function fixture(name){return `(unwind-protect
 (progn
  (assert (not (fboundp '${name})))
  (defun ${name} ()
   (declare (optimize (debug 3) (safety 3) (speed 1)))
   (let ((tag (list :owned-tag)) (tag-count 0) (value-count 0) (cleanup-count 0)
         (inline-tag-count 0) (inline-value-count 0))
    (declare (type fixnum tag-count value-count cleanup-count inline-tag-count inline-value-count)
             (ignorable inline-tag-count inline-value-count))
    (let ((answer (multiple-value-list
      (catch tag
       (unwind-protect
        (progn (cerror "Continue the owned Throw fixture." "${marker}") (values :original 7))
        (incf cleanup-count))))))
     (values-list (append answer (list tag-count value-count cleanup-count))))))
  (assert (compiled-function-p (fdefinition '${name})))
  (${name}))
 (when (fboundp '${name}) (fmakunbound '${name}))
 (unintern '${name}))`;}
async function begin(name,separate=false){
 const source=fixture(name);await writeFile(join(output,name+'.lisp'),source+'\n');job=await start(source);
 await browser.waitFor(`activeListenerJob===${q(job)} && listenerDebugger?.depth===1 && !busy`,60);
 await browser.waitFor('returnedResult(\'frames\') && !nextStopInspection(selectedStop) && !stopCommandPending(selectedStop) && !busy',60);
 parent=await browser.evaluate('selectedStop');await own(parent);evidence.fixtures??=[];evidence.fixtures.push({name,job,stop:parent});
 if(separate)await activity('debugger');
 frameIndex=await browser.evaluate(`returnedResult('frames').findIndex(f=>f.function.includes(${q(name+' ')}))`);
 assert(frameIndex>=0,'Owned compiled catch target missing');
 const id=await command(':Set Current Frame '+frameIndex);assert.equal((await result(id)).state,':returned');
 assert.equal((await request('information',{stop:parent}))['current-frame'],frameIndex);
}
async function command(source){
 const id=(await request('information',{stop:parent}))['next-command-id'];
 const selector=await editor();await fill(selector,source);
 assert.equal(await browser.evaluate(`document.querySelector(${q(selector)}).value`),source);
 await key('Enter','Enter',13);
 await browser.waitFor(`state.commands.some(c=>same(c.stop,${q(parent)})&&c.id===${id}) && !busy`,60);return id;
}
async function result(id,stop=parent){
 await browser.waitFor(`${resultQuery(id,stop)} && ![':pending',':running'].includes(${resultQuery(id,stop)}.state) && !busy`,60);
 const value=await browser.evaluate(resultQuery(id,stop));evidence.results??=[];evidence.results.push({stop,id,...value});return value;
}
async function evaluate(source,expected){
 const value=await result(await command(source));assert.equal(value.state,':returned');assert.deepEqual(value.result,expected);
}
async function prompt(id,text){
 await browser.waitFor(`${resultQuery(id)}?.['input-waiting-p'] && ${ioQuery(id)}?.text.includes(${q(text)}) && !nextCommandOutput() && !busy`,60);
 assert(await browser.evaluate(`document.querySelector(${q('#stop-detail .command-io[data-command-id="'+id+'"]')}).textContent.includes(${q(text)})`));
 evidence.prompts??=[];evidence.prompts.push({stop:parent,id,prompt:text,output:await browser.evaluate(ioQuery(id)+'.text')});
}
async function send(id,text){
 await fill(inputSelector(id),text);
 await browser.click(`#stop-detail .command-io[data-command-id="${id}"] button:nth-of-type(1)`);
}
async function throwCommand(menu=false,completion=false){
 const id=(await request('information',{stop:parent}))['next-command-id'];
 if(menu){
  await browser.click('#window-label');
  const query="[...document.querySelectorAll('#debugger-menu button')].find(b=>b.textContent===':Throw'&&!b.disabled&&b.getClientRects().length)";
  await browser.waitFor(query);await browser.evaluate(`${query}.dataset.throwTest='menu'`);
  await browser.click('[data-throw-test="menu"]');
  await browser.evaluate("document.querySelector('[data-throw-test=menu]')?.removeAttribute('data-throw-test')");
 }else if(completion){
  const selector=await editor();await fill(selector,':Th');await key(' ','Space',32);
  await browser.waitFor(`document.querySelector(${q(selector)}).value.trim()===':Throw' && !busy`);
  await key('Enter','Enter',13);
 }else await command(':Throw');
 await prompt(id,'Catch tag (Lisp expression): ');return id;
}
async function help(){
 const selector=await editor();await fill(selector,':Throw');await key('F12','F12',123);
 const box=selector==='#source'?'#listener-assistance':'#debugger-assistance';
 await browser.waitFor(`document.querySelector(${q(box)}).textContent.toLowerCase().includes('throw') && !busy`);
}
async function inlineAssistance(){
 const selector=await editor(),box=selector==='#source'?'#listener-assistance':'#debugger-assistance';
 const source=':Throw "unfinished';await fill(selector,source);await key('F12','F12',123);
 const prompt=`document.querySelector(${q(box+' .argument-prompt')})`;
 await browser.waitFor(`${prompt}?.dataset.expectedType===':lisp-source' && !busy`);
 assert.equal(await browser.evaluate(`document.querySelector(${q(selector)}).value`),source);
 assert((await browser.evaluate(`document.querySelector(${q(box)}).textContent`)).includes('Omitted expressions are prompted for.'));
 await key(' ','Space',32);
 await browser.waitFor(`${prompt}?.dataset.expectedType===':lisp-source' && !busy`);
 assert.equal(await browser.evaluate(`document.querySelector(${q(selector)}).value`),source+' ');
 const cursor=await browser.evaluate(`document.querySelector(${q(selector)}).selectionStart`);
 assert.equal(cursor,(source+' ').length);
 evidence.assistance??=[];evidence.assistance.push({activity:await browser.evaluate('activity'),source:source+' ',cursor});
}
async function inlineCommand(source,expectedPrompt='(Y or N) '){
 const text=':Throw '+source,id=await command(text);
 assert.deepEqual(await browser.evaluate(`(()=>{const c=state.commands.find(c=>same(c.stop,${q(parent)})&&c.id===${id});return [c.command,c.argument,c.source]})()`),['throw',source,text]);
 await prompt(id,expectedPrompt);return id;
}
async function operands(id,tag,values,summary){
 await send(id,tag);await prompt(id,'Throw values (Lisp expression): ');
 await send(id,values);await prompt(id,'(Y or N) ');
 assert((await browser.evaluate(ioQuery(id)+'.text')).includes(summary));
}
async function cancel(id){
 await send(id,'n');const value=await result(id);assert.equal(value.result,'Throw cancelled.');
 assert.equal(await browser.evaluate(`document.querySelector('.debugger-throw[data-command-id="${id}"] .throw-result').textContent`),'Throw cancelled.');
 assert.equal((await request('information',{stop:parent}))['current-frame'],frameIndex);
}
async function abortChild(id,pattern){
 await browser.waitFor(`stops.find(s=>same(s.token,${q(parent)}))?.info.child && !busy`,60);
 const child=(await own(parent)).child;
 await browser.waitFor(`same(selectedStop,${q(child)}) && returnedResult('condition') && !nextStopInspection(selectedStop) && !busy`,60);
 const condition=await browser.evaluate("returnedResult('condition')");assert.match(condition,pattern);
 await browser.evaluate("document.querySelector('#stop-detail .condition').scrollIntoView({block:'start'})");
 await shot('throw-child-'+(evidence.children?.length??0));
 const abortId=(await request('information',{stop:child}))['next-command-id'];await enter(await editor(),':Abort');
 await browser.waitFor(`same(selectedStop,${q(parent)}) && !nextStopInspection(selectedStop) && !busy`,60);
 assert.equal((await request('result',{stop:child,id:abortId})).state,':unwound');
 assert.equal((await result(id)).state,':unwound');
 assert.equal((await request('information',{stop:parent}))['current-frame'],frameIndex);
 evidence.children??=[];evidence.children.push({stop:child,condition});
}
async function reloadReader(id,draft){
 await fill(inputSelector(id),draft);const before=await request('information',{stop:parent});
 const raw=await request('result',{stop:parent,id});
 const cursor=await browser.evaluate(`(()=>{const e=document.querySelector(${q(inputSelector(id))});e.setSelectionRange(0,e.value.length);e.dispatchEvent(new Event('input'));return [e.value,e.selectionStart,e.selectionEnd]})()`);
 const selected=await browser.evaluate('activity'),origin=await browser.evaluate('performance.timeOrigin');await browser.send('Page.reload');
 await browser.waitFor(`performance.timeOrigin!==${origin} && typeof connected!=='undefined' && connected && !busy`,60);
 assert.equal(await browser.evaluate('activity'),'listener');
 if(selected==='debugger')await select(parent);else await activity(selected);
 await browser.waitFor(`same(selectedStop,${q(parent)}) && !busy`,60);
 await browser.waitFor(`${resultQuery(id)}?.['input-waiting-p'] && !nextHistoricalCommand() && !nextCommandOutput() && !busy`,60);
 assert.equal(await browser.evaluate('state.session'),evidence.session);
 const after=await request('information',{stop:parent});
 assert.deepEqual([after['current-frame'],after['next-command-id']],[before['current-frame'],before['next-command-id']]);
 assert.equal((await request('result',{stop:parent,id}))['input-length'],raw['input-length']);
 assert.deepEqual(await browser.evaluate(`(()=>{const e=document.querySelector(${q(inputSelector(id))});return [e.value,e.selectionStart,e.selectionEnd]})()`),cursor);
 evidence.reloads??=[];evidence.reloads.push({id,next:after['next-command-id'],inputLength:raw['input-length'],cursor});
}
async function finishOwned(token){
 for(let attempt=0;attempt<15;attempt++){
  const info=await own(token);if(info.state===':closed')return;
  if(info.child){await finishOwned(info.child);continue;}
  const id=info['next-command-id']-1,last=id>=0?await request('result',{stop:token,id}):null;
  if(last&&[':pending',':running'].includes(last.state)){
   assert.equal(last['input-waiting-p'],true,'Owned Throw command running outside input wait');
   await request('command-input',{stop:token,id,offset:last['input-length'],text:'',eof:true});
  }else await request('submit',{stop:token,id:info['next-command-id'],command:'abort',argument:null});
  await delay(100);
 }
 throw new Error('Owned Throw stop did not close: '+q(token));
}
try{
 await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const original=window.fetch;window.fetch=async(...args)=>{
 const response=await original(...args);if(!response.ok){const list=JSON.parse(sessionStorage.getItem('throw-http-failures')||'[]');list.push({request:args[1]?.body,status:response.status,response:await response.clone().text()});sessionStorage.setItem('throw-http-failures',JSON.stringify(list));}return response;};})()`});
 await browser.send('Page.navigate',{url});await browser.waitFor("document.readyState==='complete' && typeof connected!=='undefined' && connected && !busy");
 evidence.session=await browser.evaluate('state.session');evidence.originalStops=await request('stops',{include_closed:true})??[];
 evidence.protected=[];for(const stop of evidence.originalStops){const info=await request('information',{stop});evidence.protected.push({stop,id:info.id,state:info.state,generation:info.generation,next:info['next-command-id']});}
 await browser.click('#window-label');
 if(!await browser.evaluate('document.querySelector("#interactive").checked'))await browser.click('#interactive');
 assert.equal(await browser.evaluate('document.querySelector("#interactive").checked'),true);await browser.click('#close-menu');
 await begin(names[0]);await help();
 let id=await throwCommand(false,true);
 await operands(id,'(progn (incf tag-count) (values tag :ignored))','(progn (incf value-count) (values))','Catch tag: (:OWNED-TAG)\n0 values:\n');
 await shot('inline-zero-values-confirmation',id);await cancel(id);
 await evaluate('(values tag-count value-count cleanup-count)',['1','1','0']);
 evidence.checks.push('Inline SPACE/help and zero-value cancellation preserve selected frame; tag primary/value expressions execute once without program cleanup');
 await inlineAssistance();
 const commentedSource='(progn (incf inline-tag-count) (values tag :ignored)) ; primary catch tag\n'+
  '(progn (incf inline-value-count) (values "two words" "Ω" "<tag>")) #| trailing comment |#';
 id=await inlineCommand(commentedSource);
 assert((await browser.evaluate(ioQuery(id)+'.text')).includes('Catch tag: (:OWNED-TAG)\n3 values: "two words" "Ω" "<tag>"\n'));
 await shot('inline-source-confirmation',id);await cancel(id);
 id=await inlineCommand('(progn (incf inline-tag-count) (values tag :ignored))','Throw values (Lisp expression): ');
 await send(id,'(progn (incf inline-value-count) (values))');await prompt(id,'(Y or N) ');
 assert((await browser.evaluate(ioQuery(id)+'.text')).includes('0 values:\n'));await cancel(id);
 await evaluate('(values inline-tag-count inline-value-count tag-count value-count cleanup-count)',['2','2','1','1','0']);
 for(const [source,pattern] of [
  ['"unfinished',/end.of.file|EOF|end of input|end of stream/i],
  ['#.(progn (incf inline-tag-count) tag)',/READ-EVAL|read-time|Cannot #\./i],
  ['(progn (incf inline-tag-count) tag) (progn (incf inline-value-count) :unwanted) :third',/unexpected.throw.forms/i]
 ]){
  id=await command(':Throw '+source);await abortChild(id,pattern);
  await evaluate('(values inline-tag-count inline-value-count tag-count value-count cleanup-count)',['2','2','1','1','0']);
 }
 evidence.checks.push('Listener inline source retains strings, comments and unfinished-quote SPACE/help; omitted values prompt, cancellation and reader/third-form child Abort preserve the original catch without unwanted effects');
 id=await throwCommand();await send(id,'#.(error "Read-time Throw tag must not run.")');await abortChild(id,/READ-EVAL|read-time|Cannot #\./i);
 id=await throwCommand();await send(id,'tag');await prompt(id,'Throw values (Lisp expression): ');await send(id,`(error "${marker} values error")`);await abortChild(id,new RegExp(marker+' values error'));
 id=await throwCommand();await operands(id,'(list :missing-catch)','(values :missing-value)','1 value: :MISSING-VALUE\n');await send(id,'y');await abortChild(id,/catch|throw/i);
 await evaluate('(values tag-count value-count cleanup-count)',['1','1','0']);await shot('inline-child-abort-recovered');
 evidence.checks.push('Reader, value-evaluator and missing-catch errors enter children; typed Abort returns to the selected parent without unwinding the original catch');
 await result(await command(':Use Dynamic Environment'));
 id=await throwCommand(true);await operands(id,'(list :dynamic-cancel)','(values 41 42)','2 values: 41 42\n');await cancel(id);
 assert.equal((await request('information',{stop:parent}))['evaluation-environment'],':dynamic');
 await result(await command(':Use Lexical Environment'));await command(':Proceed');
 await finished(job,[':ORIGINAL','7','1','1','1']);
 evidence.checks.push('Inline menu Throw uses the selected dynamic evaluator; cancellation and original Proceed preserve values and run one application cleanup');
 await begin(names[1],true);await help();
 id=await throwCommand(false,true);await operands(id,'tag','(values :standalone-cancel)','1 value: :STANDALONE-CANCEL\n');await cancel(id);
 await evaluate('(values tag-count value-count cleanup-count)',['0','0','0']);
 id=await throwCommand(true);await reloadReader(id,'tag');await send(id,'(progn (incf tag-count) (values tag :ignored))');await prompt(id,'Throw values (Lisp expression): ');
 const valueSource='(progn (incf value-count) (values :thrown 42 "Ω"))';
 await browser.evaluate(`(()=>{const original=window.fetch;window.fetch=async(...args)=>{
 const response=await original(...args),request=args[1]?.body&&JSON.parse(args[1].body);
 if(response.ok&&request?.operation==='command-input'&&request.arguments.id===${id}){window.fetch=original;await response.arrayBuffer();throw new TypeError('Discarded accepted Throw input reply');}return response;};})()`);
 await send(id,valueSource);
 await browser.waitFor("!connected && !busy && state.pending.some(r=>r.operation==='command-input'&&r.status==='outcome unknown')");
 const receipt=await browser.evaluate("state.pending.find(r=>r.operation==='command-input'&&r.status==='outcome unknown')");
 await browser.click('#window-label');await browser.click('#resume-session');await ready();assert.equal(await browser.evaluate('state.session'),evidence.session);
 await activity('requests');
 await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row=>row.textContent.includes(${q(JSON.stringify(receipt.arguments))})).querySelector('button').dataset.throwTest='replay'`);
 await browser.click('[data-throw-test="replay"]');await browser.waitFor(`!state.pending.some(r=>r.id===${q(receipt.id)}) && !busy`);await activity('debugger');
 await prompt(id,'(Y or N) ');assert((await browser.evaluate(ioQuery(id)+'.text')).includes('Catch tag: (:OWNED-TAG)\n3 values: :THROWN 42 "Ω"\n'));evidence.replay=receipt;
 const next=(await request('information',{stop:parent}))['next-command-id'];assert.equal(next,id+1);
 await reloadReader(id,'y');await shot('standalone-confirmation-reloaded',id);await send(id,'y');
 await finished(job,[':THROWN','42','"Ω"','1','1','1']);
 assert.equal((await result(id)).state,':unwound');
 assert.equal(await browser.evaluate(`document.querySelector('.debugger-throw[data-command-id="${id}"] .throw-result').textContent`),'unwound');
 assert.equal(await request('submit',{stop:parent,id,command:'throw',argument:null}),id);
 assert.equal((await request('information',{stop:parent}))['next-command-id'],next);
 evidence.checks.push('Standalone menu/help, tag-reader and confirmation reload retain draft/cursor/IDs; discarded accepted value input replays once and ordinary Throw delivers three values with one cleanup');
 await browser.evaluate(`state.commands=state.commands.filter(c=>!(same(c.stop,${q(parent)})&&c.id===${id}));save()`);
 const origin=await browser.evaluate('performance.timeOrigin');await browser.send('Page.reload');
 await browser.waitFor(`performance.timeOrigin!==${origin} && typeof connected!=='undefined' && connected && !busy`,60);
 assert.equal(await browser.evaluate('activity'),'listener');await select(parent);
 await browser.waitFor(`same(selectedStop,${q(parent)}) && !nextHistoricalCommand() && !busy`,60);
 await browser.waitFor(`document.querySelector('.debugger-throw[data-command-id="${id}"] .throw-result') && !busy`,60);
 assert.equal(await browser.evaluate(`document.querySelector('.debugger-throw[data-command-id="${id}"] .debugger-transcript').textContent`),'→ :Throw');
 assert.equal(await browser.evaluate(`document.querySelector('.debugger-throw[data-command-id="${id}"] .throw-result').textContent`),'unwound');
 assert.equal(await browser.evaluate("document.querySelector('#debugger-command').disabled"),true);
 assert.equal((await request('information',{stop:parent}))['next-command-id'],next);
 await browser.evaluate(`document.querySelector('.debugger-throw[data-command-id="${id}"]').scrollIntoView({block:'end'})`);await shot('closed-throw-recovered');
 evidence.checks.push('Closed Throw retains canonical caption and UNWOUND history after descriptor loss/reload without a new command');
 await begin(names[2],true);await inlineAssistance();
 const inlineSource='(progn (incf inline-tag-count) (values tag :ignored)) #| retained source |# '+
  '(progn (incf inline-value-count) (let ((payload (vector :inline "two words" "Ω"))) '+
  '(mezzano.extensions:gc :full t) (values payload "two words" "<tag>" inline-tag-count inline-value-count))) #| end |#';
 id=(await request('information',{stop:parent}))['next-command-id'];
 await browser.evaluate(`(()=>{const original=window.fetch;window.fetch=async(...args)=>{
 const response=await original(...args),request=args[1]?.body&&JSON.parse(args[1].body);
 if(response.ok&&request?.operation==='submit'&&request.arguments.command==='throw'&&request.arguments.id===${id}){
  window.fetch=original;await response.arrayBuffer();throw new TypeError('Discarded accepted inline Throw submit reply');}return response;};})()`);
 const inlineEditor=await editor();await fill(inlineEditor,':Throw '+inlineSource);
 assert.equal(await browser.evaluate(`document.querySelector(${q(inlineEditor)}).value`),':Throw '+inlineSource);
 await key('Enter','Enter',13);
 await browser.waitFor("!connected && !busy && state.pending.some(r=>r.operation==='submit'&&r.arguments.command==='throw'&&r.status==='outcome unknown')");
 const inlineReceipt=await browser.evaluate("state.pending.find(r=>r.operation==='submit'&&r.arguments.command==='throw'&&r.status==='outcome unknown')");
 assert.equal(inlineReceipt.arguments.id,id);assert.equal(inlineReceipt.arguments.argument,inlineSource);
 assert.equal(inlineReceipt.source,':Throw '+inlineSource);
 await browser.click('#window-label');await browser.click('#resume-session');await ready();
 assert.equal(await browser.evaluate('state.session'),evidence.session);await activity('requests');
 await browser.evaluate(`[...document.querySelectorAll('#pending .command-row')].find(row=>row.textContent.includes(${q(JSON.stringify(inlineReceipt.arguments))})).querySelector('button').dataset.throwTest='inline-replay'`);
 await browser.click('[data-throw-test="inline-replay"]');await browser.waitFor(`!state.pending.some(r=>r.id===${q(inlineReceipt.id)}) && !busy`);await activity('debugger');
 await prompt(id,'(Y or N) ');
 assert((await browser.evaluate(ioQuery(id)+'.text')).includes('5 values: #(:INLINE "two words" "Ω") "two words" "<tag>" 1 1\n'));
 const inlineNext=(await request('information',{stop:parent}))['next-command-id'];assert.equal(inlineNext,id+1);
 await reloadReader(id,'y');await shot('inline-source-transfer-reloaded',id);await send(id,'y');
 await finished(job,['#(:INLINE "two words" "Ω")','"two words"','"<tag>"','1','1','0','0','1']);
 assert.equal((await result(id)).state,':unwound');
 assert.equal(await request('submit',{stop:parent,id,command:'throw',argument:inlineSource}),id);
 assert.equal((await request('information',{stop:parent}))['next-command-id'],inlineNext);
 evidence.inlineReplay=inlineReceipt;
 evidence.checks.push('Standalone inline Throw survives full GC, discarded accepted-submit reply, exact replay and confirmation reload; all values and once-only counters reach the catch with one cleanup');
 await activity('listener');const clean=await start(`(progn ${names.map(name=>'(assert (null (find-symbol '+q(name)+' :cl-user)))').join(' ')} 42)`);await finished(clean,['42']);
 evidence.checks.push('Original continuation and successful Throw release their unique functions; next Listener returns42');
}catch(error){
 failure=error;evidence.failure=error.stack;
 const captures=await Promise.allSettled([shot('failure'),browser.evaluate('JSON.stringify(sessionStorage)').then(v=>writeFile(join(output,'failure-state.json'),v)),browser.evaluate('document.body.innerText').then(v=>writeFile(join(output,'failure.txt'),v))]);
 secondary.push(...captures.filter(v=>v.status==='rejected').map(v=>v.reason));
}finally{
 try{
  await remember();await browser.evaluate('connected=false;activity="requests"');
  for(const name of jobs){
   const token=await browser.evaluate(`state.jobs[${q(name)}]?.token`);if(!token)continue;
   const info=await request('job-information',{job:token});
   for(const stop of info.stops??[])await finishOwned(stop);
   await browser.waitFor(`api('job-information',{job:${q(token)}}).then(v=>v.state!==':running')`,60);
   await request('release-job',{job:token});
  }
  for(const token of [...owned.values()].reverse()){
   assert.equal((await request('information',{stop:token})).state,':closed');await request('release-stop',{stop:token});
  }
  for(const token of await request('stops',{include_closed:true})??[])assert(![...owned.values()].some(v=>JSON.stringify(v)===JSON.stringify(token)));
  for(const previous of evidence.protected??[]){const info=await request('information',{stop:previous.stop});assert.deepEqual([info.id,info.state,info.generation,info['next-command-id']],[previous.id,previous.state,previous.generation,previous.next]);}
  await request('release-session');evidence.cleaned=true;
 }catch(error){evidence.cleanupFailure=error.stack;secondary.push(error);}
 evidence.jobs=jobs;evidence.stops=[...owned.entries()];evidence.errors=browser.errors;
 try{evidence.httpFailures=await browser.evaluate("JSON.parse(sessionStorage.getItem('throw-http-failures')||'[]')");assert.deepEqual(evidence.httpFailures,[]);assert.deepEqual(browser.errors,[]);}catch(error){secondary.push(error);}
 try{await browser.close();}catch(error){secondary.push(error);}
 evidence.finalizationFailures=secondary.map(v=>v.stack||String(v));evidence.passed=!failure&&!secondary.length;
 try{await writeFile(join(output,'result.json'),JSON.stringify(evidence,null,2)+'\n');}catch(error){secondary.push(error);}
}
if(failure&&secondary.length)throw new AggregateError([failure,...secondary],failure.message,{cause:failure});
if(failure)throw failure;if(secondary.length)throw new AggregateError(secondary,'Throw evidence collection or cleanup failed');
console.log(JSON.stringify(evidence,null,2));
