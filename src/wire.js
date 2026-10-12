import { connect } from 'node:net';
import { AdapterError, object } from './errors.js';

const BOOTSTRAP_FRAME = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export class WireConnection {
  constructor(socket) {
    this.socket = socket;
    this.maxFrame = BOOTSTRAP_FRAME;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.queueBytes = 0;
    this.waiter = null;
    this.error = null;
    this.active = false;
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', error => this.fail(new AdapterError('io_error', error.message, 502)));
    socket.on('close', () => this.fail(new AdapterError('io_error', 'Xenolith disconnected before a terminal event', 502)));
  }

  static async open(path, timeoutMs = 10000) {
    const socket = connect(path);
    const wire = new WireConnection(socket);
    const timer = setTimeout(() => wire.fail(new AdapterError('io_error', 'Xenolith connection timed out', 504)), timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(wire.error));
      });
      return wire;
    } catch (error) {
      wire.close();
      throw error instanceof AdapterError ? error : new AdapterError('io_error', error.message, 502);
    } finally { clearTimeout(timer); }
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    if (this.waiter) { this.waiter.reject(error); this.waiter = null; }
    this.socket.destroy();
  }

  close() { this.fail(new AdapterError('io_error', 'Wire connection closed', 502)); }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end < 0) {
        if (this.buffer.length > this.maxFrame) this.fail(new AdapterError('io_error', 'Wire frame exceeds max_frame', 502));
        return;
      }
      if (end + 1 > this.maxFrame) {
        this.fail(new AdapterError('io_error', 'Wire frame exceeds max_frame', 502));
        return;
      }
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (!line.length) continue;
      let value;
      try { value = JSON.parse(line.toString('utf8')); }
      catch { this.fail(new AdapterError('io_error', 'Malformed JSON from Xenolith', 502)); return; }
      if (!object(value)) { this.fail(new AdapterError('io_error', 'Wire frame must be an object', 502)); return; }
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter.resolve(value);
      } else {
        this.queue.push({ value, bytes: line.length });
        this.queueBytes += line.length;
        if (this.queue.length > 4096 || this.queueBytes > MAX_QUEUED_BYTES) {
          this.fail(new AdapterError('io_error', 'Wire event queue overflow', 502)); return;
        }
      }
    }
  }

  next() {
    const queued = this.queue.shift();
    if (queued) { this.queueBytes -= queued.bytes; return Promise.resolve(queued.value); }
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  send(request) {
    if (this.error) throw this.error;
    const frame = Buffer.from(`${JSON.stringify(request)}\n`);
    if (frame.length > this.maxFrame) throw new AdapterError('invalid_request', 'Request exceeds Xenolith max_frame', 413);
    this.socket.write(frame);
  }

  async request(request, timeoutMs = 30000) {
    if (this.active) throw new AdapterError('busy', 'An operation is already active on this wire connection', 409);
    this.active = true;
    const timer = setTimeout(() => this.fail(new AdapterError('io_error', 'Xenolith operation timed out', 504)), timeoutMs);
    try {
      this.send(request);
      const response = await this.next();
      if (response.ok === false) throw wireError(response);
      if (response.ok !== true) throw new AdapterError('io_error', 'Expected a wire reply', 502);
      return response;
    } finally { clearTimeout(timer); this.active = false; }
  }

  async describe(timeoutMs = 10000) {
    const timer = setTimeout(() => this.fail(new AdapterError('io_error', 'Xenolith describe timed out', 504)), timeoutMs);
    try {
      const info = await this.request({ op: 'describe' });
      if (info.protocol !== 1 || typeof info.model !== 'string' || !info.model.trim() ||
          !['context_window', 'max_output', 'max_frame'].every(k => Number.isSafeInteger(info[k]) && info[k] > 0) ||
          info.max_frame > 16 * 1024 * 1024 || typeof info.kvstore !== 'boolean' ||
          !object(info.reasoning) || !Array.isArray(info.reasoning.efforts) ||
          !info.reasoning.efforts.every(e => ['low', 'medium', 'high', 'max'].includes(e)) ||
          !Array.isArray(info.reasoning.history) ||
          !info.reasoning.history.every(h => ['discard', 'preserve_tool_calls'].includes(h)) ||
          typeof info.reasoning.budget_tokens !== 'boolean') {
        throw new AdapterError('incompatible_protocol', 'Invalid Xenolith v1 describe response', 502);
      }
      this.maxFrame = info.max_frame;
      return info;
    } finally { clearTimeout(timer); }
  }

  async *stream(request, { signal, timeoutMs = 600000, cancelTimeoutMs = 5000 } = {}) {
    if (this.active) throw new AdapterError('busy', 'An operation is already active on this wire connection', 409);
    if (signal?.aborted) throw new AdapterError('cancelled', 'Client disconnected', 499);
    this.active = true;
    let cancelTimer;
    let cancelSent = false;
    const cancel = () => {
      if (cancelSent || this.error) return;
      cancelSent = true;
      this.send({ op: 'cancel' });
      cancelTimer = setTimeout(() => this.fail(new AdapterError('cancelled', 'Xenolith did not finish cancellation', 499)), cancelTimeoutMs);
    };
    const timer = setTimeout(() => this.fail(new AdapterError('io_error', 'Xenolith generation timed out', 504)), timeoutMs);
    try {
      this.send(request);
      signal?.addEventListener('abort', cancel, { once: true });
      for (;;) {
        const event = await this.next();
        if ('ok' in event) {
          if (cancelSent) {
            // The ACK can be interleaved, and a late cancel can be rejected.
            cancelSent = false;
            continue;
          }
          if (event.ok === false) throw wireError(event);
          throw new AdapterError('io_error', 'Unexpected wire ACK during generation', 502);
        }
        if (typeof event.event !== 'string') throw new AdapterError('io_error', 'Expected a wire event', 502);
        if (event.event === 'error') throw wireError(event);
        yield event;
        if (event.event === 'done') return;
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      signal?.removeEventListener('abort', cancel);
      this.active = false;
    }
  }
}

function wireError(reply) {
  const code = typeof reply.code === 'string' ? reply.code : 'io_error';
  const status = { context_length_exceeded: 400, invalid_request: 400, busy: 429, out_of_memory: 503 }[code] ?? 502;
  return new AdapterError(code, String(reply.error ?? code), status);
}
