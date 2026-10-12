# Changelog

## 0.2.0-alpha.1

- Responses HTTP/SSE adapter for Xenolith wire v1; no runtime dependencies.
- Text, function/custom tools, single namespaces and validated tool result IDs.
- Optional process-local KV reuse with strict transcript matching and native call IDs.
- Structured shell results preserve stdout and execution metadata separately.
- Codex local compaction accepts historical tools omitted from the current catalogue,
  without making those tools executable by the model.
- Codex persisted conversations resume by replaying their history after adapter restart.
- Simulator tests exercise manual/automatic compaction and resume, using Codex 0.162.1.
- Real Gemma/Lunar Lake test fixes a multi-file cart fixture, preserves tests, compacts,
  restarts client/adapter/engine and resumes with the exact program result.

This is an alpha. Encrypted remote compaction and cross-process KV restoration are
not implemented. No license has been assigned to this repository.
