import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBrowser } from './browser-test-support.mjs';

const url = process.argv[2] ?? 'http://localhost:8765/';
const output = resolve(process.argv[3] ?? 'browser-https-results');
function jsonInput(value) {
  return `(com.inuoe.jzon:parse ${JSON.stringify(JSON.stringify(value))})`;
}
const toolDefinition = jsonInput({
  type: 'function', name: 'lispm_test_value', description: 'Request the test value.', strict: true,
  parameters: {type: 'object', properties: {value: {type: 'integer', enum: [7]}},
    required: ['value'], additionalProperties: false},
});
const answerFormat = jsonInput({
  type: 'json_schema', name: 'answer', strict: true,
  schema: {type: 'object', properties: {answer: {type: 'integer'}},
    required: ['answer'], additionalProperties: false},
});
const inputMessages = jsonInput([{role: 'user', content: 'Request the test value.'}]);
const toolResult = JSON.stringify(JSON.stringify({answer: 8}));
const cases = [
  {
    name: 'complete',
    source: '(complete "Reply with exactly: Browser completion works.")',
    check(values) {
      assert.equal(values.length, 4);
      assert(values[0].includes('Browser completion works.'));
      assert.match(values[1], /HASH-TABLE/i);
      assert.match(values[2], /^"req_/);
      assert.equal(values[3], 'NIL');
    },
  },
  {
    name: 'complete-messages',
    source: `(complete '((:role :developer :content "Follow the supplied schema.")
                         (:role :user :content "Put the integer 42 in the answer field."))
                       :model "gpt-4.1-nano-2025-04-14" :temperature 0
                       :max-output-tokens 128 :text-format ${answerFormat})`,
    check(values) {
      assert.equal(values.length, 4);
      assert.equal(JSON.parse(JSON.parse(values[0])).answer, 42);
      assert.equal(values[3], 'NIL');
    },
  },
  {
    name: 'complete-tool-call',
    source: `(complete "Request the test value using the provided function."
                       :tools (vector ${toolDefinition}) :tool-choice "lispm_test_value"
                       :max-output-tokens 128)`,
    check(values) {
      assert.equal(values.length, 4);
      assert.equal(values[0], 'NIL');
      assert.match(values[3], /:CALL-ID "call_/i);
      assert.match(values[3], /:NAME "lispm_test_value"/i);
      assert.match(values[3], /:ARGUMENTS #<HASH-TABLE/i);
    },
  },
  {
    name: 'complete-tool-result',
    source: `(let* ((input ${inputMessages})
                    (tools (vector ${toolDefinition})))
               (multiple-value-bind (text response id calls)
                   (complete input :tools tools :tool-choice :required :max-output-tokens 128)
                 (declare (ignore text id))
                 (assert (= (length calls) 1))
                 (assert (= (gethash "value" (getf (first calls) :arguments)) 7))
                 (let ((result (make-hash-table :test 'equal)))
                   (setf (gethash "type" result) "function_call_output"
                         (gethash "call_id" result) (getf (first calls) :call-id)
                         (gethash "output" result) ${toolResult})
                   (complete (concatenate 'vector input (gethash "output" response) (vector result))
                             :tools tools :tool-choice :none :top-p 1 :max-output-tokens 128
                             :instructions "Return the answer supplied by the function."
                             :text-format ${answerFormat}))))`,
    check(values) {
      assert.equal(values.length, 4);
      assert.equal(JSON.parse(JSON.parse(values[0])).answer, 8);
      assert.equal(values[3], 'NIL');
    },
  },
  {
    name: 'complete-api-error',
    source: `(handler-case (complete "Test" :model "lispm-nonexistent-model-for-test")
               (lispm-openai:http-error (condition)
                 (assert (stringp (lispm-openai:http-error-request-id condition)))
                 (assert (hash-table-p (com.inuoe.jzon:parse (lispm-openai:http-error-body condition))))
                 (values :expected-http-error (lispm-openai:http-error-status condition))))`,
    check(values) {
      assert.equal(values.length, 2);
      assert.equal(values[0], ':EXPECTED-HTTP-ERROR');
      assert(['400', '404'].includes(values[1]));
    },
  },
  {
    name: 'curl-text',
    source: '(curl "https://example.org/")',
    check(values) {
      assert.equal(values.length, 3);
      assert(values[0].includes('Example Domain'));
      assert.equal(values[1], '200');
      assert.match(values[2], /:content-type\b/i);
    },
  },
  {
    name: 'curl-http-error',
    source: '(curl "https://api.openai.com/v1/models")',
    check(values) {
      assert.equal(values.length, 3);
      assert.match(values[0], /^#\(/);
      assert.equal(values[1], '401');
      assert.match(values[2], /application\/json/i);
    },
  },
];
await mkdir(output, { recursive: true });
const browser = await openBrowser(url);
const owned = [];
let session;
try {
  await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
  session = await browser.evaluate('state.session');
  for (const test of cases) {
    await browser.waitFor("typeof connected !== 'undefined' && connected && !busy");
    const previous = await browser.evaluate('state.inputHistory.map(item => item.name)');
    const started = Date.now();
    await browser.click('#source');
    await browser.send('Input.insertText', { text: test.source });
    for (const type of ['keyDown', 'keyUp'])
      await browser.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await browser.waitFor(`state.inputHistory.some(item => !${JSON.stringify(previous)}.includes(item.name))`);
    const name = await browser.evaluate(`state.inputHistory.find(item => !${JSON.stringify(previous)}.includes(item.name)).name`);
    owned.push(name);
    await writeFile(join(output, 'owned-fixtures.json'), JSON.stringify({session, jobs: owned}, null, 2));
    const view = `views.get(${JSON.stringify(name)})`;
    await browser.waitFor(`${view}?.info && (${view}.info.state !== ':running' || ${view}.info.stops?.length)`, 120);
    const result = await browser.evaluate(`({
      name: ${JSON.stringify(name)},
      info: ${view}.info,
      displayed: ${view}.values.textContent,
      visible: !${view}.element.hidden && ${view}.values.getBoundingClientRect().height > 0
    })`);
    result.elapsedMilliseconds = Date.now() - started;
    await writeFile(join(output, test.name + '.json'), JSON.stringify(result, null, 2));
    await browser.screenshot(join(output, test.name + '.png'));
    assert.equal(result.info.state, ':returned');
    assert.equal((result.info.stops ?? []).length, 0);
    test.check(result.info.values);
    assert.equal(result.displayed, result.info.values.join('\n'));
    assert.equal(result.visible, true);
    assert.deepEqual(browser.errors, []);
    console.log(`PASS browser ${test.name} in ${result.elapsedMilliseconds} ms`);
  }
  assert.equal(await browser.evaluate('state.session'), session);
  await browser.evaluate(`(async () => {
    for (const name of ${JSON.stringify(owned)}) {
      const job = state.jobs[name];
      if (!job?.token) throw new Error('Owned HTTPS job token is missing: ' + name);
      await mutate('release-job', {job: job.token});
    }
    await mutate('release-session', {});
  })()`);
  assert.equal(await browser.evaluate('connected'), false);
  for (const name of owned) assert.equal(await browser.evaluate(`Boolean(state.jobs[${JSON.stringify(name)}])`), false);
  assert.deepEqual(browser.errors, []);
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({session, releasedJobs: owned, sessionReleased: true}, null, 2));
  console.log('PASS owned HTTPS evaluations and session released');
} catch (error) {
  await writeFile(join(output, 'failure-fixtures.json'), JSON.stringify({session, jobs: owned,
    state: await browser.evaluate('state'), error: error.stack, browserErrors: browser.errors}, null, 2));
  await browser.screenshot(join(output, 'failure.png'));
  throw error;
} finally {
  await browser.close();
}
