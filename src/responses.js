import { randomUUID } from 'node:crypto';
import { AdapterError, invalid, object } from './errors.js';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export class ResponseStream {
  constructor(model, registry, send) {
    this.send = send;
    this.registry = registry;
    this.sequence = 0;
    this.response = { id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000),
      model, status: 'in_progress', output: [], error: null, incomplete_details: null };
    this.message = null;
    this.calls = new Map();
    this.outputBytes = 0;
    this.finished = false;
  }

  async emit(type, data = {}) {
    await this.send({ type, sequence_number: this.sequence++, ...data });
  }

  async start() {
    await this.emit('response.created', { response: this.response });
    await this.emit('response.in_progress', { response: this.response });
  }

  async text(delta) {
    if (typeof delta !== 'string') invalid('Xenolith text delta must be a string');
    this.outputBytes += Buffer.byteLength(delta);
    if (this.outputBytes > 8 * 1024 * 1024) throw new AdapterError('io_error', 'Generated output exceeds the adapter limit', 502);
    if (!this.message) {
      this.message = { type: 'message', id: id('msg'), role: 'assistant', status: 'in_progress', content: [] };
      await this.emit('response.output_item.added', { output_index: 0, item: this.message });
      this.message.content.push({ type: 'output_text', text: '', annotations: [] });
      await this.emit('response.content_part.added', { output_index: 0, item_id: this.message.id,
        content_index: 0, part: this.message.content[0] });
    }
    this.message.content[0].text += delta;
    await this.emit('response.output_text.delta', { output_index: 0, item_id: this.message.id, content_index: 0, delta });
  }

  toolStart(event) {
    if (!Number.isSafeInteger(event.id) || event.id < 0 || typeof event.name !== 'string' || this.calls.has(event.id)) invalid('Invalid Xenolith toolcall_start');
    if (this.calls.size >= 256) invalid('Too many tool calls in one generation');
    this.calls.set(event.id, { name: event.name });
  }

  toolEnd(event) {
    if (!Number.isSafeInteger(event.id) || event.id < 0 || typeof event.name !== 'string' || !object(event.arguments)) invalid('Invalid Xenolith toolcall_end');
    const existing = this.calls.get(event.id);
    if (!existing && this.calls.size >= 256) invalid('Too many tool calls in one generation');
    if (existing && (existing.name !== event.name || existing.arguments)) invalid('Mismatched Xenolith tool call');
    this.outputBytes += Buffer.byteLength(JSON.stringify(event.arguments));
    if (this.outputBytes > 8 * 1024 * 1024) throw new AdapterError('io_error', 'Generated output exceeds the adapter limit', 502);
    this.calls.set(event.id, { name: event.name, arguments: event.arguments });
  }

  async done(event, parallelToolCalls) {
    if (!['stop', 'tool_use', 'length', 'aborted'].includes(event.stop)) invalid('Unknown Xenolith stop reason');
    if (event.stop === 'tool_use' && (!this.calls.size || [...this.calls.values()].some(c => !c.arguments))) invalid('Incomplete Xenolith tool calls');
    if (event.stop === 'stop' && this.calls.size) invalid('Xenolith emitted calls without tool_use stop');
    if (event.stop === 'tool_use' && parallelToolCalls === false && this.calls.size > 1) invalid('Xenolith violated parallel_tool_calls:false');
    const usage = mapUsage(event.usage);
    // Validate all calls before publishing any executable item.
    const tools = event.stop === 'tool_use' ? [...this.calls.entries()].map(([wireId, call]) =>
      this.registry.output(call.name, call.arguments, `${this.response.id}_call_${wireId}`, id('fc'))) : [];
    if (this.message) {
      const part = this.message.content[0];
      await this.emit('response.output_text.done', { output_index: 0, item_id: this.message.id, content_index: 0, text: part.text });
      await this.emit('response.content_part.done', { output_index: 0, item_id: this.message.id, content_index: 0, part });
      this.message.status = event.stop === 'length' || event.stop === 'aborted' ? 'incomplete' : 'completed';
      if (event.stop === 'stop') this.message.phase = 'final_answer';
      else if (event.stop === 'tool_use') this.message.phase = 'commentary';
      await this.emit('response.output_item.done', { output_index: 0, item: this.message });
      this.response.output.push(this.message);
    }
    for (const tool of tools) {
      const index = this.response.output.length;
      const field = tool.type === 'function_call' ? 'arguments' : 'input';
      await this.emit('response.output_item.added', { output_index: index, item: { ...tool, [field]: '', status: 'in_progress' } });
      const eventBase = { output_index: index, item_id: tool.id, call_id: tool.call_id };
      const family = tool.type === 'function_call' ? 'function_call_arguments' : 'custom_tool_call_input';
      await this.emit(`response.${family}.delta`, { ...eventBase, delta: tool[field] });
      await this.emit(`response.${family}.done`, { ...eventBase, [field]: tool[field] });
      tool.status = 'completed';
      await this.emit('response.output_item.done', { output_index: index, item: tool });
      this.response.output.push(tool);
    }
    this.response.usage = usage;
    // Preserve native accounting without claiming conversation size is API usage.
    this.response.xenolith_usage = event.usage;
    if (event.stop === 'length' || event.stop === 'aborted') {
      this.response.status = 'incomplete';
      this.response.incomplete_details = { reason: event.stop === 'length' ? 'max_output_tokens' : 'interrupted' };
      await this.emit('response.incomplete', { response: this.response });
    } else {
      this.response.status = 'completed';
      await this.emit('response.completed', { response: this.response });
    }
    this.finished = true;
  }

  async fail(error) {
    if (this.finished) return;
    this.response.status = 'failed';
    this.response.error = { code: error.code ?? 'io_error', message: error.message };
    await this.emit('response.failed', { response: this.response });
    this.finished = true;
  }
}

function mapUsage(usage) {
  if (!object(usage) || !['input', 'cache_read', 'output', 'reasoning'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0)) {
    throw new AdapterError('io_error', 'Invalid Xenolith usage counters', 502);
  }
  // Compute-accounting projection: native input computations + first cache reuse.
  // Native input may include replay/shadow; this is not a tokenizer measurement.
  const input = usage.input + usage.cache_read;
  return { input_tokens: input, output_tokens: usage.output, total_tokens: input + usage.output,
    input_tokens_details: { cached_tokens: usage.cache_read },
    output_tokens_details: { reasoning_tokens: usage.reasoning } };
}
