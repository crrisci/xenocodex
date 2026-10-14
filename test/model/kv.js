import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startAdapter } from '../../src/server.js';
import { startRealEngine } from './engine.js';

// Sequential diagnostic comparisons, not a general performance benchmark.
const sizes = (process.env.XENOLITH_BRIDGE_KV_SIZES ?? '32,128,512').split(',').map(Number);
const repetitions = Number(process.env.XENOLITH_BRIDGE_KV_REPETITIONS ?? 2);
assert.ok(sizes.length && sizes.every(n => Number.isInteger(n) && n > 0 && n <= 1000));
assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 10);
let engine, adapter;
const results = { mode: 'real_kv_diagnostic', sizes, repetitions, samples: [], order: 'seed,warm,fresh,changed,changed_fresh', fresh_session_is_not_guaranteed_cold: true, started_at: new Date().toISOString() };
const events = [], sessions = [];
async function turn(label, key, messages, expected) {
  const start = performance.now(), offset = events.length, sessionOffset = sessions.length;
  const request = { model: engine.info.model, messages, temperature: 0, max_tokens: 32, stream: true };
  const response = await fetch(adapter.baseUrl + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Xenolith-Session': key },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(300000),
  });
  assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
  let buffer = '', content = '', firstTextMs = null;
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);buffer = buffer.slice(end + 2);
      for (const line of frame.split('\n')) if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        const event = JSON.parse(line.slice(6));
        assert.ok(!event.error, JSON.stringify(event));
        const text = event.choices?.[0]?.delta?.content;
        if (text) { firstTextMs ??= performance.now() - start;content += text; }
      }
    }
  }
  const terminal = events.slice(offset).findLast(e => e.event === 'done');
  const result = { label, elapsed_ms: performance.now() - start, first_text_ms: firstTextMs,
    request, content, usage: terminal?.usage, session_events: sessions.slice(sessionOffset) };
  assert.equal(content.trim(), expected, JSON.stringify(result));
  assert.ok(terminal?.usage, 'Native usage must be observed');
  console.log(`${label} input=${result.usage.input} cache=${result.usage.cache_read} ms=${result.elapsed_ms.toFixed(0)}`);
  return result;
}
try {
  engine = await startRealEngine('kv-matrix');console.log('KV_ROOT ' + engine.root);
  adapter = await startAdapter({ socketPath: engine.socket, stateDir: join(engine.root, 'bindings'),
    onWireEvent: e => events.push(structuredClone(e)), onSessionEvent: e => sessions.push(structuredClone(e)) });
  results.describe = engine.info;
  for (const size of sizes) for (let repeat = 0; repeat < repetitions; repeat++) {
    const key = randomBytes(8).toString('hex'), nonce = randomBytes(4).toString('hex');
    const ledger = Array.from({ length: size }, (_, i) => `Record ${i}: item=${i * 17 + 103}; status=verified.`).join('\n');
    const seed = [{ role: 'system', content: 'Follow the user request. Return only the requested key or READY, without explanation.' },
      { role: 'user', content: `${ledger}\nVerification key: ${nonce}. Remember it and reply READY.` }];
    const sample = { size, repeat };results.samples.push(sample);
    sample.seed = await turn('seed', key, seed, 'READY');
    const continued = [...seed, { role: 'assistant', content: sample.seed.content }, { role: 'user', content: 'Return the verification key.' }];
    sample.warm = await turn('warm', key, continued, nonce);
    sample.fresh = await turn('fresh', key + '-fresh', continued, nonce);
    const changed = structuredClone(continued);changed[1].content = changed[1].content.replace('status=verified', 'status=updated');
    sample.changed = await turn('changed', key, changed, nonce);
    sample.changed_fresh = await turn('changed_fresh', key + '-changed-fresh', changed, nonce);
    assert.ok(sample.warm.session_events.some(e => e.kind === 'persistent_hit'), 'Unchanged history must append incrementally');
    assert.ok(sample.warm.usage.cache_read > 0, 'Warm continuation must report KV reuse');
    assert.ok(sample.changed.session_events.some(e => e.kind === 'persistent_rebuild'), 'Changed prefix must rebuild');
    await writeFile(join(engine.root, 'result.json'), JSON.stringify(results, null, 2));
  }
  results.status = 'passed';
} catch (error) {
  results.status = 'failed';results.error = { message: error.message, stack: error.stack };process.exitCode = 1;
  console.error(error);
} finally {
  try { await adapter?.close(); } finally { await engine?.close(); }
  results.finished_at = new Date().toISOString();
  if (engine) await writeFile(join(engine.root, 'result.json'), JSON.stringify(results, null, 2));
}
