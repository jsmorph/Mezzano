import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2]??'http://127.0.0.1:8772/';
assert.equal(new URL(url).hostname,'127.0.0.1','This intercepted fixture only uses local static files');
const output=process.argv[3]??'/tmp/mezzano-single-step-fixtures';
await mkdir(output,{recursive:false});
const q=JSON.stringify;
function fixtureBootstrap() {
  const saved=sessionStorage.getItem('single-step-fixture');
  window.fixture=saved?JSON.parse(saved):{generation:0,state:':stopped',results:[],calls:[],steps:0,mode:'paused'};
  const store=()=>sessionStorage.setItem('single-step-fixture',JSON.stringify(fixture));
  const token=session=>[':stop',session,1];
  const information=()=>({id:1,state:fixture.state,generation:fixture.generation,thread:'Single Step fixture',
    'current-frame':0,'next-command-id':fixture.results.length,depth:1,prompt:'→ ',
    'evaluation-environment':':lexical','evaluation-prompt':'Eval (program): '});
  const frame=()=>({index:0,function:'FUNCTION-'+fixture.generation,
    locals:[{index:0,name:'MARKER','available-p':true,value:'VALUE-'+fixture.generation}]});
  const response=value=>new Response(JSON.stringify({value,diagnostics:[]}),{status:200});
  window.fetch=async(url,options)=>{
    if(url!=='/api')throw Error('Unexpected fixture fetch '+url);
    const {operation,arguments:args,session}=JSON.parse(options.body);
    fixture.calls.push({operation,...args});store();let value;
    if(['open-session','resume-session'].includes(operation))value={};
    else if(operation==='monitor-state')value={listener:{package:'CL-USER',prompt:'Command: ',debugger:{stop:token(session),...information()}},jobs:[],
      stops:[{token:token(session),information:information()}]};
    else if(operation==='information')value=information();
    else if(operation==='result')value=fixture.results[args.id];
    else if(operation==='listener-assistance') {
      const text=args.source.trim();
      if(args.action==='parse') {
        const name={':Single Step':'single-step',':Inspect':'inspect'}[text]??(!text.startsWith(':')?'evaluate':null);
        if(!name)throw Error('Unexpected fixture command '+text);
        value={operation:name,argument:name==='evaluate'?text:null,'complete-p':true};
      } else value={text:args.source,cursor:args.cursor};
    } else if(operation==='submit') {
      if(args.id<fixture.results.length) {
        const previous=fixture.results[args.id];
        if(previous.operation!==':'+args.command||previous.argument!==args.argument)throw Error('Conflicting fixture replay');
        return response(args.id);
      }
      if(args.id!==fixture.results.length||fixture.state!==':stopped')throw Error('Invalid fixture submission');
      const name=args.command;let result,state=':returned';const generation=fixture.generation;
      if(name==='single-step') {
        fixture.steps++;fixture.generation++;fixture.state=fixture.mode==='fast'?':stopped':':stepping';state=':unwound';result=null;
      } else if(name==='frames')result=[{function:frame().function,frame:[':frame',session,fixture.generation]}];
      else if(name==='condition')result='Condition-'+generation;
      else if(name==='restarts')result=[{index:0,name:'CONTINUE-'+generation,description:'Continue fixture','default-p':true}];
      else if(name==='current-frame')result=frame();
      else if(name==='evaluate')result=['HISTORY-'+generation];
      else if(name==='inspect')result={object:[':object',session,generation],title:'OBJECT-'+generation,type:'VECTOR',
        start:0,end:1,total:1,count:32,parts:[{label:'0','bound-p':true,value:'VALUE-'+generation,
          object:[':object',session,generation+100],part:[':part',session,generation]}]};
      else throw Error('Unexpected fixture operation '+name);
      fixture.results.push({operation:':'+name,argument:args.argument,generation,state,result,
        source:name==='evaluate'?args.argument:null,'current-boot-p':true});store();value=args.id;
    } else throw Error('Unexpected fixture request '+operation);
    return response(value);
  };
}
const browser=await openBrowser('about:blank');
const ready=()=>browser.waitFor("typeof connected!=='undefined' && connected && !busy && !nextHistoricalCommand() && (stops[0]?.info.state!==':stopped' || !nextStopInspection(stops[0].token))");
const snapshot=()=>browser.evaluate(`({info:stops[0].info,frame:returnedFrameInspection(),condition:returnedResult('condition'),
  editorDisabled:[$('source').disabled,$('debugger-command').disabled],
  transcript:[...document.querySelectorAll('.debugger-transcript')].map(node=>node.textContent),
  inspector:returnedInspections().map(record=>({id:record.command.id,current:record.currentGeneration})),
  fixture})`);
async function key(key,code,n,modifiers=0) {
  for(const type of ['keyDown','keyUp'])await browser.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:n,modifiers});
}
async function menuStep() {
  await browser.evaluate("document.querySelector('#system-menu').showModal()");
  await browser.evaluate("[...document.querySelectorAll('#debugger-menu button')].find(node=>node.textContent===':Single Step').click()");
  await ready();
}
async function seedHistory() {
  await browser.evaluate("void run(()=>debuggerCommand('(values :history)'))");await ready();
  await browser.evaluate("void run(()=>debuggerCommand(':Inspect'))");await ready();
}
const evidence={fixtureOnly:true,guestRequests:0,cases:[]};
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+fixtureBootstrap.toString()+')()'});
  await browser.send('Page.navigate',{url});await ready();
  await seedHistory();
  const before=await snapshot();evidence.before=before;
  assert.equal(before.frame.result.function,'FUNCTION-0');
  const draft='(values :preserved-draft)';
  await browser.evaluate(`setEditor($('source'),${q(draft)},${draft.length});$('source').setSelectionRange(2,7);storeEditorDraft($('source'))`);
  await menuStep();
  const paused=await snapshot();evidence.cases.push({name:'observed-listener',paused});
  assert.equal(paused.info.state,':stepping');assert.equal(paused.info.generation,1);
  assert.deepEqual(paused.editorDisabled,[true,true]);assert.equal(paused.frame,null);assert.equal(paused.condition,null);
  assert(await browser.evaluate("[...document.querySelectorAll('.inspector button')].every(node=>node.disabled)"));
  assert(await browser.evaluate("[...document.querySelectorAll('#debugger-menu button')].filter(node=>[':Single Step',':Return',':Show Frame'].includes(node.textContent)).every(node=>node.disabled)"));
  assert.equal(await browser.evaluate("document.querySelector('.single-step-result').textContent"),'unwound');
  assert.equal(await browser.evaluate("document.querySelector('.debugger-single-step .debugger-transcript').textContent"),'→ :Single Step');
  assert(await browser.evaluate("document.querySelector('.debugger-evaluation').textContent.includes('HISTORY-0')"));
  const next=paused.info['next-command-id'];
  const receipt=paused.fixture.results.findIndex(row=>row.operation===':single-step');
  const original=paused.fixture.results[receipt];
  await key('Enter','Enter',13);await key('x','KeyX',88,2);await key('i','KeyI',73);
  await browser.evaluate('queueEvaluation();queueDebuggerCommand();void run(refresh)');await ready();
  assert.equal((await snapshot()).info['next-command-id'],next);
  assert.deepEqual(await browser.evaluate("[$('source').value,$('source').selectionStart,$('source').selectionEnd]"),[draft,2,7]);
  await browser.screenshot(output+'/observed-listener.png');
  const session=await browser.evaluate('state.session');
  const origin=await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${origin} && typeof connected!=='undefined'`);await ready();
  assert.equal(await browser.evaluate('state.session'),session);
  assert.deepEqual(await browser.evaluate("[$('source').value,$('source').selectionStart,$('source').selectionEnd]"),[draft,2,7]);
  assert.deepEqual((await snapshot()).editorDisabled,[true,true]);
  assert.deepEqual(await browser.evaluate("listenerDebugger.stop"),await browser.evaluate('selectedStop'));
  await browser.evaluate(`void run(()=>api('submit',{stop:stops[0].token,id:${receipt},command:'single-step',argument:null}))`);await ready();
  assert.deepEqual(await browser.evaluate(`fixture.results[${receipt}]`),original);
  assert.equal(await browser.evaluate('fixture.steps'),1);
  await browser.screenshot(output+'/stepping-reloaded.png');
  await browser.evaluate("fixture.state=':stopped';void run(refresh)");await ready();
  const resumed=await snapshot();evidence.resumed=resumed;
  assert.equal(resumed.frame.result.function,'FUNCTION-1');assert.equal(resumed.frame.result.locals[0].value,'VALUE-1');
  assert.equal(resumed.condition,'Condition-1');assert.deepEqual(resumed.editorDisabled,[false,false]);
  assert(await browser.evaluate("[...document.querySelectorAll('.inspection-pane button,.inspector-history button')].every(node=>node.disabled)"));
  assert(await browser.evaluate("document.querySelector('.inspector').textContent.includes('Recorded before this stop generation.')"));
  await seedHistory();
  await browser.evaluate("fixture.mode='fast'");
  const sampleStart=await browser.evaluate('fixture.calls.length');
  await menuStep();
  const fast=await snapshot();evidence.cases.push({name:'missed-transition',after:fast});
  assert.equal(fast.info.state,':stopped');assert.equal(fast.info.generation,2);
  assert.equal(fast.frame.result.function,'FUNCTION-2');assert.equal(fast.frame.result.locals[0].value,'VALUE-2');
  assert.equal(fast.condition,'Condition-2');assert.equal(fast.fixture.steps,2);
  assert.equal(fast.fixture.results.filter(row=>row.operation===':single-step')[1].generation,1);
  assert.equal(fast.fixture.calls.slice(sampleStart).filter(row=>row.operation==='submit'&&row.command==='single-step').length,1);
  await browser.screenshot(output+'/missed-transition.png');
  await browser.evaluate("showActivity('debugger');fixture.mode='paused';setEditor($('debugger-command'),'standalone draft',16);$('debugger-command').setSelectionRange(3,9);storeEditorDraft($('debugger-command'))");
  await menuStep();
  const standalone=await snapshot();evidence.cases.push({name:'observed-debugger',paused:standalone});
  assert.equal(standalone.info.state,':stepping');assert.deepEqual(standalone.editorDisabled,[true,true]);
  assert.equal(standalone.frame,null);assert.equal(standalone.condition,null);
  assert.deepEqual(await browser.evaluate("[$('debugger-command').value,$('debugger-command').selectionStart,$('debugger-command').selectionEnd]"),['standalone draft',3,9]);
  await browser.screenshot(output+'/observed-debugger.png');
  assert.deepEqual(browser.errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({...evidence,errors:browser.errors},null,2)+'\n');
  console.log('PASS observed/missed Single Step transitions, stepping reload/association, both editor drafts/cursors, generation-filtered live views, disabled historical Inspector references, transcript and exact-ID replay; fixture-only, zero guest requests');
} catch(error) {
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,snapshot:await snapshot(),errors:browser.errors},null,2)+'\n');
  throw error;
} finally {await browser.close();}
