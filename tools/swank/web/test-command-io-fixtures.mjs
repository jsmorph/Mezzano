import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {openBrowser} from './browser-test-support.mjs';

const output = process.argv[3] ?? '/tmp/mezzano-command-io-fixtures';
await mkdir(output, {recursive:true});
const browser = await openBrowser('about:blank');
const q = JSON.stringify;
const ready = () => browser.waitFor("connected && !busy && !nextCommandOutput() && !nextHistoricalCommand()");
const editor = '.command-io[data-command-id="4"] textarea';
async function draft(text, start=0, end=start) {
  await browser.evaluate(`(() => {const input=document.querySelector(${q(editor)});
    input.value=${q(text)};input.setSelectionRange(${start},${end});
    input.dispatchEvent(new Event('input'));input.focus()})()`);
}
async function snapshot() {
  return browser.evaluate(`(() => {const input=document.querySelector(${q(editor)});
    return {text:input.value,start:input.selectionStart,end:input.selectionEnd,
      draft:state.drafts[editorDraftKeys.get(input)],selectedStop}})()`);
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`
    window.fixture=JSON.parse(sessionStorage.getItem('command-io-fixture')||'null');
    const name='a'.repeat(64), token=id=>[':stop',name,id];
    const empty={state:':returned','current-boot-p':true,'input-length':0,'input-eof-p':true,'input-waiting-p':null,'output-length':0};
    const running=(text,source)=>({state:':running',operation:':evaluate',source,
      'current-boot-p':true,'input-length':0,'input-eof-p':null,'input-waiting-p':true,
      'output-length':Array.from(text).length,result:null,text,input:'',reads:0});
    if(!fixture) fixture={calls:[],inline:true,child:false,closed:false,held:false,drop:false,corrupt:false,
      results:[{...empty,operation:':frames',result:[{function:'TARGET',frame:[':frame',name,1]}]},
        {...empty,operation:':restarts',result:[{index:0,name:'CONTINUE',description:'Continue fixture','default-p':true}]},
        {...empty,operation:':condition',result:'Command I/O fixture'},
        {...empty,operation:':current-frame',result:{index:0,function:'TARGET',locals:[]}},
        running('λ中文😀'.repeat(16385)+'\\nFirst input: ','(read-line *query-io*)')],
      childResult:running('Child input: ','(read-line *query-io*)')};
    const store=()=>sessionStorage.setItem('command-io-fixture',JSON.stringify(fixture));
    const info=id=>({id,state:fixture.closed?':closed':':stopped',thread:'Command I/O fixture',
      depth:id===1?1:2,prompt:id===1?'→ ':'→→ ','current-frame':0,
      'next-command-id':id===1?fixture.results.length:1,
      ...(id===1&&fixture.child?{child:token(2)}:{}),...(id===2?{parent:token(1)}:{})});
    if(!sessionStorage.getItem('mezzano-monitor-v1')) sessionStorage.setItem('mezzano-monitor-v1',JSON.stringify({
      session:name,attempted:true,commands:fixture.results.map((result,id)=>({stop:token(1),id,
        command:result.operation.slice(1),...(result.source?{source:result.source}:{})}))}));
    window.fetch=async(url,options)=>{
      if(url!=='/api')throw Error('Unexpected fixture URL '+url);
      const {operation,arguments:args}=JSON.parse(options.body);
      fixture.calls.push({operation,...args});store();let value;
      if(['open-session','resume-session'].includes(operation))value={};
      else if(operation==='monitor-state')value={listener:{package:'CL-USER',prompt:'Command: ',
        ...(fixture.inline?{debugger:{stop:token(fixture.child?2:1),depth:fixture.child?2:1,prompt:'→ '}}:{})},
        jobs:[],stops:[{token:token(1),information:info(1)},...(fixture.child?[{token:token(2),information:info(2)}]:[])]};
      else if(operation==='information')value=info(args.stop[2]);
      else if(operation==='result')value=args.stop[2]===2?fixture.childResult:fixture.results[args.id];
      else if(operation==='command-output'){
        const result=args.stop[2]===2?fixture.childResult:fixture.results[args.id];
        value={start:args.start,text:Array.from(result.text).slice(args.start,args.end).join(''),end:args.end};
        if(!fixture.held){fixture.held=true;store();await new Promise(resolve=>window.releaseOutput=resolve);}
        if(fixture.corrupt){fixture.corrupt=false;value.end++;store();}
      }else if(operation==='command-input'){
        const result=args.stop[2]===2?fixture.childResult:fixture.results[args.id];
        const length=Array.from(result.input).length, end=args.offset+Array.from(args.text).length;
        if(args.offset===length){
          result.input+=args.text;result.reads++;result['input-length']=end;
          result.text+='\\nNext input: ';result['output-length']=Array.from(result.text).length;
          if(args.eof){result['input-eof-p']=true;result['input-waiting-p']=null;result.state=':returned';result.result=['42'];}
          store();
        }else if(Array.from(result.input).slice(args.offset,end).join('')!==args.text)throw Error('Input conflict');
        value=end;
        if(fixture.drop){fixture.drop=false;store();throw new TypeError('Fixture discarded accepted input reply');}
      }else if(operation==='listener-assistance')value={};
      else throw Error('Unexpected fixture operation '+operation);
      return new Response(JSON.stringify({value,diagnostics:[]}),{status:200});
    };
  `});
  await browser.send('Page.navigate', {url:process.argv[2] ?? 'http://127.0.0.1:8772/'});
  await browser.waitFor("typeof releaseOutput==='function'");
  await browser.evaluate("void run(()=>api('listener-assistance',{source:':Help',cursor:5,action:'help',context:'debugger'}));releaseOutput()");
  await ready();
  const initial=await browser.evaluate(`({text:document.querySelector('.command-output').textContent,calls:fixture.calls,
    inline:!!document.querySelector('#listener-debugger .command-io'),jobs:Object.keys(state.jobs).length})`);
  assert.equal(initial.text,'λ中文😀'.repeat(16385)+'\nFirst input: ');
  assert.equal(initial.inline,true);
  assert.equal(initial.jobs,0,'Command I/O must not require an evaluation job');
  const outputCalls=initial.calls.filter(call=>call.operation==='command-output');
  assert.deepEqual(outputCalls.map(call=>call.start),[0,65536]);
  assert(initial.calls.findIndex(call=>call.operation==='listener-assistance')
    < initial.calls.findIndex(call=>call.operation==='command-output'&&call.start===65536));

  await draft('(values λ 😀)',2,6);
  await browser.evaluate(`window.savedInput=document.querySelector(${q(editor)});showActivity('debugger')`);
  assert.equal(await browser.evaluate(`document.querySelector('#debugger .command-io textarea')===savedInput`),true);
  let saved=await snapshot();
  assert.deepEqual([saved.text,saved.start,saved.end],['(values λ 😀)',2,6]);
  const origin=await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await browser.waitFor(`performance.timeOrigin!==${origin} && typeof connected!=='undefined' && connected && !busy`);
  await ready();
  saved=await snapshot();
  assert.deepEqual([saved.text,saved.start,saved.end],['(values λ 😀)',2,6]);
  assert.equal(await browser.evaluate("fixture.calls.some(call=>call.operation==='submit')"),false);

  await draft('λ😀');
  await browser.evaluate('fixture.drop=true');
  await browser.click('.command-io[data-command-id="4"] button');
  await browser.waitFor("!connected && !busy && state.pending.some(record=>record.operation==='command-input'&&record.status==='outcome unknown')");
  const receipt=await browser.evaluate("state.pending.find(record=>record.operation==='command-input')");
  assert.deepEqual([receipt.arguments.id,receipt.arguments.offset,receipt.arguments.text],[4,0,'λ😀\n']);
  assert.equal((await snapshot()).text,'λ😀');
  assert.equal(await browser.evaluate("document.querySelector('.command-io[data-command-id=\"4\"] button').disabled"),true);
  await browser.evaluate('void run(connect)');
  await ready();
  assert.equal(await browser.evaluate("document.querySelector('.command-io[data-command-id=\"4\"] button').disabled"),true);
  await browser.evaluate("void run(async()=>{await replay(state.pending.find(record=>record.operation==='command-input'));await refresh()})");
  await ready();
  assert.equal((await snapshot()).text,'');
  assert.equal(await browser.evaluate('fixture.results[4].reads'),1);
  assert.equal(await browser.evaluate('fixture.results[4]["input-length"]'),3);

  await draft('parent draft',3,8);
  await browser.evaluate(`fixture.child=true;fixture.inline=false;
    state.commands.push({stop:[':stop',state.session,2],id:0,command:'evaluate',source:fixture.childResult.source});
    void run(refresh)`);
  await ready();
  assert.equal(await browser.evaluate(`document.querySelector(${q(editor)}).disabled`),true);
  await browser.evaluate("void run(()=>selectStop(stops.find(stop=>stop.info.id===2).token))");
  await ready();
  await browser.evaluate(`(()=>{const input=document.querySelector('.command-io[data-command-id="0"] textarea');
    input.value='child draft';input.setSelectionRange(1,4);input.dispatchEvent(new Event('input'))})()`);
  assert.equal(await browser.evaluate("state.drafts['command-input:1:4'].text"),'parent draft');
  assert.equal(await browser.evaluate("state.drafts['command-input:2:0'].text"),'child draft');
  await browser.evaluate(`fixture.child=false;fixture.childResult.state=':unwound';
    fixture.childResult['input-eof-p']=true;fixture.inline=true;void run(async()=>{await refresh();showActivity('listener')})`);
  await ready();
  saved=await snapshot();
  assert.deepEqual([saved.text,saved.start,saved.end],['parent draft',3,8]);
  await draft('');
  await browser.click('.command-io[data-command-id="4"] button:nth-of-type(2)');
  await ready();
  assert.equal(await browser.evaluate('fixture.results[4].reads'),2);
  assert.equal(await browser.evaluate("document.querySelector('.command-io[data-command-id=\"4\"] .input-form').hidden"),true);
  await browser.evaluate(`fixture.results.push({...fixture.childResult,state:':running','input-length':0,
    'input-eof-p':null,'input-waiting-p':true,text:'Fresh input: ','output-length':13,input:'',reads:0});
    state.commands.push({stop:[':stop',state.session,1],id:5,command:'evaluate',source:'(read-line)'});
    void run(refresh)`);
  await ready();
  assert.equal(await browser.evaluate("document.querySelector('.command-io[data-command-id=\"5\"] textarea').value"),'');
  assert.equal(await browser.evaluate("document.querySelector('.command-io[data-command-id=\"5\"] button').disabled"),false);
  await browser.evaluate("showActivity('debugger')");
  await browser.evaluate(`(()=>{const input=document.querySelector('.command-io[data-command-id="5"] textarea');
    input.focus();input.scrollIntoView({block:'center'});
    fixture.results[5].text+='Additional output\\n'.repeat(120)+'Fresh input: ';fixture.results[5]['output-length']=Array.from(fixture.results[5].text).length;void run(refresh)})()`);
  await ready();
  assert.equal(await browser.evaluate(`(()=>{const input=document.querySelector('.command-io[data-command-id="5"] textarea');
    const bounds=input.getBoundingClientRect(),page=document.querySelector('#page').getBoundingClientRect();
    return document.activeElement===input&&bounds.top>=page.top&&bounds.bottom<=page.bottom})()`),true,
    'Output growth must preserve a focused visible command input');
  await browser.evaluate(`document.querySelector('#page').focus();document.querySelector('#page').scrollTop=50;
    fixture.results[5].text+='More output\\n';fixture.results[5]['output-length']=Array.from(fixture.results[5].text).length;
    fixture.results[5]['current-boot-p']=null;void run(refresh)`);
  await ready();
  assert.equal(await browser.evaluate('document.querySelector("#page").scrollTop'),50,
    'Output reads must preserve unfocused manual scrolling');
  assert.equal(await browser.evaluate(`document.querySelector('.command-io[data-command-id="5"] button').disabled`),false,
    'A restored running command accepts input through its fresh stop handle');
  await browser.evaluate(`window.outputEnd=commandIOViews.get(commandKey(state.commands.at(-1))).end;
    document.querySelector('.command-io[data-command-id="5"]').scrollIntoView({block:'end'})`);
  await browser.screenshot(output+'/standalone-command-input.png');

  await browser.evaluate(`fixture.corrupt=true;fixture.results[5].text+='!';fixture.results[5]['output-length']++;
    void run(refresh)`);
  await browser.waitFor("!busy && document.querySelector('#message').textContent==='Invalid retained command output range.'");
  assert.equal(await browser.evaluate("commandIOViews.get(commandKey(state.commands.at(-1))).end===outputEnd"),true);
  await browser.evaluate('void run(refresh)');
  await ready();
  await browser.evaluate(`fixture.closed=true;fixture.results[5].state=':unwound';fixture.results[5]['input-eof-p']=true;
    void run(refresh)`);
  await ready();
  assert.equal(await browser.evaluate("[...document.querySelectorAll('.command-io textarea')].every(input=>input.disabled)"),true);
  assert.deepEqual(browser.errors,[]);
  const result=await browser.evaluate('({calls:fixture.calls,reads:fixture.results[4].reads,drafts:state.drafts})');
  await writeFile(output+'/result.json',JSON.stringify({fixtureOnly:true,guestRequests:0,initial,receipt,result,errors:browser.errors},null,2));
  console.log('PASS command I/O Unicode ranges/action priority, shared views/draft reload, lost input reply/replay, child drafts, command EOF isolation, range rejection and closed input; zero guest requests');
} catch(error) {
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,state:await browser.evaluate('state'),fixture:await browser.evaluate('fixture'),errors:browser.errors},null,2));
  throw error;
} finally {await browser.close();}
