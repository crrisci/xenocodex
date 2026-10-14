import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WireConnection } from '../../src/wire.js';

// Opt-in real-engine scenarios. All sessions and files belong to the parent test.
export async function chatScenarios({ root, socket, bindings, info, url, restart, results }) {
  const prefix = 'real-chat-' + randomBytes(8).toString('hex');
  const nonce = randomBytes(6).toString('hex');
  const engine = { socket, model: info.model, context: info.context_window, protocol: info.protocol };
  const record = async key => JSON.parse(await readFile(join(bindings,
    createHash('sha256').update(JSON.stringify([engine, key])).digest('hex') + '.json'), 'utf8'));
  const save = async () => writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
  async function request(label, key, messages, { stream = true, tools } = {}) {
    const body = { model: info.model, messages, temperature: 0, max_tokens: 256, stream,
      ...(tools ? { tools, parallel_tool_calls: false } : {}) };
    await writeFile(join(root, label + '-request.json'), JSON.stringify(body, null, 2));
    const started = performance.now();
    const response = await fetch(url + '/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Xenolith-Session': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
    let raw = '', firstTextMs = null, parsed = '', content = '', calls = [], final;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });raw += text;parsed += text;
      if (stream) {
        let end;
        while ((end = parsed.indexOf('\n\n')) >= 0) {
          const frame = parsed.slice(0, end);parsed = parsed.slice(end + 2);
          const data = frame.split('\n').find(l => l.startsWith('data: '))?.slice(6);
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data);assert.ok(!event.error, JSON.stringify(event));
          const delta = event.choices?.[0]?.delta;
          if (delta?.content) { firstTextMs ??= performance.now() - started;content += delta.content; }
          for (const call of delta?.tool_calls ?? []) {
            const c = calls[call.index] ??= { id: call.id, type: 'function', function: { name: '', arguments: '' } };
            c.id ??= call.id;c.function.name += call.function?.name ?? '';c.function.arguments += call.function?.arguments ?? '';
          }
          if (event.choices?.[0]?.finish_reason) final = event;
        }
      }
    }
    raw += decoder.decode();
    const elapsedMs = performance.now() - started;
    await writeFile(join(root, label + '-response.txt'), raw);
    assert.equal(response.status, 200, raw);
    if (!stream) { final = JSON.parse(raw);content = final.choices[0].message.content;calls = final.choices[0].message.tool_calls ?? []; }
    assert.ok(final?.xenolith_usage, raw);
    const binding = await record(key);assert.equal(binding.inFlight, false);
    const phase = { elapsed_ms: elapsedMs, first_text_ms: firstTextMs,
      usage: final.xenolith_usage, session: binding.session, persistence: final.xenolith_session,
      finish_reason: final.choices[0].finish_reason, content, calls };
    results.phases[label] = phase;await save();
    console.log(`PHASE_OK ${label} cache=${phase.usage.cache_read} elapsed_ms=${phase.elapsed_ms.toFixed(0)}`);
    return phase;
  }
  const key = prefix + '-warm';
  const messages = [{ role: 'system', content: 'Follow instructions precisely. Return only the requested answer.' },
    { role: 'user', content: Array.from({ length: 300 }, (_, i) => `Ledger ${i}: code=${i * 17}; state=verified.`).join('\n') +
      `\nThe verification key is ${nonce}. Remember it and reply READY.` }];
  const seed = await request('chat_seed', key, messages, { stream: false });
  messages.push({ role: 'assistant', content: seed.content }, { role: 'user', content: 'Return only the verification key.' });
  const warm = await request('chat_warm', key, messages);
  const cold = await request('chat_cold_identical', prefix + '-cold', messages);
  assert.equal(warm.content.trim(), nonce);assert.equal(cold.content.trim(), nonce);
  assert.ok(warm.usage.cache_read > 0);assert.equal(cold.usage.cache_read, 0);
  assert.ok(cold.usage.input > warm.usage.input);
  assert.ok(warm.first_text_ms > 0 && cold.first_text_ms > 0);
  results.kv_comparison = { identical_request_except_session_key: true, repetitions: 1,
    input_computations_avoided: cold.usage.input - warm.usage.input,
    input_computations_reduction_percent: 100 * (1 - warm.usage.input / cold.usage.input),
    elapsed_reduction_percent: 100 * (1 - warm.elapsed_ms / cold.elapsed_ms),
    first_text_reduction_percent: 100 * (1 - warm.first_text_ms / cold.first_text_ms),
    note: 'Single sequential warm/cold pair on one engine; timings include HTTP, generation and checkpoint. Not a general throughput benchmark.' };
  await save();

  const toolKey = prefix + '-tool';
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a text file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
  const toolMessages = [{ role: 'system', content: 'Use read_file when asked to read a file. After its result, return only the exact file contents, without commentary.' },
    { role: 'user', content: 'Call read_file with path secret.txt now. Do not guess the contents.' }];
  const tool = await request('chat_tool_pending', toolKey, toolMessages, { tools });
  assert.equal(tool.finish_reason, 'tool_calls');assert.equal(tool.calls.length, 1);
  assert.equal(tool.calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(tool.calls[0].function.arguments), { path: 'secret.txt' });
  const pending = await record(toolKey);assert.equal(pending.pending.length, 1);
  // The harness executes only this validated fixture read, never arbitrary model commands.
  const secret = randomBytes(12).toString('hex');
  await writeFile(join(root, 'secret.txt'), secret);
  const output = await readFile(join(root, 'secret.txt'), 'utf8');
  toolMessages.push({ role: 'assistant', content: tool.content || null, tool_calls: tool.calls },
    { role: 'tool', tool_call_id: tool.calls[0].id, content: output });
  url = await restart({ crash: true });
  const afterCrash = await request('chat_tool_after_engine_bridge_crash', toolKey, toolMessages, { tools, stream: false });
  assert.equal(afterCrash.content.trim(), secret);assert.equal(afterCrash.session, pending.session);
  if (tool.persistence.checkpoint?.saved === true) {
    assert.equal(afterCrash.persistence.resume?.loaded, true);
    assert.ok(afterCrash.usage.cache_read > 0, 'A saved pending-tool checkpoint must restore real KV');
  }
  assert.deepEqual((await record(toolKey)).pending, []);
  toolMessages.push({ role: 'assistant', content: afterCrash.content },
    { role: 'user', content: 'Return only the same file contents again. Do not call a tool.' });
  const wire = await WireConnection.open(socket);
  try { await wire.describe();await wire.request({ op: 'delete', session: afterCrash.session }); }
  finally { wire.close(); }
  const beforeRejected = await record(toolKey);
  const rejected = await fetch(url + '/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Xenolith-Session': toolKey },
    body: JSON.stringify({ model: info.model, messages: [toolMessages[0], toolMessages.at(-1)], tools }),
    signal: AbortSignal.timeout(30000) });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, 'session_state_error');
  assert.deepEqual(await record(toolKey), beforeRejected);
  results.phases.chat_missing_history_rejected = { status: rejected.status, binding_unchanged: true };
  await save();
  const recovered = await request('chat_missing_native_session', toolKey, toolMessages, { tools });
  assert.equal(recovered.content.trim(), secret);assert.notEqual(recovered.session, afterCrash.session);
  assert.deepEqual(recovered.persistence.recovery, { reason: 'session_not_found', source: 'client_history', previous_kv_restored: false });
  // Rebuilding historical tools can itself produce reusable native context.
  // The recovery flag refers to the missing session snapshot, not all cache use.
  assert.notEqual(recovered.persistence.resume?.loaded, true);
  toolMessages.push({ role: 'assistant', content: recovered.content },
    { role: 'user', content: 'Return only the same file contents once more. Do not call a tool.' });
  url = await restart({ corruptSnapshots: true });
  const damaged = await request('chat_corrupt_snapshot', toolKey, toolMessages, { tools });
  assert.equal(damaged.content.trim(), secret);assert.equal(damaged.session, recovered.session);
  assert.equal(damaged.persistence.resume?.loaded, false);
  toolMessages.push({ role: 'assistant', content: damaged.content });
  const interrupted = [...toolMessages, { role: 'user', content: 'Write the integers from 1 through 1000, one per line. Do not call any tool. Do not abbreviate.' }];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);
  timeout.unref();
  const response = await fetch(url + '/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Xenolith-Session': toolKey },
    body: JSON.stringify({ model: info.model, messages: interrupted, tools, temperature: 0, max_tokens: 2048, stream: true }), signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();let received = '';
  try {
    while (!/"content":"[^"\\]/.test(received)) {
      const part = await reader.read();assert.equal(part.done, false, 'Need active text generation before killing engine');
      received += new TextDecoder().decode(part.value);
    }
    assert.equal((await record(toolKey)).inFlight, true);
    await writeFile(join(root, 'interrupted-stream.txt'), received);
    url = await restart({ crash: true });
  } finally { clearTimeout(timeout);controller.abort();await reader.cancel().catch(() => {}); }
  toolMessages.push({ role: 'user', content: 'Return only the file contents again. Do not call any tool.' });
  const interruptedRecovery = await request('chat_interrupted_generation_recovery', toolKey, toolMessages, { tools });
  assert.equal(interruptedRecovery.content.trim(), secret);assert.equal(interruptedRecovery.session, damaged.session);
  assert.deepEqual((await record(toolKey)).pending, []);
  return url;
}
