import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { startAdapter } from '../../src/server.js';
import { testRoot, runCodex } from '../helpers/codex.js';
import { startFakeWire, done } from '../helpers/fake-wire.js';

test('installed Codex receives progressive text through the actual adapter and wire simulator', async t => {
  const root = await testRoot('text');
  const fake = await startFakeWire(root, { fragment: true, generate: async ({ send }) => {
    await send({ event: 'start' });
    await send({ event: 'text_delta', text: 'XENOLITH_BRIDGE_' });
    await send({ event: 'text_delta', text: 'TEXT_OK 🌋' });
    await send(done());
  } });
  t.after(() => fake.close());
  const requests = [];
  const adapter = await startAdapter({ socketPath: fake.socketPath, onRequest: r => requests.push(r) });
  t.after(() => adapter.close());
  const result = await runCodex(root, adapter.baseUrl, 'Reply briefly.');
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(root, 'wire.json'), JSON.stringify(fake.requests, null, 2));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.ok(result.events.some(e => e.type === 'turn.completed'));
  assert.ok(result.stdout.includes('XENOLITH_BRIDGE_TEXT_OK 🌋'));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].body.input.some(i => i.role === 'developer'));
  assert.equal(fake.requests.find(r => r.op === 'ephemeral').reasoning, false);
  console.log(`Text artifacts: ${root}`);
});

test('Codex executes a file-reading tool and returns its unpredictable result for a second inference', async t => {
  const root = await testRoot('tool');
  const nonce = `XENO_${randomBytes(16).toString('hex')}`;
  await mkdir(join(root, 'workspace'));
  await writeFile(join(root, 'workspace/input.txt'), nonce + '\n');
  let generations = 0;
  let returned;
  const fake = await startFakeWire(root, { generate: async ({ request, send }) => {
    generations++;
    assert.ok(generations <= 2, 'Unexpected extra inference');
    if (generations === 1) {
      const exec = request.tools.find(t => t.name === 'exec_command');
      assert.ok(exec, 'The actual Codex exec_command must be present');
      await send({ event: 'toolcall_start', id: 7, name: exec.name });
      await send({ event: 'toolcall_end', id: 7, name: exec.name,
        arguments: { cmd: 'cat input.txt', login: false, max_output_tokens: 1000, yield_time_ms: 1000 } });
      await send(done('tool_use'));
    } else {
      returned = request.messages.find(m => m.role === 'tool');
      assert.equal(returned?.tool, 'exec_command');
      const resultNonce = returned.text.match(/XENO_[a-f0-9]{32}/)?.[0];
      assert.ok(resultNonce, 'Final answer must come from the returned tool output');
      await send({ event: 'text_delta', text: 'Read: ' });
      await send({ event: 'text_delta', text: resultNonce });
      await send(done());
    }
  } });
  t.after(() => fake.close());
  const requests = [];
  const adapter = await startAdapter({ socketPath: fake.socketPath, onRequest: r => requests.push(r) });
  t.after(() => adapter.close());
  const result = await runCodex(root, adapter.baseUrl, 'Read input.txt using the shell tool and report its contents.');
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(root, 'wire.json'), JSON.stringify(fake.requests, null, 2));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(fake.errors.length, 0, fake.errors.map(e => e.message).join('\n'));
  assert.equal(generations, 2);
  assert.ok(returned.text.includes(nonce));
  const final = result.events.find(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
  assert.equal(final?.item.text, 'Read: ' + nonce);
  assert.ok(result.events.some(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && e.item.exit_code === 0));
  assert.ok(result.events.some(e => e.type === 'turn.completed'));
  assert.equal(requests.length, 2);
  const input = requests[1].body.input;
  const call = input.find(i => i.type === 'function_call');
  const output = input.find(i => i.type === 'function_call_output');
  assert.equal(call.call_id, output.call_id);
  assert.equal(call.name, 'exec_command');
  assert.equal(typeof call.arguments, 'string');
  console.log(`Tool artifacts: ${root}`);
});

test('actual Codex history reuses a durable session and maps the native tool ID', async t => {
  const root = await testRoot('codex-kv');
  const nonce = `XENO_${randomBytes(16).toString('hex')}`;
  await mkdir(join(root, 'workspace'));
  await writeFile(join(root, 'workspace/input.txt'), nonce + '\n');
  let turn = 0;
  const fake = await startFakeWire(root, { durable: true, generate: async ({ send }) => {
    if (++turn === 1) {
      await send({ event: 'toolcall_end', id: 53, name: 'exec_command', arguments: { cmd: 'cat input.txt' } });
      await send(done('tool_use'));
    } else {
      const returned = fake.requests.find(r => r.op === 'append' && r.role === 'tool');
      assert.equal(returned?.call_id, 53);
      assert.ok(returned?.text.includes(nonce));
      await send({ event: 'text_delta', text: nonce });
      await send(done());
    }
  } });
  const diagnostics = [];
  const adapter = await startAdapter({ socketPath: fake.socketPath, reuseKv: true, onSessionEvent: e => diagnostics.push(e) });
  t.after(async () => { await adapter.close(); assert.equal(fake.sessions.size, 0); await fake.close(); });
  const result = await runCodex(root, adapter.baseUrl, 'Read input.txt using exec_command, then report its contents.');
  await writeFile(join(root, 'wire.json'), JSON.stringify(fake.requests, null, 2));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(fake.errors.length, 0);
  assert.equal(turn, 2);
  assert.equal(fake.requests.filter(r => r.op === 'rebuild').length, 1);
  assert.deepEqual(diagnostics.map(e => e.kind), ['miss', 'hit']);
  assert.equal(result.events.filter(e => e.type === 'item.completed' && e.item.type === 'agent_message').at(-1).item.text, nonce);
  console.log(`Codex KV artifacts: ${root}`);
});
