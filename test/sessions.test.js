import test from 'node:test';
import assert from 'node:assert/strict';
import { startAdapter } from '../src/server.js';
import { startFakeWire, description, done, delay } from './helpers/fake-wire.js';
import { testRoot } from './helpers/codex.js';
import { SessionCache } from '../src/sessions.js';

const tool = { type: 'function', name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } };
const base = { model: description.model, stream: true, prompt_cache_key: 'conversation-a', tools: [tool], input: [{ role: 'user', content: 'read' }] };
async function setup(t, generate, options = {}) {
  const fake = await startFakeWire(await testRoot('kv'), { durable: true, generate });
  const diagnostics = [];
  const adapter = await startAdapter({ socketPath: fake.socketPath, reuseKv: true, onSessionEvent: e => diagnostics.push(e), ...options });
  t.after(async () => { await adapter.close(); assert.equal(fake.sessions.size, 0); await fake.close(); });
  return { fake, adapter, diagnostics };
}
async function post(adapter, body) {
  const r = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await r.text();
  const events = raw.split('\n\n').flatMap(frame => {
    const line = frame.split('\n').find(l => l.startsWith('data: '));
    return line ? [JSON.parse(line.slice(6))] : [];
  });
  return { status: r.status, final: events.at(-1), raw };
}
const textGeneration = async ({ send }) => { await send({ event: 'text_delta', text: 'ok' }); await send(done()); };

test('durable KV appends only results using engine IDs, never Responses IDs', async t => {
  let turn = 0;
  const { adapter, fake, diagnostics } = await setup(t, async ({ send }) => {
    if (++turn === 1) {
      await send({ event: 'toolcall_start', id: 41, name: 'read' });
      await send({ event: 'toolcall_end', id: 41, name: 'read', arguments: {} });
      await send(done('tool_use'));
    } else await textGeneration({ send });
  });
  const first = await post(adapter, base);
  assert.equal(first.final.type, 'response.completed');
  const call = first.final.response.output[0];
  const second = await post(adapter, { ...base, input: [...base.input, call, { type: 'function_call_output', call_id: call.call_id, output: 'nonce' }] });
  assert.equal(second.final.type, 'response.completed');
  assert.equal(fake.requests.filter(r => r.op === 'rebuild').length, 1);
  assert.deepEqual(fake.requests.find(r => r.op === 'append'), { op: 'append', role: 'tool', call_id: 41, text: 'nonce', status: 'ok' });
  assert.deepEqual(diagnostics.map(e => e.kind), ['miss', 'hit']);
});

test('changed instructions/tools/transcript and duplicate requests invalidate KV', async t => {
  const { adapter, fake, diagnostics } = await setup(t, textGeneration);
  await post(adapter, base);
  const continued = { ...base, input: [...base.input, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };
  await post(adapter, continued);
  assert.equal(diagnostics.at(-1).kind, 'hit');
  await post(adapter, { ...continued, instructions: 'new' });
  await post(adapter, { ...continued, tools: [{ ...tool, description: 'changed' }] });
  await post(adapter, { ...base, input: [{ role: 'user', content: 'changed' }] });
  await post(adapter, { ...base, input: [{ role: 'user', content: 'changed' }] });
  assert.equal(fake.requests.filter(r => r.op === 'rebuild').length, 5);
  assert.equal(fake.requests.filter(r => r.op === 'delete').length, 4);
});

test('generation failure invalidates durable session before a later request', async t => {
  let turn = 0;
  const { adapter, fake } = await setup(t, async ({ send }) => {
    if (++turn === 1) await send({ event: 'error', code: 'io_error', error: 'lost generation' });
    else await textGeneration({ send });
  });
  assert.equal((await post(adapter, base)).final.type, 'response.failed');
  assert.equal((await post(adapter, base)).final.type, 'response.completed');
  assert.equal(fake.requests.filter(r => r.op === 'create').length, 2);
});

test('concurrent requests for one key are rejected without corrupting its session', async t => {
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  t.after(() => release());
  const { adapter, fake } = await setup(t, async ({ send }) => { entered(); await gate; await textGeneration({ send }); });
  const first = post(adapter, base);
  await started;
  assert.equal((await post(adapter, base)).status, 429);
  release();
  assert.equal((await first).final.type, 'response.completed');
  assert.equal(fake.requests.filter(r => r.op === 'create').length, 1);
});

test('bounded cache evicts its own idle sessions; requests without a key stay ephemeral', async t => {
  const { adapter, fake } = await setup(t, textGeneration, { sessionLimit: 1, sessionTtlMs: 5 });
  await post(adapter, base);
  await delay(10);
  await post(adapter, { ...base, prompt_cache_key: 'b' });
  await post(adapter, { ...base, prompt_cache_key: undefined });
  assert.equal(fake.requests.filter(r => r.op === 'delete').length, 1);
  assert.equal(fake.requests.filter(r => r.op === 'ephemeral').length, 1);
});

test('lost generation connection deletes only the adapter-owned session', async t => {
  const { adapter, fake, diagnostics } = await setup(t, async ({ socket }) => socket.destroy());
  assert.equal((await post(adapter, base)).final.type, 'response.failed');
  assert.equal(fake.sessions.size, 0);
  assert.ok(fake.requests.some(r => r.op === 'delete'));
  assert.ok(!diagnostics.some(e => e.kind === 'cleanup_failed'));
});

test('durable HTTP cancellation drains the ACK then discards the session', async t => {
  const { adapter, fake } = await setup(t, async ({ send, cancelled }) => {
    await send({ event: 'text_delta', text: 'partial' });
    while (!cancelled()) await delay(5);
    await send(done('aborted'));
  });
  const controller = new AbortController();
  const response = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(base), signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  for (let i = 0; i < 100 && fake.sessions.size; i++) await delay(10);
  assert.ok(fake.requests.some(r => r.op === 'cancel'));
  assert.equal(fake.sessions.size, 0);
});

test('shutdown waits for session creation before deleting the owned record', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const operations = [];
  const wire = { close() {}, async request(r) {
    operations.push(r.op);
    if (r.op === 'create') { await gate; return { session: 'a'.repeat(32) }; }
    return { ok: true };
  } };
  const cache = new SessionCache('unused');
  const preparing = cache.prepare(wire, 'key', { op: 'ephemeral', tools: [], messages: [{ role: 'user', text: 'hi' }], reasoning: false, max_tokens: 10 });
  let closed = false;
  const closing = cache.close().then(() => { closed = true; });
  await delay(5);
  assert.equal(closed, false);
  release();
  await preparing;
  await closing;
  assert.deepEqual(operations, ['create', 'rebuild', 'delete']);
  assert.equal(cache.entries.size, 0);
});
