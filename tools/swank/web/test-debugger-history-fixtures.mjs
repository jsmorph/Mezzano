import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {openBrowser} from './browser-test-support.mjs';

const output = process.argv[3] ?? '/tmp/mezzano-debugger-history-fixtures';
await mkdir(output, {recursive:true});
const browser = await openBrowser('about:blank');
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    const saved = sessionStorage.getItem('history-fixture');
    window.fixture = saved ? JSON.parse(saved) : {calls:[], results:[], failed:false, held:false};
    if (!saved) for (let id=0; id<100; id++) fixture.results.push({state:':returned',
      operation:':arglist', source:null, 'current-boot-p':null, result:'Recorded result '+id});
    const store = () => sessionStorage.setItem('history-fixture', JSON.stringify(fixture));
    fixture.results[5] = {state:':returned', operation:':evaluate', source:'(incf writes)',
      'current-boot-p':null, result:['1']};
    fixture.results[6] = {state:':returned', operation:':lexical-environment', source:null,
      'current-boot-p':null, result:'Lexically inherited variables:\\n  ANCESTOR: 37\\n'};
    fixture.results[7] = {state:':returned', operation:':inspect', source:null,
      'current-boot-p':null, result:{object:[':object','old',1], title:'#(37)', type:'VECTOR',
        start:0,end:1,total:1,count:32, parts:[{label:'0', 'bound-p':true,value:'37',
          object:[':object','old',2],part:[':part','old',3]}]}};
    const stop = session => [':stop',session,1];
    const information = () => ({id:1,state:':stopped',thread:'History fixture',depth:1,prompt:'DBG 1: ',
      'current-frame':2,'next-command-id':fixture.results.length});
    function resultFor(command,session) {
      if(command==='frames') return ['A','B','TARGET'].map((name,id)=>({function:name,frame:[':frame',session,id]}));
      if(command==='restarts') return [{index:0,name:'CONTINUE',description:'Continue fixture','default-p':true}];
      if(command==='condition') return 'History fixture condition';
      if(command==='current-frame') return {index:2,function:'TARGET',locals:[]};
      throw Error('Unexpected submission '+command);
    }
    window.fetch = async (url,options) => {
      if(url!=='/api') throw Error('Unexpected fixture fetch '+url);
      const request=JSON.parse(options.body), {operation,arguments:args,session}=request;
      fixture.calls.push({operation,...args,time:performance.now()}); store();
      let value;
      if(operation==='open-session'||operation==='resume-session') value={};
      else if(operation==='monitor-state') value={listener:{package:'CL-USER',prompt:'Command: ',
        ...(fixture.inline?{debugger:{stop:stop(session),depth:1,prompt:'DBG 1: '}}:{})},
        jobs:[],stops:[{token:stop(session),information:information()}]};
      else if(operation==='information') value=information();
      else if(operation==='submit') {
        if(args.id!==fixture.results.length) throw Error('Submission ID changed');
        fixture.results.push({state:':returned',operation:':'+args.command,source:null,
          'current-boot-p':true,result:resultFor(args.command,session)}); store(); value=args.id;
      } else if(operation==='result') {
        if(args.id===98 && !fixture.held) {
          fixture.held=true; store();
          await new Promise(resolve=>window.releaseHistory=resolve);
        }
        if(args.id===96 && !fixture.failed) {
          fixture.failed=true; store();
          return new Response(JSON.stringify({error:'Fixture interrupted history read',uncertain:true}),{status:502});
        }
        value=fixture.results[args.id];
      } else if(operation==='listener-assistance') value={};
      else throw Error('Unexpected fixture operation '+operation);
      return new Response(JSON.stringify({value,diagnostics:[]}),{status:200});
    };
  `});
  await browser.send('Page.navigate', {url:process.argv[2] ?? 'http://127.0.0.1:8772/'});
  await browser.waitFor("typeof connected!=='undefined' && connected && !busy");
  assert.deepEqual(await browser.evaluate(`(() => {
    const info=stops[0].info, original=info['next-command-id'];
    try { return [[0,0],[0,2],[4,2]].map(([next,id])=>{
      info['next-command-id']=next;
      const command={stop:stops[0].token,id,command:'frames'};
      state.commands.push(command);
      try { return stopCommandPending(command.stop); } finally {state.commands.pop();}
    }); } finally {info['next-command-id']=original;}
  })()`),[true,true,false],'Accepted commands must remain pending beyond a stale monitor counter; older unknown history must not block');
  await browser.evaluate('void run(()=>selectStop(stops[0].token))');
  await browser.waitFor("typeof releaseHistory==='function'");
  assert.equal(await browser.evaluate("fixture.calls.filter(call=>call.operation==='submit').map(call=>call.command).join(',')"), 'frames,restarts,condition,current-frame');
  assert.equal(await browser.evaluate("document.querySelectorAll('#stop-detail .frame').length"),3);
  assert.equal(await browser.evaluate("document.querySelector('#stop-detail .restarts button').disabled"),false);
  await browser.evaluate("void run(()=>api('listener-assistance',{source:':Show ',action:'help',context:'debugger',cursor:6})); releaseHistory()");
  await browser.waitFor('!connected && !busy');
  const first = await browser.evaluate('fixture.calls');
  assert(first.findIndex(call=>call.operation==='listener-assistance') < first.findIndex(call=>call.operation==='result'&&call.id===97));
  assert.equal(first.filter(call=>call.operation==='result'&&call.id===96).length,1);
  assert.equal(await browser.evaluate("state.commands.some(command=>command.id===96)"),false);
  await browser.evaluate('void run(connect)');
  await browser.waitFor('connected && !busy && !nextHistoricalCommand()',30);
  const recovered = await browser.evaluate(`({commands:state.commands, calls:fixture.calls,
    caption:document.querySelector('.debugger-evaluation .debugger-transcript').textContent,
    historical:document.querySelector('.debugger-lexical-environment .historical-command').textContent,
    pageDisabled:[...document.querySelectorAll('.inspection-pane button,.inspector-history button')].every(button=>button.disabled),
    menuEnabled:[...document.querySelectorAll('.inspector-menu button')].every(button=>!button.disabled)})`);
  assert.deepEqual(recovered.commands.map(command=>command.id),Array.from({length:104},(_,id)=>id));
  assert.equal(recovered.caption,'→ (incf writes)');
  assert.equal(recovered.historical,'Recorded before this boot.');
  assert.equal(recovered.pageDisabled,true);
  assert.equal(recovered.menuEnabled,true);
  assert.equal(recovered.calls.filter(call=>call.operation==='submit').length,4);
  const reads=recovered.calls.filter(call=>call.operation==='result'&&call.id<100);
  assert(reads.at(-1).time-reads[0].time<15000,'History reads waited for the monitor interval');
  assert.equal(await browser.evaluate(`(() => {
    const command=state.commands.find(command=>command.id===5);
    commandResults.delete(commandKey(command)); renderStops();
    return document.querySelector('.history-progress').textContent;
  })()`),'Receiving retained command history (103 of 104).');
  await browser.evaluate('void run(loadHistoricalCommand)');
  await browser.waitFor('!busy && !nextHistoricalCommand()');
  await browser.screenshot(output+'/restored-history.png');

  await browser.evaluate(`fixture.results[102].state=':unwound'; fixture.inline=true;
    sessionStorage.setItem('history-fixture',JSON.stringify(fixture));
    state.commands=state.commands.filter(command=>command.id>=50); save()`);
  const origin=await browser.evaluate('performance.timeOrigin');
  const start=await browser.evaluate('fixture.calls.length');
  await browser.send('Page.reload',{ignoreCache:true});
  await browser.waitFor(`performance.timeOrigin!==${origin} && typeof connected!=='undefined' && connected && !busy`);
  await browser.evaluate('void run(()=>selectStop(stops[0].token))');
  await browser.waitFor('connected && !busy && !nextHistoricalCommand()',30);
  const reloaded=await browser.evaluate(`({calls:fixture.calls.slice(${start}),ids:state.commands.map(command=>command.id),
    failed:commandResults.get(commandKey(latestCommand('condition'))).state})`);
  assert.deepEqual(reloaded.calls.filter(call=>call.operation==='result').slice(0,4).map(call=>call.id),[103,100,101,102]);
  assert.deepEqual(reloaded.ids,Array.from({length:104},(_,id)=>id));
  assert.equal(reloaded.failed,':unwound');
  assert.equal(reloaded.calls.some(call=>call.operation==='submit'),false,'Reload repeated a failed printer or accepted command');
  await browser.evaluate(`showActivity('requests'); selectedStop=null;
    for(const command of state.commands) if(command.id<3) commandResults.delete(commandKey(command));
    renderPending(); void run(refresh)`);
  await browser.waitFor("!busy && state.commands.every(command=>commandResults.has(commandKey(command)))");
  const requestHistory=await browser.evaluate(`({text:document.querySelector('#pending').textContent,
    calls:fixture.calls.slice(${start}), selectedStop, records:state.commands.length})`);
  assert.equal(requestHistory.selectedStop,null);
  assert.equal(requestHistory.records,104);
  assert(!requestHistory.text.includes('unknown'));
  assert.equal(requestHistory.calls.some(call=>call.operation==='submit'),false);
  assert.deepEqual(browser.errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({fixtureOnly:true,guestRequests:0,recovered,reloaded,requestHistory,errors:browser.errors},null,2));
  console.log('PASS fresh inspection priority, serialized history reads, live action priority, failed read recovery, source/order, stale Inspector controls, partial reload, and failed-printer suppression; zero guest requests');
} catch(error) {
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,state:await browser.evaluate('state'),calls:await browser.evaluate('fixture.calls'),errors:browser.errors},null,2));
  throw error;
} finally {await browser.close();}
