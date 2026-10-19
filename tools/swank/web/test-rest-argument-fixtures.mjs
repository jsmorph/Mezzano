import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2]??'http://127.0.0.1:8787/';
assert.equal(new URL(url).hostname,'127.0.0.1','This intercepted test requires local static files');
const output=process.argv[3]??'/tmp/mezzano-frame-argument-fixtures';
await mkdir(output,{recursive:false});
process.on('exit',code=>writeFileSync(output+'/node-exit.json',JSON.stringify({pid:process.pid,ppid:process.ppid,code})+'\n'));
const evidence={fixtureOnly:true,guestRequests:0,checks:[]};
function bootstrap() {
  const session='a'.repeat(64),stop=[':stop',session,1];
  window.fixture=JSON.parse(sessionStorage.getItem('rest-argument-fixture')||'null')||{
    records:[],calls:[],executions:0,replays:0,state:':stopped',dropNext:false,index:1,omitArguments:false,
    frameArguments:'Original positions: 0 = <a> & λ\nCurrent parameters: REST [rest] = NIL\n<img src=x onerror=window.argumentMarkupExecuted=true>',
    text:'Rest argument REST = (1 "two" λ).'};
  const store=()=>sessionStorage.setItem('rest-argument-fixture',JSON.stringify(fixture));
  const information=()=>({id:1,state:fixture.state,generation:0,thread:'Rest argument fixture',
    depth:1,prompt:'→ ','current-frame':fixture.state===':closed'?null:fixture.index,
    'next-command-id':fixture.records.length,'evaluation-environment':':lexical','evaluation-prompt':'Eval (program): '});
  const values={frames:[{function:'SERVICE',frame:[':frame',session,0]},{function:'REST-TARGET',frame:[':frame',session,1]}],
    restarts:[{index:0,name:'CONTINUE',description:'Continue fixture','default-p':true}],
    condition:'Rest argument fixture condition.',
    'current-frame':null};
  const frame=()=>({index:fixture.index,function:fixture.index===1?'REST-TARGET':'SERVICE',
    arguments:fixture.frameArguments,locals:[{index:0,name:'A','available-p':true,value:'<local & λ>'},{index:1,name:'B','available-p':true,value:'NIL'}]});
  const checkStop=args=>{if(JSON.stringify(args.stop)!==JSON.stringify(stop))throw Error('Unknown fixture stop');};
  window.fetch=async(path,options)=>{
    if(path!=='/api')throw Error('Unexpected fixture URL '+path);
    const request=JSON.parse(options.body),{operation,arguments:args}=request;
    if(request.session!==session)throw Error('Unknown fixture session');
    fixture.calls.push({operation,...args});store();let result;
    if(['open-session','resume-session'].includes(operation))result={};
    else if(operation==='monitor-state')result={listener:{package:'CL-USER',prompt:'Command: ',
      ...(fixture.state===':closed'?{}:{debugger:{stop,depth:1,prompt:'→ '}})},
      jobs:[],stops:[{token:stop,information:information()}]};
    else if(operation==='information'){checkStop(args);result=information();}
    else if(operation==='result'){
      checkStop(args);if(!Number.isSafeInteger(args.id)||!fixture.records[args.id])throw Error('Unknown fixture command');
      result=fixture.records[args.id];
      if(fixture.omitArguments&&[':current-frame',':select-frame',':next-frame'].includes(result.operation)){
        const {arguments:omitted,...historical}=result.result;result={...result,result:historical};
      }
    }else if(operation==='listener-assistance'){
      if(args.context!=='debugger')throw Error('Unexpected assistance context');
      if(args.action==='parse'){
        if(args.cursor!==Array.from(args.source).length)throw Error('Unexpected parser cursor');
        const plans={':Show Rest Argument':{operation:'rest-argument',argument:null},
          ':Show Frame':{operation:'current-frame',argument:null,display:':frame'},
          ':Show Local All':{operation:'current-frame',argument:null,display:':locals'},
          ':Show Local 1':{operation:'current-frame',argument:null,display:':locals','local-index':1},
          ':Set Current Frame 0':{operation:'select-frame',argument:0,display:':frame'},
          ':Next Frame':{operation:'next-frame',argument:1,display:':frame'}};
        if(!plans[args.source])throw Error('Unexpected fixture source '+args.source);
        result={...plans[args.source],'complete-p':true};
      }else if(args.action==='inspect')result={text:args.source,cursor:args.cursor};
      else throw Error('Unexpected fixture assistance action');
    }else if(operation==='submit'){
      checkStop(args);
      const operand=args.command==='select-frame'?0:args.command==='next-frame'?1:null;
      if(args.argument!==operand||!Number.isSafeInteger(args.id)||args.id<0)throw Error('Malformed fixture submission');
      if(args.id<fixture.records.length){
        const previous=fixture.records[args.id];
        if(previous.operation!==':'+args.command)throw Error('Conflicting fixture replay');
        fixture.replays++;store();return new Response(JSON.stringify({value:args.id,diagnostics:[]}),{status:200});
      }
      if(args.id!==fixture.records.length||fixture.state!==':stopped')throw Error('Invalid fixture next ID/state');
      if(args.command==='select-frame')fixture.index=args.argument;
      if(args.command==='next-frame')fixture.index+=args.argument;
      if(fixture.index<0||fixture.index>1)throw Error('Invalid fixture selected frame');
      const text=args.command==='rest-argument'?fixture.text:['current-frame','select-frame','next-frame'].includes(args.command)?frame():values[args.command];
      if(text===undefined)throw Error('Unexpected fixture submit '+args.command);
      fixture.records.push({operation:':'+args.command,generation:0,state:':returned',source:null,
        result:text,'current-boot-p':true,'input-length':0,'input-eof-p':null,'input-waiting-p':null,'output-length':0});
      if(args.command==='rest-argument')fixture.executions++;
      result=args.id;
      if(args.command==='rest-argument'&&fixture.dropNext){fixture.dropNext=false;store();throw Error('Fixture discards accepted rest-argument reply');}
    }else throw Error('Unexpected fixture operation '+operation);
    store();return new Response(JSON.stringify({value:result,diagnostics:[]}),{status:200});
  };
  sessionStorage.setItem('mezzano-monitor-v1',sessionStorage.getItem('mezzano-monitor-v1')||JSON.stringify({session,attempted:true,commands:[]}));
}
const browser=await openBrowser('about:blank');
const ready=()=>browser.waitFor("typeof connected!=='undefined'&&connected&&!busy&&!nextHistoricalCommand()&&(!selectedStop||stops.find(row=>same(row.token,selectedStop))?.info.state!==':stopped'||!nextStopInspection(selectedStop))");
const rendered=()=>browser.evaluate("[...document.querySelectorAll('.debugger-rest-argument')].map(node=>({id:Number(node.dataset.commandId),caption:node.querySelector('.debugger-transcript').textContent,text:node.querySelector('.rest-argument-result').textContent}))");
async function enter(selector,source=':Show Rest Argument') {
  await browser.evaluate(`(()=>{const editor=document.querySelector(${JSON.stringify(selector)});if(!editor.getClientRects().length||editor.disabled)throw Error('Fixture editor is not visible/enabled');setEditor(editor,${JSON.stringify(source)},${source.length});editor.focus()})()`);
  for(const type of ['keyDown','keyUp'])await browser.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
}
try {
  await browser.send('Network.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+bootstrap.toString()+')()'});
  await browser.send('Page.navigate',{url});await ready();
  assert.equal(await browser.evaluate('activity'),'listener');
  assert.equal(await browser.evaluate('stops[0].info["current-frame"]'),1);
  const expected=await browser.evaluate('fixture.text');
  assert.equal(await browser.evaluate("document.querySelector('.frame-arguments')"),null,'Automatic inspection has no full-frame display metadata');
  await enter('#source');await ready();
  let rows=await rendered();assert.equal(rows.length,1);assert.equal(rows[0].caption,'→ :Show Rest Argument');assert.equal(rows[0].text,expected);
  evidence.checks.push('Typed Listener parser plan submits rest-argument with null operand and renders the exact formatted string.');
  await browser.evaluate("document.querySelector('#system-menu').showModal();document.querySelector('[data-activity=debugger]').click()");await ready();
  await browser.evaluate("fixture.dropNext=true;document.querySelector('#system-menu').showModal();[...document.querySelectorAll('#debugger-menu button')].find(node=>node.textContent===':Show Rest Argument').click()");
  await browser.waitFor("!connected&&!busy&&state.pending.some(row=>row.operation==='submit'&&row.status==='outcome unknown')");
  evidence.uncertain=await browser.evaluate("state.pending.find(row=>row.operation==='submit'&&row.status==='outcome unknown')");
  assert.equal(evidence.uncertain.arguments.command,'rest-argument');assert.equal(evidence.uncertain.arguments.argument,null);
  const acceptedId=evidence.uncertain.arguments.id;
  assert.equal(await browser.evaluate('fixture.executions'),2);
  await browser.send('Page.reload');await ready();
  rows=await rendered();assert.equal(rows.length,2);assert(rows.every(row=>row.caption==='→ :Show Rest Argument'&&row.text===expected));
  evidence.recovered=await browser.evaluate(`state.commands.find(row=>row.id===${acceptedId})`);
  assert.equal(evidence.recovered.command,'rest-argument');assert.equal(evidence.recovered.source,undefined);
  assert.equal(await browser.evaluate('fixture.executions'),2);
  await browser.evaluate("[...document.querySelectorAll('#pending button')].find(node=>node.textContent==='Repeat Original Request').click()");await ready();
  assert.equal(await browser.evaluate('fixture.executions'),2);assert.equal(await browser.evaluate('fixture.replays'),1);
  assert.equal(await browser.evaluate("state.pending.length"),0);
  const sameIdCalls=await browser.evaluate(`fixture.calls.filter(row=>row.operation==='submit'&&row.id===${acceptedId})`);
  assert.equal(sameIdCalls.length,2);assert.deepEqual(sameIdCalls[0],sameIdCalls[1]);
  evidence.checks.push('Menu uses the same parser. Discarded accepted reply recovers its operation/canonical caption, then exact-ID replay preserves one execution.');
  await browser.evaluate("document.querySelector('#system-menu').showModal();document.querySelector('[data-activity=debugger]').click()");await ready();
  await enter('#debugger-command');await ready();
  assert.equal(await browser.evaluate('fixture.executions'),3);
  assert.equal((await rendered()).length,3);
  assert.equal(await browser.evaluate('stops[0].info["current-frame"]'),1);
  const guestTexts=['Rest argument REST = NIL.','This frame has no &REST parameter.',
    'Rest argument unavailable: :UNAVAILABLE-FRAME.','Rest argument REST is unavailable.'];
  for(const text of guestTexts){
    await browser.evaluate(`fixture.text=${JSON.stringify(text)}`);await enter('#debugger-command');await ready();
    assert.equal((await rendered()).at(-1).text,text);
  }
  const expectedTexts=[expected,expected,expected,...guestTexts];
  evidence.checks.push('NIL, absent parameter, unavailable frame and unavailable storage remain opaque formatted guest text.');
  const argumentText=await browser.evaluate('fixture.frameArguments');
  const frameSnapshot=()=>browser.evaluate("({arguments:document.querySelector('.frame-arguments')?.textContent??null,locals:[...document.querySelectorAll('.locals tr')].map(node=>node.textContent),selected:stops[0].info['current-frame'],generation:stops[0].info.generation,tagCount:document.querySelector('.frame-arguments')?.childElementCount??0,executedMarkup:window.argumentMarkupExecuted===true})");
  const frameCallsStart=await browser.evaluate('fixture.calls.length');
  await enter('#debugger-command',':Show Frame');await ready();
  const full=await frameSnapshot();assert.equal(full.arguments,argumentText);assert.equal(full.tagCount,0);assert.equal(full.executedMarkup,false);assert.equal(full.locals.length,2);assert.equal(full.selected,1);assert.equal(full.generation,0);
  await browser.evaluate("document.querySelector('.frame-arguments').scrollIntoView({block:'start'})");await browser.screenshot(output+'/frame-arguments.png');
  await enter('#debugger-command',':Show Local 1');await ready();
  const oneLocal=await frameSnapshot();assert.equal(oneLocal.arguments,null);assert.deepEqual(oneLocal.locals,['Local 1 (B):NIL']);assert.equal(oneLocal.selected,1);
  await enter('#debugger-command',':Show Local All');await ready();
  const allLocals=await frameSnapshot();assert.equal(allLocals.arguments,null);assert.equal(allLocals.locals.length,2);assert.equal(allLocals.selected,1);
  await browser.evaluate("document.querySelector('#stop-detail .frame').click()");await ready();
  const selected=await frameSnapshot();assert.equal(selected.selected,0);assert.equal(selected.arguments,argumentText);
  await enter('#debugger-command',':Next Frame');await ready();
  const navigated=await frameSnapshot();assert.equal(navigated.selected,1);assert.equal(navigated.arguments,argumentText);assert.equal(navigated.generation,0);
  const frameCalls=await browser.evaluate(`fixture.calls.slice(${frameCallsStart}).filter(row=>row.operation==='submit')`);
  assert.deepEqual(frameCalls.map(row=>[row.command,row.argument]),[['current-frame',null],['current-frame',null],['current-frame',null],['select-frame',0],['next-frame',1]],'Frame arguments must not request separate data or inspections');
  const submissionsBeforeReload=await browser.evaluate("fixture.calls.filter(row=>row.operation==='submit').length");
  await browser.send('Page.reload');await ready();
  const reloaded=await frameSnapshot();assert.equal(reloaded.arguments,argumentText);assert.equal(reloaded.selected,1);assert.equal(reloaded.locals.length,2);
  assert.equal(await browser.evaluate("fixture.calls.filter(row=>row.operation==='submit').length"),submissionsBeforeReload);
  evidence.frameArguments={full,oneLocal,allLocals,selected,navigated,reloaded,frameCalls,submissionsBeforeReload};
  evidence.checks.push('Opaque Unicode/angle-bracket frame text, local-only filtering, selection/navigation and reload use the existing frame result only.');
  await browser.screenshot(output+'/rest-argument.png');
  await browser.evaluate("fixture.state=':closed';fixture.records.forEach(row=>row['current-boot-p']=false);sessionStorage.setItem('rest-argument-fixture',JSON.stringify(fixture))");
  await browser.send('Page.reload');await ready();
  await browser.evaluate("document.querySelector('#system-menu').showModal();document.querySelector('[data-activity=debugger]').click()");await ready();
  await browser.evaluate("[...document.querySelectorAll('#stops button')].find(node=>node.textContent.startsWith('Stop 1  ')).click()");await ready();
  rows=await rendered();assert.deepEqual(rows.map(row=>row.text),expectedTexts);assert(rows.every(row=>row.caption==='→ :Show Rest Argument'));
  assert.equal(await browser.evaluate("document.querySelectorAll('.debugger-rest-argument .historical-command').length"),7);
  assert.equal(await browser.evaluate('fixture.executions'),7);
  assert.equal(await browser.evaluate("document.querySelector('#debugger-command').disabled"),true);
  evidence.checks.push('Standalone typed input, reload, closed-stop text and prior-boot labels retain all seven results without another submission.');
  await browser.screenshot(output+'/rest-argument-recorded.png');
  const recorded=await frameSnapshot();assert.equal(recorded.arguments,argumentText);assert.equal(recorded.locals.length,2);
  await browser.evaluate("fixture.omitArguments=true;sessionStorage.setItem('rest-argument-fixture',JSON.stringify(fixture))");
  await browser.send('Page.reload');await ready();
  await browser.evaluate("document.querySelector('#system-menu').showModal();document.querySelector('[data-activity=debugger]').click()");await ready();
  await browser.evaluate("[...document.querySelectorAll('#stops button')].find(node=>node.textContent.startsWith('Stop 1  ')).click()");await ready();
  const historicalMissing=await frameSnapshot();assert.equal(historicalMissing.arguments,null);assert.equal(historicalMissing.locals.length,2);
  assert.equal(await browser.evaluate("document.querySelector('#stop-detail').textContent.includes('Original caller arguments are unavailable.')"),false);
  assert.equal(await browser.evaluate("fixture.calls.filter(row=>row.operation==='submit').length"),submissionsBeforeReload);
  evidence.frameArguments.recorded=recorded;evidence.frameArguments.historicalMissing=historicalMissing;
  evidence.checks.push('Recorded arguments survive closed reload; a historical response without the optional field preserves locals and invents no reason.');
  await browser.screenshot(output+'/historical-frame-without-arguments.png');
  evidence.fixture=await browser.evaluate('fixture');evidence.rendered=rows;
  assert.equal(evidence.fixture.calls.filter(row=>row.operation==='listener-assistance'&&row.action==='parse'&&row.source===':Show Rest Argument').length,7);
  assert.equal(evidence.fixture.calls.filter(row=>row.operation==='submit'&&row.command==='rest-argument').length,8);
  assert.deepEqual(browser.errors,[]);
  assert.equal(browser.network.filter(row=>row.method==='Network.requestWillBeSent'&&new URL(row.parameters.request.url).pathname==='/api').length,0);
  evidence.apiHttpRequests=0;evidence.errors=browser.errors;
  console.log('PASS frame argument text/full-local display, selection/navigation and recorded history; zero guest requests');
}catch(error){
  evidence.failure=error.stack;evidence.fixture=await browser.evaluate('fixture');evidence.errors=browser.errors;
  await browser.screenshot(output+'/failure.png');throw error;
}finally{
  await browser.close();evidence.browserProcessEvents=browser.processEvents;
  await writeFile(output+'/result.json',JSON.stringify(evidence,null,2)+'\n');
}
