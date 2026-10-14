# Changelog

## 0.3.0-alpha.1 (development)

- Attempt checkpoints before publishing pending tool calls, preserve native refusal reasons, and withhold execution on checkpoint transport failures.

- Extend the opt-in real-engine battery with Chat JSON/SSE, identical warm/cold requests, pending-tool continuity after forced bridge/engine termination, missing sessions, corrupt snapshots and interruption during generation.
- Distinguish missing-snapshot recovery from any partial native context reuse during reconstruction; preserve the engine's accounting.
- Allow selecting Responses or Chat persistence scenarios and retain original snapshots when testing corruption.

- Recreate missing owned native sessions only on explicit session_not_found replies and complete matching client history; preserve pending tool results and report that the previous KV was not restored.
- Keep replacement recovery durable across rebuild failures and bridge restarts, without recreating sessions for transport, busy or unrelated engine errors.
- Exercise Aider 0.86.2 with an isolated Chat Completions coding loop: file edit, failed tests, returned feedback and correction. Preserve one native session while rebuilding changed file context; do not infer KV savings from the simulator.
- Add Chat Completions JSON/SSE for text and function tools, sharing session ownership, cancellation and commit-before-publication with Responses.
- Recover process-crashed v2 state locks through a kernel-held loopback guard; preserve legacy/foreign/corrupt records for manual migration and fail closed on port collisions.
- Test concurrent owners, suspended/killed processes, directory aliases, Chat tool roundtrips, output limits and cancellation.
- Add optional OpenAI JavaScript SDK 7.32.0 integration tests and run them in CI, without runtime dependencies or external inference.
- Accept X-Xenolith-Session as explicit conversation identity in persistent and process-local session modes; reject duplicates, invalid identifiers and conflicts with prompt_cache_key.
- Use Xenolith Bridge consistently for the package, command and provider; remove compatibility aliases and use XENOLITH_BRIDGE_* test variables.
- Write the public README in English and state the supported HTTP contract and client-independent scope.
- Add experimental --state-dir persistent session bindings, atomic private writes and an exclusive directory lease.
- Reopen owned sessions and preserve native pending tool IDs after orderly bridge restart.
- Save uncertainty before mutation and commit bindings before publishing executable tools.
- Request checkpoints for completed turns when autosave did not confirm persistence.
- Fail closed on committed state divergence, incomplete recovery history and incompatible lock metadata.
- Add an opt-in direct HTTP persistence battery covering bridge/engine restart and missing snapshots.
- Verify actual KV restoration with the real engine, retaining evidence privately.
- Test pending-tool continuity after SIGKILL and automatic lease recovery with the simulator.
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
