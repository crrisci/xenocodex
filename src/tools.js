import { createHash } from 'node:crypto';
import { invalid, unsupported, object } from './errors.js';

export class ToolRegistry {
  constructor(declarations = []) {
    if (!Array.isArray(declarations)) invalid('tools must be an array');
    this.byWire = new Map();
    this.byIdentity = new Map();
    this.declarations = [];
    this.add(declarations);
  }

  add(declarations, namespace) {
    for (const tool of declarations) {
      if (!object(tool) || typeof tool.name !== 'string' || !tool.name) invalid('Each tool needs a name');
      if (tool.type === 'namespace') {
        if (namespace || !Array.isArray(tool.tools)) unsupported('Nested or malformed namespaces are not supported');
        this.add(tool.tools, tool.name);
        continue;
      }
      if (!['function', 'custom'].includes(tool.type)) unsupported(`Tool type ${tool.type} is not supported`);
      if (tool.description !== undefined && typeof tool.description !== 'string') invalid('Tool description must be a string');
      if (tool.defer_loading) unsupported('Deferred tools are not supported');
      const identity = JSON.stringify([namespace ?? null, tool.name]);
      if (this.byIdentity.has(identity)) invalid(`Duplicate tool ${identity}`);
      // Preserve plain names when possible. Qualified identities use a stable hash
      // so dots/underscores and arbitrary namespace names cannot alias one another.
      const wireName = !namespace && /^[A-Za-z][A-Za-z0-9_]*$/.test(tool.name)
        ? tool.name : `xc_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
      if (this.byWire.has(wireName)) invalid('Tool wire name collision');
      const entry = { name: tool.name, namespace, type: tool.type, wireName };
      let parameters = tool.parameters;
      if (tool.type === 'custom') {
        if (tool.format && !['text', 'grammar'].includes(tool.format.type)) unsupported('Unsupported custom tool format');
        parameters = { type: 'object', properties: {
          input: { type: 'string', description: 'Complete freeform tool input. Preserve literal newlines.' },
        }, required: ['input'], additionalProperties: false };
      } else if (!object(parameters)) invalid(`Tool ${tool.name} requires object parameters`);
      this.byWire.set(wireName, entry);
      this.byIdentity.set(identity, entry);
      const namespaceHelp = namespace ? `Tool ${namespace}.${tool.name}; wire name ${wireName}. ` : '';
      const grammarHelp = tool.type === 'custom' && tool.format?.type === 'grammar'
        ? `\nTool input grammar (${tool.format.syntax}):\n${tool.format.definition}` : '';
      this.declarations.push({ name: wireName, description: namespaceHelp + (tool.description ?? '') + grammarHelp, parameters });
    }
  }

  resolve(name, namespace) {
    const entry = this.byIdentity.get(JSON.stringify([namespace ?? null, name]));
    if (!entry) invalid(`Unknown tool ${namespace ? namespace + '.' : ''}${name}`);
    return entry;
  }

  historical(name, namespace, type) {
    if (typeof name !== 'string' || !name || (namespace !== undefined && (typeof namespace !== 'string' || !namespace))) invalid('Invalid historical tool identity');
    const identity = JSON.stringify([namespace ?? null, name]);
    const declared = this.byIdentity.get(identity);
    if (declared) return declared;
    // Local Codex compaction omits the tool catalogue. Past calls remain data;
    // never register these names as tools the model may execute now.
    const wireName = !namespace && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
      ? name : `xc_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    if (this.byWire.has(wireName)) invalid('Historical tool wire name collision');
    return { name, namespace, type, wireName };
  }

  output(name, args, callId, itemId) {
    const tool = this.byWire.get(name);
    if (!tool) invalid(`Xenolith called undeclared tool ${name}`);
    if (!object(args)) invalid('Tool arguments must be a JSON object');
    const out = { type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call',
      id: itemId, call_id: callId, name: tool.name };
    if (tool.namespace) out.namespace = tool.namespace;
    if (tool.type === 'custom') {
      if (typeof args.input !== 'string' || Object.keys(args).some(k => k !== 'input')) invalid('Custom tool arguments must contain only a string input');
      out.input = args.input;
    } else out.arguments = JSON.stringify(args);
    return out;
  }
}
