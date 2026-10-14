import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
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
async function setup(t, generate, options = {}) {
  const root = await testRoot('persistent');
  const stateDir = join(root, 'bindings');
  const fake = await startFakeWire(root, { ...options, durable: true, persistent: true, generate });
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
async function post(adapter, body, headers = {}) {
  const res = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const raw = await res.text();
  const events = raw.split('\n\n').flatMap(f => {
    const line = f.split('\n').find(x => x.startsWith('data: ')); return line ? [JSON.parse(line.slice(6))] : [];
  });
  return { status: res.status, events, final: events.at(-1), raw };
}
const text = async ({ send }) => { await send({ event: 'text_delta', text: 'ok' }); await send(done()); };

test('header session identity persists across restart and isolates identical conversations', async t => {
  const s = await setup(t, text);let adapter = await s.start();
  const { prompt_cache_key, ...body } = base;
  assert.equal((await post(adapter, body, { 'X-Xenolith-Session': 'conversation-A' })).final.type, 'response.completed');
  const saved = await s.record();await s.close();adapter = await s.start();
  const next = { ...body, input: [...body.input, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };
  assert.equal((await post(adapter, next, { 'X-Xenolith-Session': 'conversation-A' })).final.type, 'response.completed');
  assert.equal((await s.record()).value.session, saved.value.session);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 1);
  assert.equal((await post(adapter, body, { 'X-Xenolith-Session': 'conversation-B' })).final.type, 'response.completed');
  assert.equal(s.fake.sessions.size, 2);
  assert.ok(!s.fake.requests.some(r => r.op === 'ephemeral'));
});

test('conflicting or malformed session headers fail before contacting the engine', async t => {
  const s = await setup(t, text);const adapter = await s.start();
  const { prompt_cache_key, ...body } = base;
  const before = s.fake.requests.length;
  for (const value of ['', 'two words', 'a,b', 'x'.repeat(513)]) {
    assert.equal((await post(adapter, body, { 'X-Xenolith-Session': value })).status, 400);
  }
  assert.equal((await post(adapter, base, { 'X-Xenolith-Session': 'different' })).status, 400);
  assert.equal((await post(adapter, { ...body, prompt_cache_key: '   ' })).status, 400);
  // node:http preserves duplicate field lines, including identical values.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${adapter.baseUrl}/responses`, { method: 'POST', headers: {
      'content-type': 'application/json', 'X-Xenolith-Session': ['same', 'same'],
    } }, res => { res.resume();res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);req.end(JSON.stringify(body));
  });
  assert.equal(status, 400);
  assert.equal(s.fake.requests.length, before);
  assert.equal((await post(adapter, base, { 'X-Xenolith-Session': prompt_cache_key })).final.type, 'response.completed');
});

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
  assert.equal(first.final.response.xenolith_session.checkpoint.saved, true);
  assert.equal(s.fake.requests.filter(r => r.op === 'checkpoint').length, 1);
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

const recovery = { reason: 'session_not_found', source: 'client_history', previous_kv_restored: false };
const continued = { ...base, input: [...base.input, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };

test('missing native session is recreated from complete history with an explicit recovery report', async t => {
  const s = await setup(t, text);let adapter = await s.start();await post(adapter, base);
  const before = await s.record();await s.close();s.fake.sessions.delete(before.value.session);
  const unrelated = 'f'.repeat(32);s.fake.sessions.set(unrelated, { messages: [], marker: 0, pending: [] });
  adapter = await s.start();const result = await post(adapter, continued);
  assert.equal(result.final.type, 'response.completed');
  assert.deepEqual(result.final.response.xenolith_session.recovery, recovery);
  assert.equal(result.final.response.xenolith_session.resume, null);
  const after = await s.record();assert.notEqual(after.value.session, before.value.session);
  assert.equal(after.value.inFlight, false);assert.equal(after.value.recoveryPending, false);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 2);
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 2);
  assert.ok(!s.fake.requests.some(r => ['append', 'delete', 'ephemeral'].includes(r.op)));
  assert.ok(s.fake.sessions.has(unrelated));assert.ok(s.events.some(e => e.reason === 'session_not_found'));
  const next = await post(adapter, { ...continued, input: [...continued.input,
    { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }] });
  assert.equal(next.final.type, 'response.completed');assert.equal(next.final.response.xenolith_session.recovery, undefined);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 2);
});

test('missing session recovery preserves pending tool results without appending obsolete native IDs', async t => {
  let turn = 0;const s = await setup(t, async ({ send }) => {
    if (++turn === 1) { await send({ event: 'toolcall_end', id: 72, name: 'read', arguments: {} });await send(done('tool_use')); }
    else await text({ send });
  });
  const adapter = await s.start();const first = await post(adapter, { ...base, tools: [tool] });
  const call = first.final.response.output[0];const before = await s.record();s.fake.sessions.delete(before.value.session);
  const result = await post(adapter, { ...base, tools: [tool], input: [...base.input, call,
    { type: 'function_call_output', call_id: call.call_id, output: 'already-executed-result' }] });
  assert.equal(result.final.type, 'response.completed');assert.deepEqual(result.final.response.xenolith_session.recovery, recovery);
  const rebuilt = s.fake.requests.filter(r => r.op === 'rebuild').at(-1);
  assert.deepEqual(rebuilt.messages.at(-1), { role: 'tool', tool: 'read', text: 'already-executed-result', status: 'ok' });
  assert.ok(!s.fake.requests.some(r => r.op === 'append'));
  assert.ok(!result.final.response.output.some(item => item.type === 'function_call'));
});

test('missing session with truncated or changed history is refused before creating a replacement', async t => {
  const s = await setup(t, text);const adapter = await s.start();await post(adapter, base);
  const before = await s.record();s.fake.sessions.delete(before.value.session);
  for (const body of [base, { ...continued, instructions: 'changed' }, { ...continued, tools: [tool] }]) {
    const result = await post(adapter, body);assert.equal(result.status, 503);
    assert.deepEqual((await s.record()).value, before.value);
  }
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
});

test('pending calls cannot be omitted from missing-session recovery', async t => {
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'toolcall_end', id: 32, name: 'read', arguments: {} });await send(done('tool_use'));
  });
  const adapter = await s.start();await post(adapter, { ...base, tools: [tool] });
  const before = await s.record();s.fake.sessions.delete(before.value.session);
  const result = await post(adapter, { ...base, tools: [tool] });assert.equal(result.status, 503);
  assert.deepEqual((await s.record()).value, before.value);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
});

test('open errors and disconnections never trigger session recreation', async t => {
  const faults = {};const s = await setup(t, text, { faults });let adapter = await s.start();await post(adapter, base);
  const before = await s.record();
  for (const fault of ['disconnect', { ok: false, code: 'io_error', error: 'session not found' },
    { ok: false, code: 'out_of_memory' }, { ok: false, code: 'busy' }, { ok: true, marker: -1, pending: [] }]) {
    await s.close();faults.open = fault;adapter = await s.start();
    const result = await post(adapter, continued);assert.notEqual(result.status, 200);
    assert.deepEqual((await s.record()).value, before.value);
  }
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 1);
  assert.equal(s.fake.requests.filter(r => r.op === 'rebuild').length, 1);
});

test('failed replacement creation preserves the previous binding', async t => {
  const faults = {};const s = await setup(t, text, { faults });const adapter = await s.start();await post(adapter, base);
  const before = await s.record();s.fake.sessions.delete(before.value.session);
  faults.create = { ok: false, code: 'out_of_memory', error: 'no room' };
  const result = await post(adapter, continued);assert.equal(result.status, 503);
  assert.deepEqual((await s.record()).value, before.value);
  delete faults.create;
  assert.equal((await post(adapter, continued)).final.type, 'response.completed');
});

test('replacement rebuild failure survives restart and retries the same replacement with recovery diagnostics', async t => {
  const faults = {};const s = await setup(t, text, { faults });let adapter = await s.start();await post(adapter, base);
  const before = await s.record();s.fake.sessions.delete(before.value.session);
  faults.rebuild = { ok: false, code: 'io_error', error: 'interrupted rebuild' };
  assert.equal((await post(adapter, continued)).status, 502);
  const replacement = await s.record();assert.notEqual(replacement.value.session, before.value.session);
  assert.equal(replacement.value.inFlight, true);assert.equal(replacement.value.recoveryPending, true);
  assert.deepEqual(replacement.value.messages, before.value.messages);
  await s.close();delete faults.rebuild;adapter = await s.start();
  assert.equal((await post(adapter, base)).status, 503);
  const recovered = await post(adapter, continued);assert.equal(recovered.final.type, 'response.completed');
  assert.deepEqual(recovered.final.response.xenolith_session.recovery, recovery);
  assert.equal((await s.record()).value.session, replacement.value.session);
  assert.equal(s.fake.requests.filter(r => r.op === 'create').length, 2);
});

test('lost tool-result ACK recovers from client history without appending the result twice', async t => {
  let turn = 0;
  const s = await setup(t, async ({ send }) => {
    if (++turn === 1) {
      await send({ event: 'toolcall_end', id: 57, name: 'read', arguments: {} });
      await send(done('tool_use'));
    } else await text({ send });
  }, { afterAppend: ({ socket }) => socket.destroy() });
  let adapter = await s.start();
  const first = await post(adapter, { ...base, tools: [tool] });
  const call = first.final.response.output[0];assert.equal(call.type, 'function_call');
  const before = await s.record();
  const body = { ...base, tools: [tool], input: [...base.input, call,
    { type: 'function_call_output', call_id: call.call_id, output: 'already-executed-result' }] };
  const interrupted = await post(adapter, body);
  assert.ok(interrupted.status !== 200 || interrupted.final?.type === 'response.failed');
  assert.equal((await s.record()).value.inFlight, true);
  await s.close();adapter = await s.start();
  const recovered = await post(adapter, body);
  assert.equal(recovered.final.type, 'response.completed');
  assert.ok(!recovered.final.response.output.some(item => item.type === 'function_call'));
  assert.equal((await s.record()).value.session, before.value.session);
  assert.equal(s.fake.requests.filter(r => r.op === 'append').length, 1);
  const rebuilt = s.fake.requests.filter(r => r.op === 'rebuild');
  assert.equal(rebuilt.length, 2);
  assert.deepEqual(rebuilt[1].messages.filter(m => m.role === 'tool'),
    [{ role: 'tool', tool: 'read', text: 'already-executed-result', status: 'ok' }]);
  assert.ok(s.events.some(e => e.reason === 'interrupted_request'));
  assert.deepEqual(s.fake.errors, []);
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


for (const abrupt of [false, true]) {
test(`persistent tool binding survives two actual CLI processes (${abrupt ? 'SIGKILL and automatic lease recovery' : 'orderly shutdown'})`, { timeout: 15000 }, async t => {
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
  const saved = await s.record();
  if (abrupt) {
    const exited = once(first.child, 'exit');first.child.kill('SIGKILL');
    const [code, signal] = await exited;children.delete(first.child);
    assert.equal(code, null);assert.equal(signal, 'SIGKILL');
    const leasePath = join(s.stateDir, '.bridge.lock');
    const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    assert.equal(lease.pid, first.child.pid);
    assert.deepEqual((await s.record()).value, saved.value);
  } else await stop(first.child);
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
}

test('a refused pending-tool checkpoint remains explicit without losing the tool', async t => {
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'toolcall_end', id: 81, name: 'read', arguments: {} });
    await send(done('tool_use'));
  }, { faults: { checkpoint: { ok: true, saved: false, tokens: 50, reason: 'kv_diverged' } } });
  const result = await post(await s.start(), { ...base, tools: [tool] });
  assert.equal(result.final.type, 'response.completed');
  assert.equal(result.final.response.output[0].type, 'function_call');
  assert.equal(result.final.response.xenolith_session.checkpoint.saved, false);
  assert.equal(result.final.response.xenolith_session.checkpoint.reason, 'kv_diverged');
  const { value } = await s.record();
  assert.equal(value.inFlight, false);assert.equal(value.pending[0].id, 81);
});

test('pending-tool checkpoint transport failure withholds execution and keeps uncertainty', async t => {
  const s = await setup(t, async ({ send }) => {
    await send({ event: 'toolcall_end', id: 82, name: 'read', arguments: {} });
    await send(done('tool_use'));
  }, { faults: { checkpoint: 'disconnect' } });
  const result = await post(await s.start(), { ...base, tools: [tool] });
  assert.equal(result.final.type, 'response.failed');
  assert.ok(!result.events.some(e => e.item?.type === 'function_call'));
  assert.equal((await s.record()).value.inFlight, true);
});
