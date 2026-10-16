import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { WireConnection } from '../src/wire.js';
import { testRoot } from './helpers/codex.js';
import { description, done } from './helpers/fake-wire.js';

async function wirePeer(t, handle) {
  const root = await testRoot('wire-fault'), path = join(root, 'w.sock'), sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);socket.on('error', () => {});socket.on('close', () => sockets.delete(socket));let buffer = '';
    socket.on('data', bytes => { buffer += bytes;for (;;) {
      const end = buffer.indexOf('\n');if (end < 0) break;
      const request = JSON.parse(buffer.slice(0, end));buffer = buffer.slice(end + 1);
      if (request.op === 'describe') socket.write(JSON.stringify(description) + '\n');else handle(request, socket);
    } });
  });
  server.listen(path);await once(server, 'listening');
  const wire = await WireConnection.open(path);await wire.describe();
  t.after(async () => { wire.close();for (const s of sockets) s.destroy();await new Promise(resolve => server.close(resolve)); });
  return wire;
}

for (const kind of ['invalid UTF-8', 'terminal followed by malformed JSON', 'oversized frame', 'queue overflow', 'disconnection']) {
  test(`wire fails closed on ${kind} without delivering a terminal`, async t => {
    const wire = await wirePeer(t, (_, socket) => {
      if (kind === 'invalid UTF-8') socket.write(Buffer.concat([Buffer.from('{"event":"text_delta","text":"'), Buffer.from([0xff]), Buffer.from('"}\n' + JSON.stringify(done()) + '\n')]));
      if (kind === 'terminal followed by malformed JSON') socket.write(JSON.stringify({ event: 'start' }) + '\n' + JSON.stringify(done()) + '\nnot-json\n');
      if (kind === 'oversized frame') socket.write('x'.repeat(description.max_frame + 1));
      if (kind === 'queue overflow') socket.write((JSON.stringify({ event: 'a' }) + '\n').repeat(4100));
      if (kind === 'disconnection') socket.destroy();
    });
    const received = [];
    await assert.rejects(async () => { for await (const event of wire.stream({ op: 'ephemeral' }, { timeoutMs: 1000 })) {
      received.push(event);
      if (kind === 'queue overflow' && received.length === 1 && !wire.error) await once(wire.socket, 'close');
    } }, e => {
      assert.equal(e.code, 'io_error');
      assert.match(e.message, { 'invalid UTF-8': /Malformed JSON or UTF-8/, 'terminal followed by malformed JSON': /Malformed JSON or UTF-8/,
        'oversized frame': /exceeds max_frame/, 'queue overflow': /queue overflow/, disconnection: /disconnected/ }[kind]);return true;
    });
    assert.ok(!received.some(e => e.event === 'done'));
    assert.ok(wire.error);assert.equal(wire.queue.length, 0);assert.equal(wire.queueBytes, 0);
  });
}

for (const ack of [true, false]) test(`cancel ${ack ? 'acknowledged' : 'rejected'} without a terminal is bounded`, async t => {
  let cancelCount = 0;
  const wire = await wirePeer(t, (request, socket) => {
    if (request.op === 'cancel') { cancelCount++;socket.write(JSON.stringify({ ok: ack, code: 'invalid_request' }) + '\n'); }
    else socket.write(JSON.stringify({ event: 'text_delta', text: 'partial' }) + '\n');
  });
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const event of wire.stream({ op: 'ephemeral' }, { signal: controller.signal, cancelTimeoutMs: 30, timeoutMs: 1000 })) {
      if (event.event === 'text_delta') controller.abort();
    }
  }, { code: 'cancelled' });
  assert.equal(cancelCount, 1);assert.ok(wire.socket.destroyed);
});

test('a generation deadline closes the uncertain connection', async t => {
  const wire = await wirePeer(t, () => {});
  await assert.rejects(async () => { for await (const _ of wire.stream({ op: 'ephemeral' }, { timeoutMs: 30 })) {} }, { code: 'io_error', status: 504 });
  assert.ok(wire.socket.destroyed);
  await assert.rejects(wire.request({ op: 'describe' }), { code: 'io_error' });
});


test('a plausible operation reply followed by corruption cannot report success', async t => {
  const wire = await wirePeer(t, (_, socket) => socket.write('{"ok":true}\ncorrupt\n'));
  await assert.rejects(wire.request({ op: 'probe' }), e => e.code === 'io_error' && /Malformed JSON/.test(e.message));
});
