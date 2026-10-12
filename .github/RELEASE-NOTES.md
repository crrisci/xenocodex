First public alpha of Xenolith Bridge: a dependency-free Node.js adapter between Codex CLI Responses HTTP/SSE and Xenolith wire v1.

- Text streaming, function/custom tools, single namespaces and validated tool results.
- Optional process-local KV reuse and structured shell output metadata.
- Persisted Codex resume after restart, rebuilding the engine history.
- Local text compaction, including historical calls absent from the current tool catalogue.

Validation: 48 unit/transport tests and 8 installed-Codex integration tests passed on macOS and WSL; also passed on Node 22 on macOS and in CI on Linux/macOS with Node 22/24. Codex version: 0.162.1. Real Gemma/Lunar Lake validation covers coding, unchanged tests, manual compaction, restart of client/adapter/engine, and resume with exact output `1097` (281.89 s; 5 KV hits, 4 misses).

Automatic compaction is simulator-verified. Cross-process KV restoration, encrypted remote compaction, reasoning, media, hosted/deferred tools, nested namespaces and constrained JSON are unsupported. Resume requires unchanged sandbox/instruction context. The expanded real coding test explicitly requests a shell heredoc; an unrestricted patch attempt exposed a model reliability limit. See docs/VERIFICA-RESUME-COMPACT.md.

No license assigned for now. No model weights or credentials are included.
