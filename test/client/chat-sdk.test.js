import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startAdapter } from '../../src/server.js';
import { testRoot } from '../helpers/codex.js';
import { startFakeWire, done } from '../helpers/fake-wire.js';

const sdk = resolve(process.env.XENOLITH_BRIDGE_OPENAI_SDK ?? '.test-artifacts/chat-sdk/node_modules/openai/index.mjs');
const { default: OpenAI } = await import(pathToFileURL(sdk).href);

test('OpenAI SDK parses JSON, accumulates streamed calls and returns their result after restart', async t => {
  const root = await testRoot('chat-sdk');let turn = 0;
  const fake = await startFakeWire(root, { durable: true, persistent: true, generate: async ({ send }) => {
    if (++turn === 2) {
      await send({ event: 'toolcall_end', id: 28, name: 'read', arguments: { path: 'example.txt' } });
      await send(done('tool_use'));
    } else {
      await send({ event: 'text_delta', text: 'ready' });await send(done());
    }
  } });
  let adapter;
  t.after(async () => { try { await adapter?.close(); } finally { await fake.close(); } });
  async function start() {
    adapter = await startAdapter({ socketPath: fake.socketPath, stateDir: join(root, 'state') });
    return new OpenAI({ baseURL: adapter.baseUrl, apiKey: 'local-test', maxRetries: 0,
      defaultHeaders: { 'X-Xenolith-Session': 'sdk-conversation' } });
  }
  let client = await start();const messages = [{ role: 'user', content: 'hello' }];
  const first = await client.chat.completions.create({ model: adapter.info.model, messages });
  assert.equal(first.choices[0].message.content, 'ready');
  messages.push(first.choices[0].message, { role: 'user', content: 'read the file' });
  const tools = [{ type: 'function', function: { name: 'read', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  } } }];
  const stream = client.chat.completions.stream({ model: adapter.info.model, messages, tools,
    stream_options: { include_usage: true } });
  const second = await stream.finalChatCompletion();
  const assistant = second.choices[0].message;
  assert.equal(second.choices[0].finish_reason, 'tool_calls');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"path":"example.txt"}');
  assert.equal(second.usage.prompt_tokens, 15);
  await adapter.close();client = await start();
  messages.push(assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'retained-result' });
  const final = await client.chat.completions.create({ model: adapter.info.model, messages, tools, stream: true });
  let text = '';for await (const chunk of final) text += chunk.choices[0]?.delta.content ?? '';
  assert.equal(text, 'ready');
  assert.ok(fake.requests.some(r => r.op === 'append' && r.call_id === 28 && r.text === 'retained-result'));
});

test('OpenAI SDK surfaces a streaming engine failure as an error', async t => {
  const root = await testRoot('chat-sdk-error');
  const fake = await startFakeWire(root, { generate: async ({ send }) => {
    await send({ event: 'error', code: 'io_error', error: 'simulated failure' });
  } });
  let adapter;t.after(async () => { try { await adapter?.close(); } finally { await fake.close(); } });
  adapter = await startAdapter({ socketPath: fake.socketPath });
  const client = new OpenAI({ baseURL: adapter.baseUrl, apiKey: 'local-test', maxRetries: 0 });
  await assert.rejects(async () => {
    const stream = await client.chat.completions.create({ model: adapter.info.model,
      messages: [{ role: 'user', content: 'hello' }], stream: true });
    for await (const chunk of stream) assert.equal(chunk.choices[0].finish_reason, null);
  }, /simulated failure/);
});
