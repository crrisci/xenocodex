import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startAdapter } from '../src/server.js';
import { runAcceptance } from './model/api-acceptance.js';
import { startFakeWire, done, delay } from './helpers/fake-wire.js';
import { testRoot } from './helpers/codex.js';

// Validate the acceptance driver's assertions/control flow, without presenting
// simulated cache persistence or generation as real-model release evidence.
test('acceptance driver covers all four API modes and abort/recovery', { timeout: 30000 }, async t => {
  const root = await testRoot('acceptance');let adapter, fake, phase = 0, restartCount = 0;
  const pattern = ['tool', 'answer', 'tool', 'answer', 'cancel', 'answer', 'tool', 'answer', 'tool', 'answer', 'cancel', 'answer'];
  fake = await startFakeWire(root, { durable: true, persistent: true, generate: async ({ session, send, cancelled, socket }) => {
    const next = pattern[phase++];assert.ok(next, 'Unexpected extra generation');
    if (next === 'tool') {
      await send({ event: 'toolcall_end', id: phase, name: 'read_file', arguments: { path: 'input.txt' } });await send(done('tool_use'));
    } else if (next === 'cancel') {
      await send({ event: 'text_delta', text: '1\n' });
      for (let i = 0; i < 200 && !cancelled() && !socket.destroyed; i++) await delay(5);
      assert.ok(cancelled() || socket.destroyed, 'Driver must cancel the live generation');
    } else {
      const history = JSON.stringify(fake.sessions.get(session).messages);
      const nonce = history.match(/BRIDGE_[a-f0-9-]+/)?.[0];assert.ok(nonce, 'Actual tool result must reach the wire');
      await send({ event: 'text_delta', text: nonce });await send(done());
    }
  } });
  t.after(async () => { await adapter?.close();await fake.close(); });
  const start = async () => { adapter = await startAdapter({ socketPath: fake.socketPath, stateDir: join(root, 'bindings') }); };
  await start();
  const results = await runAcceptance({ root, requireSnapshot: false,
    connect: async () => ({ baseUrl: adapter.baseUrl, model: adapter.info.model }),
    restart: async () => { restartCount++;await adapter.close();await start(); } });
  assert.equal(results.length, 4);assert.equal(restartCount, 6);assert.equal(phase, pattern.length);
  assert.equal(results.filter(r => r.cancellation).length, 2);assert.deepEqual(fake.errors, []);
});

test('real acceptance gate rejects a correct answer without explicit snapshot restoration', async t => {
  const root = await testRoot('acceptance-gate');let adapter, fake, calls = 0;
  fake = await startFakeWire(root, { durable: true, persistent: true, generate: async ({ session, send }) => {
    if (++calls === 1) {
      await send({ event: 'toolcall_end', id: 1, name: 'read_file', arguments: { path: 'input.txt' } });await send(done('tool_use'));
    } else {
      const nonce = JSON.stringify(fake.sessions.get(session).messages).match(/BRIDGE_[a-f0-9-]+/)[0];
      await send({ event: 'text_delta', text: nonce });await send(done());
    }
  } });
  t.after(async () => { await adapter?.close();await fake.close(); });
  const start = async () => { adapter = await startAdapter({ socketPath: fake.socketPath, stateDir: join(root, 'bindings') }); };
  await start();
  await assert.rejects(runAcceptance({ root,
    connect: async () => ({ baseUrl: adapter.baseUrl, model: adapter.info.model }),
    restart: async () => { await adapter.close();await start(); } }), /explicitly report snapshot restoration/);
  assert.equal(calls, 2);assert.deepEqual(fake.errors, []);
});
