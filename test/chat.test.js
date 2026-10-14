import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startAdapter } from '../src/server.js';
import { testRoot } from './helpers/codex.js';
import { startFakeWire, done, description, delay } from './helpers/fake-wire.js';

const base = { model: description.model, messages: [{ role: 'user', content: 'hello' }] };
const tool = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } };
async function setup(t, options = {}, persistent = false) {
  const root = await testRoot('chat');const stateDir = join(root, 'state');
  const fake = await startFakeWire(root, { ...options, ...(persistent ? { durable: true, persistent: true } : {}) });
  let adapter;
  const start = async () => adapter = await startAdapter({ socketPath: fake.socketPath, ...(persistent ? { stateDir } : {}) });
  const close = async () => { await adapter?.close();adapter = undefined; };
  t.after(async () => { try { await close(); } finally { await fake.close(); } });
  return { fake, root, stateDir, start, close };
}
function chunks(raw) {
  return raw.split('\n').filter(line => line.startsWith('data: ')).map(line =>
    line === 'data: [DONE]' ? '[DONE]' : JSON.parse(line.slice(6)));
}
async function request(adapter, body, headers = {}, options = {}) {
  return fetch(`${adapter.baseUrl}/chat/completions`, { method: 'POST', headers: {
    'content-type': 'application/json', ...headers }, body: JSON.stringify(body), ...options });
}

test('Chat text streams before done with data-only chunks, usage and DONE sentinel', async t => {
  let release;const gate = new Promise(resolve => { release = resolve; });t.after(() => release());
  const s = await setup(t, { fragment: true, generate: async ({ send }) => {
    await send({ event: 'text_delta', text: 'Hello 🌋' });await gate;
    await send({ event: 'text_delta', text: ' world' });await send(done());
  } });
  const response = await request(await s.start(), { ...base, stream: true, stream_options: { include_usage: true } });
  assert.equal(response.status, 200);assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();const decoder = new TextDecoder();let raw = '';
  while (!raw.includes('Hello 🌋')) raw += decoder.decode((await reader.read()).value, { stream: true });
  assert.ok(!raw.includes('[DONE]'));release();
  for (;;) { const part = await reader.read();if (part.done) break;raw += decoder.decode(part.value, { stream: true }); }
  assert.ok(!raw.includes('event: '));
  const events = chunks(raw);assert.equal(events.at(-1), '[DONE]');
  const data = events.slice(0, -1);
  assert.ok(data.every(e => e.object === 'chat.completion.chunk' && e.id === data[0].id));
  assert.equal(data[0].choices[0].delta.role, 'assistant');
  assert.equal(data.flatMap(e => e.choices).map(c => c.delta.content ?? '').join(''), 'Hello 🌋 world');
  assert.equal(data.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(data.at(-1).choices, []);
  assert.equal(data.at(-1).usage.prompt_tokens, 15);assert.equal(data.at(-1).usage.total_tokens, 18);
  assert.ok(data.slice(0, -1).every(e => e.usage === null));
});

test('Chat defaults to a complete JSON response and maps text parts, instructions and output cap', async t => {
  const s = await setup(t);const response = await request(await s.start(), { ...base, max_completion_tokens: 100,
    messages: [{ role: 'system', content: 'Be concise' }, { role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
  assert.equal(response.status, 200);assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Ciao 🌋');assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 5);
  const wire = s.fake.requests.find(r => r.op === 'ephemeral');
  assert.equal(wire.system, 'Be concise');assert.equal(wire.max_tokens, 100);
  assert.deepEqual(wire.messages, [{ role: 'user', text: 'hello' }]);
});

test('Chat tool result roundtrip persists native IDs across bridge restart', async t => {
  let turn = 0;
  const s = await setup(t, { generate: async ({ send }) => {
    if (++turn === 1) {
      await send({ event: 'toolcall_end', id: 81, name: 'read', arguments: {} });await send(done('tool_use'));
    } else {
      await send({ event: 'text_delta', text: 'File received' });await send(done());
    }
  } }, true);
  const secret = randomUUID();const file = join(s.root, 'tool-input.txt');await writeFile(file, secret);
  const headers = { 'X-Xenolith-Session': 'chat-tool-test' };
  const first = await request(await s.start(), { ...base, tools: [tool] }, headers);
  const answer = await first.json();assert.equal(answer.choices[0].finish_reason, 'tool_calls');
  const assistant = answer.choices[0].message;assert.equal(assistant.content, null);
  assert.equal(assistant.tool_calls.length, 1);assert.equal(assistant.tool_calls[0].function.name, 'read');
  const bindingFile = (await readdir(s.stateDir)).find(name => name.endsWith('.json'));
  const saved = JSON.parse(await readFile(join(s.stateDir, bindingFile), 'utf8'));
  assert.equal(saved.inFlight, false);assert.equal(saved.pending[0].id, 81);
  // The client executes the requested read exactly here, then retains its result.
  const result = await readFile(file, 'utf8');await s.close();
  const second = await request(await s.start(), { ...base, stream: true, tools: [tool], messages: [
    ...base.messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: result },
  ] }, headers);
  const events = chunks(await second.text());assert.equal(events.at(-1), '[DONE]');
  assert.equal(events.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(s.fake.requests.find(r => r.op === 'append'), { op: 'append', role: 'tool', call_id: 81, text: secret, status: 'ok' });
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 1);
  assert.equal(JSON.parse(await readFile(join(s.stateDir, bindingFile), 'utf8')).session, saved.session);
  assert.ok(!s.fake.requests.some(r => ['ephemeral', 'delete'].includes(r.op)));
});

test('Chat holds every tool chunk until terminal validation and durable binding commit', async t => {
  let release;const gate = new Promise(resolve => { release = resolve; });t.after(() => release());
  const s = await setup(t, { generate: async ({ send }) => {
    await send({ event: 'toolcall_end', id: 1, name: 'read', arguments: {} });await gate;await send(done('tool_use'));
  } }, true);
  const response = await request(await s.start(), { ...base, stream: true, tools: [tool], prompt_cache_key: 'held' });
  const reader = response.body.getReader();const decoder = new TextDecoder();
  let raw = decoder.decode((await reader.read()).value);assert.ok(!raw.includes('tool_calls'));
  release();
  for (;;) {
    const part = await reader.read();if (part.done) break;raw += decoder.decode(part.value);
    if (raw.includes('tool_calls')) {
      const name = (await readdir(s.stateDir)).find(n => n.endsWith('.json'));
      const record = JSON.parse(await readFile(join(s.stateDir, name), 'utf8'));
      assert.equal(record.inFlight, false);assert.equal(record.pending[0].id, 1);
    }
  }
  const events = chunks(raw);assert.equal(events.at(-2).choices[0].finish_reason, 'tool_calls');
  const call = events.flatMap(e => e.choices ?? []).flatMap(c => c.delta.tool_calls ?? [])[0];
  assert.equal(call.index, 0);assert.equal(call.function.arguments, '{}');
});

for (const stream of [false, true]) {
  test(`Chat rejects incomplete tool transactions without publishing calls (stream:${stream})`, async t => {
    const s = await setup(t, { generate: async ({ send }) => {
      await send({ event: 'toolcall_end', id: 1, name: 'read', arguments: {} });
      await send({ event: 'toolcall_end', id: 2, name: 'undeclared', arguments: {} });await send(done('tool_use'));
    } });
    const response = await request(await s.start(), { ...base, tools: [tool], stream });
    const raw = await response.text();assert.ok(!raw.includes('"tool_calls"'));
    if (stream) { const events = chunks(raw);assert.ok(events.some(e => e.error));assert.equal(events.at(-1), '[DONE]'); }
    else { assert.notEqual(response.status, 200);assert.ok(JSON.parse(raw).error); }
  });

  test(`Chat maps output limit to length, and engine abortion to error (stream:${stream})`, async t => {
    let turn = 0;const s = await setup(t, { generate: async ({ send }) => {
      await send({ event: 'text_delta', text: 'partial' });await send(done(++turn === 1 ? 'length' : 'aborted'));
    } });
    const adapter = await s.start();const first = await request(adapter, { ...base, stream });
    const raw = await first.text();
    assert.equal((stream ? chunks(raw).at(-2) : JSON.parse(raw)).choices[0].finish_reason, 'length');
    const second = await request(adapter, { ...base, stream });const failure = await second.text();
    assert.ok((stream ? chunks(failure).at(-2) : JSON.parse(failure)).error);
  });

  test(`Chat client disconnect cancels native generation (stream:${stream})`, async t => {
    let started;const generating = new Promise(resolve => { started = resolve; });
    const s = await setup(t, { generate: async ({ send, cancelled }) => {
      started();for (let i = 0; i < 200 && !cancelled(); i++) await delay(5);
      await send(done('aborted'));
    } });
    const controller = new AbortController();
    const pending = request(await s.start(), { ...base, stream }, {}, { signal: controller.signal })
      .then(response => response.text()).catch(error => error.name);
    await generating;controller.abort();await pending;
    for (let i = 0; i < 100 && !s.fake.requests.some(r => r.op === 'cancel'); i++) await delay(5);
    assert.ok(s.fake.requests.some(r => r.op === 'cancel'));
  });
}

test('unsupported Chat controls and malformed histories fail before wire inference', async t => {
  const s = await setup(t);const adapter = await s.start();const before = s.fake.requests.length;
  for (const change of [{ n: 2 }, { stop: ['END'] }, { response_format: { type: 'json_object' } },
    { reasoning_effort: 'high' }, { stream: true, stream_options: { include_usage: 'yes' } },
    { max_tokens: 5, max_completion_tokens: 10 }, { tool_choice: 'required' },
    { tools: [{ type: 'function', function: { ...tool.function, strict: true } }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///unused' } }] }] },
    { messages: [...base.messages, { role: 'tool', tool_call_id: 'unknown', content: 'result' }] },
    { messages: [{ role: 'assistant', content: null }] },
    { messages: [...base.messages, { role: 'assistant', content: 'text', parsed: { value: 1 } }] },
    { messages: [...base.messages, { role: 'assistant', content: 'text', refusal: 'refused' }] }]) {
    const response = await request(adapter, { ...base, ...change });
    assert.equal(response.status, 400, JSON.stringify(change));assert.ok((await response.json()).error);
  }
  assert.equal(s.fake.requests.length, before);
});

test('Chat never publishes executable tool chunks if durable binding commit fails', async t => {
  const s = await setup(t, { generate: async ({ send }) => {
    await send({ event: 'toolcall_end', id: 9, name: 'read', arguments: {} });
    const name = (await readdir(s.stateDir)).find(n => n.endsWith('.json'));
    await unlink(join(s.stateDir, name));await mkdir(join(s.stateDir, name));
    await send(done('tool_use'));
  } }, true);
  const response = await request(await s.start(), { ...base, tools: [tool], stream: true, prompt_cache_key: 'failure' });
  const events = chunks(await response.text());
  assert.ok(events.some(e => e.error));assert.equal(events.at(-1), '[DONE]');
  assert.ok(!events.flatMap(e => e.choices ?? []).some(c => c.delta.tool_calls || c.finish_reason));
});

test('Chat and Responses share the same binding for an explicitly identified conversation', async t => {
  const s = await setup(t, {}, true);const adapter = await s.start();
  const first = await request(adapter, { ...base, prompt_cache_key: 'shared' });
  const assistant = (await first.json()).choices[0].message;
  const second = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Xenolith-Session': 'shared' },
    body: JSON.stringify({ model: base.model, stream: true, input: [...base.messages, assistant, { role: 'user', content: 'next' }] }) });
  assert.equal(second.status, 200);assert.match(await second.text(), /event: response.completed/);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 1);
  assert.ok(s.fake.requests.some(r => r.op === 'append' && r.text === 'next'));
});

for (const stream of [false, true]) {
  test(`Chat reports a rebuilt missing session without claiming KV restoration (stream:${stream})`, async t => {
    const s = await setup(t, {}, true);const adapter = await s.start();
    const first = await request(adapter, { ...base, prompt_cache_key: 'missing' });
    const assistant = (await first.json()).choices[0].message;s.fake.sessions.clear();
    const second = await request(adapter, { ...base, stream, prompt_cache_key: 'missing', messages: [
      ...base.messages, assistant, { role: 'user', content: 'next' },
    ] });
    assert.equal(second.status, 200);
    const raw = await second.text();const final = stream ? chunks(raw).at(-2) : JSON.parse(raw);
    assert.deepEqual(final.xenolith_session.recovery, {
      reason: 'session_not_found', source: 'client_history', previous_kv_restored: false,
    });
    assert.equal(final.xenolith_session.resume, null);
  });
}

test('Chat tool_choice:none removes executable declarations while retaining historical results', async t => {
  const s = await setup(t);const response = await request(await s.start(), { ...base, tool_choice: 'none', tools: [tool], messages: [
    ...base.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: 'old-result' },
  ] });
  assert.equal(response.status, 200);await response.json();
  const wire = s.fake.requests.find(r => r.op === 'ephemeral');assert.deepEqual(wire.tools, []);
  assert.equal(wire.messages.at(-1).text, 'old-result');
});
