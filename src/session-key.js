import { AdapterError } from './errors.js';

// Explicit conversation identity shared by HTTP frontends. Never infer it from
// prompt similarity, a model name, an API key or a connection's lifetime.
export function sessionKey(req, body, { enabled, persistent }) {
  const values = req.headersDistinct['x-xenolith-session'];
  const header = values?.[0];
  if (values && (values.length !== 1 || typeof header !== 'string' ||
      !/^[\x21-\x2b\x2d-\x7e]{1,512}$/.test(header))) {
    throw new AdapterError('invalid_request', 'X-Xenolith-Session must be one nonempty ASCII identifier of at most 512 characters, without whitespace or commas');
  }
  if (header !== undefined && !enabled) {
    throw new AdapterError('invalid_request', 'X-Xenolith-Session requires --state-dir or --reuse-kv');
  }
  const key = body.prompt_cache_key;
  if (header !== undefined && key !== undefined && header !== key) {
    throw new AdapterError('invalid_request', 'X-Xenolith-Session and prompt_cache_key must match when both are supplied');
  }
  const selected = header ?? key;
  if (persistent && !(typeof selected === 'string' && selected.trim().length > 0)) {
    throw new AdapterError('invalid_request', 'Persistent mode requires a stable prompt_cache_key or X-Xenolith-Session');
  }
  return typeof selected === 'string' && selected.length > 0 ? selected : undefined;
}
