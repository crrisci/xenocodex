# Xenolith Bridge

A local HTTP/SSE bridge between Responses or Chat Completions clients and the Xenolith
wire v1 protocol. The client runs tools and manages its own approvals; the bridge
translates inference requests and results over a Unix socket to an existing engine.

Requires **Node.js >=22**. No runtime dependencies or compilation are needed.
The bridge does not start or stop Xenolith.

```text
Responses / Chat Completions client → HTTP/SSE → Xenolith Bridge → Unix socket / JSONL → Xenolith
```

## Current status

**0.3.0-alpha.1 — development version.** Supported HTTP contracts are a Responses
streaming subset and a Chat Completions text/function-tool subset (streaming or JSON).
Codex CLI 0.162.1 is the reference Responses client used for integration tests.
An isolated Aider 0.86.2 coding test also exercises Chat Completions against the simulator.
Compatibility with other clients must be checked against their actual requests.

- Progressive text, function/custom tools, one namespace level and validated tool results.
- Bounded process-local KV reuse with `--reuse-kv`.
- Experimental persistent session bindings with `--state-dir`: reopen owned sessions
  after a bridge restart or process crash, preserve pending native tool IDs and checkpoint
  completed turns before publishing completion to the client.
- Resume from client history and local text compaction with compatible instructions.
- Explicit failures for unsupported requests and uncertain wire operations.

The user chooses and configures the client. The bridge translates the supported
HTTP contract into Xenolith wire operations; it does not choose an agent, execute
tools or provide an agent interface. Clients must speak one of the documented
subsets or use their own compatible adapter. Other HTTP APIs are not implemented.
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
| POST | `/v1/chat/completions` | Text/function inference; JSON by default, SSE with `stream:true` |
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

## Chat Completions subset

```sh
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_SERVED_MODEL","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Hello"}]}'
```

Supported inputs are text messages (strings or `type:text` parts), initial
system/developer instructions, assistant function calls and `role:tool` results
matched by `tool_call_id` in call order. Send the complete transcript on every turn.
Tools use `{"type":"function","function":{"name":"...","parameters":{...}}}`;
an omitted parameter schema describes a function with no parameters.

Supported controls are `temperature`, `top_p`, either `max_tokens` or
`max_completion_tokens`, `parallel_tool_calls`, and `tool_choice:auto|none`.
Only one choice (`n:1`), text output and non-strict function schemas are supported.
`tool_choice:none` disables current tool declarations while preserving historical
calls and results. Reasoning, media, stop sequences, nonzero penalties, logprobs,
forced tool choices, strict schemas and unknown fields are rejected explicitly.
Null SDK history annotations (`refusal`, `parsed`, `parsed_arguments`) are accepted;
non-null values are unsupported.

With `stream:true`, data-only SSE chunks carry `chat.completion.chunk` objects and
end with `[DONE]`. Tool chunks appear only after the native transaction and any
persistent binding have committed. `stream_options.include_usage:true` adds a final
usage chunk with empty `choices`. Streaming failures emit an `error` object followed
by `[DONE]`, without a successful finish reason. Without streaming, the response is
a `chat.completion` JSON object or an HTTP error. Engine abortion is an error;
an output limit produces `finish_reason:length`.

Both endpoints share the same session engine, cancellation and tool validation.
They accept `prompt_cache_key` or `X-Xenolith-Session` in session modes. The wire
simulator tests this HTTP contract; compatibility with a particular coding harness
still requires checking that harness's requests.
Protocol reference: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

## Session modes

### Temporary requests

Without either session option, each request uses native `ephemeral` inference with
the complete transcript. No durable binding is created by the bridge.

### Process-local reuse

```sh
node src/cli.js serve --socket /absolute/path/wire.sock --reuse-kv
```

Requests need a nonempty `prompt_cache_key` or `X-Xenolith-Session` header. Matching histories reuse owned native
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
or `X-Xenolith-Session` header
for every request. It does not silently fall back to temporary inference.
Keep the same socket/model configuration, binding directory and engine state/cache
when restarting. The bridge reopens its owned session and checks the committed
marker and pending calls before appending a compatible continuation.

For clients that support custom HTTP headers, send a conversation identifier:

```sh
curl http://127.0.0.1:PORT/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'X-Xenolith-Session: conversation-123' \
  -d '{"model":"YOUR_SERVED_MODEL","stream":true,"input":"Hello"}'
```

Keep this identifier across turns and restarts, and use a different one for each
conversation. A header configured globally for all chats does not provide conversation
isolation. The header accepts one ASCII identifier of 1–512 characters, without
whitespace or commas. If `prompt_cache_key` is also supplied, both values must match.
Duplicate headers and conflicting values are rejected before contacting the engine.
The header requires `--state-dir` or `--reuse-kv`; it does not enable persistence by
itself. It is a conversation key, not authentication, and clients must still send
the full supported transcript. The header works on both implemented inference endpoints.

Bindings are written atomically with file/directory fsync and private permissions.
Mutations are recorded as in-flight before sending them. A validated terminal event
and persisted binding precede publication of executable tools. Shutdown releases
connections and the directory lease, retaining native sessions and bindings.

Completed textual turns request a checkpoint if the terminal report did not
confirm one. `response.xenolith_session` reports the marker and checkpoint; a
checkpoint reporting `saved:false` does not mean a snapshot was restored.

Limits of this first persistent implementation:

- One bridge process may own a state directory. On local macOS/Linux filesystems,
  a kernel-held loopback guard automatically releases ownership after process exit,
  including SIGKILL. A suspended process retains ownership. `.bridge.lock` remains
  as versioned metadata after shutdown; its presence alone does not mean it is busy.
  The guard reserves one deterministic port in `127.0.0.1:49152–65535`, derived from
  the directory's device/inode so path aliases cannot bypass ownership. It carries
  no inference traffic and immediately closes incoming connections. A port collision
  refuses startup without modifying state; it never chooses an uncoordinated fallback.
  This is for a dedicated **local directory on one host and one network namespace**.
  Shared/network filesystems and access from different containers/network namespaces
  are unsupported. Never remove or replace an active state directory or its metadata.
- Legacy, corrupt or foreign `.bridge.lock` records are not automatically overwritten.
  For migration, stop every bridge using that directory, preserve its contents, then
  remove only `.bridge.lock` and start the new version. Do not do this while an owner
  is running. Session binding files and engine state/cache must be retained.
- Interrupted mutations rebuild from the supplied client transcript; the bridge
  does not execute or replay tools. Uncommitted streamed output is not recoverable.
  Simulator tests cover a connection lost after accepting a tool result but before
  acknowledging it: recovery rebuilds history instead of appending the result again.
  Clients must retain completed tool results; this is not an exactly-once execution
  guarantee for tools or future model-generated calls.
- Committed marker/pending-call divergence stops without mutation. An explicit
  `session_not_found` reply can recreate an owned native session and rebuild it from
  the client's full history. Recovery requires the saved conversation prefix,
  unchanged instructions/tools and every pending tool result; truncated or changed
  history is rejected. I/O errors, disconnections, busy replies and other failures
  never trigger recreation. No existing engine session is deleted.
- The recovered response includes `xenolith_session.recovery` with
  `reason:session_not_found`, `source:client_history`, and `previous_kv_restored:false`.
  Rebuilding history does not restore the old KV snapshot. Native `resume` and usage
  counters remain unmodified. A failed replacement rebuild stays marked in-flight
  so a retry can reopen that replacement and rebuild safely, including after a
  bridge restart. The recovery report accompanies its first committed response.
- Bindings contain conversation text. Keep their directory private and outside Git.
- Orderly bridge/engine restart and actual snapshot restoration have been checked
  with direct HTTP requests on Linux/WSL using a real model. Pending-tool restart
  remains simulator-tested, including a bridge killed with SIGKILL followed by
  automatic lease recovery and submission of the saved tool result. The new lock
  and Chat frontend have local simulator coverage; abrupt engine crashes and pending
  tools across a real engine restart still need hardware verification.

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

API usage represents request computation; `xenolith_usage` preserves native
counters, whose context total can differ from that sum. Missing terminal events,
wire errors and timeouts produce failures rather than fabricated success.
HTTP disconnects send best-effort cancellation and drain the terminal exchange.

## Tests

```sh
npm test
XENOLITH_BRIDGE_CODEX_BIN=/absolute/path/to/codex npm run test:codex
npm install --prefix .test-artifacts/chat-sdk --ignore-scripts openai@7.32.0
npm run test:chat
```

Unit tests use a wire simulator. Installed-client tests exercise actual requests,
progressive output, tools, resume and compaction with Codex 0.162.1. Persistent
binding tests include orderly restart, pending tool IDs, divergent markers,
uncertain generation and persistence failure before tool publication. Lock tests use
real competing processes, SIGSTOP/SIGKILL, path aliases and an occupied guard port.
Chat tests cover JSON/SSE, an actual file-read result, restart, cancellation and errors.
The optional SDK tests use OpenAI's JavaScript SDK 7.32.0 against the local simulator,
with no external inference. To use another installation, set
`XENOLITH_BRIDGE_OPENAI_SDK` to its absolute `openai/index.mjs` path. The SDK is a test
dependency only. These checks also run in the Linux/macOS, Node 22/24 CI matrix.

The optional Aider test requires a separate Python 3.12 environment:

```sh
python3.12 -m venv .test-artifacts/aider-runtime
.test-artifacts/aider-runtime/bin/python -m pip install aider-chat==0.86.2
npm run test:aider
```

Alternatively, set `XENOLITH_BRIDGE_AIDER_PYTHON` to an absolute Python executable
with Aider installed. This test uses a temporary workspace, isolated configuration,
disabled analytics and a local wire simulator. Aider reads and edits a small program,
runs its tests, sends a real failing test result back through Chat Completions, and
applies the next scripted correction. It proves that client/protocol workflow, not
model coding ability. It uses Aider's `whole` edit format and a stable per-conversation
`X-Xenolith-Session` custom header via its model settings `extra_params.extra_headers`.
See [Aider's custom-header settings](https://aider.chat/docs/config/adv-model-settings.html).

Aider changes file context between turns in this scenario: the bridge reopens the
same native session but rebuilds history instead of incrementally appending it.
No KV savings are inferred from the simulator. Other Aider modes and actual model
quality still need separate verification. This test runs on Linux/macOS with Node 22
in CI; neither Aider nor Python becomes a bridge runtime dependency.

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

Local coverage now includes missing-session recovery and a second coding harness
(Aider, in the specific workflow above). Next: expand harness scenarios and measure
context-rebuild behavior. Real-engine checks for Chat, pending tools, missing-session
recovery, rejected snapshots and abrupt crashes remain a separate final validation
stage when suitable hardware is available.
The focus remains durable sessions, honest cache/checkpoint reports, cancellation
and tool/result integrity. No client-specific frontend is planned.

Reasoning/history reasoning, images/audio, hosted/deferred tools, nested namespaces,
constrained JSON/verbosity, compressed requests, WebSocket, `previous_response_id`,
Responses storage, rewind and encrypted remote compaction are unsupported.
Unsupported features are rejected explicitly.

## License

The independent HTTP bridge is [MIT](LICENSE).
The separate Codex fork retains Apache-2.0 and its upstream notices.
