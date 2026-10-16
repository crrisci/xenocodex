# Changelog

## 0.4.0-rc.1

- Add `doctor` to inspect Node, Unix socket reachability and wire v1 capabilities without loading a model, creating sessions or generating text. Include a bounded deadline, machine-readable local output and nonzero failure status.
- Add private, field-limited doctor/acceptance summaries and a `report` command. Exclude arbitrary native text, paths, model names, prompts and tool results; refuse overwrites. Preserve partial acceptance outcomes and distinguish self-reported real runs from describe-only checks.
- Reject invalid native UTF-8 instead of silently replacing bytes. Discard buffered frames after wire failure and prevent queued replies/terminals from reporting success after corruption.
- Add protocol fault coverage across both JSON/SSE APIs, checkpoint disconnections, queue/frame limits, cancellation deadlines and silent peers.
- Document reference client versions and patch policy, add a bug report form and separate weekly/manual latest-client compatibility probes. The pinned client matrix remains the publication gate.
- Prepare this candidate without claiming a new real-engine run. Persistent bindings remain experimental; the 0.3.0 real-engine evidence is historical.

## 0.3.0

- Publish the documented Responses and Chat Completions text/tool contract as a stable GitHub release, with installable npm and source archives plus SHA256 sidecars. No runtime behavior changes since `0.3.0-rc.1`.
- Add an opt-in installed-release real-engine battery for the four JSON/SSE API modes, pending-tool restart, explicit snapshot restoration and cancellation/recovery; check the driver against the simulator.
- Document the validation boundary: automated API/client/package checks and earlier real-engine base/LNL evidence are available; the final complete real-engine matrix was not run after access to the test host ended. Independent founder feedback is optional; persistent bindings remain experimental.

## 0.3.0-rc.1

- Add Responses JSON output by default, retaining SSE with `stream:true`, bounded accumulation and commit-before-publication.
- Support `tool_choice:none` on both APIs; align temperature limits and null optional controls. Reject strict function schemas explicitly and classify malformed native calls as engine errors.
- Verify Responses through the official OpenAI SDK, including progressive text, JSON, output caps, typed failures and actual tool-result continuation across restart.
- Add offline installation/CLI smoke checks in CI, package metadata and a precise API contract. Refresh completed milestones and installation instructions.

## 0.3.0-alpha.1 (development)

- Record per-request context decisions, native usage and wire timings in coding diagnostics; add persistent bindings and an explicit snapshot-restoration check to the opt-in Codex coding lifecycle.
- Verify a real-model Aider error-feedback correction on a two-module invoice fixture; keep detailed results private.
- Add a multi-file Aider invoice scenario that requires a failed edit, actual error feedback in subsequent inference, a passing correction and independent verification with unchanged tests. Add an opt-in real-engine launcher; simulated replies verify the workflow only.
- Add an opt-in real-model Aider coding test with isolated engine ownership, unchanged-test checks and native usage evidence.
- Add repeated KV diagnostics across context sizes, comparing incremental continuation and changed-history rebuild with fresh sessions.

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
