import assert from 'node:assert/strict';
import {access, mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const output = process.argv[3] ?? '/tmp/mezzano-image-restore-test';
await mkdir(output, {recursive:true});
for (const name of ['ready.json','restored']) {
  try {
    await access(output+'/'+name);
    throw new Error('Use a fresh output directory for the image-restoration test');
  } catch (error) {if(error.code !== 'ENOENT') throw error;}
}
const browser = await openBrowser(process.argv[2] ?? 'http://127.0.0.1:8765/');
const symbol = '*WEB-RESTORE-' + randomBytes(6).toString('hex').toUpperCase() + '*';
const owned = [];
const q = JSON.stringify;
const ready = () => browser.waitFor("typeof connected !== 'undefined' && connected && !busy",120);
async function submit(source) {
  await ready();
  const previous = await browser.evaluate('Object.keys(state.jobs)');
  await browser.evaluate(`showActivity('listener'); setEditor(document.querySelector('#source'), ${q(source)}, ${Array.from(source).length})`);
  for (const type of ['keyDown','keyUp']) {
    await browser.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  }
  const match = `Object.values(state.jobs).find(job => job.source === ${q(source)} && !${q(previous)}.includes(job.name))`;
  await browser.waitFor(match,120);
  const name = await browser.evaluate(`${match}.name`);
  owned.push(name);
  await browser.waitFor(`views.get(${q(name)})?.info.state === ':returned' && !busy`,120);
  return name;
}
try {
  await ready();
  const initial = await submit(`(progn (defvar cl-user::${symbol} 0) (incf cl-user::${symbol}))`);
  assert.deepEqual(await browser.evaluate(`views.get(${q(initial)}).info.values`),['1']);
  assert.deepEqual(browser.errors, []);
  const session = await browser.evaluate('state.session');
  await writeFile(output+'/ready.json',JSON.stringify({session,initial,symbol,owned},null,2));
  console.log('READY retained browser session and counter for image restoration');
  const deadline = Date.now() + 15 * 60 * 1000;
  while (true) {
    if (Date.now() >= deadline) throw new Error('Image restoration was not confirmed within 15 minutes');
    try {await access(output+'/restored'); break;} catch (error) {if(error.code !== 'ENOENT') throw error;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  await browser.send('Page.reload',{ignoreCache:true});
  await browser.waitFor(`typeof state !== 'undefined' && typeof connected !== 'undefined' && connected && !busy && state.session !== ${q(session)}`,120);
  const replacement = await browser.evaluate('state.session');
  assert.notEqual(replacement,session);
  await browser.waitFor(`views.get(${q(initial)})?.info.state === ':returned'`,120);
  const recoveryErrorCount = browser.errors.length;
  assert(browser.errors.every(error => error.source === 'network' && /status of (409|502|503)/.test(error.text)), JSON.stringify(browser.errors));
  assert.equal(await browser.evaluate(`Boolean(views.get(${q(initial)}).info['current-boot-p'])`),false);
  assert.equal(await browser.evaluate(`state.inputHistory.some(item=>item.name === ${q(initial)})`),true);
  const checked = await submit(`cl-user::${symbol}`);
  assert.deepEqual(await browser.evaluate(`views.get(${q(checked)}).info.values`),['1']);
  await browser.evaluate("showActivity('examiner')");
  await browser.waitFor("[...document.querySelectorAll('#examiner-candidates .document-topic')].some(item=>item.textContent==='Lisp Command Processor')",120);
  await browser.evaluate("[...document.querySelectorAll('#examiner-candidates .document-topic')].find(item=>item.textContent==='Lisp Command Processor').click()");
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Clear All') && !busy",120);
  await browser.screenshot(output+'/restored-documentation.png');
  await browser.evaluate("showActivity('peek')");
  for (const type of ['keyDown','keyUp']) {
    await browser.send('Input.dispatchKeyEvent',{type,key:'p',code:'KeyP',windowsVirtualKeyCode:80});
  }
  await browser.waitFor("document.querySelectorAll('#process-rows tr').length>0 && !busy",120);
  await browser.screenshot(output+'/restored-peek.png');
  const cleanup = await submit(`(let ((symbol (find-symbol ${q(symbol)} "CL-USER"))) (assert symbol) (unintern symbol "CL-USER"))`);
  await browser.evaluate(`void run(async()=>{
    for (const name of ${q(owned)}) await mutate('release-job',{job:state.jobs[name].token});
    await mutate('release-session',{});
  })`);
  await browser.waitFor('!connected && !busy',120);
  assert.equal(browser.errors.length, recoveryErrorCount);
  await writeFile(output+'/result.json',JSON.stringify({session,replacement,initial,checked,cleanup,owned,symbol,errors:browser.errors,cleaned:true},null,2));
  console.log('PASS real image restore: expired session replaced, retained result/history recovered, evaluation not replayed, updated docs and Peek, owned cleanup');
} catch(error) {
  await browser.screenshot(output+'/failure.png');
  await writeFile(output+'/failure.json',JSON.stringify({error:error.stack,state:await browser.evaluate('state'),owned,symbol,errors:browser.errors},null,2));
  throw error;
} finally {await browser.close();}
