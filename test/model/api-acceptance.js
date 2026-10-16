import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const instructions = 'Use read_file to read input.txt when asked. Never guess file contents. After receiving its result, return exactly the entire file contents, with no commentary or formatting.';
const tool = { name: 'read_file', description: 'Read a local text file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} };

// Exercises the HTTP interface, including terminal extensions that SDK stream
// accumulators may discard. No engine or client credentials are required here.
export async function request(baseUrl, api, body, key, { cancelAfterText = false, beforeCancel } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('Request exceeded ten minutes')), 600000);
  const start = Date.now();let firstTextMs, cancelled = false;
  try {
    const response = await fetch(`${baseUrl}/${api}`, { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'X-Xenolith-Session': key }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
    if (!body.stream) return { value: await response.json(), elapsed_ms: Date.now() - start };
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const decoder = new TextDecoder();let buffer = '', terminal, ended = false;
    const message = { role: 'assistant', content: '', tool_calls: [] };
    const events = [];
    try {
      outer: for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        for (;;) {
          const end = buffer.indexOf('\n\n');if (end < 0) break;
          const frame = buffer.slice(0, end);buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
          if (!data) continue;
          if (data === '[DONE]') { ended = true;continue; }
          const event = JSON.parse(data);events.push(event);
          assert.ok(!event.error && event.type !== 'response.failed', JSON.stringify(event));
          const delta = api === 'responses' ? (event.type === 'response.output_text.delta' ? event.delta : '') : event.choices?.[0]?.delta?.content;
          if (delta) {
            firstTextMs ??= Date.now() - start;
            if (cancelAfterText) { await beforeCancel?.();cancelled = true;controller.abort();break outer; }
          }
          if (api === 'responses') {
            if (['response.completed', 'response.incomplete'].includes(event.type)) terminal = event.response;
          } else {
            const choice = event.choices?.[0];
            message.content += choice?.delta?.content ?? '';
            for (const call of choice?.delta?.tool_calls ?? []) {
              const current = message.tool_calls[call.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (call.id) current.id = call.id;
              current.function.name += call.function?.name ?? '';current.function.arguments += call.function?.arguments ?? '';
            }
            if (choice?.finish_reason) terminal = { ...event, choices: [{ ...choice, message }] };
            if (event.usage && terminal) terminal.usage = event.usage;
          }
        }
      }
    } catch (error) { if (!cancelled || error.name !== 'AbortError') throw error; }
    if (cancelAfterText) assert.ok(cancelled, 'Generation completed without observing text to cancel');
    else {
      assert.ok(terminal, 'SSE ended without a terminal response');
      if (api !== 'responses') assert.ok(ended, 'Chat SSE missing [DONE]');
    }
    return { value: terminal, events, cancelled, first_text_ms: firstTextMs, elapsed_ms: Date.now() - start };
  } finally { clearTimeout(timer);controller.abort(); }
}

function answer(api, value) {
  if (api === 'responses') {
    assert.equal(value.status, 'completed');
    return value.output.filter(i => i.type === 'message').flatMap(i => i.content).map(i => i.text ?? '').join('');
  }
  assert.equal(value.choices[0].finish_reason, 'stop');return value.choices[0].message.content;
}

export async function runAcceptance({ root, connect, restart, requireSnapshot = true, beforeCancel }) {
  await mkdir(root, { recursive: true });
  const results = [];
  for (const api of ['responses', 'chat/completions']) for (const stream of [false, true]) {
    const label = `${api === 'responses' ? 'responses' : 'chat'}-${stream ? 'sse' : 'json'}`;
    const caseRoot = join(root, label);await mkdir(caseRoot, { recursive: true });
    const current = { case: label, status: 'failed' };results.push(current);
    try {
      const nonce = `BRIDGE_${randomUUID()}`;await writeFile(join(caseRoot, 'input.txt'), nonce);
      const key = randomUUID();let { baseUrl, model } = await connect();
      const responses = api === 'responses';
      const common = { model, stream, temperature: 0, parallel_tool_calls: false,
        ...(responses ? { instructions, store: false, max_output_tokens: 512, tools: [{ type: 'function', ...tool, strict: false }] }
          : { max_completion_tokens: 512, tools: [{ type: 'function', function: { ...tool, strict: false } }],
            ...(stream ? { stream_options: { include_usage: true } } : {}) }) };
      let history = [...(responses ? [] : [{ role: 'system', content: instructions }]), { role: 'user', content: 'Read input.txt using read_file and return its entire contents.' }];
      const payload = () => ({ ...common, ...(responses ? { input: history } : { messages: history }) });
      const first = await request(baseUrl, api, payload(), key);
      await writeFile(join(caseRoot, 'first.json'), JSON.stringify(first, null, 2));
      const calls = responses ? first.value.output.filter(i => i.type === 'function_call') : first.value.choices[0].message.tool_calls;
      assert.equal(calls?.length, 1, 'Expected exactly one file read');
      const call = calls[0], fn = responses ? call : call.function;
      assert.equal(fn.name, 'read_file');assert.deepEqual(JSON.parse(fn.arguments), { path: 'input.txt' });
      assert.equal(first.value.xenolith_session?.checkpoint?.saved, true, 'Tool must have a durable checkpoint');
      // Execute only the validated fixture path. The nonce was never in the prompt.
      const actual = await readFile(join(caseRoot, 'input.txt'), 'utf8');
      history.push(...(responses ? [...first.value.output, { type: 'function_call_output', call_id: call.call_id, output: actual }]
        : [first.value.choices[0].message, { role: 'tool', tool_call_id: call.id, content: actual }]));
      await restart(`${label}-pending-tool`);({ baseUrl, model } = await connect());assert.equal(model, common.model);
      const second = await request(baseUrl, api, payload(), key);
      await writeFile(join(caseRoot, 'second.json'), JSON.stringify(second, null, 2));
      assert.equal(answer(api, second.value).trim(), nonce);
      if (requireSnapshot) {
        assert.equal(second.value.xenolith_session?.resume?.loaded, true, 'Engine must explicitly report snapshot restoration');
        const cached = responses ? second.value.usage.input_tokens_details.cached_tokens : second.value.usage.prompt_tokens_details.cached_tokens;
        assert.ok(cached > 0, 'Engine must report actual cache reuse');
      }
      if (stream) assert.ok(second.first_text_ms !== undefined, 'Expected progressive text');
      history.push(...(responses ? second.value.output : [second.value.choices[0].message]));
      let cancellation;
      if (stream) {
        const committed = [...history];history.push({ role: 'user', content: 'List all integers from 1 to 10000, one per line. Do not use tools.' });
        cancellation = await request(baseUrl, api, { ...payload(), tool_choice: 'none' }, key, { cancelAfterText: true, beforeCancel });
        await writeFile(join(caseRoot, 'cancel.json'), JSON.stringify(cancellation, null, 2));
        await restart(`${label}-cancelled`);({ baseUrl } = await connect());
        // Discard the interrupted turn and supply only committed history.
        history = [...committed, { role: 'user', content: 'Return exactly the previous file contents again. Do not read the file again.' }];
        const recovered = await request(baseUrl, api, { ...payload(), tool_choice: 'none' }, key);
        await writeFile(join(caseRoot, 'recovered.json'), JSON.stringify(recovered, null, 2));
        assert.equal(answer(api, recovered.value).trim(), nonce);
      }
      const result = { case: label, status: 'passed', actual_file_reads: 1, restart_before_result: true,
        snapshot_required: requireSnapshot, resume: second.value.xenolith_session?.resume,
        first_text_ms: second.first_text_ms, cancellation: cancellation?.cancelled ?? false };
      Object.assign(current, result);
      console.log(`API_ACCEPTANCE_PASS ${label}`);
    } finally { await writeFile(join(root, 'cases.json'), JSON.stringify(results, null, 2)); }
  }
  return results;
}
