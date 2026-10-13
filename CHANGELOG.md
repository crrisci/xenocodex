# Changelog

## 0.2.0-alpha.4 (release candidate)

- Rename the bridge to Xenolith Bridge; package/command xenolith-bridge, with xenolith-bridge retained as a compatibility alias.
- Clarify that the bridge currently supports Responses HTTP/SSE; Anthropic/Claude Code and cross-process KV restoration remain future work.

- Adopt the MIT license, matching Xenolith's licensing choice.
- Add a reproducible local Codex native fork: Unix wire transport, durable session bindings, checkpoints and real cross-process KV restoration.
- Display local prefill/decode, cache and snapshot telemetry in the TUI; support explicit offline rewind with wire token cost.
- Verify real coding, client/engine restart, compaction, missing/corrupt snapshots and crash recovery on Intel/WSL; simulator coverage includes pending tools without duplicated effects.

## 0.2.0-alpha.3

- Responses HTTP/SSE adapter for Xenolith wire v1; no runtime dependencies.
- Text, function/custom tools, single namespaces and validated tool result IDs.
- Optional process-local KV reuse with strict transcript matching and native call IDs.
- Structured shell results preserve stdout and execution metadata separately.
- Codex local compaction accepts historical tools omitted from the current catalogue,
  without making those tools executable by the model.
- Codex persisted conversations resume by replaying their history after adapter restart.
- CI launcher tests honor the explicit Codex binary path, including npm installations.
- Simulator tests exercise manual/automatic compaction and resume, using Codex 0.162.1.
- Real Gemma/Lunar Lake test fixes a multi-file cart fixture, preserves tests, compacts,
  restarts client/adapter/engine and resumes with the exact program result.

This is an alpha. Encrypted remote compaction and cross-process KV restoration are
not implemented. The original release did not include a license; MIT was adopted subsequently.
