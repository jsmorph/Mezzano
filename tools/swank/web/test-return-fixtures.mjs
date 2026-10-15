import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {openBrowser} from './browser-test-support.mjs';

const output=process.argv[3]??'/tmp/mezzano-return-fixtures';
await mkdir(output,{recursive:true});
const browser=await openBrowser('about:blank');
const ready=()=>browser.waitFor("typeof connected!=='undefined' && connected && !busy && !nextHistoricalCommand()");
const currentButton="[...document.querySelectorAll('#stop-detail button')].find(button=>button.textContent==='Current Stop')";
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const name='a'.repeat(64), token=id=>[':stop',name,id];
    const empty={state:':returned','current-boot-p':true,source:null,'input-length':0,
      'input-eof-p':null,'input-waiting-p':null,'output-length':0};
    window.fixture=JSON.parse(sessionStorage.getItem('return-fixture')||'null')||{calls:[],link:true,
      records:{1:[{...empty,operation:':return',result:'Return cancelled.'}],2:[],3:[]}};
    const store=()=>sessionStorage.setItem('return-fixture',JSON.stringify(fixture));
    const info=id=>({id,state:id===1?':closed':':stopped',thread:'Duplicate thread label',depth:1,prompt:'→ ',
      'current-frame':id===1?null:0,'next-command-id':fixture.records[id].length,
      'thread-stop':fixture.link?token(2):null});
    const value=(command,id)=>({frames:[{function:'TARGET-'+id,frame:[':frame',name,id]}],
      restarts:[{index:0,name:'CONTINUE',description:'Continue','default-p':true}],
      condition:'Condition '+id,'current-frame':{index:0,function:'TARGET-'+id,locals:[]},
      return:'Return cancelled.'})[command];
    if(!sessionStorage.getItem('mezzano-monitor-v1'))sessionStorage.setItem('mezzano-monitor-v1',JSON.stringify({
      session:name,attempted:true,commands:[]}));
    window.fetch=async(url,options)=>{
      if(url!=='/api')throw Error('Unexpected fixture URL '+url);
      const {operation,arguments:args}=JSON.parse(options.body);
      fixture.calls.push({operation,...args});store();let result;
      if(['open-session','resume-session'].includes(operation))result={};
      else if(operation==='monitor-state')result={listener:{package:'CL-USER',prompt:'Command: '},jobs:[],
        stops:[1,3,2].map(id=>({token:token(id),information:info(id)}))};
      else if(operation==='information')result=info(args.stop[2]);
      else if(operation==='result')result=fixture.records[args.stop[2]][args.id];
      else if(operation==='submit'){
        const records=fixture.records[args.stop[2]],returned=value(args.command,args.stop[2]);
        if(args.id!==records.length||returned===undefined||args.argument!==null)throw Error('Invalid fixture submission');
        records.push({...empty,operation:':'+args.command,result:returned});store();result=args.id;
      }else if(operation==='listener-assistance'){
        if(args.source!==':Return'||args.action!=='parse')throw Error('Unexpected assistance');
        result={operation:'return',argument:null,'complete-p':true};
      }else throw Error('Unexpected fixture operation '+operation);
      return new Response(JSON.stringify({value:result,diagnostics:[]}),{status:200});
    };
  `});
  await browser.send('Page.navigate',{url:process.argv[2]??'http://127.0.0.1:8778/'});
  await ready();
  await browser.evaluate('void run(()=>selectStop(stops.find(stop=>stop.info.id===1).token))');
  await ready();
  assert.equal(await browser.evaluate("document.querySelector('.return-result').textContent"),'Return cancelled.');
  assert.equal(await browser.evaluate("document.querySelector('.debugger-return .debugger-transcript').textContent"),'→ :Return');
  assert.equal(await browser.evaluate("fixture.calls.some(call=>call.operation==='submit')"),false);
  await browser.screenshot(output+'/closed-return.png');
  await browser.evaluate(`(${currentButton}).click()`);
  await browser.waitFor("selectedStop?.[2]===2 && !nextStopInspection(selectedStop) && !busy");
  assert.equal(await browser.evaluate("returnedResult('condition')"),'Condition 2');
  assert.deepEqual(await browser.evaluate("fixture.calls.filter(call=>call.operation==='submit').map(call=>[call.stop[2],call.command])"),
    [[2,'frames'],[2,'restarts'],[2,'condition'],[2,'current-frame']]);
  assert.equal(await browser.evaluate(`Boolean(${currentButton})`),false,'Active records must not offer Current Stop');
  await browser.evaluate("[...document.querySelectorAll('#debugger-menu button')].find(button=>button.textContent===':Return').click()");
  await ready();
  assert.equal(await browser.evaluate("document.querySelector('.return-result').textContent"),'Return cancelled.');
  assert.equal(await browser.evaluate("fixture.calls.filter(call=>call.operation==='submit'&&call.command==='return').length"),1);
  await browser.send('Page.reload');
  await ready();
  await browser.evaluate('void run(()=>selectStop(stops.find(stop=>stop.info.id===2).token))');
  await ready();
  assert.equal(await browser.evaluate("document.querySelector('.return-result').textContent"),'Return cancelled.');
  assert.equal(await browser.evaluate("fixture.calls.filter(call=>call.operation==='submit'&&call.command==='return').length"),1);
  await browser.evaluate('fixture.link=false;void run(()=>selectStop(stops.find(stop=>stop.info.id===1).token))');
  await ready();
  assert.equal(await browser.evaluate(`Boolean(${currentButton})`),false,'A closed record without a link has no Current Stop action');
  assert.deepEqual(browser.errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({fixtureOnly:true,guestRequests:0,
    checks:['Retained Return cancellation without resubmission','Exact Current Stop token among duplicate thread labels',
      'Closed-only navigation and initial inspections','Return menu uses existing parser and no-argument submit',
      'Cancellation survives reload without another execution','Absent thread-stop has no navigation action'],
    fixture:await browser.evaluate('fixture'),errors:browser.errors},null,2));
  console.log('PASS Return rendering/menu/reload and closed-only exact Current Stop navigation; zero guest requests');
} catch(error) {
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,fixture:await browser.evaluate('fixture'),errors:browser.errors},null,2));
  throw error;
} finally {await browser.close();}
