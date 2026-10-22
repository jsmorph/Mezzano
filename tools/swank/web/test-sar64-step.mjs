import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {URL} from 'node:url';
import {openBrowser} from './browser-test-support.mjs';

const cases=[
  {label:'sar64-register-immediate-0',opcode:'SAR64',kind:'register-immediate',initial:-3,count:1,depth:0,
    target:'SAR64-REGISTER-IMMEDIATE-1',raxAfter:'#xFFFFFFFFFFFFFFFE',memoryAfter:'#xFFFFFFFFFFFFFFFD',rcx:0,finalMarker:-2},
  {label:'sar64-memory-cl-mask-2',opcode:'SAR64',kind:'memory-cl',initial:-3,count:65,depth:2,
    target:'SAR64-MEMORY-CL-5',raxAfter:'#xFFFFFFFFFFFFFFFD',memoryAfter:'#xFFFFFFFFFFFFFFFE',rcx:65,finalMarker:-2}
];
const q=JSON.stringify;
const ls=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
const pkg='(find-package :cl-user)';
const record=name=>`(symbol-value (find-symbol ${ls(name)} ${pkg}))`;

function forms(test,name,instructionText='@INSTRUCTION@',stopId='@STOP-ID@') {
  const opcode='mezzano.lap.x86:'+test.opcode.toLowerCase();
  const instructionCheck=offset=>`(assert (search (format nil "at byte offset #x~X " ${offset}) ${ls(instructionText)}))
      (assert (search (symbol-name (mezzano.internals::function-name function)) ${ls(instructionText)}))`;
  const operandCheck=test.kind==='register-immediate'
    ? `(assert (equal (mezzano.disassemble.x86-64::inst-operands instruction) '(:rax 1)))`
    : `(let* ((operands (mezzano.disassemble.x86-64::inst-operands instruction)) (address (first operands)))
          (assert (= (length operands) 2)) (assert (eq (second operands) :cl))
          (assert (typep address 'mezzano.disassemble.x86-64::effective-address))
          (assert (eq (mezzano.disassemble.x86-64::ea-base address) :rbp))
          (assert (= (mezzano.disassemble.x86-64::ea-disp address) -24))
          (assert (null (mezzano.disassemble.x86-64::ea-index address)))
          (assert (null (mezzano.disassemble.x86-64::ea-scale address)))
          (assert (null (mezzano.disassemble.x86-64::ea-segment address))))`;
  const savedWord=(register,displacement='')=>`(lispm-retained-integer-step-test::raw-word (list nil nil nil (first handles)) ${register} ${displacement})`;
  const architecturalCheck=(after)=>`(multiple-value-bind (rax flags)
          (lispm-retained-logical-step-test::registers (list nil nil nil (first handles)))
        (assert (= rax ${after?test.raxAfter:'#xFFFFFFFFFFFFFFFD'}))
        (assert (= (logand flags #x8C5) ${after?'#x81':'#x845'})))
      (assert (= ${savedWord(':rbp','-24')} ${after?test.memoryAfter:'#xFFFFFFFFFFFFFFFD'}))
      (assert (= ${savedWord(':rcx')} ${test.rcx}))
      (assert (= (logand ${test.count} 63) 1))
      ${after?`(assert (= (- ${test.kind==='register-immediate'?'(lispm-retained-logical-step-test::registers (list nil nil nil (first handles)))':savedWord(':rbp','-24')} (ash 1 64)) -2))`:''}`;
  return {
    prepare:`(progn
  (assert (not (find-symbol ${ls(name)} ${pkg})))
  (assert (= mezzano.internals::+n-fixnum-bits+ 1))
  (assert (= (length lispm-retained-integer-step-test::*shift-targets*) 70))
  (assert (= (count 'mezzano.lap.x86:shr32 lispm-retained-integer-step-test::*shift-targets* :key #'second) 30))
  (assert (= (count '${opcode} lispm-retained-integer-step-test::*shift-targets* :key #'second) 40))
  (let ((matches (remove-if-not
                  (lambda (entry)
                    (and (eq (second entry) '${opcode}) (eq (third entry) :${test.kind})
                         (= (fourth entry) ${test.initial}) (= (fifth entry) ${test.count})))
                  lispm-retained-integer-step-test::*shift-targets*)))
    (assert (= (length matches) 1))
    (let* ((entry (first matches)) (function (first entry)) (value (fourth entry))
           (context (mezzano.disassemble:make-disassembler-context function))
           (instructions (remove-if-not
                          (lambda (instruction)
                            (eq (mezzano.disassemble.x86-64::inst-opcode instruction) '${opcode}))
                          (mezzano.disassemble:context-instructions context))))
      (assert (= (length instructions) 1))
      (let* ((instruction (elt instructions 0))
             (offset (mezzano.disassemble:inst-offset instruction))
             (next (+ offset (mezzano.disassemble:inst-size instruction)))
             (marker (vector :hardware-breakpoint))
             (original (mezzano.supervisor::instruction-breakpoints))
             (symbol (intern ${ls(name)} ${pkg})))
        ${operandCheck}
        (assert (string= (symbol-name (mezzano.internals::function-name function)) ${ls(test.target)}))
        (assert (mezzano.disassemble:instruction-at context next))
        (assert (not (find-if (lambda (point)
                              (and (eq (mezzano.supervisor::instruction-breakpoint-function point) function)
                                   (= (mezzano.supervisor::instruction-breakpoint-offset point) offset))) original)))
        (setf (symbol-value symbol)
              (list :function function :offset offset :next next :initial value :marker marker
                    :state (vector 0 0 nil marker nil) :original-points original :point nil
                    :thread nil :stop nil :generation nil :bytes (lispm-hardware-breakpoint-test::code-bytes function)))
        (setf (getf (symbol-value symbol) :point) (mezzano.supervisor::install-instruction-breakpoint function offset))
        (values offset next (symbol-name (mezzano.internals::function-name function)))))))`,
    run:`(let* ((record ${record(name)}) (state (getf record :state)))
  (assert (null (getf record :thread)))
  (setf (getf record :thread) (mezzano.supervisor:current-thread))
  (lispm-hardware-breakpoint-test::caller (getf record :function) state ${test.depth})
  (values-list (aref state 2)))`,
    releaseEntry:`(let* ((record ${record(name)}) (function (getf record :function))
         (handles (remove-if-not
                   (lambda (handle) (eq (mezzano.debug::service-stop-thread (mezzano.debug::service-handle-stop handle))
                                        (getf record :thread)))
                   (mezzano.debug:debugger-stops :include-closed t))))
  (assert (= (length handles) 1))
  (let ((stop (mezzano.debug::service-handle-stop (first handles))))
    (assert (= (getf (mezzano.debug:debugger-stop-information (first handles)) :id) ${stopId}))
    (assert (eq (mezzano.debug::service-stop-state stop) :stopped))
    (assert (null (mezzano.debug::service-stop-child stop)))
    (assert (eq (mezzano.internals::instruction-trap-breakpoint (mezzano.debug::service-stop-condition stop))
                (getf record :point)))
    (multiple-value-bind (found offset index reason) (mezzano.debug::service-instruction-trap-context stop)
      (assert (null reason)) (assert (eq found function)) (assert (= offset (getf record :offset)))
      (assert (= index (mezzano.debug::service-stop-current-frame stop)))
      ${architecturalCheck(false)})
    ${instructionCheck('(getf record :offset)')}
    (assert (eq (aref (getf record :marker) 0) :hardware-breakpoint))
    (assert (zerop (aref (getf record :state) 0)))
    (assert (zerop (aref (getf record :state) 1)))
    (setf (getf record :stop) stop (getf record :generation) (mezzano.debug::service-stop-generation stop))
    (assert (mezzano.supervisor::clear-instruction-breakpoint (getf record :point)))
    (setf (getf record :point) nil)
    t))`,
    checkStopped:`(let* ((record ${record(name)}) (function (getf record :function))
         (handles (remove-if-not
                   (lambda (handle) (eq (mezzano.debug::service-stop-thread (mezzano.debug::service-handle-stop handle))
                                        (getf record :thread)))
                   (mezzano.debug:debugger-stops :include-closed t))))
  (assert (= (length handles) 1))
  (let ((stop (mezzano.debug::service-handle-stop (first handles))))
    (assert (eq stop (getf record :stop)))
    (assert (= (getf (mezzano.debug:debugger-stop-information (first handles)) :id) ${stopId}))
    (assert (eq (mezzano.debug::service-stop-state stop) :stopped))
    (assert (= (mezzano.debug::service-stop-generation stop) (1+ (getf record :generation))))
    (assert (eq (mezzano.internals::instruction-trap-kind (mezzano.debug::service-stop-condition stop)) :single-step))
    (multiple-value-bind (found offset index reason) (mezzano.debug::service-instruction-trap-context stop)
      (assert (null reason)) (assert (eq found function)) (assert (= offset (getf record :next)))
      (assert (= index (mezzano.debug::service-stop-current-frame stop)))
      ${architecturalCheck(true)})
    (let* ((marker (getf record :marker)) (address (mezzano.internals::lisp-object-address marker)))
      (mezzano.extensions:gc :full t)
      (assert (/= address (mezzano.internals::lisp-object-address marker)))
      (assert (eq marker (getf record :marker)))
      ${architecturalCheck(true)})
    ${instructionCheck('(getf record :next)')}
    (assert (eq (aref (getf record :marker) 0) :hardware-breakpoint))
    (assert (zerop (aref (getf record :state) 0)))
    (assert (zerop (aref (getf record :state) 1)))
    (assert (null (mezzano.supervisor::find-instruction-step-request (getf record :thread))))
    (assert (equalp (getf record :bytes) (lispm-hardware-breakpoint-test::code-bytes function)))
    t))`,
    finish:`(let* ((symbol (find-symbol ${ls(name)} ${pkg})) (record (symbol-value symbol))
         (state (getf record :state)) (points (mezzano.supervisor::instruction-breakpoints))
         (original (getf record :original-points)))
  (assert (= (aref state 0) 1)) (assert (= (aref state 1) 1))
  (assert (eq (first (aref state 2)) (getf record :marker)))
  (assert (equal (rest (aref state 2)) '(:caller)))
  (assert (= (aref (getf record :marker) 0) ${test.finalMarker}))
  (assert (null (aref state 4))) (assert (null (getf record :point)))
  (assert (not (find (getf record :thread) (mezzano.debug:debugger-stops :include-closed t)
                     :key (lambda (handle) (mezzano.debug::service-stop-thread (mezzano.debug::service-handle-stop handle))))))
  (assert (= (length points) (length original)))
  (assert (every (lambda (point) (member point original :test #'eq)) points))
  (assert (equalp (getf record :bytes) (lispm-hardware-breakpoint-test::code-bytes (getf record :function))))
  (makunbound symbol) (assert (unintern symbol ${pkg})) t)`
  };
}

if(process.argv[2]==='--check') {
  const prepared=cases.map(test=>({...test,forms:forms(test,'WEB-SAR64-PREPARED-'+test.label.toUpperCase(),'at byte offset #x10 SAR64',123)}));
  await writeFile(process.argv[3],JSON.stringify(prepared,null,2)+'\n');
  console.log('PASS generated two SAR64 cases; no browser or guest requests');
  process.exit(0);
}

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.equal(config.executionAuthorized,true,'Preparation only: explicit native-tested handoff required');
const endpoint=new URL(config.endpoint);
assert(['http:','https:'].includes(endpoint.protocol),'HTTP(S) endpoint required');
assert.equal(endpoint.pathname,'/','Root endpoint required');
assert(!endpoint.href.includes('?'),'Endpoint query is unsupported');
assert(!endpoint.href.includes('#'),'Endpoint fragment is unsupported');
assert.equal(config.sar64NativeAccepted,true);
for (const field of ['metadata','nativeGuard','handoff','sourceManifest','bookProvenance','auxiliaryProvenance']) {
  const pin=config.runtime[field];
  assert(pin&&typeof pin.localPath==='string'&&pin.localPath.length);
  assert.match(pin.sha256,/^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(await readFile(pin.localPath)).digest('hex'),pin.sha256);
}
assert.equal(config.guards.length,3);
for(const guard of config.guards) {
  assert.equal(createHash('sha256').update(await readFile(guard.localSource)).digest('hex'),guard.sourceSha256);
  assert(guard.program&&Array.isArray(guard.arguments)&&guard.arguments.length);
}
const output=process.argv[3];
await mkdir(output,{recursive:false});
const execute=promisify(execFile),evidence={config,cases:[],jobs:[],commands:[],guards:[]};
async function save(){await writeFile(output+'/result.json.tmp',JSON.stringify(evidence,null,2)+'\n');await rename(output+'/result.json.tmp',output+'/result.json');}
async function guards(phase){
  for(const [index,guard] of config.guards.entries()){
    const result=await execute(guard.program,guard.arguments,{encoding:'utf8',maxBuffer:4*1024*1024});
    await writeFile(output+'/'+phase+'-guard-'+index+'.log',result.stdout+result.stderr);
    evidence.guards.push({phase,index});
  }
}
await guards('before');
let primaryError;
const browser=await openBrowser('about:blank');
const evaluate=expression=>{new Function(expression);return browser.evaluate(expression);};
const wait=(expression,seconds=90)=>{new Function('return ('+expression+'\n)');return browser.waitFor(expression,seconds);};
const request=(operation,args={})=>evaluate(`api(${q(operation)},${q(args)})`);
const ready=()=>wait("typeof connected!=='undefined'&&connected&&!busy",60);
const resultQuery=receipt=>`commandResults.get(commandKey({stop:${q(receipt.stop)},id:${receipt.id}}))`;
async function key(key,code,n){for(const type of ['keyDown','keyUp'])await browser.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:n,text:key==='Enter'?'\r':undefined});}
async function enter(source){await ready();await evaluate(`setEditor(document.querySelector('#source'),${q(source)},${Array.from(source).length});document.querySelector('#source').focus()`);await key('Enter','Enter',13);}
async function baseline(){
  const stops=[],jobs=[];
  for(const token of await request('stops',{include_closed:true})??[])stops.push({token,info:await request('information',{stop:token})});
  for(const token of await request('jobs')??[])jobs.push({token,info:await request('job-information',{job:token})});
  stops.sort((a,b)=>a.info.id-b.info.id);jobs.sort((a,b)=>a.info.name.localeCompare(b.info.name));
  assert.deepEqual(stops.map(row=>row.info.id),config.protectedStopIds);assert.equal(jobs.length,config.protectedJobCount);
  return {stops,jobs};
}
async function ownedEvaluation(phase,source,expected=['T']){
  const record={phase,name:randomBytes(32).toString('hex'),source};evidence.jobs.push(record);await save();
  await evaluate(`mutate('start-evaluation',${q({name:record.name,source,package:'CL-USER'})})`);
  await wait(`views.get(${q(record.name)})?.info&&(views.get(${q(record.name)}).info.state!==':running'||views.get(${q(record.name)}).info.stops?.length)&&!busy`);
  record.token=await evaluate(`state.jobs[${q(record.name)}].token`);
  record.information=await request('job-information',{job:record.token});await save();
  assert.equal(record.information.state,':returned',phase+' failed; original helper preserved');
  if(expected!==null)assert.deepEqual(record.information.values,expected);
  await request('release-job',{job:record.token});record.released=true;await save();return record;
}
async function startListener(source){
  const job={phase:'target',source};evidence.jobs.push(job);await save();
  const previous=await evaluate('state.inputHistory.map(row=>row.name)');await enter(source);
  const query=`state.inputHistory.find(row=>row.source===${q(source)}&&!${q(previous)}.includes(row.name))`;
  await wait(query,60);job.name=await evaluate(query+'.name');job.token=await evaluate(`state.jobs[${q(job.name)}].token`);await save();
  await wait(`views.get(${q(job.name)})?.info.stops?.length===1&&!busy`);
  job.stop=await evaluate(`views.get(${q(job.name)}).info.stops[0]`);await save();return job;
}
async function command(stop,source){
  const receipt={stop,id:(await request('information',{stop}))['next-command-id'],source};evidence.commands.push(receipt);await save();
  await enter(source);await wait(`state.commands.some(command=>same(command.stop,${q(stop)})&&command.id===${receipt.id})&&!busy`);return receipt;
}
async function result(receipt,state=':returned'){
  await wait(`${resultQuery(receipt)}?.state===${q(state)}&&!busy`);
  const value=await evaluate(resultQuery(receipt));assert(Number.isSafeInteger(value.generation));return value;
}
async function live(job,generation,functionName,condition){
  await wait(`same(selectedStop,${q(job.stop)})&&!nextStopInspection(selectedStop)&&!busy`);
  const view=await evaluate(`(()=>{const row=stops.find(row=>same(row.token,${q(job.stop)}));const frame=returnedFrameInspection();return {
    info:row.info,frame,functionText:document.querySelector('#stop-detail .current-function')?.textContent,
    basic:['frames','restarts','condition'].map(name=>{const row=returnedInspection(name);return row&&{name,value:commandResults.get(commandKey(row.command))}}),
    frameResult:frame&&commandResults.get(commandKey(frame.command))}})()`);
  assert.equal(view.info.state,':stopped');assert.equal(view.info.generation,generation);
  assert.equal(view.frame.result.index,view.info['current-frame']);assert(view.functionText.includes(functionName));
  assert.equal(view.frameResult.generation,generation);
  for(const row of view.basic){assert(row?.value);assert.equal(row.value.generation,generation);}
  const text=view.basic.find(row=>row.name==='condition').value.result;
  if(condition===null)assert(text.includes('Instruction breakpoint at'));else assert.equal(text,condition);
  const listener=await request('listener-information'),info=await request('job-information',{job:job.token});
  assert.equal(listener['active-job'],job.name);assert.deepEqual(listener.debugger.stop,job.stop);
  assert(info.stops.some(stop=>q(stop)===q(job.stop)));return view;
}
async function instruction(job,generation,functionName,offset){
  const receipt=await command(job.stop,':Show Instruction'),value=await result(receipt);
  assert.equal(value.generation,generation);assert(value.result.includes(functionName));
  assert(value.result.includes('at byte offset #x'+offset.toString(16).toUpperCase()+' '));
  assert(await evaluate(`[...document.querySelectorAll('.instruction-result')].some(node=>node.textContent===${q(value.result)})`));return value;
}
try {
  await browser.send('Network.enable');await browser.send('Page.navigate',{url:config.endpoint});
  await wait("document.readyState==='complete'&&typeof connected!=='undefined'");await ready();
  evidence.session=await evaluate('state.session');evidence.baseline=await baseline();
  assert.equal(await evaluate('selectedStop'),null);
  for(const test of cases){
    const name='*WEB-SAR64-'+randomBytes(8).toString('hex').toUpperCase()+'*';
    const entry={...test,name};evidence.cases.push(entry);const source=forms(test,name);
    entry.preparation=await ownedEvaluation(test.label+' prepare',source.prepare,null);
    const metadata=entry.preparation.information.values;assert.equal(metadata.length,3);
    assert(metadata.slice(0,2).every(value=>/^\d+$/.test(value)));
    entry.offset=Number(metadata[0]);entry.next=Number(metadata[1]);entry.functionName=JSON.parse(metadata[2]);
    assert(Number.isSafeInteger(entry.offset)&&Number.isSafeInteger(entry.next)&&entry.offset>=16&&entry.next>=16);
    assert.equal(typeof entry.functionName,'string');assert(entry.functionName.length);
    const job=await startListener(source.run);entry.job=job;
    const before=await request('information',{stop:job.stop});entry.before=await live(job,before.generation,entry.functionName,null);
    assert(!config.protectedStopIds.includes(before.id));
    entry.initialInstruction=await instruction(job,before.generation,entry.functionName,entry.offset);
    assert.match(entry.initialInstruction.result,/\bSAR64\s/i);
    await ownedEvaluation(test.label+' initial context and owned point removal',forms(test,name,entry.initialInstruction.result,before.id).releaseEntry);
    entry.step=await command(job.stop,':Single Step');entry.stepResult=await result(entry.step,':unwound');
    assert.equal(entry.stepResult.generation,before.generation);
    await wait(`(async()=>{const info=await api('information',{stop:${q(job.stop)}});return info.state===':stopped'&&info.generation===${before.generation+1}})()`);
    entry.after=await live(job,before.generation+1,entry.functionName,'Single step.');
    entry.instruction=await instruction(job,before.generation+1,entry.functionName,entry.next);
    await ownedEvaluation(test.label+' exact stepped native context',forms(test,name,entry.instruction.result,before.id).checkStopped);
    entry.historyBeforeReplay=await evaluate('state.inputHistory');
    entry.commandsBeforeReplay=await evaluate('state.commands');
    const next=(await request('information',{stop:job.stop}))['next-command-id'];
    assert.equal(await request('submit',{stop:job.stop,id:entry.step.id,command:'single-step',argument:null}),entry.step.id);
    assert.deepEqual(await request('result',{stop:job.stop,id:entry.step.id}),entry.stepResult);
    const replay=await request('information',{stop:job.stop});assert.equal(replay.generation,before.generation+1);assert.equal(replay['next-command-id'],next);
    assert.deepEqual(await evaluate('state.inputHistory'),entry.historyBeforeReplay);
    assert.deepEqual(await evaluate('state.commands'),entry.commandsBeforeReplay);
    assert(await evaluate(`[...document.querySelectorAll('.instruction-result')].some(node=>node.textContent===${q(entry.initialInstruction.result)})`));
    const transcript=`[...document.querySelectorAll('#stop-detail [data-command-id]')].filter(node=>Number(node.dataset.commandId)===${entry.step.id}).map(node=>node.textContent)`;
    await wait(`${transcript}.some(text=>text.includes(':Single Step')&&text.includes('unwound'))&&!busy`);
    entry.transcript=await evaluate(transcript);await browser.screenshot(output+'/'+test.label+'.png');await save();
    entry.proceed=await command(job.stop,':Proceed');await result(entry.proceed,':unwound');
    await wait(`views.get(${q(job.name)})?.info.state!==':running'&&!busy`);
    job.information=await request('job-information',{job:job.token});assert.equal(job.information.state,':returned');
    assert.deepEqual(job.information.values,['#('+test.finalMarker+')',':CALLER']);
    assert.equal((await request('information',{stop:job.stop})).state,':closed');
    await request('release-stop',{stop:job.stop});entry.stopReleased=true;
    await request('release-job',{job:job.token});job.released=true;
    await ownedEvaluation(test.label+' values and fixture cleanup',source.finish);entry.cleaned=true;
    assert.deepEqual(await baseline(),evidence.baseline);await save();console.log('PASS '+test.label);
  }
  assert.deepEqual(await baseline(),evidence.baseline);
  await browser.click('#package-label');
  await browser.click('#release-session');
  await browser.waitFor('!busy && !connected && state.session === null');
  evidence.cleaned=true;assert.deepEqual(browser.errors,[]);await guards('final');
}catch(error){
  primaryError=error;evidence.failure=error.stack;evidence.preservedForDiagnosis=true;
  for(const [phase,operation] of [
    ['failure-save',save],['failure-state',async()=>{evidence.state=await evaluate('state');}],
    ['failure-capture',()=>browser.screenshot(output+'/failure.png')]
  ]){
    try{await operation();}catch(secondary){(evidence.finalizationFailures??=[]).push({phase,error:secondary.stack});}
  }
}finally{
  evidence.errors=browser.errors;
  for(const [phase,operation] of [['final-save',save],['browser-close',()=>browser.close()]]){
    try{await operation();}catch(error){(evidence.finalizationFailures??=[]).push({phase,error:error.stack});primaryError??=error;}
  }
}
evidence.passed=!primaryError&&!evidence.finalizationFailures?.length;
try{await save();}catch(error){primaryError??=error;}
if(primaryError)throw primaryError;
assert.equal(evidence.passed,true,'Capture or finalization failed');
console.log('PASS two SAR64 Listener Single Step cases; all owned state released');
