import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openBrowser} from './browser-test-support.mjs';

const url=process.argv[2] ?? 'http://127.0.0.1:8765/';
const output=resolve(process.argv[3] ?? 'peek-fixture-results');
await mkdir(output,{recursive:true});
const browser=await openBrowser('about:blank');
async function key(key,code,number){
  for(const type of ['keyDown','keyUp'])await browser.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:number});
}
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.peekFixture={count:0,active:0,maximum:0,delay:0,errors:[],sample:{title:'Processes',
      'run-time-units-per-second':1000000,threads:[
        {name:'Notifications 1',state:':sleeping',priority:':normal','wait-kind':':condition-variable',wait:'User Input','run-time':1234567,stops:[]},
        {name:'same <img src=x>',state:':waiting-for-page-write',priority:':normal','wait-kind':null,wait:null,'run-time':0,stops:[]},
        {name:'same <img src=x>',state:':sleeping',priority:':normal','wait-kind':':mutex',wait:'<script>plain text</script>','run-time':10,stops:[[':stop','0'.repeat(64),17]]}
      ]}};
    window.fetch=async (url,options)=>{
      if(url!=='/api')throw new Error('Unexpected fixture fetch '+url);
      const request=JSON.parse(options.body);let value;
      switch(request.operation){
        case 'open-session':case 'resume-session':case 'release-session':value={};break;
        case 'jobs':case 'stops':value=[];break;
        case 'monitor-state': value={listener:{package:'COMMON-LISP-USER',mode:':command-preferred',prompt:'Command: ','busy-p':false,'default-pathname':'SYS:HOME;'},jobs:[],stops:[]};break;
        case 'listener-information':value={package:'COMMON-LISP-USER',mode:':command-preferred',prompt:'Command: ','busy-p':false,'default-pathname':'SYS:HOME;'};break;
        case 'processes':{
          const f=window.peekFixture;f.count++;f.active++;f.maximum=Math.max(f.maximum,f.active);
          try{
            if(f.delay)await new Promise(resolve=>setTimeout(resolve,f.delay));
            if(f.errors.length){const status=f.errors.shift();return new Response(JSON.stringify({error:status===409?':released-stop':'Fixture transport failure',uncertain:status!==409}),{status});}
            value=f.sample;
          }finally{f.active--;}
          break;
        }
        default:throw new Error('Unexpected fixture operation '+request.operation);
      }
      return new Response(JSON.stringify({value,diagnostics:[]}),{status:200});
    };`});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:980,height:717,deviceScaleFactor:1,mobile:false});
  await browser.send('Page.navigate',{url});
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  await key('F9','F9',120);await key('p','KeyP',80);
  await browser.waitFor('activity === "peek"');
  assert.equal(await browser.evaluate('peekFixture.count'),0);
  assert(await browser.evaluate('document.querySelector("#mouse-help").textContent.includes("P: Processes")'));
  await key('p','KeyP',80);
  await browser.waitFor('document.querySelectorAll(".process-name").length === 3');
  assert.equal(await browser.evaluate('document.querySelectorAll("#process-table img, #process-table script").length'),0);
  assert.equal(await browser.evaluate('document.querySelectorAll(".process-name")[1].textContent'),'same <img src=x>');
  assert.equal(await browser.evaluate('document.querySelectorAll(".process-name")[2].textContent'),'same <img src=x>');
  assert(await browser.evaluate(`(() => {
    const element=document.querySelector('#process-rows tr:nth-child(2) td:nth-child(2)');
    const range=document.createRange();range.selectNodeContents(element);
    return range.getBoundingClientRect().right <= element.getBoundingClientRect().right;
  })()`));
  await browser.screenshot(join(output,'processes.png'));
  await browser.click('.process-name');
  await browser.waitFor('document.querySelector("#peek-process-menu").open');
  await browser.click('#peek-process-actions button');
  await browser.waitFor('document.querySelector("#peek-description").open');
  assert(await browser.evaluate('document.querySelector("#peek-description-fields").textContent.includes("1.234567 seconds")'));
  await browser.click('#close-peek-description');
  await browser.click('#process-rows tr:nth-child(3) .process-name');
  await browser.waitFor('document.querySelector("#peek-process-menu").open');
  assert(await browser.evaluate('[...document.querySelectorAll("#peek-process-actions button")].find(item=>item.textContent.startsWith("Debugger")).disabled'));
  await browser.evaluate('document.querySelector("#peek-process-menu").close()');
  await key('1','Digit1',49);await key('z','KeyZ',90);
  const before=await browser.evaluate('peekFixture.count');
  await browser.waitFor(`peekFixture.count >= ${before+2}`);
  await key('F12','F12',123);
  const helpCount=await browser.evaluate('peekFixture.count');
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal(await browser.evaluate('peekFixture.count'),helpCount);
  await browser.evaluate('peekFixture.delay=1200');await key('p','KeyP',80);
  await browser.waitFor('peekFixture.active === 1');
  for(let i=0;i<3;i++)await key(' ','Space',32);
  await browser.waitFor('peekFixture.active === 0');
  assert.equal(await browser.evaluate('peekFixture.maximum'),1);
  await browser.evaluate('peekFixture.delay=0;peekFixture.errors=[409]');await key(' ','Space',32);
  await browser.waitFor('document.querySelector("#peek-sample-status").dataset.state === "stale"');
  assert.equal(await browser.evaluate('connected'),true);
  assert.equal(await browser.evaluate('document.querySelectorAll(".process-name").length'),3);
  await browser.screenshot(join(output,'stale409.png'));
  await browser.waitFor('document.querySelector("#peek-sample-status").dataset.state === "sampled"');
  await browser.evaluate('peekFixture.errors=[502]');await key(' ','Space',32);
  await browser.waitFor('!connected && document.querySelector("#peek-sample-status").dataset.state === "stale"');
  const disconnectedCount=await browser.evaluate('peekFixture.count');
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal(await browser.evaluate('peekFixture.count'),disconnectedCount);
  await browser.evaluate('run(connect)');
  await browser.waitFor('connected && document.querySelector("#peek-sample-status").dataset.state === "sampled"');
  await browser.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))");
  const hiddenCount=await browser.evaluate('peekFixture.count');
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal(await browser.evaluate('peekFixture.count'),hiddenCount);
  await browser.evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))");
  await browser.waitFor(`peekFixture.count > ${hiddenCount}`);
  await browser.evaluate("peekFixture.sample.threads[0].name = 'x'.repeat(160)");
  await key(' ','Space',32);
  await browser.waitFor('document.querySelector(".process-name").textContent.length === 160');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:640,height:720,deviceScaleFactor:1,mobile:false});
  assert(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  assert(await browser.evaluate('document.querySelector("#page").scrollWidth > document.querySelector("#page").clientWidth'));
  await browser.click('#horizontal-track');
  assert(await browser.evaluate('document.querySelector("#page").scrollLeft > 0'));
  await browser.screenshot(join(output,'narrow.png'));
  await key('q','KeyQ',81);await browser.waitFor('activity === "listener" && !busy');
  const otherCount=await browser.evaluate('peekFixture.count');
  await new Promise(resolve=>setTimeout(resolve,1250));
  assert.equal(await browser.evaluate('peekFixture.count'),otherCount);
  assert.deepEqual(browser.errors,[]);
  const result={fixtureOnly:true,guestRequests:0,count:otherCount,maximum:await browser.evaluate('peekFixture.maximum'),errors:browser.errors};
  await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));
  console.log('PASS fixture Peek rows, fonts, safe text, Describe, expired-session links, timed/manual refresh, hidden mode/activity/tab, nonoverlap, stale409 retry, transport reconnect, narrow horizontal scrolling, and Quit');
  console.log(JSON.stringify(result));
}catch(error){await browser.screenshot(join(output,'failure.png'));throw error}
finally{await browser.close()}
