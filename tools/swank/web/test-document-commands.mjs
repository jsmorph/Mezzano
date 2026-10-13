import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'document-command-results');
await mkdir(output, {recursive:true});
const browser = await openBrowser(url);
const current = 'state.examiner.viewers.find(viewer=>viewer.name===state.examiner.current)';
const guide = 'doc/project-guide.md';
const searches = [];
const marker = 'COMMANDS-' + randomBytes(6).toString('hex').toUpperCase();
const relativePath = ';' + marker + '.PSB';
const pathname = 'SYS:HOME;' + marker + '.PSB';
const jobs = [];
let fileOwned = false;
let sessionReleased = false;

async function evaluate(source) {
  const job = await browser.evaluate(`api('start-evaluation',{name:freshName(),source:${JSON.stringify(source)}})`);
  jobs.push(job);
  await browser.waitFor(`api('job-information',{job:${JSON.stringify(job)}}).then(info=>info.state!==':running')`);
  const info = await browser.evaluate(`api('job-information',{job:${JSON.stringify(job)}})`);
  assert.equal(info.state, ':returned', JSON.stringify(info));
  return info;
}
async function cleanup() {
  if (fileOwned) {
    const result = await evaluate(`(let ((path ${JSON.stringify(pathname)})) (when (probe-file path) (delete-file path)) (null (probe-file path)))`);
    assert.deepEqual(result.values, ['T']);
    fileOwned = false;
  }
  for (const job of jobs) await browser.evaluate(`api('release-job',{job:${JSON.stringify(job)}})`);
  jobs.length = 0;
  await browser.evaluate(`api('release-session')`);
  sessionReleased = true;
}

async function key(key, code, number, modifiers=0) {
  for (const type of ['keyDown','keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {type,key,code,windowsVirtualKeyCode:number,modifiers,
      ...(type === 'keyDown' && key === ' ' ? {text:' ',unmodifiedText:' '} : {})});
  }
}
async function fill(source) {
  await browser.waitFor('connected && !busy');
  await browser.click('#examiner-command');
  await key('a','KeyA',65,2);
  await browser.send('Input.insertText', {text:source});
}
async function command(source) {
  await fill(source);
  await key('Enter','Enter',13);
  await browser.waitFor(`document.querySelector('#examiner-command-output').textContent === ${JSON.stringify('▶ '+source)}`);
}
async function rightClick(selector) {
  const point = await browser.evaluate(`(()=>{
    const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`);
  for (const type of ['mousePressed','mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {type,button:'right',clickCount:1,...point});
  }
}
async function search(mode, adjacent, query, includesGuide) {
  await rightClick('[data-examiner-command="Show Candidates "]');
  await browser.waitFor("document.querySelector('#examiner-menu').open");
  await browser.click(`[data-search-mode=":${mode}"]`);
  await browser.waitFor(`${current}.search.mode === ${JSON.stringify(':'+mode)} && document.querySelector('#examiner-menu').open`);
  if (Boolean(await browser.evaluate(`${current}.search.adjacent`)) !== adjacent) {
    await browser.click('#examiner-adjacent');
    await browser.waitFor(`Boolean(${current}.search.adjacent) === ${adjacent} && document.querySelector('#examiner-menu').open`);
  }
  await browser.click('#examiner-menu-items button:last-child');
  const previous = await browser.evaluate(`${current}.candidates.length`);
  await command('Show Candidates '+query);
  await browser.waitFor(`${current}.candidates.length === ${previous+1}`);
  const result = await browser.evaluate(`${current}.candidates.at(-1)`);
  assert.equal(result.mode, ':'+mode);
  assert.equal(Boolean(result.adjacent), adjacent);
  assert.equal((result.topics || []).some(topic=>topic.id===guide), includesGuide,
    `${mode}, adjacent=${adjacent}, query=${query}`);
  searches.push({mode,adjacent,query,topics:(result.topics || []).map(topic=>topic.id)});
}

try {
  await browser.waitFor("typeof examiner !== 'undefined' && connected && !busy");
  await browser.evaluate('document.fonts.ready.then(()=>true)');
  await browser.evaluate(`(() => {
    window.examinerRequests = [];
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const request = JSON.parse(args[1]?.body || '{}');
      if (request.operation) examinerRequests.push({request,status:response.status,reply:await response.clone().json()});
      return response;
    };
  })()`);
  await browser.click('#window-label');
  await browser.waitFor("document.querySelector('#system-menu').open");
  await browser.click('[data-activity="examiner"]');
  await browser.waitFor("document.querySelector('#examiner-candidates [data-topic=\"doc/project-guide.md\"]')");
  await command('Show Documentation '+guide);
  await browser.waitFor("document.querySelector('#examiner-topics').textContent.includes('Getting started')");
  assert(await browser.evaluate(`${current}.bookmarks.some(item=>item.topic.id===${JSON.stringify(guide)} && item.viewed)`));
  await command('Show Table of Contents '+guide);
  const contents = await browser.evaluate(`${current}.candidates.at(-1)`);
  assert.equal(contents.action, 'contents');
  assert.equal(contents.topics[0].id, guide);
  assert(contents.topics.some(topic=>topic.depth > 0));
  await command('Show Overview '+guide);
  await browser.waitFor("!document.querySelector('#examiner-typeout').hidden");
  assert(await browser.evaluate("document.querySelector('#examiner-typeout .document-source a').href.endsWith('/doc/project-guide.md')"));
  await browser.screenshot(join(output, 'typed-overview.png'));
  await key(' ','Space',32);
  await browser.waitFor("document.querySelector('#examiner-typeout').hidden");
  await search('exact', false, 'mezz', false);
  await search('initial', false, 'mezz', true);
  await search('substring', false, 'zzan', true);
  await search('exact', false, 'guide mezzano', true);
  await search('exact', true, 'guide mezzano', false);
  await search('exact', true, 'Mezzano user', true);
  await search('exact', false, 'mezzano absentdocumentationword', false);
  assert.deepEqual(await browser.evaluate(`${current}.candidates.at(-1).topics || []`), []);
  await browser.screenshot(join(output, 'search-options.png'));
  await fill('Read Private Document');
  await key(' ','Space',32);
  await browser.waitFor("document.querySelector('#examiner-command').value==='Read Private Document ' && document.querySelector('#examiner-assistance').textContent.includes('SYS:HOME;PRIVATE.PSB')");
  await key(' ','Space',32);
  await browser.waitFor("document.querySelector('#examiner-command').value.includes('SYS:HOME;PRIVATE.PSB')");
  const defaultInput = await browser.evaluate("document.querySelector('#examiner-command').value");
  await browser.screenshot(join(output, 'accepted-default.png'));
  const emptyPlan = await browser.evaluate(`api('document-assistance',{source:'Read Private Document',cursor:21,action:'parse'})`);
  assert.equal(emptyPlan.error, null);
  assert.equal(emptyPlan.argument, 'SYS:HOME;PRIVATE.PSB');
  const savedTopics = await browser.evaluate(`${current}.bookmarks.map(item=>item.topic.id)`);
  await command('Save Private Document ' + relativePath);
  const saved = await browser.evaluate(`examinerRequests.find(item=>item.request.operation==='save-private-document')`);
  assert.equal(saved.status,200);
  assert.equal(saved.request.arguments.pathname,pathname + '.NEWEST');
  jobs.push(saved.reply.value);
  fileOwned = true;
  await browser.waitFor(`api('job-information',{job:${JSON.stringify(saved.reply.value)}}).then(info=>info.state!==':running')`);
  assert.equal((await browser.evaluate(`api('job-information',{job:${JSON.stringify(saved.reply.value)}})`)).state,':returned');
  await command('Select Viewer ' + marker);
  await command('Read Private Document ' + relativePath);
  assert.deepEqual(await browser.evaluate(`${current}.bookmarks.map(item=>item.topic.id)`),savedTopics);
  const beforeMalformed = await browser.evaluate(`JSON.stringify(${current})`);
  const malformed = [
    '', 'nil', '(:mezzano-document 2 :topics ())',
    '(:mezzano-document 1 :topics ("doc/project-guide.md")) (extra)',
    '(:mezzano-document 1 :topics () . 7)',
    '#1=(:mezzano-document 1 :topics () . #1#)',
    '(:mezzano-document 1 :topics ("doc/project-guide.md" . 7))',
    '(:mezzano-document 1 :topics #1=("doc/project-guide.md" . #1#))',
    '(:mezzano-document 1 :topics (42))',
    '(:mezzano-document 1 :topics (',
    '#.(error "Reader evaluation must remain disabled")'
  ];
  const invalidTopics = '(:mezzano-document 1 :topics ("missing-browser-topic-' + marker + '"))';
  const rejectedInputs = [...malformed.map(content=>({content,reason:':invalid-private-document'})),
    {content:invalidTopics,reason:':missing-topic'}];
  for (const {content,reason} of rejectedInputs) {
    const result = await evaluate(`(with-open-file (stream ${JSON.stringify(pathname)} :direction :output :if-exists :supersede :if-does-not-exist :error) (write-string ${JSON.stringify(content)} stream) (values))`);
    assert.equal(result.values,null);
    const previous = await browser.evaluate(`examinerRequests.filter(item=>item.request.operation==='read-private-document').length`);
    await fill('Read Private Document ' + relativePath);
    await key('Enter','Enter',13);
    await browser.waitFor(`!busy && examinerRequests.filter(item=>item.request.operation==='read-private-document').length === ${previous+1}`);
    const response = await browser.evaluate(`examinerRequests.filter(item=>item.request.operation==='read-private-document').at(-1)`);
    assert.equal(response.status,409,JSON.stringify(response));
    assert.equal(response.reply.error,reason);
    assert.equal(response.reply.uncertain,false);
    assert.equal(await browser.evaluate('connected'),true);
    assert.equal(await browser.evaluate(`JSON.stringify(${current})`),beforeMalformed);
    assert((await browser.evaluate(`api('document-query',{action:'topic',topic:${JSON.stringify(guide)}})`)).topic);
  }
  await browser.screenshot(join(output,'malformed-document.png'));
  const missingPath = 'SYS:HOME;' + marker + '-ABSENT.PSB';
  await fill('Read Private Document ' + missingPath);
  await key('Enter','Enter',13);
  await browser.waitFor(`!busy && examinerRequests.some(item=>item.request.operation==='read-private-document' && item.request.arguments.pathname.includes('-ABSENT.PSB'))`);
  const missing = await browser.evaluate(`examinerRequests.filter(item=>item.request.operation==='read-private-document').at(-1)`);
  assert.equal(missing.status,409,JSON.stringify(missing));
  assert.equal(missing.reply.error,':private-document-io-error');
  assert.equal(missing.reply.uncertain,false);
  assert.equal(await browser.evaluate('connected'),true);
  assert.equal(await browser.evaluate(`JSON.stringify(${current})`),beforeMalformed);
  assert((await browser.evaluate(`api('document-query',{action:'topic',topic:${JSON.stringify(guide)}})`)).topic);
  await browser.screenshot(join(output,'missing-file.png'));
  await cleanup();
  const expectedNetwork = browser.errors.filter(error=>error.source==='network' && error.text?.includes('409'));
  assert.equal(expectedNetwork.length,rejectedInputs.length + 1);
  assert.deepEqual(browser.errors.filter(error=>!expectedNetwork.includes(error)),[]);
  await writeFile(join(output,'result.json'), JSON.stringify({typedCommands:true,searches,defaultInput,
    emptyPlan,defaultFileAccessed:false,relativePath,malformedRejected:malformed.length,missingTopicRejected:true,
    missingFileRejected:true,ownedFileAndJobsRemoved:true,sessionReleased,expectedNetworkErrors:expectedNetwork},null,2));
  console.log('PASS typed commands, search semantics/options, empty/default pathname parsing, relative Save/Read, malformed/read-eval rejection, and owned cleanup');
} catch (error) {
  await writeFile(join(output,'failure-session.json'), JSON.stringify(await browser.evaluate('state'),null,2));
  await writeFile(join(output,'failure-api.json'),JSON.stringify(await browser.evaluate('window.examinerRequests'),null,2));
  await browser.screenshot(join(output,'failure.png'));
  throw error;
} finally {
  try { if (!sessionReleased) await cleanup(); }
  finally { await browser.close(); }
}
