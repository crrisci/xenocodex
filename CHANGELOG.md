# Changelog

## 0.3.0-alpha.1 (development)

- Use Xenolith Bridge consistently for the package, command and provider; remove compatibility aliases and use XENOLITH_BRIDGE_* test variables.
- Write the public README in English and separate current support from future frontends.
- Add experimental --state-dir persistent session bindings, atomic private writes and an exclusive directory lease.
- Reopen owned sessions and preserve native pending tool IDs after orderly bridge restart.
- Save uncertainty before mutation and commit bindings before publishing executable tools.
- Request checkpoints for completed turns when autosave did not confirm persistence.
- Fail closed on committed state divergence, missing engine sessions and stale crash leases.
- Keep internal analysis and verification documents out of Git and public packages.

## 0.2.0-alpha.4

- Prepare the Responses bridge for independent source distribution under MIT.
- Link to the separate native Codex integration.

## 0.2.0-alpha.3

- Text streaming, function/custom tools, single namespaces and validated result IDs.
- Optional bounded process-local KV reuse and structured shell output metadata.
- Resume client history and support local text compaction with compatible context.
- Cross-platform Responses integration tests with Codex 0.162.1.
