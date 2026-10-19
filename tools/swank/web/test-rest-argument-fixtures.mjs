import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2]??'http://127.0.0.1:8786/';
assert.equal(new URL(url).hostname,'127.0.0.1','This intercepted test requires local static files');
const output=process.argv[3]??'/tmp/mezzano-rest-argument-fixtures';
await mkdir(output,{recursive:false});
process.on('exit',code=>writeFileSync(output+'/node-exit.json',JSON.stringify({pid:process.pid,ppid:process.ppid,code})+'\n'));
const evidence={fixtureOnly:true,guestRequests:0,checks:[]};
function bootstrap() {
  const session='a'.repeat(64),stop=[':stop',session,1];
  window.fixture=JSON.parse(sessionStorage.getItem('rest-argument-fixture')||'null')||{
    records:[],calls:[],executions:0,replays:0,state:':stopped',dropNext:false,
    text:'Rest argument REST = (1 "two" λ).'};
  const store=()=>sessionStorage.setItem('rest-argument-fixture',JSON.stringify(fixture));
  const information=()=>({id:1,state:fixture.state,generation:0,thread:'Rest argument fixture',
    depth:1,prompt:'→ ','current-frame':fixture.state===':closed'?null:1,
    'next-command-id':fixture.records.length,'evaluation-environment':':lexical','evaluation-prompt':'Eval (program): '});
  const values={frames:[{function:'SERVICE',frame:[':frame',session,0]},{function:'REST-TARGET',frame:[':frame',session,1]}],
    restarts:[{index:0,name:'CONTINUE',description:'Continue fixture','default-p':true}],
    condition:'Rest argument fixture condition.',
    'current-frame':{index:1,function:'REST-TARGET',locals:[]}};
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
    }else if(operation==='listener-assistance'){
      if(args.context!=='debugger')throw Error('Unexpected assistance context');
      if(args.action==='parse'){
        if(args.source!==':Show Rest Argument')throw Error('Unexpected fixture source '+args.source);
        if(args.cursor!==Array.from(args.source).length)throw Error('Unexpected parser cursor');
        result={operation:'rest-argument',argument:null,'complete-p':true};
      }else if(args.action==='inspect')result={text:args.source,cursor:args.cursor};
      else throw Error('Unexpected fixture assistance action');
    }else if(operation==='submit'){
      checkStop(args);
      if(args.argument!==null||!Number.isSafeInteger(args.id)||args.id<0)throw Error('Malformed fixture submission');
      if(args.id<fixture.records.length){
        const previous=fixture.records[args.id];
        if(previous.operation!==':'+args.command)throw Error('Conflicting fixture replay');
        fixture.replays++;store();return new Response(JSON.stringify({value:args.id,diagnostics:[]}),{status:200});
      }
      if(args.id!==fixture.records.length||fixture.state!==':stopped')throw Error('Invalid fixture next ID/state');
      const text=args.command==='rest-argument'?fixture.text:values[args.command];
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
async function enter(selector) {
  await browser.evaluate(`(()=>{const editor=document.querySelector(${JSON.stringify(selector)});setEditor(editor,':Show Rest Argument',19);editor.focus()})()`);
  for(const type of ['keyDown','keyUp'])await browser.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
}
try {
  await browser.send('Network.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+bootstrap.toString()+')()'});
  await browser.send('Page.navigate',{url});await ready();
  assert.equal(await browser.evaluate('activity'),'listener');
  assert.equal(await browser.evaluate('stops[0].info["current-frame"]'),1);
  const expected=await browser.evaluate('fixture.text');
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
  evidence.fixture=await browser.evaluate('fixture');evidence.rendered=rows;
  assert.equal(evidence.fixture.calls.filter(row=>row.operation==='listener-assistance'&&row.action==='parse').length,7);
  assert.equal(evidence.fixture.calls.filter(row=>row.operation==='submit'&&row.command==='rest-argument').length,8);
  assert.deepEqual(browser.errors,[]);
  assert.equal(browser.network.filter(row=>row.method==='Network.requestWillBeSent'&&new URL(row.parameters.request.url).pathname==='/api').length,0);
  evidence.apiHttpRequests=0;evidence.errors=browser.errors;
  console.log('PASS rest-argument text/menu/typed input, accepted replay and recorded history; zero guest requests');
}catch(error){
  evidence.failure=error.stack;evidence.fixture=await browser.evaluate('fixture');evidence.errors=browser.errors;
  await browser.screenshot(output+'/failure.png');throw error;
}finally{
  await browser.close();evidence.browserProcessEvents=browser.processEvents;
  await writeFile(output+'/result.json',JSON.stringify(evidence,null,2)+'\n');
}
