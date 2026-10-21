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
  window.fixture=saved?JSON.parse(saved):{generation:0,state:':stopped',results:[],calls:[],steps:0,mode:'paused',holdCondition:true,ordinary:true};
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
    fixture.calls.push({operation,...args,time:performance.now()});if(fixture.holdCondition&&fixture.calls.length>50)throw Error('Unbounded pending-inspection requests');store();let value;
    if(['open-session','resume-session'].includes(operation))value={};
    else if(operation==='monitor-state')value={listener:{package:'CL-USER',prompt:'Command: ',
      herald:{title:'Listener viewport fixture',facts:[],help:[],'detailed-p':true,
        systems:Array.from({length:220},(_,index)=>({name:'viewport-system-'+index,version:null}))},
      debugger:fixture.ordinary?null:{stop:token(session),...information()}},jobs:[],
      stops:fixture.ordinary?[]:[{token:token(session),information:information()}]};
    else if(operation==='information')value=information();
    else if(operation==='result') {
      if(fixture.holdHistory&&fixture.results[args.id]?.operation===':inspect') {
        await new Promise(resolve=>{window.releaseHeldHistory=resolve;});
        fixture.holdHistory=false;store();
      }
      value=fixture.results[args.id];
    }
    else if(operation==='document-query'&&args.action==='catalog')value={title:'All Documents',topics:[],
      'search-options':{adjacent:null,mode:':substring',modes:[{label:'Exact',value:':exact'},{label:'Initial',value:':initial'},{label:'Substring',value:':substring'}]}};
    else if(operation==='listener-assistance') {
      const text=args.source.trim();
      if(args.action==='parse') {
        const name={':Single Step':'single-step',':Inspect':'inspect'}[text]??(!text.startsWith(':')?'evaluate':null);
        if(!name)throw Error('Unexpected fixture command '+text);
        value={operation:name,argument:name==='evaluate'?text:null,'complete-p':true};
      } else value={text:args.source,cursor:args.cursor};
    } else if(operation==='submit') {
      if(fixture.rejectNext){fixture.rejectNext=false;store();return new Response(JSON.stringify({error:':stop-busy',uncertain:false}),{status:409});}
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
      else if(name==='condition'){result='Condition-'+generation;if(fixture.holdCondition)state=':running';}
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
const snapshot=()=>browser.evaluate(`({info:stops[0]?.info,frame:returnedFrameInspection(),condition:returnedResult('condition'),
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
async function editorViewport(label) {
  const viewport=await browser.evaluate(`(()=>{const p=$('page'),page=p.getBoundingClientRect(),editor=$('source').getBoundingClientRect();return {scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,pageTop:page.top,pageBottom:page.bottom,editorTop:editor.top,editorBottom:editor.bottom,activeElement:document.activeElement.id||document.activeElement.tagName,disabled:$('source').disabled}})()`);
  assert(viewport.editorTop>=viewport.pageTop&&viewport.editorBottom<=viewport.pageBottom,label+': '+JSON.stringify(viewport));
  await browser.screenshot(output+'/'+label+'.png');
  return viewport;
}
const evidence={fixtureOnly:true,guestRequests:0,cases:[]};
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+fixtureBootstrap.toString()+')()'});
  await browser.send('Page.navigate',{url});
  await browser.waitFor("typeof fixture!=='undefined' && typeof connected!=='undefined' && connected && !busy");
  const initialViewport=await browser.evaluate("({scrollTop:$('page').scrollTop,height:$('page').clientHeight,heraldHeight:document.querySelector('#herald .herald').getBoundingClientRect().height,ordinary:fixture.ordinary})");
  assert.equal(initialViewport.ordinary,true);assert.equal(initialViewport.scrollTop,0);
  assert(initialViewport.heraldHeight>initialViewport.height,'Fixture herald must exceed the viewport');
  evidence.initialViewport=initialViewport;
  await browser.screenshot(output+'/initial-herald.png');
  await browser.evaluate("fixture.ordinary=false;void run(refresh)");
  await browser.waitFor("typeof fixture!=='undefined' && fixture.results.some(row=>row.operation===':condition' && row.state===':running') && !busy");
  const pendingStart=await browser.evaluate("({time:performance.now(),calls:fixture.calls.length})");
  await browser.evaluate("void run(()=>{fixture.queuedAction='completed'})");
  await browser.waitFor("fixture.queuedAction==='completed' && performance.now()-"+pendingStart.time+">=3500 && !busy");
  const pendingEnd=await browser.evaluate("({time:performance.now(),calls:fixture.calls,results:fixture.results})");
  const pendingPolls=pendingEnd.calls.slice(pendingStart.calls).filter(row=>row.operation==='monitor-state').length;
  assert(pendingPolls>=2&&pendingPolls<=3,'Pending inspection must retain ordinary timed polling');
  assert.equal(pendingEnd.calls.filter(row=>row.operation==='submit'&&row.command==='condition').length,1);
  assert.equal(pendingEnd.calls.filter(row=>row.operation==='submit'&&row.command==='current-frame').length,0);
  const initialSubmits=pendingEnd.calls.filter(row=>row.operation==='submit');
  assert.deepEqual(initialSubmits.map(row=>row.command),['frames','restarts','condition']);
  const initialSpacing=initialSubmits.slice(1).map((row,index)=>row.time-initialSubmits[index].time);
  assert(initialSpacing.every(milliseconds=>milliseconds<1000),'Terminal inspections waited for timer polling');
  evidence.inspectionQueue={pendingStart,pendingEnd,pendingPolls,initialSpacing};
  await browser.evaluate("fixture.results.find(row=>row.operation===':condition').state=':returned';fixture.holdCondition=false;void run(refresh)");
  await ready();
  assert.deepEqual(await browser.evaluate("fixture.calls.filter(row=>row.operation==='submit').map(row=>row.command)"),['frames','restarts','condition','current-frame']);
  await browser.evaluate("fixture.postTerminalOrder=[];void run(()=>{fixture.postTerminalOrder.push('first')});void run(()=>{fixture.postTerminalOrder.push('second')})");
  await browser.waitFor("fixture.postTerminalOrder.length===2&&!busy");
  evidence.postTerminalFifo=await browser.evaluate('fixture.postTerminalOrder');
  assert.deepEqual(evidence.postTerminalFifo,['first','second']);
  const messageDraft='(values :message-recovery)';
  await browser.evaluate(`fixture.rejectNext=true;setEditor($('source'),${q(messageDraft)},${messageDraft.length});void queueEvaluation()`);
  await ready();
  const rejectedMessage=await browser.evaluate(`({message:$('message').textContent,draft:$('source').value,next:fixture.results.length,record:state.pending.findLast(row=>row.status==='rejected')})`);
  assert.equal(rejectedMessage.message,':stop-busy');assert.equal(rejectedMessage.draft,messageDraft);
  assert.equal(rejectedMessage.record.error,':stop-busy');
  const messageWait=await browser.evaluate('performance.now()');
  await browser.waitFor(`performance.now()-${messageWait}>=1700&&!busy`);
  assert.equal(await browser.evaluate("$('message').textContent"),':stop-busy');
  assert.equal(await browser.evaluate('fixture.results.length'),rejectedMessage.next);
  await browser.evaluate('void queueEvaluation()');await ready();
  assert.equal(await browser.evaluate("$('message').textContent"),'');
  assert.deepEqual(await browser.evaluate(`state.pending.find(row=>row.id===${q(rejectedMessage.record.id)})`),rejectedMessage.record);
  await browser.evaluate("report(new Error('Earlier failure'));void run(async()=>{report(new Error('Newer failure'))})");await ready();
  assert.equal(await browser.evaluate("$('message').textContent"),'Newer failure');
  await browser.evaluate("void run(async()=>{showActivity('examiner');report(new Error('Nested restore failure'))},{background:true})");await ready();
  assert.equal(await browser.evaluate("$('message').textContent"),'Nested restore failure');
  assert.deepEqual(await browser.evaluate("fixture.calls.filter(row=>row.operation==='document-query').map(row=>row.action)"),['catalog']);
  await browser.evaluate("showActivity('listener')");
  await browser.evaluate("void run(async()=>{throw new Error('Explicit failure')})");await ready();
  assert.equal(await browser.evaluate("$('message').textContent"),'Explicit failure');
  await browser.evaluate("message('Informational notice')");
  await seedHistory();
  assert.equal(await browser.evaluate("$('message').textContent"),'Informational notice');
  evidence.messageLifetime={rejectedMessage,backgroundPreserved:true,successfulExplicitRecoveryCleared:true,requestHistoryPreserved:true,newerFailurePreserved:true,nestedActivityFailurePreserved:true,failingActionReported:true,informationalNoticePreserved:true};
  const before=await snapshot();evidence.before=before;
  assert.equal(before.frame.result.function,'FUNCTION-0');
  const draft='(values :preserved-draft)';
  await browser.evaluate(`setEditor($('source'),${q(draft)},${draft.length});$('source').setSelectionRange(2,7);storeEditorDraft($('source'))`);
  const stoppedOrigin=await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${stoppedOrigin} && typeof connected!=='undefined'`);await ready();
  assert.deepEqual(await browser.evaluate("[$('source').value,$('source').selectionStart,$('source').selectionEnd]"),[draft,2,7]);
  evidence.stoppedReloadViewport=await editorViewport('stopped-reloaded');
  await browser.evaluate("$('page').focus();$('page').scrollTop=0;void run(refresh)");await ready();
  assert.equal(await browser.evaluate("$('page').scrollTop"),0,'Unchanged stopped context must preserve history reading');
  await browser.click('#source');
  await browser.evaluate("$('source').setSelectionRange(2,7);storeEditorDraft($('source'))");
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
  evidence.steppingReloadViewport=await editorViewport('stepping-reloaded');
  await browser.evaluate("$('page').focus();$('page').scrollTop=0;void run(refresh)");await ready();
  assert.equal(await browser.evaluate("$('page').scrollTop"),0,'Unchanged stepping context must preserve history reading');
  await browser.evaluate("fixture.holdHistory=true;sessionStorage.setItem('single-step-fixture',JSON.stringify(fixture))");
  const historyOrigin=await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${historyOrigin} && typeof connected!=='undefined' && connected && typeof releaseHeldHistory==='function'`);
  await editorViewport('stepping-before-held-history');
  await browser.evaluate("$('page').focus();$('page').scrollTop=0;releaseHeldHistory()");await ready();
  assert.equal(await browser.evaluate("$('page').scrollTop"),0,'Historical insertion must preserve deliberate offscreen reading');
  evidence.historyReadingPreserved=true;
  await browser.screenshot(output+'/history-reading-recovered.png');
  await browser.evaluate("fixture.state=':stopped';void run(refresh)");await ready();
  await browser.click('#source');
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
  const escapedApiRequests=browser.network.filter(row=>row.method==='Network.requestWillBeSent'&&new URL(row.parameters.request.url).pathname==='/api');
  assert.deepEqual(escapedApiRequests,[]);evidence.apiRequestsSentOverHttp=escapedApiRequests.length;
  await writeFile(output+'/result.json',JSON.stringify({...evidence,errors:browser.errors},null,2)+'\n');
  console.log('PASS immediate/pending inspection queue, observed/missed Single Step transitions, stepping reload/association, both editor drafts/cursors, generation-filtered live views, disabled historical Inspector references, transcript and exact-ID replay; fixture-only, zero guest requests');
} catch(error) {
  await writeFile(output+'/first-failure.json',JSON.stringify({error:error.stack,errors:browser.errors},null,2)+'\n');
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,snapshot:await snapshot(),errors:browser.errors},null,2)+'\n');
  throw error;
} finally {
  await browser.close();
  await writeFile(output+'/browser-process-events.json',JSON.stringify(browser.processEvents,null,2)+'\n');
}
