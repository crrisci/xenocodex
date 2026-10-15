import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startAdapter } from '../../src/server.js';
import { testRoot } from '../helpers/codex.js';
import { startFakeWire, done } from '../helpers/fake-wire.js';

const sdk = resolve(process.env.XENOLITH_BRIDGE_OPENAI_SDK ?? '.test-artifacts/chat-sdk/node_modules/openai/index.mjs');
const { default: OpenAI } = await import(pathToFileURL(sdk).href);
const tool = { type: 'function', name: 'read', strict: false, parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} };

async function setup(t, generate, persistent = false) {
  const root = await testRoot('responses-sdk');
  const fake = await startFakeWire(root, { generate, durable: persistent, persistent });
  let adapter;
  t.after(async () => { try { await adapter?.close(); } finally { await fake.close(); } });
  const start = async () => {
    adapter = await startAdapter({ socketPath: fake.socketPath, ...(persistent ? { stateDir: join(root, 'state') } : {}) });
    return new OpenAI({ baseURL: adapter.baseUrl, apiKey: 'local-test', maxRetries: 0,
      ...(persistent ? { defaultHeaders: { 'X-Xenolith-Session': 'responses-sdk-conversation' } } : {}) });
  };
  return { root, fake, start, get adapter() { return adapter; } };
}

test('Responses SDK JSON and accumulated SSE preserve an actual tool result across restart', async t => {
  let turn = 0;
  const s = await setup(t, async ({ send }) => {
    if (++turn === 1) {
      await send({ event: 'toolcall_end', id: 41, name: 'read', arguments: { path: 'example.txt' } });
      await send(done('tool_use'));
    } else { await send({ event: 'text_delta', text: 'Result received 🌋' });await send(done()); }
  }, true);
  let client = await s.start();
  const input = [{ role: 'user', content: 'Read example.txt' }];
  const first = await client.responses.create({ model: s.adapter.info.model, input, tools: [tool], store: false });
  assert.equal(first.object, 'response');assert.equal(first.status, 'completed');
  assert.equal(first.output[0].type, 'function_call');
  assert.equal(first.output[0].arguments, '{"path":"example.txt"}');
  assert.equal(first.usage.input_tokens_details.cached_tokens, 5);
  assert.ok(first.xenolith_session.checkpoint.saved);
  const workspace = join(s.root, 'workspace');await mkdir(workspace);
  const nonce = randomUUID();await writeFile(join(workspace, 'example.txt'), nonce);
  const actualResult = await readFile(join(workspace, JSON.parse(first.output[0].arguments).path), 'utf8');
  await s.adapter.close();client = await s.start();
  const runner = client.responses.stream({ model: s.adapter.info.model, store: false, tools: [tool],
    input: [...input, ...first.output, { type: 'function_call_output', call_id: first.output[0].call_id, output: actualResult }] });
  const final = await runner.finalResponse();
  assert.equal(final.status, 'completed');assert.equal(final.output_text, 'Result received 🌋');
  assert.equal(final.output[0].content[0].text, final.output_text);
  assert.ok(s.fake.requests.some(r => r.op === 'append' && r.call_id === 41 && r.text === nonce));
  assert.deepEqual(s.fake.errors, []);
});

test('Responses SDK stream yields text before the terminal and exposes final output_text', async t => {
  let release;const gate = new Promise(resolve => { release = resolve; });t.after(() => release());
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'text_delta', text: 'first' });await gate;
    await send({ event: 'text_delta', text: ' second' });await send(done());
  });
  const client = await s.start();
  const runner = client.responses.stream({ model: s.adapter.info.model, input: 'hello', store: false });
  let partial = '';
  for await (const event of runner) {
    if (event.type === 'response.output_text.delta') {
      partial += event.delta;
      if (partial === 'first') release();
    }
  }
  assert.equal(partial, 'first second');assert.equal((await runner.finalResponse()).output_text, partial);
});

for (const stream of [false, true]) {
  test(`Responses SDK output cap is incomplete, not a successful full answer (stream:${stream})`, async t => {
    const s = await setup(t, async ({ send }) => {
      await send({ event: 'text_delta', text: 'partial' });await send(done('length'));
    });
    const client = await s.start();const params = { model: s.adapter.info.model, input: 'hello', store: false };
    const response = stream ? await client.responses.stream(params).finalResponse() : await client.responses.create(params);
    assert.equal(response.status, 'incomplete');assert.equal(response.incomplete_details.reason, 'max_output_tokens');
    assert.equal(response.output_text, 'partial');
  });
}

test('Responses SDK receives a JSON engine error without leaking partial output or calls', async t => {
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'text_delta', text: 'uncommitted' });
    await send({ event: 'toolcall_end', id: 1, name: 'read', arguments: {} });
    await send({ event: 'error', code: 'io_error', error: 'simulated disk failure' });
  });
  const client = await s.start();
  await assert.rejects(client.responses.create({ model: s.adapter.info.model, input: 'hello', tools: [tool] }), e => {
    assert.equal(e.status, 502);assert.equal(e.code, 'io_error');
    assert.ok(!JSON.stringify(e.error).includes('uncommitted'));
    return /simulated disk failure/.test(e.message);
  });
});

test('Responses SDK surfaces a typed failed streaming response and never a successful completion', async t => {
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'text_delta', text: 'partial' });await send(done('aborted'));
  });
  const client = await s.start();
  const runner = client.responses.stream({ model: s.adapter.info.model, input: 'hello', store: false });
  const response = await runner.finalResponse();
  assert.equal(response.status, 'failed');assert.equal(response.error.code, 'io_error');
  assert.ok(!response.output.some(i => i.type === 'function_call'));
});

test('Responses SDK can disable tools while returning historical tool results', async t => {
  const s = await setup(t, async ({ request, send }) => {
    assert.deepEqual(request.tools, []);assert.ok(request.messages.some(m => m.role === 'tool' && m.text === 'past result'));
    await send({ event: 'text_delta', text: 'summary' });await send(done());
  });
  const client = await s.start();
  const response = await client.responses.create({ model: s.adapter.info.model, tool_choice: 'none', tools: [tool], input: [
    { role: 'user', content: 'Read' }, { type: 'function_call', call_id: 'past', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'past', output: 'past result' }, { role: 'user', content: 'Summarize' },
  ] });
  assert.equal(response.output_text, 'summary');
});
