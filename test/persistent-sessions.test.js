import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startAdapter } from '../src/server.js';
import { startFakeWire, description, done } from './helpers/fake-wire.js';
import { testRoot } from './helpers/codex.js';

const tool = { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } };
const base = { model: description.model, stream: true, prompt_cache_key: 'stable-conversation',
  input: [{ role: 'user', content: 'hello' }] };
async function setup(t, generate) {
  const root = await testRoot('persistent');
  const stateDir = join(root, 'bindings');
  const fake = await startFakeWire(root, { durable: true, persistent: true, generate });
  let adapter;
  const events = [];
  async function start() { adapter = await startAdapter({ socketPath: fake.socketPath, stateDir, onSessionEvent: e => events.push(e) }); return adapter; }
  async function close() { await adapter?.close(); adapter = undefined; }
  t.after(async () => { await close(); await fake.close(); });
  async function record() {
    const name = (await readdir(stateDir)).find(n => n.endsWith('.json'));
    return { path: join(stateDir, name), value: JSON.parse(await readFile(join(stateDir, name), 'utf8')) };
  }
  return { fake, stateDir, start, close, record, events };
}
async function post(adapter, body) {
  const res = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await res.text();
  const events = raw.split('\n\n').flatMap(f => {
    const line = f.split('\n').find(x => x.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : [];
  });
  return { status: res.status, events, final: events.at(-1), raw };
}
const text = async ({ send }) => { await send({ event: 'text_delta', text: 'ok' }); await send(done()); };

test('persistent binding reopens after bridge restart without rebuild or deletion', async t => {
  const s = await setup(t, text);let adapter = await s.start();
  const first = await post(adapter, base);assert.equal(first.final.type, 'response.completed');
  assert.equal(first.final.response.xenolith_session.checkpoint.saved, true);
  const before = await s.record();assert.equal(before.value.inFlight, false);
  assert.equal((await stat(before.path)).mode & 0o777, 0o600);
  await s.close();assert.equal(s.fake.sessions.size, 1);
  adapter = await s.start();
  const second = await post(adapter, { ...base, input: [...base.input, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] });
  assert.equal(second.final.type, 'response.completed');
  assert.equal((await s.record()).value.session, before.value.session);
  for (const op of ['create', 'rebuild']) assert.equal(s.fake.requests.filter(r => r.op === op).length, 1);
  assert.equal(s.fake.requests.filter(r => r.op === 'open').length, 1);
  assert.ok(s.events.some(e => e.kind === 'persistent_hit'));
  assert.ok(!s.fake.requests.some(r => ['ephemeral', 'delete'].includes(r.op)));
});

test('pending tool results retain native IDs across bridge restart', async t => {
  let turn = 0;const s = await setup(t, async ({ send }) => {
    if (++turn === 1) { await send({ event: 'toolcall_start', id: 41, name: 'read' });
      await send({ event: 'toolcall_end', id: 41, name: 'read', arguments: {} });await send(done('tool_use')); }
    else await text({ send });
  });
  let adapter = await s.start();const first = await post(adapter, { ...base, tools: [tool] });
  const call = first.final.response.output[0];assert.equal(call.type, 'function_call');
  assert.equal((await s.record()).value.pending[0].id, 41);
  await s.close();adapter = await s.start();
  const result = await post(adapter, { ...base, tools: [tool], input: [...base.input, call,
    { type: 'function_call_output', call_id: call.call_id, output: 'nonce-result' }] });
  assert.equal(result.final.type, 'response.completed');
  assert.deepEqual(s.fake.requests.find(r => r.op === 'append'), { op: 'append', role: 'tool', call_id: 41, text: 'nonce-result', status: 'ok' });
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 1);
});

test('committed marker divergence fails before mutation', async t => {
  const s = await setup(t, text);let adapter = await s.start();await post(adapter, base);
  const { value } = await s.record();await s.close();s.fake.sessions.get(value.session).marker += 20;
  adapter = await s.start();const before = s.fake.requests.length;
  const result = await post(adapter, { ...base, input: [...base.input, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] });
  assert.equal(result.status, 503);
  assert.ok(!s.fake.requests.slice(before).some(r => ['append', 'rebuild', 'generate', 'create', 'delete'].includes(r.op)));
});

test('interrupted generation rebuilds committed client history on the same session', async t => {
  let turn = 0;const s = await setup(t, async ({ send }) => {
    if (++turn === 1) await send({ event: 'error', code: 'io_error', error: 'uncertain mutation' });else await text({ send });
  });
  let adapter = await s.start();assert.equal((await post(adapter, base)).final.type, 'response.failed');
  const before = await s.record();assert.equal(before.value.inFlight, true);
  await s.close();adapter = await s.start();assert.equal((await post(adapter, base)).final.type, 'response.completed');
  assert.equal((await s.record()).value.session, before.value.session);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 2);
  assert.ok(s.events.some(e => e.reason === 'interrupted_request'));
});

test('persistent mode refuses missing keys and competing state-directory owners', async t => {
  const s = await setup(t, text);const adapter = await s.start();
  const { prompt_cache_key, ...withoutKey } = base;assert.equal((await post(adapter, withoutKey)).status, 400);
  assert.ok(!s.fake.requests.some(r => ['create', 'ephemeral'].includes(r.op)));
  await assert.rejects(startAdapter({ socketPath: s.fake.socketPath, stateDir: s.stateDir }), /locked/);
});

test('binding write failure withholds executable tool items', async t => {
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'toolcall_end', id: 17, name: 'read', arguments: {} });
    // Substitute a non-writable destination after the in-flight record was saved.
    const { path } = await s.record();const { unlink, mkdir } = await import('node:fs/promises');await unlink(path);await mkdir(path);
    await send(done('tool_use'));
  });
  const adapter = await s.start();const result = await post(adapter, { ...base, tools: [tool] });
  assert.equal(result.final.type, 'response.failed');
  assert.ok(!result.events.some(e => e.item?.type === 'function_call'));
});


test('persistent tool binding survives two actual CLI processes', { timeout: 15000 }, async t => {
  let turn = 0;
  const s = await setup(t, async ({ send }) => {
    if (++turn === 1) {
      await send({ event: 'toolcall_end', id: 93, name: 'read', arguments: {} });await send(done('tool_use'));
    } else await text({ send });
  });
  const children = new Set();
  async function stop(child) {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');child.kill('SIGTERM');await exited;children.delete(child);
  }
  t.after(async () => { for (const child of children) await stop(child); });
  async function start() {
    const child = spawn(process.execPath, [resolve('src/cli.js'), 'serve', '--socket', s.fake.socketPath,
      '--state-dir', s.stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });children.add(child);
    let stdout = '', stderr = '';
    child.stderr.on('data', b => { stderr += b; });
    const baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM');reject(new Error('Bridge startup timeout: ' + stderr)); }, 5000);
      child.once('error', error => { clearTimeout(timer);reject(error); });
      child.once('exit', code => { clearTimeout(timer);reject(new Error('Bridge exited: ' + code + ': ' + stderr)); });
      child.stdout.on('data', b => { stdout += b;
        if (stdout.includes('\n')) { clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]).base_url); }
      });
    });
    return { child, baseUrl };
  }
  const first = await start();const response = await post(first, { ...base, tools: [tool] });
  const call = response.final.response.output[0];assert.equal(call.type, 'function_call');
  const saved = await s.record();await stop(first.child);
  const second = await start();assert.notEqual(second.child.pid, first.child.pid);
  const continued = await post(second, { ...base, tools: [tool], input: [...base.input, call,
    { type: 'function_call_output', call_id: call.call_id, output: 'program-output' }] });
  assert.equal(continued.final.type, 'response.completed');await stop(second.child);
  assert.equal((await s.record()).value.session, saved.value.session);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 1);
  assert.equal(s.fake.requests.find(r => r.op === 'append').call_id, 93);
  assert.ok(!s.fake.requests.some(r => ['ephemeral', 'delete'].includes(r.op)));
});
