import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startAdapter } from '../src/server.js';
import { testRoot } from './helpers/codex.js';
import { startFakeWire, done, delay, description } from './helpers/fake-wire.js';

const base = { model: description.model, stream: true, store: false, input: 'hello' };
const tool = { type: 'function', name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } };

async function setup(t, options = {}, adapterOptions = {}) {
  const root = await testRoot('unit');
  const fake = await startFakeWire(root, options);
  let adapter;
  t.after(async () => { try { await adapter?.close(); } finally { await fake.close(); } });
  adapter = await startAdapter({ socketPath: fake.socketPath, ...adapterOptions });
  return { fake, adapter };
}

function eventsOf(text) {
  return text.split('\n\n').flatMap(frame => {
    const line = frame.split('\n').find(line => line.startsWith('data: '));
    return line ? [JSON.parse(line.slice(6))] : [];
  });
}

async function post(adapter, body = base) {
  const response = await fetch(`${adapter.baseUrl}/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, events: eventsOf(text) };
}

test('explicit session header requires a session mode instead of silently using ephemeral inference', async t => {
  const { adapter, fake } = await setup(t);
  const before = fake.requests.length;
  const response = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST', headers: {
    'content-type': 'application/json', 'X-Xenolith-Session': 'conversation-A',
  }, body: JSON.stringify(base) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /--state-dir or --reuse-kv/);
  assert.equal(fake.requests.length, before);
});

test('explicit session header also enables process-local KV reuse', async t => {
  const { adapter, fake } = await setup(t, { durable: true }, { reuseKv: true });
  for (const input of ['hello', [{ role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Ciao 🌋' }, { role: 'user', content: 'next' }]]) {
    const response = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST', headers: {
      'content-type': 'application/json', 'X-Xenolith-Session': 'conversation-A',
    }, body: JSON.stringify({ ...base, input }) });
    assert.equal(response.status, 200);
    assert.equal(eventsOf(await response.text()).at(-1).type, 'response.completed');
  }
  assert.equal(fake.requests.filter(r => r.op === 'create').length, 1);
  assert.equal(fake.requests.filter(r => r.op === 'rebuild').length, 1);
  assert.ok(fake.requests.some(r => r.op === 'append'));
  assert.ok(!fake.requests.some(r => r.op === 'ephemeral'));
});

test('real HTTP streaming arrives before terminal, fragmented UTF-8 survives', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { adapter, fake } = await setup(t, { fragment: true, generate: async ({ send }) => {
    await send({ event: 'start' });
    await send({ event: 'text_delta', text: 'Ciao 🌋' });
    await gate;
    await send({ event: 'text_delta', text: '\n世界' });
    await send(done());
  } });
  const response = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(base) });
  const reader = response.body.getReader();
  let text = '';
  const decoder = new TextDecoder();
  while (!text.includes('Ciao 🌋')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.ok(!text.includes('response.completed'));
  release();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  const events = eventsOf(text);
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'Ciao 🌋\n世界');
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, index) => index));
  assert.equal(events.at(-1).response.usage.total_tokens, 18);
  assert.equal(events.at(-1).response.xenolith_usage.total, 100);
  assert.deepEqual(fake.requests.map(r => r.op), ['describe', 'describe', 'ephemeral']);
});

test('no executable tool item is emitted before Xenolith commits done', async t => {
  let committed = false;
  const { adapter } = await setup(t, { generate: async ({ send }) => {
    await send({ event: 'toolcall_start', id: 7, name: 'read' });
    await send({ event: 'toolcall_end', id: 7, name: 'read', arguments: { path: 'a' } });
    await delay(50);
    committed = true;
    await send(done('tool_use'));
  } });
  const response = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, tools: [tool] }) });
  let text = '';
  for await (const chunk of response.body) {
    text += Buffer.from(chunk).toString('utf8');
    if (text.includes('function_call')) assert.ok(committed);
  }
  const item = eventsOf(text).find(e => e.type === 'response.output_item.done').item;
  assert.equal(item.arguments, '{"path":"a"}');
  assert.equal(item.name, 'read');
  assert.equal(typeof item.call_id, 'string');
});

test('complete custom namespace tool roundtrip through HTTP and wire', async t => {
  const declarations = [{ type: 'namespace', name: 'edits', tools: [{ type: 'custom', name: 'patch', description: 'Patch' }] }];
  let finalInput;
  const { adapter } = await setup(t, { generate: async ({ request, send }) => {
    const result = request.messages.find(m => m.role === 'tool');
    if (!result) {
      await send({ event: 'toolcall_start', id: 1, name: request.tools[0].name });
      await send({ event: 'toolcall_end', id: 1, name: request.tools[0].name, arguments: { input: 'line 1\nline 2' } });
      await send(done('tool_use'));
    } else {
      finalInput = result;
      await send({ event: 'text_delta', text: result.text });
      await send(done());
    }
  } });
  const first = await post(adapter, { ...base, tools: declarations });
  const call = first.events.at(-1).response.output[0];
  assert.equal(call.type, 'custom_tool_call');
  assert.equal(call.namespace, 'edits');
  assert.equal(call.name, 'patch');
  const clientResult = call.input.toUpperCase(); // External client executes the test tool.
  const second = await post(adapter, { ...base, tools: declarations, input: [
    { role: 'user', content: 'hello' }, call,
    { type: 'custom_tool_call_output', call_id: call.call_id, output: clientResult },
  ] });
  assert.equal(finalInput.text, 'LINE 1\nLINE 2');
  assert.equal(second.events.at(-1).response.output[0].content[0].text, clientResult);
});

for (const [name, generate, expected] of [
  ['wire rejects generation', async ({ send }) => send({ ok: false, code: 'context_length_exceeded', error: 'Too many tokens' }), 'response.failed'],
  ['wire error after partial text', async ({ send }) => { await send({ event: 'text_delta', text: 'partial' }); await send({ event: 'error', code: 'io_error', error: 'disk failure' }); }, 'response.failed'],
  ['EOF after partial text', async ({ send, socket }) => { await send({ event: 'text_delta', text: 'partial' }); socket.end(); }, 'response.failed'],
  ['malformed frame', async ({ socket }) => socket.write('not JSON\n'), 'response.failed'],
  ['length stop', async ({ send }) => { await send({ event: 'text_delta', text: 'partial' }); await send(done('length')); }, 'response.incomplete'],
  ['aborted stop', async ({ send }) => send(done('aborted')), 'response.failed'],
  ['uncommitted tool on error', async ({ send }) => { await send({ event: 'toolcall_end', id: 1, name: 'read', arguments: {} }); await send({ event: 'error', code: 'io_error', error: 'Commit failed' }); }, 'response.failed'],
  ['invalid accounting before tool publication', async ({ send }) => {
    await send({ event: 'toolcall_end', id: 1, name: 'read', arguments: {} });
    await send({ ...done('tool_use'), usage: {} });
  }, 'response.failed'],
]) {
  test(name, async t => {
    const { adapter } = await setup(t, { generate });
    const { events } = await post(adapter, { ...base, tools: [tool] });
    assert.equal(events.at(-1).type, expected);
    assert.ok(!events.some(e => e.type === 'response.completed'));
    if (name.includes('tool')) assert.ok(!events.some(e => e.item?.type === 'function_call'));
  });
}

test('unsupported capabilities fail as HTTP errors before generating', async t => {
  const { adapter, fake } = await setup(t);
  const result = await post(adapter, { ...base, previous_response_id: 'x' });
  assert.equal(result.response.status, 400);
  assert.equal(JSON.parse(result.text).error.code, 'unsupported_feature');
  assert.ok(!fake.requests.some(r => r.op === 'ephemeral'));
});

test('frame limit is checked before starting SSE', async t => {
  const { adapter } = await setup(t, { info: { ...description, max_frame: 256 } });
  const result = await post(adapter, { ...base, input: 'a'.repeat(300) });
  assert.equal(result.response.status, 413);
  assert.equal(JSON.parse(result.text).error.code, 'invalid_request');
});

test('disconnected HTTP client sends cancel on the generating connection', async t => {
  let cancellation;
  const observed = new Promise(resolve => { cancellation = resolve; });
  const { adapter, fake } = await setup(t, { generate: async ({ send, cancelled }) => {
    await send({ event: 'text_delta', text: 'start' });
    for (let i = 0; i < 100 && !cancelled(); i++) await delay(10);
    if (cancelled()) cancellation();
    await send(done('aborted'));
  } });
  await new Promise((resolve, reject) => {
    const req = httpRequest(`${adapter.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.once('error', reject);
    req.end(JSON.stringify(base));
  });
  await Promise.race([observed, delay(2000).then(() => { throw new Error('No wire cancellation'); })]);
  assert.ok(fake.requests.some(r => r.op === 'cancel'));
});

test('heartbeat covers engine silence and generation timeout fails explicitly', async t => {
  const { adapter } = await setup(t, { generate: async () => delay(150) }, { heartbeatMs: 10, generationTimeoutMs: 80 });
  const result = await post(adapter);
  assert.ok(result.text.includes(': xenolith-bridge heartbeat'));
  assert.equal(result.events.at(-1).type, 'response.failed');
  assert.match(result.events.at(-1).response.error.message, /timed out/);
});

test('invalid discovery rejects adapter startup', async () => {
  const root = await testRoot('discovery');
  const fake = await startFakeWire(root, { info: { ...description, protocol: 2 } });
  try { await assert.rejects(startAdapter({ socketPath: fake.socketPath }), /describe/); }
  finally { await fake.close(); }
});
