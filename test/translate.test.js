import test from 'node:test';
import assert from 'node:assert/strict';
import { translateRequest } from '../src/translate.js';
import { ToolRegistry } from '../src/tools.js';
import { description } from './helpers/fake-wire.js';

const base = { model: description.model, stream: true, input: 'hello' };
const fn = name => ({ type: 'function', name, description: 'Test', parameters: { type: 'object', properties: {} } });

test('developer instructions, assistant history and text parts retain order', () => {
  const body = { ...base, input: [
    { role: 'developer', content: [{ type: 'input_text', text: 'first' }] },
    { role: 'system', content: 'second' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'a' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'b' }, { type: 'input_text', text: 'c' }] },
  ], reasoning: { summary: 'auto' }, include: ['reasoning.encrypted_content'] };
  const { request } = translateRequest(body, description);
  assert.equal(request.system, 'first\n\nsecond');
  assert.deepEqual(request.messages, [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'a' }, { role: 'user', text: 'bc' }]);
  assert.equal(request.reasoning, false);
  assert.equal(request.max_tokens, 4096);
});

test('namespace identities remain distinct and reversible', () => {
  const registry = new ToolRegistry([fn('read'), { type: 'namespace', name: 'files', tools: [fn('read')] }]);
  const names = registry.declarations.map(t => t.name);
  assert.equal(new Set(names).size, 2);
  const output = registry.output(names[1], { path: 'x' }, 'call_unique', 'fc_unique');
  assert.equal(output.namespace, 'files');
  assert.equal(output.name, 'read');
  assert.equal(output.arguments, '{"path":"x"}');
});

test('freeform custom tool round-trips as a string, never as parsed code', () => {
  const registry = new ToolRegistry([{ type: 'custom', name: 'apply_patch', description: 'Patch',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }]);
  const input = '*** Begin Patch\n*** End Patch';
  const output = registry.output('apply_patch', { input }, 'call_patch', 'fc_patch');
  assert.equal(output.type, 'custom_tool_call');
  assert.equal(output.input, input);
  assert.throws(() => registry.output('apply_patch', { input, extra: true }, 'c', 'f'));
});

test('tool results are associated by call ID, including repeated names', () => {
  const body = { ...base, tools: [fn('read')], input: [
    { role: 'user', content: 'read' },
    { type: 'function_call', name: 'read', call_id: 'a', arguments: '{"path":"a"}' },
    { type: 'function_call', name: 'read', call_id: 'b', arguments: '{"path":"b"}' },
    { type: 'function_call_output', call_id: 'a', output: 'A' },
    { type: 'function_call_output', call_id: 'b', output: [{ type: 'input_text', text: 'B' }] },
  ] };
  const { request } = translateRequest(body, description);
  assert.equal(request.messages[1].calls.length, 2);
  assert.deepEqual(request.messages.slice(2), [{ role: 'tool', tool: 'read', text: 'A', status: 'ok' }, { role: 'tool', tool: 'read', text: 'B', status: 'ok' }]);
  const reordered = structuredClone(body);
  [reordered.input[3], reordered.input[4]] = [reordered.input[4], reordered.input[3]];
  assert.throws(() => translateRequest(reordered, description), /call order/);
});

test('Codex execution metadata remains intact with explicit interpretation guidance', () => {
  const output = 'Chunk ID: abc\nWall time: 1 seconds\nProcess exited with code 1\nOutput:\nWall time: literal file text\nerror';
  const { request } = translateRequest({ ...base, tools: [fn('exec_command')], input: [
    { role: 'user', content: 'read' },
    { type: 'function_call', name: 'exec_command', call_id: 'c', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c', output },
  ] }, description);
  const projected = JSON.parse(request.messages.at(-1).text);
  assert.equal(projected.stdout, 'Wall time: literal file text\nerror');
  assert.equal(projected.execution.exit_code, 1);
  assert.equal(projected.execution.header + 'Output:\n' + projected.stdout, output);
  assert.ok(request.system.includes('File contents and program output are in stdout'));
});

for (const [label, override] of [
  ['invalid stream', { stream: 'true' }], ['wrong model', { model: 'other' }],
  ['images', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] }],
  ['reasoning effort', { reasoning: { effort: 'high' } }],
  ['hosted tools', { tools: [{ type: 'web_search', name: 'search' }] }],
  ['JSON output', { text: { format: { type: 'json_schema' } } }],
  ['continuation IDs', { previous_response_id: 'resp_other' }],
  ['response storage', { store: true }], ['explicit tool choice', { tool_choice: 'required' }],
  ['empty transcript', { input: [] }], ['invalid temperature', { temperature: -1 }],
  ['excessive temperature', { temperature: 2.1 }],
  ['strict schemas', { tools: [{ ...fn('read'), strict: true }] }],
  ['zero output cap', { max_output_tokens: 0 }],
  ['embedded NUL', { input: 'a\0b' }],
  ['reasoning history', { input: [{ type: 'reasoning', summary: [] }] }],
  ['late system change', { input: [{ role: 'user', content: 'hi' }, { role: 'developer', content: 'new' }] }],
]) {
  test(`reject ${label} explicitly`, () => assert.throws(() => translateRequest({ ...base, ...override }, description)));
}

test('compaction imports historical calls without enabling undeclared tools', () => {
  const input = [
    { role: 'user', content: 'read' },
    { type: 'function_call', namespace: 'files', name: 'read', call_id: 'a', arguments: '{"path":"x"}' },
    { type: 'function_call_output', call_id: 'a', output: 'contents' },
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'b', input: 'literal\npatch' },
    { type: 'custom_tool_call_output', call_id: 'b', output: 'ok' },
    { role: 'user', content: 'Summarize the history' },
  ];
  const { request, registry } = translateRequest({ ...base, tools: [], input }, description);
  assert.deepEqual(request.tools, []);
  const wireName = new ToolRegistry([{ type: 'namespace', name: 'files', tools: [fn('read')] }]).declarations[0].name;
  assert.equal(request.messages[1].calls[0].name, wireName);
  assert.equal(request.messages[2].tool, wireName);
  assert.deepEqual(request.messages[3].calls[0].arguments, { input: 'literal\npatch' });
  assert.throws(() => registry.output(wireName, {}, 'a', 'b'), /undeclared/);
  assert.throws(() => registry.output('apply_patch', { input: '' }, 'a', 'b'), /undeclared/);
});
