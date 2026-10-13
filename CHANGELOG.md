# Changelog

## 0.3.0-alpha.1 (development)

- Accept X-Xenolith-Session as explicit conversation identity in persistent and process-local session modes; reject duplicates, invalid identifiers and conflicts with prompt_cache_key.
- Use Xenolith Bridge consistently for the package, command and provider; remove compatibility aliases and use XENOLITH_BRIDGE_* test variables.
- Write the public README in English and state the supported HTTP contract and client-independent scope.
- Add experimental --state-dir persistent session bindings, atomic private writes and an exclusive directory lease.
- Reopen owned sessions and preserve native pending tool IDs after orderly bridge restart.
- Save uncertainty before mutation and commit bindings before publishing executable tools.
- Request checkpoints for completed turns when autosave did not confirm persistence.
- Fail closed on committed state divergence, missing engine sessions and stale crash leases.
- Add an opt-in direct HTTP persistence battery covering bridge/engine restart and missing snapshots.
- Verify actual KV restoration with the real engine, retaining evidence privately.
- Test pending-tool continuity after SIGKILL and manual lease recovery with the simulator; retain fail-closed stale leases.
- Test recovery after a lost tool-result acknowledgement by rebuilding supplied history on the same session instead of repeating append.
- Keep internal analysis and verification documents out of Git and public packages.

## 0.2.0-alpha.4

- Prepare the Responses bridge for independent source distribution under MIT.
- Link to the separate native Codex integration.

## 0.2.0-alpha.3

- Text streaming, function/custom tools, single namespaces and validated result IDs.
- Optional bounded process-local KV reuse and structured shell output metadata.
- Resume client history and support local text compaction with compatible context.
- Cross-platform Responses integration tests with Codex 0.162.1.
