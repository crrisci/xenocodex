import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startAdapter } from '../src/server.js';
import { testRoot } from './helpers/codex.js';
import { startFakeWire, description, done } from './helpers/fake-wire.js';

for (const api of ['responses', 'chat/completions']) for (const stream of [false, true]) {
  for (const fault of ['UTF-8 corruption', 'corrupt tail after terminal', 'checkpoint disconnect']) {
    test(`${api} stream:${stream} withholds tools on ${fault}`, async t => {
      const root = await testRoot('api-fault');
      const fake = await startFakeWire(root, { durable: true, persistent: true,
        ...(fault === 'checkpoint disconnect' ? { faults: { checkpoint: 'disconnect' } } : {}),
        generate: async ({ send, socket }) => {
          if (fault === 'UTF-8 corruption') {
            socket.write(Buffer.concat([Buffer.from('{"event":"text_delta","text":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
          } else if (fault === 'corrupt tail after terminal') {
            // A single native packet queues a plausible tool/terminal followed
            // by protocol corruption. It must not commit or expose the tool.
            socket.write(JSON.stringify({ event: 'start' }) + '\n' +
              JSON.stringify({ event: 'toolcall_end', id: 7, name: 'read', arguments: {} }) + '\n' +
              JSON.stringify({ ...done('tool_use'), marker: 1 }) + '\ninvalid-json\n');return;
          }
          await send({ event: 'toolcall_end', id: 7, name: 'read', arguments: {} });await send(done('tool_use'));
        } });
      let adapter;t.after(async () => { await adapter?.close();await fake.close(); });
      adapter = await startAdapter({ socketPath: fake.socketPath, stateDir: join(root, 'bindings') });
      const tool = { name: 'read', parameters: { type: 'object', properties: {} } };
      const body = { model: description.model, stream, ...(api === 'responses' ? { input: 'Read', tools: [{ type: 'function', ...tool }] }
        : { messages: [{ role: 'user', content: 'Read' }], tools: [{ type: 'function', function: tool }] }) };
      const response = await fetch(`${adapter.baseUrl}/${api}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Xenolith-Session': 'fault-case' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      assert.equal(response.status, stream ? 200 : 502, text);
      if (stream) {
        const frames = text.split('\n\n').flatMap(frame => {
          const line = frame.split('\n').find(l => l.startsWith('data: '));return line && line !== 'data: [DONE]' ? [JSON.parse(line.slice(6))] : [];
        });
        assert.ok(frames.some(e => e.type === 'response.failed' || e.error), text);
        assert.ok(!frames.some(e => e.type === 'response.completed' || e.item?.type === 'function_call' || e.choices?.[0]?.delta?.tool_calls), text);
      } else {
        const result = JSON.parse(text);assert.equal(result.error.code, 'io_error');assert.ok(!result.output && !result.choices);
      }
    });
  }
}
