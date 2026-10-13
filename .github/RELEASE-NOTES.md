Xenolith Bridge 0.3.0-alpha.1 — development preview.

A dependency-free Node.js Responses HTTP/SSE bridge to Xenolith wire v1.

- Consistent project naming and an English README.
- Experimental persistent binding mode with --state-dir, explicit conversation keys,
  orderly bridge restart and native tool-result ID preservation.
- Atomic binding commit before executable tool publication; uncertain mutations are
  reconstructed from client history rather than automatically replayed.
- The default remains temporary inference; --reuse-kv remains process-local.

Orderly bridge/engine restart and actual KV snapshot restoration are verified
with direct HTTP requests on a real model. Missing snapshots report no cache reuse.
Pending-tool restart remains simulator-tested; abrupt crash coverage is incomplete.
Crash leases require manual recovery after verifying the owner has stopped.
HTTP APIs other than the documented Responses subset, reasoning, media, hosted/deferred tools, nested
namespaces, constrained JSON and encrypted remote compaction are unsupported.

Requires Node.js >=22. MIT. No private reports, model weights, snapshots or credentials
are included. The separate native Codex fork remains Apache-2.0.
