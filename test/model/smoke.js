import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startAdapter } from '../../src/server.js';
import { WireConnection } from '../../src/wire.js';
import { providerArgs } from '../../src/config.js';
import { testRoot } from '../helpers/codex.js';
import { appServer } from '../helpers/app-server.js';

// Opt-in, Linux-only real model battery. No installation or engine rebuild.
const bin = process.env.XENOLITH_BIN;
const model = process.env.XENOLITH_MODEL;
const reuseKv = process.env.XENOLITH_BRIDGE_REUSE_KV === '1';
const persistent = process.env.XENOLITH_BRIDGE_PERSISTENT === '1';
const clients = new Set();
let engine, adapter, root;
let stopping;
const result = { started_at: new Date().toISOString(), mode: 'real', phases: {} };
result.reuse_kv = reuseKv;
result.persistent = persistent;
result.request_metrics = [];
result.generations = [];
result.kv_hits = 0;
result.kv_misses = 0;

async function preflight() {
  assert.equal(process.platform, 'linux', 'Real model battery requires the Intel Linux/WSL host');
  assert.ok(bin && model, 'Set XENOLITH_BIN and XENOLITH_MODEL explicitly');
  await access(bin);
  await access(model);
  const meminfo = await readFile('/proc/meminfo', 'utf8');
  const available = Number(/MemAvailable:\s+(\d+)/.exec(meminfo)?.[1]) / 1024 / 1024;
  assert.ok(available >= 21, `Refusing to load weights: ${available.toFixed(1)} GiB available, need at least 21`);
  const owners = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const exe = await readlink(`/proc/${pid}/exe`);
      if (basename(exe).includes('xenolith')) owners.push({ pid, exe });
    } catch {} // Other users' processes and exiting processes can be unreadable.
  }
  assert.equal(owners.length, 0, `Refusing a second engine: ${JSON.stringify(owners)}`);
  result.preflight = { available_gib: available, bin, model, context: 65536 };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (!await Promise.race([exited.then(() => true), sleep(10000).then(() => false)])) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
  }
}

function cleanup() {
  stopping ??= (async () => {
    await Promise.all([...clients].map(stopChild));
    await adapter?.close();
    await stopChild(engine);
  })();
  return stopping;
}

async function waitForEngine(socketPath) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (engine.failure) throw engine.failure;
    if (engine.exitCode !== null || engine.signalCode !== null) throw new Error(`Engine exited during startup (${engine.exitCode ?? engine.signalCode}); see engine.log`);
    let wire;
    try {
      wire = await WireConnection.open(socketPath, 1000);
      return await wire.describe(10000);
    } catch (error) {
      if (error.code === 'incompatible_protocol') throw error;
    } finally { wire?.close(); }
    await sleep(1000);
  }
  throw new Error('Engine startup exceeded five minutes');
}

async function apiText() {
  const started = Date.now();
  const response = await fetch(`${adapter.baseUrl}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: adapter.info.model, stream: true, store: false,
      input: 'Reply with exactly XENOLITH_BRIDGE_REAL_OK and nothing else.', temperature: 0, max_output_tokens: 128 }),
    signal: AbortSignal.timeout(600000) });
  let text = '', firstDeltaMs;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (firstDeltaMs === undefined && text.includes('response.output_text.delta')) firstDeltaMs = Date.now() - started;
  }
  text += decoder.decode();
  await writeFile(join(root, 'text.sse'), text);
  assert.equal(response.status, 200, text);
  const events = text.split('\n\n').flatMap(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    return data ? [JSON.parse(data.slice(6))] : [];
  });
  assert.equal(events.at(-1)?.type, 'response.completed', text);
  const answer = events.at(-1).response.output.filter(i => i.type === 'message').flatMap(i => i.content).map(p => p.text).join('');
  assert.equal(answer.trim(), 'XENOLITH_BRIDGE_REAL_OK');
  assert.ok(firstDeltaMs !== undefined);
  return { answer, first_delta_ms: firstDeltaMs, elapsed_ms: Date.now() - started,
    usage: events.at(-1).response.xenolith_usage };
}

async function codexTurn(label, prompt) {
  const caseRoot = join(root, label);
  const workspace = join(caseRoot, 'workspace');
  const home = join(caseRoot, 'codex-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  let nonce, expectedContents;
  let originalTests, baseline;
  if (label === 'tool' || label === 'tool_literal') {
    nonce = `XENO_${randomBytes(16).toString('hex')}`;
    expectedContents = label === 'tool_literal' ? `Chunk ID: literal file content\nOutput: literal output line\n${nonce}` : nonce;
    await writeFile(join(workspace, 'input.txt'), expectedContents + '\n');
  } else if (label === 'coding') {
    await writeFile(join(workspace, 'sum.cjs'), 'function sum(a, b) { return a - b; }\nmodule.exports = { sum };\nif (require.main === module) console.log(sum(Number(process.argv[2]), Number(process.argv[3])));\n');
    originalTests = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum } = require('./sum.cjs');\ntest('sum adds numbers', () => { for (const [a,b] of [[2,3],[-4,7],[0,0],[1.5,2.25],[100,23]]) assert.equal(sum(a,b),a+b); });\n";
    await writeFile(join(workspace, 'sum.test.cjs'), originalTests);
    baseline = await fixtureCommand(workspace, ['--test', 'sum.test.cjs']);
    assert.equal(baseline.code, 1, 'Fixture must fail before the model changes it');
    await writeFile(join(caseRoot, 'baseline.log'), baseline.stdout + baseline.stderr);
  }
  const started = Date.now();
  const child = spawn(process.env.XENOLITH_BRIDGE_CODEX_BIN ?? 'codex', ['--no-daemon', 'exec',
    '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'workspace-write', '--json', '-C', workspace,
    ...providerArgs(adapter.baseUrl, adapter.info), prompt], {
    cwd: workspace, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  clients.add(child);
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; void stopChild(child); }, 600000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(timer); clients.delete(child); }
  await writeFile(join(caseRoot, 'codex.stdout.jsonl'), stdout);
  await writeFile(join(caseRoot, 'codex.stderr.log'), stderr);
  assert.ok(!timedOut, `${label} exceeded ten minutes`);
  assert.equal(code, 0, stderr + stdout);
  const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(events.some(e => e.type === 'turn.completed'), stdout);
  const final = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text;
  if (label === 'tool' || label === 'tool_literal') {
    assert.ok(events.some(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && e.item.exit_code === 0 && e.item.aggregated_output.includes(nonce)), stdout);
    assert.equal(final?.trim(), expectedContents, 'Model must return file contents without the execution wrapper: ' + stdout);
  } else if (label === 'coding') {
    assert.equal(await readFile(join(workspace, 'sum.test.cjs'), 'utf8'), originalTests, 'Model must not change the tests');
    const commands = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => e.item);
    assert.ok(commands.some(c => c.exit_code === 0 && c.aggregated_output.includes('return a - b')), 'Model must read the original broken source');
    assert.ok(commands.some(c => c.exit_code === 0 && c.command.includes('sum.test.cjs') && c.aggregated_output.includes('pass 1')), 'Model must execute the tests successfully');
    assert.ok(commands.some(c => c.exit_code === 0 && c.command.includes('sum.cjs 19 23') && /\b42\b/.test(c.aggregated_output)), 'Model must execute the corrected program');
    const verified = await fixtureCommand(workspace, ['--test', 'sum.test.cjs']);
    const executed = await fixtureCommand(workspace, ['sum.cjs', '19', '23']);
    await writeFile(join(caseRoot, 'verification.log'), verified.stdout + verified.stderr + executed.stdout + executed.stderr);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    assert.equal(executed.code, 0);
    assert.equal(executed.stdout.trim(), '42');
    assert.equal(final?.trim(), '42', 'Final answer must contain only the program result');
  } else assert.equal(final?.trim(), 'XENOLITH_BRIDGE_CODEX_REAL_OK');
  // Tool phase proves execution/result transport; report instruction fidelity separately.
  return { elapsed_ms: Date.now() - started, answer: final, nonce, expected_contents: expectedContents, events: events.length,
    exact_result: true, baseline_exit: baseline?.code };
}

async function fixtureCommand(cwd, args) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  clients.add(child);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', s => { stdout += s; });
  child.stderr.setEncoding('utf8').on('data', s => { stderr += s; });
  const timer = setTimeout(() => void stopChild(child), 30000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); clients.delete(child); }
}

async function lifecycle(restartAdapter) {
  const caseRoot = join(root, 'lifecycle');
  await mkdir(join(caseRoot, 'workspace'), { recursive: true });
  const workspace = join(caseRoot, 'workspace');
  const tests = "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {total}=require('./cart.cjs'); test('cart',()=>{assert.equal(total([{price:199,qty:3},{price:250,qty:2}]),1097);assert.equal(total([]),0);assert.equal(total([{price:100,qty:0}]),0);assert.throws(()=>total([{price:-1,qty:1}]),RangeError);assert.throws(()=>total([{price:100,qty:1.5}]),RangeError);});\n";
  await writeFile(join(workspace, 'cart.cjs'), "function total(items) { return items.reduce((s,x)=>s+x.price,0); }\nmodule.exports={total};\n");
  await writeFile(join(workspace, 'main.cjs'), "const {total}=require('./cart.cjs'); console.log(total(JSON.parse(process.argv[2])));\n");
  await writeFile(join(workspace, 'cart.test.cjs'), tests);
  const originalMain = await readFile(join(workspace, 'main.cjs'), 'utf8');
  const baseline = await fixtureCommand(workspace, ['--test', 'cart.test.cjs']);
  assert.equal(baseline.code, 1);
  await writeFile(join(caseRoot, 'baseline.log'), baseline.stdout + baseline.stderr);
  const started = Date.now();
  let client;
  try {
    client = await appServer(caseRoot, adapter.baseUrl, adapter.info, { timeoutMs: 600000 });
    const {thread} = await client.request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false });
    await client.turn(thread.id, 'Read cart.cjs, main.cjs and cart.test.cjs with exec_command. Rewrite cart.cjs using exec_command with a correctly quoted shell heredoc (cat > cart.cjs). Do not invoke apply_patch. Fix only cart.cjs: total sums price*qty in integer cents; both fields must be nonnegative safe integers, otherwise throw RangeError. Keep the tests and main.cjs unchanged. Run node --test cart.test.cjs until it passes. Report completion briefly.');
    assert.equal(await readFile(join(workspace, 'cart.test.cjs'), 'utf8'), tests);
    assert.equal(await readFile(join(workspace, 'main.cjs'), 'utf8'), originalMain);
    const checked = await fixtureCommand(workspace, ['--test', 'cart.test.cjs']);
    await writeFile(join(caseRoot, 'verification.log'), checked.stdout + checked.stderr);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    await client.compact(thread.id);
    const afterCompact = await client.turn(thread.id, 'Run node main.cjs with a JSON array containing price 199 qty 3 and price 250 qty 2. Reply with exactly the numeric program output, without commentary.');
    assert.equal(afterCompact.filter(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage').at(-1)?.params.item.text.trim(), '1097');
    await client.close('before-restart'); client = undefined;
    await restartAdapter();
    client = await appServer(caseRoot, adapter.baseUrl, adapter.info, { timeoutMs: 600000 });
    await client.request('thread/resume', {threadId:thread.id,cwd:workspace,approvalPolicy:'never',sandbox:'workspace-write'});
    const events = await client.turn(thread.id, 'Verify cart.test.cjs again using exec_command. Run main.cjs with price 199 qty 3 and price 250 qty 2 again. Reply with exactly the numeric program output, without commentary.');
    const answer = events.filter(e=>e.method==='item/completed' && e.params.item.type==='agentMessage').at(-1)?.params.item.text;
    assert.equal(answer?.trim(), '1097');
    const commands = events.filter(e => e.method === 'item/completed' && e.params.item.type === 'commandExecution').map(e => e.params.item);
    assert.ok(commands.some(c => c.exitCode === 0 && c.command.includes('cart.test.cjs')), 'Resumed model must run the tests');
    assert.ok(commands.some(c => c.exitCode === 0 && c.command.includes('main.cjs')), 'Resumed model must run the program');
    assert.equal(await readFile(join(workspace, 'cart.test.cjs'), 'utf8'), tests);
    assert.equal(await readFile(join(workspace, 'main.cjs'), 'utf8'), originalMain);
    const verified = await fixtureCommand(workspace, ['--test','cart.test.cjs']);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    return {elapsed_ms:Date.now()-started,answer,baseline_exit:1,exact_result:true,manual_compact:true,client_adapter_restart:true,engine_restart:true};
  } finally { await client?.close('after-restart'); }
}

async function launchEngine(label) {
  const engineLog = createWriteStream(join(root, label));
  engine = spawn(bin, ['serve', model, '--ctx', '65536', '--socket', join(root, 'w.sock'),
    '--state', join(root, 'state'), '--cache', join(root, 'cache'), '--idle-shutdown', '2'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  engine.on('error', error => { engine.failure = error; });
  engine.stdout.pipe(engineLog, { end: false });
  engine.stderr.pipe(engineLog, { end: false });
  engine.once('exit', () => engineLog.end());
  console.log(`ENGINE_START pid=${engine.pid}`);
  return waitForEngine(join(root, 'w.sock'));
}

async function main() {
  await preflight();
  root = await testRoot('real');
  console.log(`REAL_ROOT ${root}`);
  await mkdir(join(root, 'state'));
  await mkdir(join(root, 'cache'));
  result.describe = await launchEngine('engine.log');
  result.engine_pid = engine.pid;
  await writeFile(join(root, 'engine.pid'), String(engine.pid));
  assert.equal(result.describe.context_window, 65536);
  console.log(`DESCRIBE_OK ${JSON.stringify(result.describe)}`);
  const requests = createWriteStream(join(root, 'requests.jsonl'));
  const wireEvents = createWriteStream(join(root, 'wire-events.jsonl'));
  const sessionEvents = createWriteStream(join(root, 'session-events.jsonl'));
  let count = 0, current, phase;
  const start = () => startAdapter({ socketPath: join(root, 'w.sock'), maxOutputTokens: 2048, reuseKv,
    ...(persistent ? { stateDir: join(root, 'bindings') } : {}),
    onSessionEvent: event => {
      sessionEvents.write(JSON.stringify({ timestamp: Date.now(), ...event }) + '\n');
      current?.session_events.push(structuredClone(event));
      if (['hit', 'persistent_hit'].includes(event.kind)) result.kv_hits++;
      if (['miss', 'persistent_rebuild'].includes(event.kind)) result.kv_misses++;
      console.log(`KV ${event.kind}`);
    },
    onRequest: request => {
      if (++count > 40) throw new Error('Real battery request limit exceeded');
      current = { index: count, phase, started_at: Date.now(), first_wire_text_ms: null,
        wire_done_ms: null, session_events: [] };
      result.request_metrics.push(current);
      requests.write(JSON.stringify({ timestamp: Date.now(), ...request }) + '\n');
      console.log(`REQUEST ${count} input_items=${Array.isArray(request.body.input) ? request.body.input.length : 1}`);
    },
    onWireEvent: event => {
      wireEvents.write(JSON.stringify({ timestamp: Date.now(), ...event }) + '\n');
      if (event.event === 'text_delta' && current.first_wire_text_ms === null) current.first_wire_text_ms = Date.now() - current.started_at;
      if (event.event === 'done') {
        result.generations.push(event);
        Object.assign(current, { wire_done_ms: Date.now() - current.started_at,
          usage: event.usage, inference: event.inference, resume: event.resume ?? null });
      }
    },
  });
  adapter = await start();
  try {
    const phases = [
      ['codex_lifecycle', () => lifecycle(async () => {
        await adapter.close(); adapter = undefined;
        await stopChild(engine);
        const restarted = await launchEngine('engine-restarted.log');
        assert.equal(restarted.model, result.describe.model);
        result.restarted_engine_pid = engine.pid;
        result.engine_restart_request_offset = count;
        adapter = await start();
      })],
      ['api_text', apiText],
      ['codex_text', () => codexTurn('text', 'Reply with exactly XENOLITH_BRIDGE_CODEX_REAL_OK and nothing else. Do not call any tools.')],
      ['codex_tool', () => codexTurn('tool', 'Use exec_command to run cat input.txt. Then reply with the exact contents of the file, with no commentary. Do not guess the contents.')],
      ['codex_literal', () => codexTurn('tool_literal', 'Use exec_command to run cat input.txt. Reply with the exact contents of the file, including all its literal lines, without commentary or code fences. Do not guess the contents.')],
      ['codex_coding', () => codexTurn('coding', 'Read sum.cjs and sum.test.cjs using exec_command before editing. Fix sum.cjs so sum(a,b) correctly adds the two numbers. Keep sum.test.cjs unchanged. Use exec_command to run node --test sum.test.cjs and ensure the tests pass. Then use exec_command to run node sum.cjs 19 23. Reply with exactly the program output and nothing else.')],
    ];
    const selected = process.env.XENOLITH_BRIDGE_PHASES?.split(',') ?? phases.map(([label]) => label);
    assert.ok(selected.length && selected.every(label => phases.some(([name]) => name === label)), 'Unknown/empty XENOLITH_BRIDGE_PHASES');
    for (const [label, run] of phases.filter(([label]) => selected.includes(label))) {
      phase = label;
      console.log(`PHASE_START ${label}`);
      try {
        result.phases[label] = { status: 'passed', ...await run() };
        console.log(`PHASE_PASS ${label} ${JSON.stringify(result.phases[label])}`);
      } catch (error) {
        result.phases[label] = { status: 'failed', error: error.message };
        throw error;
      }
    }
    if (persistent && selected.includes('codex_lifecycle')) {
      assert.ok(result.request_metrics.slice(result.engine_restart_request_offset).some(r => r.resume?.loaded === true),
        'Persistent coding lifecycle must report actual snapshot restoration after engine restart');
    }
    if ((reuseKv || persistent) && selected.some(label => ['codex_tool', 'codex_literal', 'codex_coding'].includes(label))) {
      assert.ok(result.kv_hits > 0, 'KV battery must exercise a matching continuation');
      assert.ok(result.generations.some(event => event.usage.cache_read > 0), 'Engine must report actual KV reuse');
    }
  } finally { requests.end(); wireEvents.end(); await adapter.close(); adapter = undefined; sessionEvents.end(); }
}

process.once('SIGINT', () => { process.exitCode = 130; void cleanup(); });
process.once('SIGTERM', () => { process.exitCode = 143; void cleanup(); });
try {
  await main();
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = error.message;
  console.error(`REAL_FAILED ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  result.finished_at = new Date().toISOString();
  if (root) await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`REAL_FINISHED status=${result.status} artifacts=${root ?? 'preflight failed'}`);
}
