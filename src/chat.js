import { errorBody, invalid, object, unsupported } from './errors.js';
import { translateRequest } from './translate.js';
import { ResponseStream } from './responses.js';

function fields(value, allowed, label) {
  if (!object(value)) invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(`${label} field ${key} is not supported`);
}

function content(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('Chat content must be text or an array of text parts');
  return value.map(part => {
    fields(part, ['type', 'text'], 'Chat content part');
    if (part.type !== 'text') unsupported('Only text content is supported');
    if (typeof part.text !== 'string') invalid('Chat text parts require a string');
    return { type: 'input_text', text: part.text };
  });
}

// Normalize Chat into the existing validated conversation representation. This
// is an in-process frontend, sharing the wire/session/tool transaction path.
export function translateChat(body, info, options) {
  fields(body, ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice',
    'parallel_tool_calls', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p',
    'n', 'store', 'prompt_cache_key', 'response_format', 'stop', 'frequency_penalty',
    'presence_penalty', 'logprobs'], 'Chat request');
  if (body.stream != null && typeof body.stream !== 'boolean') invalid('stream must be boolean');
  if (body.n != null && body.n !== 1) unsupported('Only n:1 is supported');
  if (body.stop != null || (body.frequency_penalty != null && body.frequency_penalty !== 0) ||
      (body.presence_penalty != null && body.presence_penalty !== 0) ||
      (body.logprobs != null && body.logprobs !== false)) unsupported('Stop sequences, penalties and log probabilities are not supported');
  if (body.temperature != null && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) invalid('Chat temperature must be between 0 and 2');
  if (body.max_tokens != null && body.max_completion_tokens != null) invalid('Supply only one of max_tokens and max_completion_tokens');
  if (body.stream_options != null) {
    fields(body.stream_options, ['include_usage'], 'stream_options');
    if (body.stream !== true) invalid('stream_options requires stream:true');
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') invalid('include_usage must be boolean');
  }
  if (body.response_format != null) {
    fields(body.response_format, ['type'], 'response_format');
    if (body.response_format.type !== 'text') unsupported('Only response_format:text is supported');
  }
  if (body.tool_choice != null && !['auto', 'none'].includes(body.tool_choice)) unsupported('Only tool_choice:auto or none is supported');
  const declarations = body.tools ?? [];
  if (!Array.isArray(declarations)) invalid('tools must be an array');
  const tools = declarations.map(tool => {
    fields(tool, ['type', 'function'], 'Chat tool');
    if (tool.type !== 'function') unsupported('Chat supports function tools only');
    fields(tool.function, ['name', 'description', 'parameters', 'strict'], 'Chat function');
    if (tool.function.strict != null && tool.function.strict !== false) unsupported('Strict tool schemas are not supported');
    return { type: 'function', name: tool.function.name, description: tool.function.description,
      parameters: tool.function.parameters ?? { type: 'object', properties: {} } };
  });
  if (!Array.isArray(body.messages) || body.messages.length === 0) invalid('messages must be a nonempty array');
  const input = [];
  for (const message of body.messages) {
    fields(message, ['role', 'content', ...(message?.role === 'assistant' ? ['tool_calls', 'refusal', 'parsed'] : []),
      ...(message?.role === 'tool' ? ['tool_call_id'] : [])], 'Chat message');
    // SDK stream accumulators annotate ordinary history with null placeholders.
    if (message.refusal != null || message.parsed != null) unsupported('Refusal or parsed structured history is not supported');
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: content(message.content) });
      continue;
    }
    if (!['user', 'assistant', 'system', 'developer'].includes(message.role)) unsupported('Unsupported Chat message role');
    if (message.content != null) input.push({ role: message.role, content: content(message.content) });
    else if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) invalid('Message content is required except for assistant tool calls');
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) invalid('tool_calls must be an array');
      for (const call of message.tool_calls) {
        fields(call, ['id', 'type', 'function'], 'Chat tool call');
        if (call.type !== 'function') unsupported('Chat supports function calls only');
        fields(call.function, ['name', 'arguments', 'parsed_arguments'], 'Chat function call');
        if (call.function.parsed_arguments != null) unsupported('Parsed tool arguments are not supported; send JSON string arguments');
        if (typeof call.id !== 'string' || !call.id || typeof call.function.arguments !== 'string') invalid('Tool calls require an ID and JSON string arguments');
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  const normalized = { model: body.model, stream: true, input,
    tools: body.tool_choice === 'none' ? [] : tools };
  for (const key of ['parallel_tool_calls', 'temperature', 'top_p', 'store', 'prompt_cache_key']) {
    if (body[key] != null) normalized[key] = body[key];
  }
  const cap = body.max_completion_tokens ?? body.max_tokens;
  if (cap != null) normalized.max_output_tokens = cap;
  return { ...translateRequest(normalized, info, options),
    streaming: body.stream === true, includeUsage: body.stream_options?.include_usage === true };
}

function usageOf(response) {
  const usage = response.usage;
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens, prompt_tokens_details: usage.input_tokens_details,
    completion_tokens_details: usage.output_tokens_details };
}
const toolOf = item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });

// Reuse bounded accumulation, terminal validation and commit-before-tools from
// ResponseStream; only HTTP serialization differs between the two frontends.
export class ChatStream extends ResponseStream {
  constructor(model, registry, send, { streaming, includeUsage }) {
    super(model, registry, send);
    this.streaming = streaming;this.includeUsage = includeUsage;this.toolIndex = 0;
  }
  envelope(object = 'chat.completion.chunk') {
    return { id: this.response.id.replace('resp_', 'chatcmpl-'), object,
      created: this.response.created_at, model: this.response.model };
  }
  async chunk(delta, finish_reason = null, extra = {}) {
    await this.send({ ...this.envelope(), choices: [{ index: 0, delta, logprobs: null, finish_reason }],
      ...(this.includeUsage ? { usage: null } : {}), ...extra });
  }
  async emit(type, data) {
    if (this.streaming && type === 'response.created') await this.chunk({ role: 'assistant', content: '' });
    if (this.streaming && type === 'response.output_text.delta') await this.chunk({ content: data.delta });
    if (this.streaming && type === 'response.output_item.done' && data.item.type === 'function_call') {
      await this.chunk({ tool_calls: [{ index: this.toolIndex++, ...toolOf(data.item) }] });
    }
    if (!['response.completed', 'response.incomplete'].includes(type)) return;
    const response = data.response;
    const calls = response.output.filter(item => item.type === 'function_call').map(toolOf);
    const finish = response.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop';
    const extensions = { xenolith_usage: response.xenolith_usage,
      ...(response.xenolith_session ? { xenolith_session: response.xenolith_session } : {}) };
    if (this.streaming) {
      await this.chunk({}, finish, extensions);
      if (this.includeUsage) await this.send({ ...this.envelope(), choices: [], usage: usageOf(response) });
      await this.send('[DONE]');
    } else {
      await this.send({ ...this.envelope('chat.completion'), choices: [{ index: 0,
        message: { role: 'assistant', content: this.message?.content[0]?.text ?? (calls.length ? null : ''),
          ...(calls.length ? { tool_calls: calls } : {}) }, logprobs: null, finish_reason: finish }],
      usage: usageOf(response), ...extensions });
    }
  }
  async fail(error) {
    if (this.finished) return;
    await this.send(errorBody(error), error.status ?? 502);
    if (this.streaming) await this.send('[DONE]');
    this.finished = true;
  }
}
