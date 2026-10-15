Xenolith Bridge 0.3.0-alpha.1 — development preview.

A dependency-free Node.js HTTP/SSE bridge from Responses and Chat Completions
clients to Xenolith wire v1. The bridge translates inference requests and tool
results; the client runs the tools.

- Add Chat Completions JSON/SSE, function tools and explicit conversation identity
  through `X-Xenolith-Session` or `prompt_cache_key`.
- Add experimental persistent bindings with `--state-dir`, atomic commits,
  checkpoint handling and native tool-result ID preservation across restarts.
- Recover leases after process crashes and reconstruct missing/uncertain sessions
  from retained client history, without automatically replaying tool effects.
- Verify Aider's multi-file edit, actual test-failure feedback and correction with
  unchanged tests; provide a separate opt-in real-model feedback harness.
- Add per-request coding diagnostics and a persistent Codex lifecycle covering
  compaction, client/bridge/engine restart and explicit snapshot restoration.

The default remains temporary inference. `--reuse-kv` retains sessions only in the
bridge process. A persistent session does not guarantee cached tokens when a
client changes earlier context; diagnostics distinguish continuation, rebuild and
actual snapshot loading. Timings are diagnostic, not a general engine benchmark.

Validation uses wire simulators, actual Codex/Aider/Chat SDK clients and opt-in
real-engine tests. Detailed reports and raw requests remain private.

Text and the documented API subsets are supported. Reasoning, media,
hosted/deferred tools, nested namespaces, constrained JSON and encrypted remote
compaction are rejected. Other clients and edit formats need their own acceptance
checks. Linux/WSL is required for the provided real-engine launchers.

Requires Node.js >=22. Source preview under MIT; no model, prebuilt engine, private
reports, snapshots, credentials or client dependencies are included. CodeXe is a
separate Apache-2.0 fork of Codex.
