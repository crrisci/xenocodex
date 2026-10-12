import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerArgs } from '../../src/config.js';

// Actual installed Codex JSON-RPC client. Each run owns its isolated home.
export async function appServer(root, baseUrl, info, { timeoutMs = 45000 } = {}) {
  const home = join(root, 'codex-home'), workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const child = spawn(process.env.XENOLITH_BRIDGE_CODEX_BIN ?? 'codex', ['--no-daemon',
    ...providerArgs(baseUrl, info), '-c', 'mcp_servers={}', 'app-server', '--listen', 'stdio://'], {
    cwd: workspace, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0, buffer = '', stderr = '', failed;
  const pending = new Map(), notifications = [], waiters = new Set(), transcript = [];
  function fail(error) { failed = error; for (const p of pending.values()) p.reject(error); for (const w of waiters) w.reject(error); }
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Codex app-server exited ${code}: ${stderr}`)));
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { fail(error); return; }
      transcript.push(message);
      if (message.id !== undefined && !message.method) {
        const p = pending.get(message.id); pending.delete(message.id);
        if (message.error) p?.reject(new Error(JSON.stringify(message.error))); else p?.resolve(message.result);
      } else if (message.id !== undefined) {
        // Fixtures use approvalPolicy:never. Unexpected interactive requests fail.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unexpected server request in test' } }) + '\n');
        fail(new Error(`Unexpected interactive request ${message.method}`));
      } else {
        notifications.push(message);
        for (const w of waiters) if (w.match(message)) { waiters.delete(w); w.resolve(message); }
      }
    }
  });
  async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Codex app-server timeout: ${stderr}`)), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function request(method, params) {
    if (failed) throw failed;
    const id = ++sequence;
    return bounded(new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    }));
  }
  function wait(match, since = notifications.length) {
    if (failed) return Promise.reject(failed);
    const existing = notifications.slice(since).find(match);
    if (existing) return Promise.resolve(existing);
    let waiter;
    return bounded(new Promise((resolve, reject) => { waiter = { match, resolve, reject }; waiters.add(waiter); }))
      .finally(() => waiters.delete(waiter));
  }
  try {
    await request('initialize', { clientInfo: { name: 'xenolith-bridge-test', version: '0.2.0' }, capabilities: { experimentalApi: true } });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  return { request, wait, notifications, workspace,
    async turn(threadId, text) {
      const since = notifications.length;
      const started = await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      const completed = await wait(m => m.method === 'turn/completed' && m.params.turn.id === started.turn.id, since);
      if (completed.params.turn.status !== 'completed') throw new Error(JSON.stringify(completed.params.turn));
      return notifications.slice(since);
    },
    async compact(threadId) {
      const since = notifications.length;
      await request('thread/compact/start', { threadId });
      const result = await wait(m => m.method === 'turn/completed' && m.params.threadId === threadId, since);
      if (result.params.turn.status !== 'completed') throw new Error(JSON.stringify(result.params.turn));
      return notifications.slice(since);
    },
    async close(label = 'app-server') {
      child.stdin.end();
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      await writeFile(join(root, `${label}.json`), JSON.stringify(transcript, null, 2));
      await writeFile(join(root, `${label}.stderr.log`), stderr);
    },
  };
}
