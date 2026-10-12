import { isDeepStrictEqual } from 'node:util';
import { AdapterError } from './errors.js';
import { WireConnection } from './wire.js';

// Process-local cache: never opens a session created by another adapter.
export class SessionCache {
  constructor(socketPath, { limit = 4, ttlMs = 600000, operationTimeoutMs = 600000, onEvent } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid KV session cache limits');
    this.socketPath = socketPath;
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.operationTimeoutMs = operationTimeoutMs;
    this.onEvent = onEvent ?? (event => {
      if (event.kind === 'cleanup_failed') console.warn(`Xenolith Bridge could not delete its session ${event.session}: ${event.error}`);
    });
    this.entries = new Map();
    this.preparing = new Map();
  }

  async dispose(entry) {
    if (entry.disposing) return entry.disposing;
    entry.disposing = this.remove(entry);
    return entry.disposing;
  }

  async remove(entry) {
    this.entries.delete(entry.key);
    let wire = entry.wire;
    try {
      if (entry.session) {
        if (wire.error) { wire.close(); wire = await WireConnection.open(this.socketPath, 1000); }
        await wire.request({ op: 'delete', session: entry.session });
      }
    } catch (error) {
      this.onEvent?.({ kind: 'cleanup_failed', session: entry.session, error: error.message });
    } finally { wire.close(); entry.wire.close(); }
  }

  async prepare(freshWire, key, request) {
    if (this.closed || this.preparing.has(key)) throw new AdapterError('busy', 'KV conversation is being prepared or closed', 429);
    const preparing = this.prepareEntry(freshWire, key, request);
    this.preparing.set(key, preparing);
    try { return await preparing; }
    finally { this.preparing.delete(key); }
  }

  async prepareEntry(freshWire, key, request) {
    const now = Date.now();
    for (const entry of [...this.entries.values()]) {
      if (!entry.busy && now - entry.used >= this.ttlMs) await this.dispose(entry);
    }
    let entry = this.entries.get(key);
    if (entry?.busy) throw new AdapterError('busy', 'This KV conversation already has an active request', 429);
    const identity = { system: request.system, tools: request.tools };
    const suffix = entry ? request.messages.slice(entry.messages.length) : [];
    const valid = entry && !entry.wire.error && isDeepStrictEqual(identity, entry.identity) &&
      isDeepStrictEqual(request.messages.slice(0, entry.messages.length), entry.messages) &&
      suffix.length > 0 && suffix.every(m => ['tool', 'user'].includes(m.role)) &&
      suffix.filter(m => m.role === 'tool').length === entry.pending.length &&
      suffix.slice(0, entry.pending.length).every((m, i) => m.role === 'tool' && m.tool === entry.pending[i].name) &&
      suffix.slice(entry.pending.length).every(m => m.role === 'user');
    if (entry && !valid) { await this.dispose(entry); entry = undefined; }
    if (!entry) {
      if (this.entries.size >= this.limit) {
        const idle = [...this.entries.values()].filter(e => !e.busy).sort((a, b) => a.used - b.used)[0];
        if (!idle) throw new AdapterError('busy', 'KV session cache is full', 429);
        await this.dispose(idle);
      }
      entry = { key, wire: freshWire, identity, messages: [], pending: [], busy: true, used: now };
      this.entries.set(key, entry);
      try {
        const created = await freshWire.request({ op: 'create', ...identity }, this.operationTimeoutMs);
        if (typeof created.session !== 'string' || !/^[a-f0-9]{32}$/.test(created.session)) throw new AdapterError('io_error', 'Invalid durable session ID', 502);
        entry.session = created.session;
        await freshWire.request({ op: 'rebuild', ...identity, messages: request.messages }, this.operationTimeoutMs);
      } catch (error) { await this.dispose(entry); throw error; }
      this.onEvent?.({ kind: 'miss', session: entry.session });
    } else {
      entry.busy = true;
      freshWire.close();
      try {
        for (let i = 0; i < suffix.length; i++) {
          const m = suffix[i];
          await entry.wire.request(m.role === 'tool'
            ? { op: 'append', role: 'tool', call_id: entry.pending[i].id, text: m.text, status: m.status }
            : { op: 'append', role: 'user', text: m.text }, this.operationTimeoutMs);
        }
      } catch (error) { await this.dispose(entry); throw error; }
      this.onEvent?.({ kind: 'hit', session: entry.session, appended: suffix.length });
    }
    const { system, tools, messages, op, ...settings } = request;
    // Durable generations retain omitted sampler settings; reset to ephemeral defaults.
    const generate = { op: 'generate', temperature: 1, top_p: 0.95, top_k: 64, seed: 1, ...settings };
    return { entry, wire: entry.wire, request: generate };
  }

  commit(entry, request, stream) {
    const assistant = { role: 'assistant', text: stream.message?.content[0]?.text ?? '' };
    entry.pending = [...stream.calls.entries()].map(([id, call]) => ({ id, ...call }));
    if (entry.pending.length) assistant.calls = entry.pending.map(({ name, arguments: args }) => ({ name, arguments: args }));
    entry.messages = structuredClone([...request.messages, assistant]);
    entry.used = Date.now();
    entry.busy = false;
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.preparing.values()]);
    for (const entry of [...this.entries.values()]) await this.dispose(entry);
  }
}
