import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';

export const description = { ok: true, protocol: 1, model: 'xenolith-bridge-sim', context_window: 65536,
  max_output: 8192, max_frame: 1048576, kvstore: false,
  reasoning: { efforts: ['low', 'medium', 'high', 'max'], history: ['discard', 'preserve_tool_calls'], budget_tokens: true } };
export const usage = { input: 10, cache_read: 5, output: 3, reasoning: 0, total: 100, replayed: 0 };
export const done = (stop = 'stop') => ({ event: 'done', stop, usage, marker: null });
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Transport simulator, not a model or a Gemma schema renderer. No tools execute here.
export async function startFakeWire(root, { info = description, generate, afterAppend, faults, fragment = false, durable = false, persistent = false } = {}) {
  const socketPath = join(root, 'w.sock');
  const requests = [];
  const sockets = new Set();
  const errors = [];
  const sessions = new Map();
  let generationQueue = Promise.resolve();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let generating = false;
    let cancelled = false;
    let session;
    const send = async value => {
      if (persistent && session && sessions.has(session)) {
        const state = sessions.get(session);
        if (value.event === 'toolcall_end') state.pending.push(value.id);
        if (value.event === 'done') {
          state.marker++;
          if (value.stop === 'stop') state.pending = [];
          value = { ...value, marker: value.marker ?? state.marker };
        }
      }
      if (socket.destroyed) return;
      const frame = Buffer.from(JSON.stringify(value) + '\n');
      if (fragment) {
        for (let offset = 0; offset < frame.length; offset += 3) socket.write(frame.subarray(offset, offset + 3));
      } else socket.write(frame);
    };
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const request = JSON.parse(line);
        requests.push(request);
        if (faults?.[request.op]) {
          if (faults[request.op] === 'disconnect') socket.destroy();else void send(faults[request.op]);
          continue;
        }
        if (request.op === 'describe') void send(persistent ? { ...info, kvstore: true } : info);
        else if (request.op === 'cancel') {
          cancelled = true;
          void send(generating ? { ok: true } : { ok: false, code: 'invalid_request', error: 'No active generation' });
        } else if (persistent && request.op === 'open') {
          session = request.session;
          const state = sessions.get(session);
          void send(state ? { ok: true, marker: state.marker, pending: state.pending, resume: 'snapshot' }
            : { ok: false, code: 'session_not_found', error: 'Missing owned session' });
        } else if (persistent && request.op === 'checkpoint') {
          void send({ ok: true, saved: true, tokens: 100 });
        } else if (durable && request.op === 'create') {
          session = randomUUID().replaceAll('-', '');
          sessions.set(session, { messages: [], marker: 0, pending: [] });
          void send({ ok: true, session, marker: 0 });
        } else if (durable && request.op === 'rebuild') {
          sessions.get(session).messages = request.messages;
          if (persistent) { sessions.get(session).marker++; sessions.get(session).pending = []; }
          void send({ ok: true, marker: 1 });
        } else if (durable && request.op === 'append') {
          sessions.get(session).messages.push(request);
          if (afterAppend) {
            void Promise.resolve().then(() => afterAppend({ request, socket, send }))
              .catch(error => { errors.push(error);socket.destroy(); });
          } else void send({ ok: true, marker: 2 });
        } else if (durable && request.op === 'delete') {
          sessions.delete(request.session);
          void send({ ok: true });
        } else if (request.op === 'ephemeral' || (durable && request.op === 'generate')) {
          generating = true;
          generationQueue = generationQueue.then(async () => {
            try {
              await (generate ?? (async ({ send }) => {
                await send({ event: 'start' });
                await send({ event: 'text_delta', text: 'Ciao 🌋' });
                await send(done());
              }))({ request, send, socket, cancelled: () => cancelled, callId: randomUUID() });
            } catch (error) {
              errors.push(error);
              await send({ event: 'error', code: 'invalid_request', error: error.message });
            } finally { generating = false; }
          });
        } else void send({ ok: false, code: 'invalid_request', error: `Unexpected op ${request.op}` });
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { socketPath, requests, errors, sessions,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    } };
}
