import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('./app.js',import.meta.url),'utf8');
const end=source.indexOf('\ndocument.addEventListener("keydown", event =>');
assert(end>0);
const editors=new Map(['source','debugger-command'].map(id=>[id,{id,value:'preserved draft',selectionStart:2,selectionEnd:5}]));
const context=vm.createContext({sessionStorage:{getItem:()=>null},document:{getElementById:id=>editors.get(id)}});
vm.runInContext(source.slice(0,end),context);
const evaluate=code=>vm.runInContext(code,context);
const value=code=>JSON.parse(JSON.stringify(evaluate(code)));
evaluate(`
  const token=[':stop','test-session',1];
  stops=[{token,info:{state:':stopped',generation:0,'current-frame':0}}];
  selectedStop=token;
  listenerDebugger={stop:token};
  function add(command,result,generation=0,state_=':returned',currentBoot=true) {
    const record={stop:token,id:state.commands.length,command};
    state.commands.push(record);
    commandResults.set(commandKey(record),{state:state_,generation,'current-boot-p':currentBoot,result});
    return record;
  }
  add('frames',[{function:'OLD',frame:[':frame','test-session',1]}]);
  add('restarts',[{name:'OLD-RESTART'}]);
  add('condition','Old condition');
  add('current-frame',{index:0,function:'OLD',locals:[{name:'MARKER',value:'11'}]});
  add('inspect',{object:[':object','test-session',1],title:'Old object'});
  add('evaluate',['Old transcript']);
`);
assert.equal(evaluate('nextStopInspection(token)'),null);
assert.equal(evaluate('returnedFrameInspection().result.locals[0].value'),'11');

evaluate("add('single-step',null,0,':unwound');stops[0].info.generation=1;stops[0].info.state=':stepping'");
for(const name of ['frames','restarts','condition'])assert.equal(evaluate(`returnedResult('${name}')`),null);
assert.equal(evaluate('returnedFrameInspection()'),null);
assert.equal(evaluate('returnedInspections()[0].currentGeneration'),false);
assert.equal(evaluate('state.commands.length'),7);
assert.deepEqual(value("commandResults.get(commandKey(state.commands[5])).result"),['Old transcript']);
for(const activity of ['listener','debugger']) {
  evaluate(`activity='${activity}'`);
  for(const editor of editors.values())assert.equal(evaluate(`editorBlocked($('${editor.id}'))`),true);
}
let prevented=0;
context.event={preventDefault:()=>prevented++,key:'Enter'};
evaluate("let queuedActions=0;run=()=>{queuedActions++};queueEvaluation();queueDebuggerInput($('debugger-command'),'input',token)");
for(const key of ['Enter','F10','Tab','x','i']) {
  context.event.key=key;
  evaluate("editorKey($('source'),event);editorKey($('debugger-command'),event)");
}
assert.equal(prevented,10);
assert.equal(evaluate('queuedActions'),0);
for(const editor of editors.values())assert.deepEqual([editor.value,editor.selectionStart,editor.selectionEnd],['preserved draft',2,5]);
assert.throws(()=>evaluate('recallInput(0)'),/stepping/);
evaluate('api=async()=>stops[0].info;mutate=()=>{queuedActions++}');
await assert.rejects(evaluate("submit(token,'single-step')"),/stepping/);
assert.equal(evaluate('queuedActions'),0);

evaluate("stops[0].info.state=':stopped'");
assert.equal(evaluate('nextStopInspection(token)'),'frames');
assert.equal(evaluate('returnedFrameInspection()'),null,'A missed stepping monitor sample must not restore old locals at the same frame index');
for(const [name,result] of [['frames',[{function:'NEW'}]],['restarts',[{name:'NEW-RESTART'}]],['condition','New condition']]) {
  assert.equal(evaluate('nextStopInspection(token)'),name);
  evaluate(`add(${JSON.stringify(name)},${JSON.stringify(result)},1)`);
}
assert.equal(evaluate('nextStopInspection(token)'),'current-frame');
evaluate("add('current-frame',{index:0,function:'NEW',locals:[{name:'MARKER',value:'42'}]},1)");
assert.equal(evaluate('nextStopInspection(token)'),null);
assert.equal(evaluate('returnedFrameInspection().result.function'),'NEW');
assert.equal(evaluate('returnedFrameInspection().result.locals[0].value'),'42');
assert.equal(evaluate("returnedResult('condition')"),'New condition');
assert.equal(evaluate('returnedInspections()[0].currentGeneration'),false);
evaluate("add('inspect',{object:[':object','test-session',2],title:'New object'},1)");
assert.deepEqual(value('returnedInspections().map(record=>record.currentGeneration)'),[false,true]);
assert.equal(evaluate("commandResults.get(commandKey(state.commands[6])).generation"),0,'Step acceptance generation must remain historical');

evaluate("stops[0].info.generation=2;add('frames',null,2,':unwound')");
assert.equal(evaluate('nextStopInspection(token)'),'restarts','An unwound current-generation printer must not be resubmitted');
evaluate("const missingGeneration=add('condition','Missing generation');delete commandResults.get(commandKey(missingGeneration)).generation");
assert.equal(evaluate("returnedResult('condition')"),null,'Missing generation cannot qualify as a live result');
evaluate("add('condition','Prior boot',2,':returned',null)");
assert.equal(evaluate("returnedResult('condition')"),null);
evaluate("stops[0].info.state=':closed'");
assert.equal(evaluate('returnedFrameInspection().result.function'),'NEW','Closed-stop frame history remains descriptive');
console.log('PASS observed/missed generation transitions, same-index caller locals, stale Inspector references, old transcripts, stepping input preservation, printer suppression, and closed history; no browser or guest requests');
