# Xenolith Bridge

A local HTTP/SSE bridge between Responses-compatible clients and the Xenolith
wire v1 protocol. The client runs tools and manages its own approvals; the bridge
translates inference requests and results over a Unix socket to an existing engine.

Requires **Node.js >=22**. No runtime dependencies or compilation are needed.
The bridge does not start or stop Xenolith.

```text
Responses client → HTTP/SSE → Xenolith Bridge → Unix socket / JSONL → Xenolith
```

## Current status

**0.3.0-alpha.1 — development version.** The implemented frontend is Responses
HTTP/SSE. Codex CLI 0.162.1 is the reference client used for integration tests.
Compatibility with other clients must be checked against their actual requests.

- Progressive text, function/custom tools, one namespace level and validated tool results.
- Bounded process-local KV reuse with `--reuse-kv`.
- Experimental persistent session bindings with `--state-dir`: reopen owned sessions
  after an orderly bridge restart, preserve pending native tool IDs and checkpoint
  completed turns before publishing completion to the client.
- Resume from client history and local text compaction with compatible instructions.
- Explicit failures for unsupported requests and uncertain wire operations.

**Anthropic Messages and Claude Code are not supported yet.** A separate frontend
is required; pointing Claude Code at the current Responses endpoint is insufficient.
For Codex itself, the [native Xenolith fork](https://github.com/crrisci/codex/tree/xenolith-native)
provides direct wire integration and local inference telemetry in the TUI.

## Start the bridge

Start your compiled Xenolith separately, with its model, Unix socket and dedicated
engine state/cache directories. Then connect the bridge:

```sh
node src/cli.js serve --socket /absolute/path/wire.sock --port 8080
```

The bridge binds to `127.0.0.1`. It prints the base URL, served model and limits
obtained from `describe`. Omit `--port`, or use `--port 0`, for an available port.

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/responses` | Streaming inference; requires `stream:true` |
| GET | `/v1/models` | Served model |
| GET | `/healthz` | Initial discovery/readiness information |

Every inference checks the engine again. A change in model/context/output capacity
requires restarting the bridge. The request must name the exact served model.

## Session modes

### Temporary requests

Without either session option, each request uses native `ephemeral` inference with
the complete transcript. No durable binding is created by the bridge.

### Process-local reuse

```sh
node src/cli.js serve --socket /absolute/path/wire.sock --reuse-kv
```

Requests need a nonempty `prompt_cache_key`. Matching histories reuse owned native
sessions while the bridge runs. Missing keys use temporary inference. This cache
is bounded and expires idle entries; normal shutdown deletes only its own sessions.
It does not restore bindings after restarting the bridge.

### Persistent bindings (experimental)

Use a **dedicated private directory**, with permissions `0700`:

```sh
node src/cli.js serve --socket /absolute/path/wire.sock \
  --state-dir /absolute/private/bridge-state
```

This mode requires engine kvstore support and a stable, nonempty `prompt_cache_key`
for every request. It does not silently fall back to temporary inference.
Keep the same socket/model configuration, binding directory and engine state/cache
when restarting. The bridge reopens its owned session and checks the committed
marker and pending calls before appending a compatible continuation.

Bindings are written atomically with file/directory fsync and private permissions.
Mutations are recorded as in-flight before sending them. A validated terminal event
and persisted binding precede publication of executable tools. Shutdown releases
connections and the directory lease, retaining native sessions and bindings.

Completed textual turns request a checkpoint if the terminal report did not
confirm one. `response.xenolith_session` reports the marker and checkpoint; a
checkpoint reporting `saved:false` does not mean a snapshot was restored.

Limits of this first persistent implementation:

- One bridge process may own a state directory. A crashed directory lease is not
  reclaimed automatically: verify that the previous process has stopped before
  removing `.bridge.lock`. Never remove a live owner's lease.
- Interrupted mutations rebuild from the supplied client transcript; the bridge
  does not execute or replay tools. Uncommitted streamed output is not recoverable.
- Committed marker/pending-call divergence stops without mutation. A missing owned
  engine session is currently an error, rather than automatic recreation.
- Bindings contain conversation text. Keep their directory private and outside Git.
- Restart semantics are simulator-tested. Actual KV restoration after an engine
  restart still requires a dedicated real-model test of this bridge implementation.

## Optional Codex launcher

Use a new, dedicated home; the launcher supports `exec` and keeps sandbox/approval
handling in Codex. It applies provider overrides only to its child process and does
not copy authentication or modify personal configuration.

```sh
node src/cli.js run --socket /absolute/path/wire.sock \
  --state-dir /absolute/private/bridge-state \
  --codex-home /absolute/private/client-home -- \
  exec --skip-git-repo-check --sandbox workspace-write --json \
  "Read the program, fix it and run its tests."
```

For resume, use the same client home, sandbox and instruction context. Model/context
are discovered from the engine; output defaults to 4096 tokens and may be limited
with `--max-output-tokens N`. A local model absent from Codex's catalogue uses its
fallback metadata. The provider identifier is `xenolith-bridge`.

## Tools, errors and accounting

The bridge never executes tools. Function/custom calls are buffered until a valid
native `done` event; failed or incomplete calls are not exposed as executable output.
Recognized Codex shell wrappers preserve stdout separately from execution metadata;
unknown wrappers and other tool output remain unchanged.

Responses usage represents request computation; `xenolith_usage` preserves native
counters, whose context total can differ from that sum. Missing terminal events,
wire errors and timeouts produce failures rather than fabricated success.
HTTP disconnects send best-effort cancellation and drain the terminal exchange.

## Tests

```sh
npm test
XENOLITH_BRIDGE_CODEX_BIN=/absolute/path/to/codex npm run test:codex
```

Unit tests use a wire simulator. Installed-client tests exercise actual requests,
progressive output, tools, resume and compaction with Codex 0.162.1. Persistent
binding tests include orderly restart, pending tool IDs, divergent markers,
uncertain generation and persistence failure before tool publication.

The opt-in model harness requires Linux, sufficient free memory and exclusive use
of an engine it starts in private directories:

```sh
XENOLITH_BIN=/absolute/path/to/xenolith \
XENOLITH_MODEL=/absolute/path/to/model.gguf npm run test:model
```

Use `XENOLITH_BRIDGE_REUSE_KV=1` for process-local reuse and
`XENOLITH_BRIDGE_PHASES` to select model-harness phases. That harness does not yet
validate the new persistent binding mode. Test artifacts remain private and ignored.

## Next milestones and unsupported features

Next: real-model persistent restart checks, missing/rejected snapshot recovery and
safe crash-lease recovery. Then add an Anthropic frontend with captured client
requests, streaming text and a complete tool/result cycle before claiming Claude
Code compatibility.

Reasoning/history reasoning, images/audio, hosted/deferred tools, nested namespaces,
constrained JSON/verbosity, compressed requests, WebSocket, `previous_response_id`,
Responses storage, rewind and encrypted remote compaction are unsupported.
Unsupported features are rejected explicitly.

## License

The independent HTTP bridge is [MIT](LICENSE).
The separate Codex fork retains Apache-2.0 and its upstream notices.
