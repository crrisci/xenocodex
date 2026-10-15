import { createServer } from 'node:http';
import { once } from 'node:events';
import { AdapterError, errorBody } from './errors.js';
import { WireConnection } from './wire.js';
import { translateRequest } from './translate.js';
import { ResponseStream } from './responses.js';
import { SessionCache } from './sessions.js';
import { PersistentSessionCache } from './persistent-sessions.js';
import { sessionKey } from './session-key.js';
import { translateChat, ChatStream } from './chat.js';

export async function startAdapter({ socketPath, port = 0, maxBodyBytes = 8 * 1024 * 1024,
  maxOutputTokens = 4096, heartbeatMs = 15000, generationTimeoutMs = 600000, maxConcurrent = 4,
  onRequest, onWireEvent, reuseKv = false, stateDir, sessionLimit = 4, sessionTtlMs = 600000, onSessionEvent } = {}) {
  if (!socketPath) throw new Error('A Xenolith socket path is required');
  if (stateDir !== undefined && (typeof stateDir !== 'string' || !stateDir.trim())) {
    throw new Error('An explicit nonempty state directory is required');
  }
  const discovery = await WireConnection.open(socketPath);
  let info;
  try { info = await discovery.describe(); } finally { discovery.close(); }
  const wires = new Set();
  const sessions = stateDir ? await PersistentSessionCache.create(socketPath, info, stateDir, {
    operationTimeoutMs: generationTimeoutMs, onEvent: onSessionEvent }) : reuseKv ? new SessionCache(socketPath, { limit: sessionLimit, ttlMs: sessionTtlMs,
    operationTimeoutMs: generationTimeoutMs, onEvent: onSessionEvent }) : null;
  let active = 0;
  const handlers = new Set();
  let closing;
  const server = createServer((req, res) => {
    const handling = handle(req, res).catch(error => {
    if (!res.headersSent) json(res, error.status ?? 500, errorBody(error));
    else res.destroy();
    });
    handlers.add(handling);
    handling.then(() => handlers.delete(handling), () => handlers.delete(handling));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  async function handle(req, res) {
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, model: info.model, protocol: info.protocol });
    if (req.method === 'GET' && path === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: info.model, object: 'model', owned_by: 'xenolith' }] });
    const chat = path === '/v1/chat/completions';
    if (req.method !== 'POST' || (!chat && path !== '/v1/responses')) return json(res, 404, errorBody(new AdapterError('unsupported_endpoint', 'Supported inference endpoints: POST /v1/responses and POST /v1/chat/completions', 404)));
    if (active >= maxConcurrent) return json(res, 429, errorBody(new AdapterError('busy', 'Adapter concurrency limit reached', 429)));
    active++;
    let wire, stream, heartbeat, lease, translated, terminal, committed = false;
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', disconnect);
    try {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new AdapterError('unsupported_feature', 'Compressed requests are not supported', 415);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AdapterError('invalid_request', 'Content-Type must be application/json', 415);
      if (Number(req.headers['content-length']) > maxBodyBytes) throw new AdapterError('invalid_request', 'HTTP body exceeds limit', 413);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) throw new AdapterError('invalid_request', 'HTTP body exceeds limit', 413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AdapterError('invalid_request', 'Malformed JSON request'); }
      // Optional diagnostics hook for tests; production does not log prompts or headers.
      await onRequest?.({ method: req.method, path, body });
      translated = (chat ? translateChat : translateRequest)(body, info, { maxOutputTokens });
      const key = sessionKey(req, body, { enabled: Boolean(sessions), persistent: Boolean(stateDir) });
      wire = await WireConnection.open(socketPath);
      wires.add(wire);
      const current = await wire.describe();
      if (current.model !== info.model || current.context_window !== info.context_window || current.max_output !== info.max_output) throw new AdapterError('incompatible_protocol', 'Engine changed; restart the adapter', 503);
      if (Buffer.byteLength(JSON.stringify(translated.request)) + 1 > current.max_frame) throw new AdapterError('invalid_request', 'Request exceeds Xenolith max_frame', 413);
      if (abort.signal.aborted) return;
      if (sessions && key !== undefined) {
        lease = await sessions.prepare(wire, key, translated.request);
        wires.delete(wire);
        wire = lease.wire;
      }
      wires.add(wire);
      const streaming = translated.streaming;
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        heartbeat = setInterval(() => { if (!res.destroyed && !res.writableNeedDrain) res.write(': xenolith-bridge heartbeat\n\n'); }, heartbeatMs);
      }
      const send = async (event, status = 200) => {
        if (res.destroyed) return;
        if (!streaming) return json(res, status, event);
        const frame = chat ? `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`
          : `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        if (!res.write(frame)) {
          // 'close' also releases a writer whose peer disappeared during drain.
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
        }
      };
      stream = chat ? new ChatStream(info.model, translated.registry, send, translated)
        : new ResponseStream(info.model, translated.registry, send, { streaming });
      await stream.start();
      for await (const event of wire.stream(lease?.request ?? translated.request, { signal: abort.signal, timeoutMs: generationTimeoutMs })) {
        await onWireEvent?.(event);
        if (abort.signal.aborted) continue; // Drain cancel ACK and the terminal event.
        switch (event.event) {
          case 'text_delta': await stream.text(event.text); break;
          case 'toolcall_start': stream.toolStart(event); break;
          case 'toolcall_end': stream.toolEnd(event); break;
          case 'reasoning_delta': throw new AdapterError('unsupported_feature', 'Unexpected reasoning while reasoning is disabled', 502);
          case 'done':
            terminal = event;
            break;
          // start/progress and unknown nonterminal events are wire diagnostics.
        }
      }
      if (terminal && !abort.signal.aborted) {
        await stream.done(terminal, body.parallel_tool_calls, async () => {
          if (lease && ['stop', 'tool_use'].includes(terminal.stop)) {
            await sessions.commit(lease.entry, translated.request, stream, terminal);
            committed = true;
            if (stateDir) stream.response.xenolith_session = { marker: lease.entry.record.marker,
              checkpoint: lease.entry.record.checkpoint ?? null, resume: terminal.resume ?? null,
              ...(lease.entry.recovery ? { recovery: lease.entry.recovery } : {}) };
          }
        });
      }
      if (!abort.signal.aborted && !stream.finished) throw new AdapterError('io_error', 'No terminal response from Xenolith', 502);
    } catch (error) {
      if (!abort.signal.aborted) {
        if (stream) await stream.fail(error);
        else json(res, error.status ?? 500, errorBody(error));
      }
    } finally {
      clearInterval(heartbeat);
      if (wire) {
        wires.delete(wire);
        if (lease) {
          if (!committed || stateDir) await sessions.dispose(lease.entry);
        } else wire.close();
      }
      active--;
      res.off('close', disconnect);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }

  server.listen(port, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) { server.close(); await sessions?.close(); throw error; }
  return { info, server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close() {
      return closing ??= (async () => {
        for (const wire of wires) wire.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await Promise.allSettled([...handlers]);
        await sessions?.close();
      })();
    } };
}

function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
