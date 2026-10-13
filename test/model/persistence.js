import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, readlink, writeFile, rename } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WireConnection } from '../../src/wire.js';

// Opt-in direct HTTP test. Owns only its isolated engine, bridge, state and cache.
assert.equal(process.platform, 'linux', 'Run the real persistence test on Linux/WSL');
const engineBin = process.env.XENOLITH_BIN;
const model = process.env.XENOLITH_MODEL;
for (const p of [engineBin, model]) { assert.ok(p?.startsWith('/'), 'Explicit absolute engine/model paths required'); await access(p); }
await mkdir(resolve('.test-artifacts'), { recursive: true });
const root = await mkdtemp(resolve('.test-artifacts/persistence-'));
const socket = join(root, 'w.sock'), bindings = join(root, 'bindings');
await Promise.all(['state', 'cache'].map(n => mkdir(join(root, n), { mode: 0o700 })));
const results = { root, phases: {}, started_at: new Date().toISOString(), mode: 'direct_http_real_model' };
let engine, bridge, info;
const key = 'persistence-' + randomBytes(8).toString('hex');
const nonce = randomBytes(4).toString('hex');
const instructions = 'Follow the user request. When asked for a verification key, return only that key, without explanation.';
const ledger = Array.from({ length: 300 }, (_, i) => `Ledger ${String(i).padStart(3, '0')}: code=${(i * 17 + 103).toString(16)}; state=verified; retain this reference.`).join('\n');
let history = [{ role: 'user', content: `${ledger}\nThe verification key is ${nonce}. Remember it for this conversation. Reply with READY.` }];

async function exclusivePreflight() {
  const mem = await readFile('/proc/meminfo', 'utf8');
  const gib = Number(/MemAvailable:\s+(\d+)/.exec(mem)[1]) / 1024 / 1024;
  assert.ok(gib >= 21, `Need 21 GiB available, have ${gib.toFixed(1)}`);
  for (const pid of await readdir('/proc')) if (/^\d+$/.test(pid)) {
    try { const exe = await readlink(`/proc/${pid}/exe`);assert.ok(!basename(exe).includes('xenolith'), `Another engine is active: ${pid}`); }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');child.kill('SIGTERM');
  if (!await Promise.race([exited.then(() => true), sleep(10000).then(() => false)])) {
    child.kill('SIGKILL');await Promise.race([exited, sleep(5000)]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned process did not exit');
}
async function startEngine(label) {
  await exclusivePreflight();
  const log = createWriteStream(join(root, `engine-${label}.log`));
  engine = spawn(engineBin, ['serve', model, '--ctx', '65536', '--socket', socket,
    '--state', join(root, 'state'), '--cache', join(root, 'cache')], { stdio: ['ignore', 'pipe', 'pipe'] });
  engine.on('error', error => { engine.failure = error; });engine.stdout.pipe(log, { end: false });engine.stderr.pipe(log, { end: false });
  engine.once('exit', () => log.end());
  console.log(`ENGINE_START ${engine.pid} ${label}`);
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (engine.failure) throw engine.failure;
    assert.equal(engine.exitCode, null, 'Owned engine exited during startup');
    let wire;
    try { wire = await WireConnection.open(socket, 1000);info = await wire.describe();return; }
    catch (error) { if (error.code === 'incompatible_protocol') throw error; }
    finally { wire?.close(); }
    await sleep(500);
  }
  throw new Error('Engine startup timeout');
}
async function startBridge(label) {
  const log = createWriteStream(join(root, `bridge-${label}.log`));
  bridge = spawn(process.execPath, [resolve('src/cli.js'), 'serve', '--socket', socket, '--state-dir', bindings],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.stderr.pipe(log, { end: false });bridge.once('exit', () => log.end());
  let stdout = '', stderr = '';
  bridge.stderr.on('data', b => { stderr += b; });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bridge startup timeout: ' + stderr)), 15000);
    bridge.once('error', e => { clearTimeout(timer);reject(e); });
    bridge.once('exit', c => { clearTimeout(timer);reject(new Error('Bridge exited: ' + c + ': ' + stderr)); });
    bridge.stdout.on('data', b => { stdout += b;
      if (stdout.includes('\n')) { clearTimeout(timer);resolve(JSON.parse(stdout.split('\n')[0]).base_url); }
    });
  });
  console.log(`BRIDGE_START ${bridge.pid} ${label}`);return baseUrl;
}
async function binding() {
  const name = (await readdir(bindings)).find(n => n.endsWith('.json'));
  return JSON.parse(await readFile(join(bindings, name), 'utf8'));
}
async function turn(url, label, question) {
  if (question) history.push({ role: 'user', content: question });
  const body = { model: info.model, stream: true, prompt_cache_key: key, instructions,
    temperature: 0, max_output_tokens: 128, input: history };
  await writeFile(join(root, label + '-request.json'), JSON.stringify(body, null, 2));
  const response = await fetch(url + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  const raw = await response.text();await writeFile(join(root, label + '-sse.txt'), raw);
  assert.equal(response.status, 200, raw);
  const events = raw.split('\n\n').flatMap(frame => {
    const line = frame.split('\n').find(x => x.startsWith('data: '));return line ? [JSON.parse(line.slice(6))] : [];
  });
  const final = events.at(-1);assert.equal(final?.type, 'response.completed', raw);
  const answer = final.response.output.filter(i => i.type === 'message').flatMap(i => i.content).map(p => p.text).join('');
  assert.ok(answer.trim(), 'Empty answer');
  if (question) assert.equal(answer.trim(), nonce, 'Model must retain the original verification key');
  history.push({ role: 'assistant', content: answer });
  const record = await binding();assert.equal(record.inFlight, false);assert.deepEqual(record.pending, []);
  assert.equal(final.response.xenolith_session.checkpoint.saved, true, 'Need an actual saved checkpoint');
  const phase = { pid: bridge.pid, session: record.session, marker: record.marker,
    checkpoint: final.response.xenolith_session.checkpoint, resume: final.response.xenolith_session.resume,
    usage: final.response.xenolith_usage, answer };
  results.phases[label] = phase;await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`PHASE_OK ${label} cache=${phase.usage.cache_read} loaded=${phase.resume?.loaded ?? 'not-reported'}`);
  return phase;
}
const cleanup = async () => { await stop(bridge);await stop(engine); };
try {
  console.log('PERSISTENCE_ROOT ' + root);
  await startEngine('initial');results.describe = info;
  let url = await startBridge('initial');const first = await turn(url, 'initial');
  await stop(bridge);url = await startBridge('bridge-restart');
  const second = await turn(url, 'bridge_restart', 'Return the verification key.');
  assert.equal(second.session, first.session);assert.notEqual(second.pid, first.pid);
  assert.ok(second.usage.cache_read > 0, 'Bridge restart must reuse actual engine context');
  await stop(bridge);await stop(engine);await startEngine('restart');url = await startBridge('engine-restart');
  const third = await turn(url, 'engine_restart', 'Return the verification key again.');
  assert.equal(third.session, first.session);assert.equal(third.resume?.loaded, true, 'Need an actual loaded snapshot report');
  assert.ok(third.usage.cache_read > 0, 'Engine restart must reuse loaded KV');
  await stop(bridge);await stop(engine);
  await rename(join(root, 'cache'), join(root, 'cache-retained'));await mkdir(join(root, 'cache'), { mode: 0o700 });
  await startEngine('missing-snapshot');url = await startBridge('missing-snapshot');
  const fourth = await turn(url, 'missing_snapshot', 'Return the verification key once more.');
  assert.equal(fourth.session, first.session);assert.equal(fourth.resume?.loaded, false);
  assert.equal(fourth.usage.cache_read, 0, 'Missing snapshot must not be presented as KV reuse');
  results.completed = true;console.log('PERSISTENCE_OK ' + root);
} catch (error) {
  results.failure = { message: error.message, stack: error.stack };console.error('PERSISTENCE_FAILED ' + error.message);process.exitCode = 1;
} finally {
  await cleanup();results.finished_at = new Date().toISOString();await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
}
