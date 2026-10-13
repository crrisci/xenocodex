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

**0.3.0-alpha.1 — development version.** The supported HTTP contract is Responses
HTTP/SSE. Codex CLI 0.162.1 is the reference client used for integration tests.
Compatibility with other clients must be checked against their actual requests.

- Progressive text, function/custom tools, one namespace level and validated tool results.
- Bounded process-local KV reuse with `--reuse-kv`.
- Experimental persistent session bindings with `--state-dir`: reopen owned sessions
  after an orderly bridge restart, preserve pending native tool IDs and checkpoint
  completed turns before publishing completion to the client.
- Resume from client history and local text compaction with compatible instructions.
- Explicit failures for unsupported requests and uncertain wire operations.

The user chooses and configures the client. The bridge translates the supported
HTTP contract into Xenolith wire operations; it does not choose an agent, execute
tools or provide an agent interface. Clients must speak the documented Responses
subset or use their own compatible adapter. Other HTTP APIs are not implemented.
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

A client can send a text request directly, without the optional launcher:

```sh
curl -N http://127.0.0.1:8080/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_SERVED_MODEL","stream":true,"prompt_cache_key":"YOUR_CONVERSATION_ID","input":"Hello"}'
```

Use the served model from `/v1/models` and a stable conversation key when using
persistent bindings. Client selection and client configuration remain up to you.

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
  Simulator tests cover a connection lost after accepting a tool result but before
  acknowledging it: recovery rebuilds history instead of appending the result again.
  Clients must retain completed tool results; this is not an exactly-once execution
  guarantee for tools or future model-generated calls.
- Committed marker/pending-call divergence stops without mutation. A missing owned
  engine session is currently an error, rather than automatic recreation.
- Bindings contain conversation text. Keep their directory private and outside Git.
- Orderly bridge/engine restart and actual snapshot restoration have been checked
  with direct HTTP requests on Linux/WSL using a real model. Pending-tool restart
  remains simulator-tested, including a bridge killed with SIGKILL followed by
  manual lease recovery and submission of the saved tool result. Automatic lease
  recovery and abrupt engine crashes remain unverified.

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
`XENOLITH_BRIDGE_PHASES` to select model-harness phases. That harness covers the process-local mode. Test artifacts remain private and ignored.

The dedicated persistent-mode battery uses HTTP directly and owns isolated bridge
processes, engine state/cache and bindings:

```sh
XENOLITH_BIN=/absolute/path/to/xenolith \
XENOLITH_MODEL=/absolute/path/to/model.gguf npm run test:persistence
```

It checks a bridge restart, an engine restart with `resume.loaded:true`, and a
missing snapshot with `loaded:false` and zero cache reuse. Real test results and
prompts are retained privately, outside Git.

## Next milestones and unsupported features

Next: rejected-snapshot and pending-tool checks with the real engine, plus safe
crash-lease recovery. Focus on the bridge core: durable session ownership,
honest cache/checkpoint reports, cancellation, tool/result integrity and deterministic
recovery without repeated tool effects. No client-specific frontend is planned.

Reasoning/history reasoning, images/audio, hosted/deferred tools, nested namespaces,
constrained JSON/verbosity, compressed requests, WebSocket, `previous_response_id`,
Responses storage, rewind and encrypted remote compaction are unsupported.
Unsupported features are rejected explicitly.

## License

The independent HTTP bridge is [MIT](LICENSE).
The separate Codex fork retains Apache-2.0 and its upstream notices.
