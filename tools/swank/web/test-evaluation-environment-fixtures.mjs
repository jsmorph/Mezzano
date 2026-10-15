import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {openBrowser} from './browser-test-support.mjs';

const output=process.argv[3] ?? '/tmp/evaluation-environment-fixtures';
await mkdir(output,{recursive:true});
const browser=await openBrowser('about:blank');
const q=JSON.stringify;
const ready=()=>browser.waitFor("typeof connected!=='undefined' && connected && !busy && !nextHistoricalCommand() && (!selectedStop || (!nextStopInspection(selectedStop) && !stopCommandPending(selectedStop)))");
async function key(key,code,number,modifiers=0,repeat=false,type='keyDown') {
  await browser.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:number,modifiers,autoRepeat:repeat});
}
async function press(keyName,code,number,modifiers=0) {
  await key(keyName,code,number,modifiers);
  await key(keyName,code,number,modifiers,false,'keyUp');
}
async function edit(id,value,start=value.length,end=start,direction='none') {
  await browser.evaluate(`setEditor(document.querySelector(${q('#'+id)}),${q(value)},${Array.from(value).length});
    document.querySelector(${q('#'+id)}).setSelectionRange(${start},${end},${q(direction)});
    storeEditorDraft(document.querySelector(${q('#'+id)})); document.querySelector(${q('#'+id)}).focus()`);
}
async function draft(id) {
  return browser.evaluate(`(()=>{const e=document.querySelector(${q('#'+id)});return [e.value,e.selectionStart,e.selectionEnd,e.selectionDirection]})()`);
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.fixture=JSON.parse(sessionStorage.getItem('environment-fixture')||'null')||{mode:':lexical',calls:[],results:[],inline:true,depth:1,holdInitial:true};
    const store=()=>sessionStorage.setItem('environment-fixture',JSON.stringify(fixture));
    const token=session=>[':stop',session,1];
    const prompt=()=>fixture.mode===':lexical'?'Eval (program): ':'Eval (debugger): ';
    const info=()=>({id:1,state:':stopped',thread:'Environment fixture',depth:fixture.depth,prompt:'→'.repeat(fixture.depth)+' ',
      'current-frame':0,'next-command-id':fixture.results.length,
      ...(!fixture.missing?{'evaluation-environment':fixture.mode,'evaluation-prompt':prompt()}:{})});
    window.fetch=async(url,options)=>{
      if(url!=='/api') throw Error('Unexpected fixture request '+url);
      const {operation,arguments:args,session}=JSON.parse(options.body); fixture.calls.push({operation,...args});store();let value;
      if(['open-session','resume-session'].includes(operation))value={};
      else if(operation==='monitor-state')value={listener:{package:'CL-USER',prompt:'Command: ',
        ...(fixture.inline?{debugger:{stop:token(session),...info()}}:{})},jobs:[],stops:[{token:token(session),information:info()}]};
      else if(operation==='information')value=info();
      else if(operation==='submit'){
        if(args.id!==fixture.results.length)throw Error('Unexpected command ID');
        const name=args.command;let result;
        if(name==='toggle-evaluation-environment')fixture.mode=fixture.mode===':lexical'?':dynamic':':lexical';
        if(name==='use-dynamic-environment')fixture.mode=':dynamic';
        if(name==='use-lexical-environment')fixture.mode=':lexical';
        if(name.includes('evaluation-environment')||name.startsWith('use-'))result=prompt();
        else if(name==='frames')result=Array.from({length:40},(_,i)=>({function:i?'CALLER '+i:'TARGET',frame:[':frame',session,i+1]}));
        else if(name==='condition')result='Environment fixture';
        else if(name==='restarts')result=[{index:0,name:'CONTINUE',description:'Continue','default-p':true}];
        else if(name==='current-frame')result={index:0,function:'TARGET',locals:[]};
        else if(name==='evaluate')result=['42'];
        else throw Error('Unexpected command '+name);
        fixture.results.push({state:':returned',operation:':'+name,source:name==='evaluate'?args.argument:null,'current-boot-p':true,result});store();value=args.id;
        if(name==='frames'&&fixture.holdInitial){fixture.holdInitial=false;store();await new Promise(resolve=>window.releaseInspection=resolve);}
        if(name==='toggle-evaluation-environment'&&fixture.holdNext){fixture.holdNext=false;store();await new Promise(resolve=>window.releaseToggle=resolve);}
      }else if(operation==='result')value=fixture.results[args.id];
      else if(operation==='listener-assistance'){
        const trimmed=args.source.trim();
        const command={':Use Dynamic Environment':'use-dynamic-environment',':Use Lexical Environment':'use-lexical-environment'}[trimmed];
        value=args.action==='parse'?{kind:command?':debugger-command':':form',operation:command||'evaluate',argument:command?null:args.source,display:command?':text':':values','complete-p':true}
          :{text:args.source,cursor:args.cursor,'complete-p':true};
      }else throw Error('Unexpected fixture operation '+operation);
      return new Response(JSON.stringify({value,diagnostics:[]}),{status:200});
    };
  `});
  await browser.send('Page.navigate',{url:process.argv[2] ?? 'http://127.0.0.1:8773/'});
  await browser.waitFor("typeof releaseInspection==='function'");
  assert.equal(await browser.evaluate("document.querySelector('#source').disabled"),false);
  await edit('source','(values overlap)',3,7,'backward');
  const overlapDraft=await draft('source');
  await press('x','KeyX',88,2);await key('i','KeyI',73);
  await key('i','KeyI',73,0,true);await key('i','KeyI',73,0,false,'keyUp');
  assert.deepEqual(await browser.evaluate("fixture.calls.filter(call=>call.operation==='submit').map(call=>call.command)"),['frames']);
  await browser.click('#window-label');
  await browser.click('[data-activity="requests"]');
  assert.equal(await browser.evaluate('activity'),'requests');
  await browser.evaluate('releaseInspection()');await browser.evaluate('actions.then(() => true)');
  assert.equal(await browser.evaluate("fixture.calls.filter(call=>call.operation==='submit'&&call.command==='toggle-evaluation-environment').length"),1);
  await browser.click('#window-label');
  await browser.click('[data-activity="listener"]');
  await ready();
  assert.deepEqual(await draft('source'),overlapDraft);
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ Eval (debugger): ');
  await browser.screenshot(output+'/queued-inspection-toggle.png');
  await edit('source',':Use Lexical Environment');await press('Enter','Enter',13);await ready();
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ ');
  await edit('source','(values x)',3,7,'backward');
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ Eval (program): ');
  const original=await draft('source');
  const before=await browser.evaluate('fixture.results.length');
  await browser.evaluate('fixture.holdNext=true');
  await press('x','KeyX',88,2);
  await key('i','KeyI',73);
  await browser.waitFor("typeof releaseToggle==='function'");
  await key('i','KeyI',73,0,true);
  await key('i','KeyI',73,0,true);
  await key('i','KeyI',73,0,false,'keyUp');
  await browser.evaluate('releaseToggle()');
  await ready();
  assert.equal(await browser.evaluate('fixture.results.length'),before+1,'Repeated keydown toggled twice');
  assert.deepEqual(await draft('source'),original);
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ Eval (debugger): ');
  assert.equal(await browser.evaluate("document.querySelector('.toggle-evaluation-environment-result').textContent"),'Eval (debugger): ');
  await browser.screenshot(output+'/listener-dynamic-draft.png');
  await edit('source',':Use Lexical Environment');
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ ');
  await press('Enter','Enter',13);await ready();
  assert.equal(await browser.evaluate('fixture.mode'),':lexical');
  assert.deepEqual(await draft('source'),['',0,0,'forward']);
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ ');
  await edit('source','x');
  await press('F10','F10',121);
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ ');
  await edit('source','x');await press('Enter','Enter',13);await ready();
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ ');

  await browser.evaluate("showActivity('debugger')");
  await edit('debugger-command','(values x)',2,5,'backward');
  await browser.click('#debugger-command');
  await ready();
  const standalone=await draft('debugger-command');
  const bounds=()=>browser.evaluate(`(() => {const e=document.querySelector('#debugger-command').getBoundingClientRect(), p=document.querySelector('#page').getBoundingClientRect();return {top:e.top,bottom:e.bottom,pageTop:p.top,pageBottom:p.bottom,focused:document.activeElement.id};})()`);
  const beforeBounds=await bounds();
  assert(beforeBounds.top>=beforeBounds.pageTop&&beforeBounds.bottom<=beforeBounds.pageBottom,'Editor was not initially visible');
  await press('x','KeyX',88,2);await press('i','KeyI',73);await ready();
  assert.deepEqual(await draft('debugger-command'),standalone);
  assert.equal(await browser.evaluate("document.querySelector('#debugger-prompt').textContent"),'→ Eval (debugger): ');
  const afterBounds=await bounds();
  await writeFile(output+'/standalone-bounds.json',JSON.stringify({before:beforeBounds,after:afterBounds},null,2));
  assert(afterBounds.top>=afterBounds.pageTop&&afterBounds.bottom<=afterBounds.pageBottom,'Focused editor left viewport after toggle');
  await browser.screenshot(output+'/standalone-dynamic-draft.png');
  await browser.evaluate("document.querySelector('#page').focus();document.querySelector('#page').scrollTop=80");
  const manual=await browser.evaluate("document.querySelector('#page').scrollTop");
  await browser.evaluate("run(()=>submit(selectedStop,'use-dynamic-environment')).then(()=>true)");await ready();
  assert.equal(await browser.evaluate("document.querySelector('#page').scrollTop"),manual,'Unfocused editor changed manual scroll');
  await browser.evaluate("document.querySelector('#debugger-command').focus({preventScroll:true});document.querySelector('#page').scrollTop=0");
  await browser.evaluate("run(()=>submit(selectedStop,'use-dynamic-environment')).then(()=>true)");await ready();
  assert.equal(await browser.evaluate("document.querySelector('#page').scrollTop"),0,'Invisible editor changed manual scroll');

  await browser.evaluate("showActivity('listener')");
  assert.deepEqual(await draft('source'),standalone);
  const origin=await browser.evaluate('performance.timeOrigin');
  const count=await browser.evaluate('fixture.results.length');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${origin}`);await ready();
  assert.deepEqual(await draft('source'),standalone);
  assert.equal(await browser.evaluate('fixture.results.length'),count,'Reload submitted another command');
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→ Eval (debugger): ');
  await press('x','KeyX',88,2);
  await browser.evaluate("showActivity('requests');showActivity('listener')");
  await press('i','KeyI',73);await ready();
  assert.equal(await browser.evaluate('fixture.results.length'),count,'Activity change retained a prefix');
  await edit('source','x');await press('x','KeyX',88,2);
  await browser.evaluate('fixture.depth=2;void run(refresh)');await ready();
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→→ Eval (debugger): ');
  await browser.evaluate('fixture.missing=true;void run(refresh)');await ready();
  assert.equal(await browser.evaluate("document.querySelector('#listener-prompt').textContent"),'→→ ','Missing backend field synthesized a prompt');
  await browser.evaluate('fixture.inline=false;void run(refresh)');await ready();
  await edit('source','ordinary');
  await press('x','KeyX',88,2);await press('i','KeyI',73);await ready();
  assert.equal(await browser.evaluate('fixture.results.length'),count,'Ordinary Listener submitted a debugger operation');
  assert.deepEqual(browser.errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({fixtureOnly:true,guestRequests:0,original,standalone,
    calls:await browser.evaluate('fixture.calls'),results:await browser.evaluate('fixture.results'),errors:browser.errors},null,2));
  console.log('PASS fixture-only environment prompts, typed commands, toggle repeat, draft/cursor, reload, context cancellation, and older-backend prompt handling');
}catch(error){
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,state:await browser.evaluate('state'),fixture:await browser.evaluate('fixture'),errors:browser.errors},null,2));throw error;
}finally{await browser.close();}
