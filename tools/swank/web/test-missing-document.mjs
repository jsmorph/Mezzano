import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8765/';
const output = resolve(process.argv[3] ?? 'missing-document-results');
await mkdir(output, {recursive: true});
const browser = await openBrowser(url);
const marker = randomBytes(8).toString('hex');
const missing = {id: 'doc/removed-' + marker + '.md', title: 'Removed document'};
const child = {id: 'doc/project-guide.md#removed-' + marker, title: 'Removed heading'};
const controlled = {id: 'doc/response-' + marker + '.md', title: 'Controlled response'};
const text = JSON.stringify;
try {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  const initial = await browser.evaluate('api("document-query",{action:"topic",topic:"doc/project-guide.md"})');
  const valid = initial.sections.map(section => ({topic:section.topic, level:section.level, query:initial.topic.id}));
  const bookmarks = [missing, initial.topic, child].map(topic => ({topic, viewed:true}));
  const retained = {name:'Retained references', sections:[
    {topic:missing, level:0, query:missing.id}, ...valid,
    {topic:child, level:1, query:initial.topic.id}],
    bookmarks, candidates:[], candidateIndex:-1, current:missing.id, scroll:0};
  await browser.evaluate(`state.examiner={current:${text(retained.name)},previous:null,viewers:[${text(retained)}]};save()`);
  for (let pass = 0; pass < 2; pass++) {
    await browser.send('Page.reload');
    await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
    await browser.evaluate('showActivity("examiner")');
    await browser.waitFor("!busy && document.querySelectorAll('#examiner-topics .document-unavailable').length === 2");
    assert.equal(await browser.evaluate('connected'), true);
    assert.deepEqual(await browser.evaluate('state.examiner.viewers[0].bookmarks'), bookmarks);
    assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#examiner-topics .document-unavailable')].map(item=>item.dataset.topic)"), [missing.id,child.id]);
    assert.equal(await browser.evaluate("document.querySelectorAll('#examiner-topics .document-section:not(.document-unavailable)').length"), valid.length);
    assert(await browser.evaluate("[...document.querySelectorAll('.document-unavailable')].every(item=>item.textContent.includes('Topic unavailable:'))"));
  }
  await browser.screenshot(join(output,'retained-topics.png'));
  console.log('PASS missing document and child remain visible beside valid content, with unchanged bookmarks after reload');

  await browser.evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.documentResponse = 'transport';
    window.fetch = async (url, options) => {
      const request = options?.body && JSON.parse(options.body);
      if (request?.operation === 'document-query' && request.arguments.action === 'topic' && request.arguments.topic === ${text(controlled.id)}) {
        if (window.documentResponse === 'transport') return new Response(JSON.stringify({error:'Controlled transport failure',uncertain:true}),{status:502});
        if (window.documentResponse === 'missing') return new Response(JSON.stringify({error:':missing-topic',uncertain:false}),{status:409});
        return new Response(JSON.stringify({value:{topic:${text(controlled)},sections:[{topic:${text(controlled)},level:0,blocks:[{kind:':paragraph',content:[{kind:':text',text:'Topic restored.'}]}]}]}}),{status:200});
      }
      return original(url,options);
    };
    state.examiner.viewers.push({name:'Response classification',sections:[{topic:${text(controlled)},level:0,query:${text(controlled.id)}}],bookmarks:[{topic:${text(controlled)},viewed:true}],candidates:[],candidateIndex:-1,current:${text(controlled.id)},scroll:0});
    state.examiner.current='Response classification';save();
  })()`);
  await browser.evaluate('run(()=>examiner.show())');
  assert.equal(await browser.evaluate('connected'), false);
  assert.equal(await browser.evaluate("document.querySelector('#message').textContent"),'Controlled transport failure');
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.document-unavailable')].some(item=>item.dataset.topic===${text(controlled.id)})`),false);
  await browser.evaluate("window.documentResponse='missing';run(async()=>{await connect();await examiner.show()})");
  await browser.waitFor(`connected && !busy && [...document.querySelectorAll('.document-unavailable')].some(item=>item.dataset.topic===${text(controlled.id)})`);
  await browser.evaluate("window.documentResponse='restored'");
  await browser.click('#examiner-bookmarks .document-topic');
  await browser.waitFor("!busy && document.querySelector('#examiner-topics').textContent.includes('Topic restored.')");
  assert.equal(await browser.evaluate("document.querySelectorAll('.document-unavailable').length"),0);
  assert.equal(await browser.evaluate('state.examiner.viewers[1].bookmarks.length'),1);
  await browser.screenshot(join(output,'restored-topic.png'));
  console.log('PASS controlled transport failure stays distinct; later lookup replaces unavailable content');

  await browser.evaluate('run(async()=>{await api("release-session");connected=false})');
  assert.equal(await browser.evaluate('connected'),false);
  assert.equal(browser.errors.length,4);
  assert(browser.errors.every(error=>error.source==='network' && error.text.includes('status of 409')));
  await writeFile(join(output,'result.json'),JSON.stringify({liveMissingTopics:true,controlledResponses:true,sessionReleased:true,expectedHTTP409:4,errors:browser.errors},null,2));
  console.log('PASS owned session released; four expected HTTP 409 responses and no unexpected browser errors');
} catch (error) {
  await writeFile(join(output,'failure-session.json'),JSON.stringify(await browser.evaluate('state'),null,2));
  await browser.screenshot(join(output,'failure.png'));
  throw error;
} finally { await browser.close(); }
