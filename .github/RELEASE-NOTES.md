Xenolith Bridge 0.2.0-alpha.4 — formerly Xenolith Bridge.

A dependency-free Node.js Responses HTTP/SSE bridge to Xenolith wire v1.
This delivery introduces the new project name, MIT licensing and a clear separation
from the native Codex fork. It does not add a new inference frontend.

- Package and primary command: xenolith-bridge; xenolith-bridge remains a compatibility alias.
- Text streaming, function/custom tools, single namespaces and validated tool results.
- Optional process-local KV reuse and structured shell output metadata.
- Resume from persisted Codex history after restart, rebuilding the engine context.
- Local text compaction, including historical calls absent from the current catalogue.

The HTTP bridge does not restore KV between its processes. Its default remains
stateless native inference; --reuse-kv is bounded to the running bridge process.
Anthropic Messages / Claude Code, reasoning, media, hosted/deferred tools, nested
namespaces, constrained JSON and encrypted remote compaction are not implemented.
Automatic compaction is simulator-verified. Resume requires compatible instructions
and sandbox context.

Codex native integration, including actual cross-process KV restoration and local
TUI telemetry, is available separately at https://github.com/crrisci/codex/tree/xenolith-native.
The native Codex fork is Apache-2.0; the HTTP bridge is MIT.
No model weights, cache snapshots, credentials or private conversations are included.
