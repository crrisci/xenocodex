export class AdapterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
  }
}

export function invalid(message) { throw new AdapterError('invalid_request', message); }
export function unsupported(message) { throw new AdapterError('unsupported_feature', message); }
export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function errorBody(error) {
  return { error: { type: (error.status ?? 500) >= 500 ? 'server_error' : 'invalid_request_error',
    code: error.code ?? 'io_error', message: error.message } };
}
