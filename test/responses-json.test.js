import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { startAdapter } from '../src/server.js';
import { testRoot } from './helpers/codex.js';
import { startFakeWire, done, delay } from './helpers/fake-wire.js';

async function setup(t, generate, persistent = false) {
  const root = await testRoot('responses-json');
  const fake = await startFakeWire(root, { generate, durable: persistent, persistent });
  let adapter;
  t.after(async () => { try { await adapter?.close(); } finally { await fake.close(); } });
  adapter = await startAdapter({ socketPath: fake.socketPath, ...(persistent ? { stateDir: join(root, 'state') } : {}) });
  const post = body => fetch(adapter.baseUrl + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: adapter.info.model, input: 'hello', ...body }) });
  return { root, fake, adapter, post };
}
const tool = { type: 'function', name: 'read', parameters: { type: 'object' }, strict: false };

test('Responses JSON withholds the entire response until terminal validation and persistent commit', async t => {
  let release, started;
  const gate = new Promise(r => { release = r; });const observed = new Promise(r => { started = r; });
  t.after(() => release());
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'text_delta', text: 'reading' });
    await send({ event: 'toolcall_end', id: 7, name: 'read', arguments: {} });
    started();await gate;await send(done('tool_use'));
  }, true);
  let resolved = false;
  const pending = s.post({ tools: [tool], prompt_cache_key: 'transaction', stream: false }).then(r => { resolved = true;return r; });
  await observed;await delay(20);assert.equal(resolved, false);
  release();const response = await pending;
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();assert.equal(body.status, 'completed');
  assert.equal(body.output[1].type, 'function_call');assert.ok(body.xenolith_session.checkpoint.saved);
});

test('Responses JSON withholds tools on a persistent binding write failure', async t => {
  let root;
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'toolcall_end', id: 8, name: 'read', arguments: {} });
    await rename(join(root, 'state'), join(root, 'retained-state'));await writeFile(join(root, 'state'), 'blocked');
    await send(done('tool_use'));
  }, true);root = s.root;
  const response = await s.post({ tools: [tool], prompt_cache_key: 'transaction' });
  assert.equal(response.status, 502);
  const body = await response.json();assert.ok(body.error);assert.equal(body.output, undefined);
});

test('Responses JSON rejects malformed native calls as server errors without exposing tools', async t => {
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'toolcall_end', id: 9, name: 'undeclared', arguments: {} });await send(done('tool_use'));
  });
  const response = await s.post({ tools: [tool] });
  assert.equal(response.status, 502);assert.equal((await response.json()).error.code, 'io_error');
});

test('disconnect before Responses JSON completion cancels the generating wire operation', async t => {
  let started, cancelled;
  const running = new Promise(r => { started = r; });const observed = new Promise(r => { cancelled = r; });
  const s = await setup(t, async ({ send, cancelled: isCancelled }) => {
    await send({ event: 'text_delta', text: 'not published' });started();
    for (let i = 0; i < 100 && !isCancelled(); i++) await delay(10);
    if (isCancelled()) cancelled();await send(done('aborted'));
  });
  const req = httpRequest(s.adapter.baseUrl + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});req.end(JSON.stringify({ model: s.adapter.info.model, input: 'hello' }));
  await running;req.destroy();
  await Promise.race([observed, delay(2000).then(() => { throw Error('No cancellation'); })]);
  assert.ok(s.fake.requests.some(r => r.op === 'cancel'));
});
