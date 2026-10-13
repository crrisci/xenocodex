import { open, mkdir, readFile, rename, unlink, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { AdapterError } from './errors.js';
import { acquireStateLock } from './state-lock.js';

const failure = message => new AdapterError('session_state_error', message, 503);
const marker = value => Number.isSafeInteger(value) && value >= 0;
const identity = request => ({ system: request.system ?? '', tools: request.tools });

// A dedicated local directory has one writer, protected by a kernel-held guard.
export class PersistentSessionCache {
  static async create(socketPath, info, stateDir, options = {}) {
    const cache = new PersistentSessionCache(socketPath, info, stateDir, options);
    await mkdir(cache.directory, { recursive: true, mode: 0o700 });
    const directory = await stat(cache.directory);
    if (directory.mode & 0o077) throw failure('The session state directory must have private permissions (0700)');
    cache.lock = await acquireStateLock(cache.directory);
    return cache;
  }

  constructor(socketPath, info, stateDir, { operationTimeoutMs = 600000, onEvent } = {}) {
    if (!info.kvstore) throw failure('Persistent sessions require Xenolith kvstore support');
    this.directory = resolve(stateDir);
    this.engine = { socket: resolve(socketPath), model: info.model, context: info.context_window, protocol: info.protocol };
    this.timeout = operationTimeoutMs;
    this.onEvent = onEvent;
    this.entries = new Map();
    this.preparing = new Map();
  }

  path(key) {
    const digest = createHash('sha256').update(JSON.stringify([this.engine, key])).digest('hex');
    return join(this.directory, `${digest}.json`);
  }

  async save(entry) {
    const temporary = `${entry.path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(entry.record));
      await file.sync(); await file.close(); file = undefined;
      await rename(temporary, entry.path);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await file?.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async load(path) {
    let data;
    try {
      if ((await stat(path)).size > 32 * 1024 * 1024) throw failure('Session binding exceeds the state limit');
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure('Cannot read a valid session binding: ' + error.message);
    }
    if (!data || typeof data !== 'object' || data.version !== 1 || !isDeepStrictEqual(data.engine, this.engine) ||
        !/^[a-f0-9]{32}$/.test(data.session ?? '') || !marker(data.marker) ||
        typeof data.inFlight !== 'boolean' || !Array.isArray(data.messages) ||
        !Array.isArray(data.pending) || !data.identity ||
        data.pending.some(p => !p || !marker(p.id) || typeof p.name !== 'string' || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments))) {
      throw failure('Invalid or incompatible persisted session binding');
    }
    return data;
  }

  async prepare(wire, key, request) {
    if (this.closed || this.preparing.has(key) || this.entries.has(key)) {
      throw new AdapterError('busy', 'This persistent conversation already has an active request', 429);
    }
    const preparing = this.prepareEntry(wire, key, request);
    this.preparing.set(key, preparing);
    try { return await preparing; } finally { this.preparing.delete(key); }
  }

  async prepareEntry(wire, key, request) {
    const entry = { key, path: this.path(key), wire, record: await this.load(this.path(key)) };
    this.entries.set(key, entry);
    try {
      const sameIdentity = identity(request);
      let reason = 'new_session';
      if (entry.record) {
        let opened;
        for (let attempt = 0; ; attempt++) {
          try { opened = await wire.request({ op: 'open', session: entry.record.session }, this.timeout); break; }
          catch (error) {
            if (['busy', 'session_busy'].includes(error.code) && attempt < 25) { await sleep(20); continue; }
            // Do not guess whether an engine error means this session is missing.
            throw error;
          }
        }
        if (!marker(opened.marker) || !Array.isArray(opened.pending) || opened.pending.some(p => !marker(p))) {
          throw failure('Invalid native session opening report');
        }
        if (!entry.record.inFlight && (opened.marker !== entry.record.marker ||
            !isDeepStrictEqual(opened.pending, entry.record.pending.map(p => p.id)))) {
          throw failure('Committed session marker or pending calls diverged; no mutation was sent');
        }
        reason = entry.record.inFlight ? 'interrupted_request' : 'changed_history';
      } else {
        const created = await wire.request({ op: 'create', ...sameIdentity }, this.timeout);
        if (!/^[a-f0-9]{32}$/.test(created.session ?? '') || !marker(created.marker)) throw failure('Invalid created session');
        entry.record = { version: 1, engine: this.engine, session: created.session, marker: created.marker,
          identity: sameIdentity, messages: [], pending: [], inFlight: true };
        await this.save(entry);
      }
      const record = entry.record;
      const suffix = request.messages.slice(record.messages.length);
      const incremental = !record.inFlight && isDeepStrictEqual(record.identity, sameIdentity) &&
        isDeepStrictEqual(request.messages.slice(0, record.messages.length), record.messages) && suffix.length > 0 &&
        suffix.slice(0, record.pending.length).every((m, i) => m.role === 'tool' && m.tool === record.pending[i].name) &&
        suffix.filter(m => m.role === 'tool').length === record.pending.length &&
        suffix.slice(record.pending.length).every(m => m.role === 'user');
      // Persist uncertainty before any append/rebuild/generation can mutate the engine.
      record.inFlight = true; await this.save(entry);
      if (incremental) {
        for (let i = 0; i < suffix.length; i++) {
          const m = suffix[i];
          await wire.request(m.role === 'tool'
            ? { op: 'append', role: 'tool', call_id: record.pending[i].id, text: m.text, status: m.status }
            : { op: 'append', role: 'user', text: m.text }, this.timeout);
        }
      } else {
        await wire.request({ op: 'rebuild', ...sameIdentity, messages: request.messages }, this.timeout);
      }
      this.onEvent?.({ kind: incremental ? 'persistent_hit' : 'persistent_rebuild', session: record.session, reason: incremental ? undefined : reason });
      const { system, tools, messages, op, ...settings } = request;
      return { entry, wire, request: { op: 'generate', temperature: 1, top_p: 0.95, top_k: 64, seed: 1, ...settings } };
    } catch (error) { await this.dispose(entry); throw error; }
  }

  async commit(entry, request, stream, terminal) {
    if (!marker(terminal.marker)) throw failure('A persistent generation needs a valid committed marker');
    const assistant = { role: 'assistant', text: stream.message?.content[0]?.text ?? '' };
    const pending = [...stream.calls.entries()].map(([id, call]) => ({ id, ...call }));
    if (pending.length) assistant.calls = pending.map(({ name, arguments: args }) => ({ name, arguments: args }));
    let checkpoint = terminal.checkpoint;
    if (terminal.stop === 'stop' && checkpoint?.saved !== true) {
      checkpoint = await entry.wire.request({ op: 'checkpoint' }, this.timeout);
      if (typeof checkpoint.saved !== 'boolean') throw failure('Invalid native checkpoint report');
    }
    entry.record = { ...entry.record, marker: terminal.marker, identity: identity(request),
      messages: structuredClone([...request.messages, assistant]), pending, checkpoint, inFlight: false };
    await this.save(entry);
    this.onEvent?.({ kind: 'persistent_commit', session: entry.record.session, marker: terminal.marker, checkpoint });
    // Release the native binding before a published tool can produce another request.
    entry.wire.close();
  }

  async dispose(entry) {
    entry.wire.close();
    this.entries.delete(entry.key);
    // Keep owned engine sessions and the last durable record, including uncertainty.
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.preparing.values()]);
    for (const entry of [...this.entries.values()]) await this.dispose(entry);
    if (this.lock) {
      await this.lock.close(); this.lock = undefined;
    }
  }
}
