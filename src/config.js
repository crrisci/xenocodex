export function providerArgs(baseUrl, info) {
  const values = {
    model_provider: 'xenolith-bridge', model: info.model,
    model_context_window: info.context_window,
    model_auto_compact_token_limit: Math.floor(info.context_window * 0.75),
    web_search: 'disabled',
    'model_providers.xenolith-bridge.name': 'Xenolith Bridge',
    'model_providers.xenolith-bridge.base_url': baseUrl,
    'model_providers.xenolith-bridge.wire_api': 'responses',
    'model_providers.xenolith-bridge.requires_openai_auth': false,
    'model_providers.xenolith-bridge.supports_websockets': false,
    'model_providers.xenolith-bridge.request_max_retries': 0,
    'model_providers.xenolith-bridge.stream_max_retries': 0,
    'model_providers.xenolith-bridge.stream_idle_timeout_ms': 600000,
  };
  return Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}
