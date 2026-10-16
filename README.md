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

**0.4.0-rc.1 — development candidate; not yet published.**

The latest published stable release is [0.3.0](https://github.com/crrisci/xenolith-bridge/releases/tag/v0.3.0).
This candidate adds read-only diagnostics, field-limited reports and protocol fault hardening.

See [release acceptance](ACCEPTANCE.md) for clean installation, real-engine
checks and the validation scope of this release.

Both Responses and Chat Completions return JSON by default and support streaming.
This is a defined subset of the APIs, not every feature offered by OpenAI.
Codex CLI 0.162.1 is the reference Responses client used for integration tests.
Aider 0.86.2 exercises Chat Completions with the simulator and real inference.
The OpenAI JavaScript SDK exercises JSON, streaming and tool history on both APIs.
Compatibility with other clients must be checked against their actual requests.

Validation combines automated wire-simulator/client/package checks with earlier
real-engine Aider, Codex and recovery runs on base/LNL builds. The new complete
JSON/SDK matrix has not been rerun on a real engine: access to the test hardware
ended before final release validation. Stable status applies to the documented
0.3.0 contract; persistent bindings remain experimental in this candidate too. See [validation details](ACCEPTANCE.md).

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
For Codex itself, the [CodeXe fork](https://github.com/crrisci/codexe/tree/xenolith-native)
provides direct wire integration and local inference telemetry in the TUI.

## Install and run

Use Node.js 22 or newer on Linux or macOS and an existing text-only Xenolith v1
Unix socket. Native Windows requires running the bridge inside WSL.

From a source checkout:

```sh
git clone https://github.com/crrisci/xenolith-bridge.git
cd xenolith-bridge
npm exec --offline -- xenolith-bridge --help
npm exec --offline -- xenolith-bridge serve --socket /absolute/path/wire.sock --port 8080
```

There is no dependency installation or build step. To install a downloaded source
archive, or produce a portable npm package from a checkout:

```sh
npm pack
# Produces xenolith-bridge-0.4.0-rc.1.tgz for this development candidate.
npm install --prefix /absolute/private/bridge-install ./xenolith-bridge-0.4.0-rc.1.tgz
npm exec --prefix /absolute/private/bridge-install -- xenolith-bridge serve --socket /absolute/path/wire.sock
```

A GitHub source-release `.tar.gz` can also be passed directly to `npm install`.
Global installation is optional: `npm install -g ./xenolith-bridge-0.4.0-rc.1.tgz`
then `xenolith-bridge serve --socket /absolute/path/wire.sock`.
Published installable archives are distributed through GitHub Releases; this
development candidate has not been published. The package is not on the npm registry. No credentials, runtime SDK, engine or model are bundled.

## Diagnose and report

```sh
xenolith-bridge doctor --socket /absolute/path/wire.sock
xenolith-bridge doctor --socket /absolute/path/wire.sock --timeout-ms 3000 --report doctor-summary.json
```

`doctor` checks Node, the Unix socket and the engine's wire v1 `describe` reply.
It reports context/output/frame limits and durable KV availability, then closes
the connection. It does not create sessions, load a model or run inference.
Exit status is 0 for a compatible reply and 1 on failure. A successful check
establishes protocol reachability, not real-model or persistent-resume correctness.

`--json` prints local diagnostic details; do not share that output as a report.
`--report NEW_FILE` instead writes a field-limited summary without socket/model
names, paths, raw errors, prompts or results. Files are created privately, existing
files are never overwritten and nothing is uploaded. Review summaries before
sharing: versions, capacity values and build hashes can identify an environment.

The real acceptance battery writes a separate `release-summary.json` for sharing.
To summarize an older private result:

```sh
xenolith-bridge report --input /private/release-result.json --output acceptance-summary.json
```

Summaries explicitly identify describe-only checks or self-reported real-engine
results; they do not certify the engine or convert simulator evidence into real
inference. See [acceptance and reporting](ACCEPTANCE.md) and
[client compatibility and maintenance](COMPATIBILITY.md).

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
| POST | `/v1/responses` | Text/tool inference; JSON by default, SSE with `stream:true` |
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

## API contract

Send the full conversation on each turn. Response IDs identify results; they do
not enable server-side conversation storage or retrieval. Omit `store` or use
`store:false`. Both endpoints reject unknown request fields rather than silently
pretending to implement them.

| Capability / control | Responses | Chat Completions |
|---|---|---|
| Input | `input` text or ordered input items, optional `instructions` | `messages` with text content |
| JSON / streaming | Omit `stream` or set false / set true | Same |
| Streaming format | Named SSE events, ending in `response.completed`, `response.incomplete` or `response.failed` | Data-only chunks, ending in `[DONE]` |
| Tools | Function/custom tools and one namespace level | Function tools |
| Tool choice | `auto` (default) or `none` | Same |
| Historical tool results | Matched `call_id`, in call order | Matched `tool_call_id`, in call order |
| `temperature` | 0–2 | Same |
| `top_p` | Greater than 0, at most 1 | Same |
| Output limit | `max_output_tokens` | `max_tokens` or `max_completion_tokens`, not both |
| Parallel tools | `parallel_tool_calls` boolean | Same |
| Persistence identity | `prompt_cache_key` or `X-Xenolith-Session` | Same |
| Schemas | Non-strict function schemas; omitted parameters mean an empty object | Same |
| Output limit reached | `status:incomplete`, reason `max_output_tokens` | `finish_reason:length` |
| Engine/wire failure | JSON HTTP error, or a typed `response.failed` SSE event | JSON HTTP error, or an SSE error then `[DONE]` |

Output defaults to the smaller of the launcher's `--max-output-tokens` setting
(default 4096) and the engine's advertised limit. An explicit request limit may
select any positive integer up to the advertised engine limit.
`tool_choice:none` removes current executable declarations while retaining past
tool calls/results as history. Forced/required tool choices are rejected, as are
strict schemas: the bridge cannot guarantee schema-constrained engine output.
Custom-tool grammar definitions are prompt guidance, not enforced constraints.

The JSON Responses body is a complete `response` object with output items, status,
usage and native extensions. It is withheld until terminal validation and any
persistent commit succeed. Partial JSON and uncommitted tools are never returned
as a successful answer. On streaming responses, text can arrive before completion;
clients must inspect the terminal status before treating the answer as successful.

OpenAI's SDK provides `response.output_text` as a helper; raw JSON consumers can
read `output[].content[]` entries with `type:output_text`.
An upstream abort without a client disconnect is an engine error on both APIs.
A client disconnect sends best-effort wire cancellation, including in JSON mode.

Responses supports the existing Codex compatibility include
`reasoning.encrypted_content` only as an empty capability with reasoning disabled;
no reasoning item or encrypted content is fabricated. JSON formats, verbosity,
reasoning, hosted tools and storage remain outside this contract.

Reference: [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)
and [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

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

Completed textual turns and pending tool calls request a checkpoint if the
terminal report did not confirm one. The checkpoint is attempted before publishing
a tool call, so a successful save can also survive a restart while the harness
executes the tool. This can add checkpoint latency before tool dispatch. The engine
can refuse a checkpoint; its reason is preserved. `response.xenolith_session`
reports the marker and checkpoint; a
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
  Rebuilding history does not restore the old KV snapshot. It can still produce
  partially reusable context, so `previous_kv_restored:false` does not imply
  `cache_read:0`. Native `resume` and usage counters remain unmodified. A failed replacement rebuild stays marked in-flight
  so a retry can reopen that replacement and rebuild safely, including after a
  bridge restart. The recovery report accompanies its first committed response.
- Bindings contain conversation text. Keep their directory private and outside Git.
- Real-model checks on Linux/WSL cover orderly bridge/engine restart, actual snapshot
  restoration, Chat JSON/SSE, pending tool results after bridge/engine SIGKILL,
  automatic lock recovery, missing native sessions, rejected snapshots and a crash
  during generation. These checks use isolated state and a Gemma model on the
  text-only Xenolith v1 protocol; they do not establish compatibility with every
  engine build or model. A pending-tool checkpoint was also restored after forced
  termination of both processes; when a checkpoint is refused, tool continuity
  still does not imply KV restoration.

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
npm run test:sdk
npm run test:package
```

Unit tests use a wire simulator. Installed-client tests exercise actual requests,
progressive output, tools, resume and compaction with Codex 0.162.1. Persistent
binding tests include orderly restart, pending tool IDs, divergent markers,
uncertain generation and persistence failure before tool publication. Lock tests use
real competing processes, SIGSTOP/SIGKILL, path aliases and an occupied guard port.
Chat tests cover JSON/SSE, an actual file-read result, restart, cancellation and errors.
The optional SDK tests cover both APIs using OpenAI's JavaScript SDK 7.32.0 against the local simulator,
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
No KV savings are inferred from the simulator. This test runs on Linux/macOS with
Node 22 in CI; neither Aider nor Python becomes a bridge runtime dependency.

To exercise the same coding fixture with real inference on Linux/WSL:

```sh
XENOLITH_BIN=/absolute/path/to/xenolith \
XENOLITH_MODEL=/absolute/path/to/model.gguf \
XENOLITH_BRIDGE_AIDER_PYTHON=/absolute/path/to/aider-venv/bin/python \
npm run test:aider:real
```

The launcher requires at least 21 GiB of available memory and no other Xenolith
engine, starts its own text-only engine with a 65,536-token context, and stops it
after the test. The test checks an initially failing program, Aider's
own passing test run, independent verification and unchanged tests. It records
native usage and session events without requiring a particular number of model
attempts. Aider 0.86.2 with Gemma 4 26B A4B passed this small fixture in whole-file
mode on WSL; that run corrected the program in one request and reported no cache
reuse. The separate multi-file feedback scenario below has also passed with
Aider 0.86.2 and this model on WSL: a failed model edit, returned test feedback,
a passing correction and independent verification with unchanged tests. Larger
tasks and other edit modes remain unverified.

The multi-file feedback scenario is available separately:

```sh
XENOLITH_BIN=/absolute/path/to/xenolith \
XENOLITH_MODEL=/absolute/path/to/model.gguf \
XENOLITH_BRIDGE_AIDER_PYTHON=/absolute/path/to/aider-venv/bin/python \
npm run test:aider:feedback:real
```

It asks Aider to repair monetary conversion and invoice totals in two modules.
The unchanged test suite specifies decimal half-up rounding through real failure
messages. Each test invocation records source snapshots, test hashes and results.
Acceptance requires a failing test after a model edit, that failure's unique marker
in a later Chat Completions request, Aider's passing correction and an independent
passing run. A first-attempt solution does not complete this feedback check.
`npm run test:aider` also exercises it with scripted wire replies; this verifies
the harness, not real-model correction ability. Artifacts remain private under
`.test-artifacts/`.

The opt-in model harness requires Linux, sufficient free memory and exclusive use
of an engine it starts in private directories:

```sh
XENOLITH_BIN=/absolute/path/to/xenolith \
XENOLITH_MODEL=/absolute/path/to/model.gguf npm run test:model
```

Use `XENOLITH_BRIDGE_REUSE_KV=1` for process-local reuse and
`XENOLITH_BRIDGE_PHASES` to select model-harness phases. Test artifacts remain private and ignored.

For the coding lifecycle with persistent bindings, select
`XENOLITH_BRIDGE_PERSISTENT=1 XENOLITH_BRIDGE_PHASES=codex_lifecycle` when running
`npm run test:model`. This scenario edits and tests a cart module, compacts the
conversation, restarts client/bridge/engine and verifies the resumed program.
Persistent mode requires an explicit native `loaded: true` report after the engine
restart. The model harness and multi-file Aider scenario record per-request native
usage, session decisions, time to first wire text and time to the wire terminal.
These timings are observed inside the bridge and exclude final HTTP delivery;
tool-only responses have no first-text measurement. They are diagnostics, not a
general performance benchmark.

The dedicated persistent-mode battery uses HTTP directly and owns isolated bridge
processes, engine state/cache and bindings:

```sh
XENOLITH_BIN=/absolute/path/to/xenolith \
XENOLITH_MODEL=/absolute/path/to/model.gguf npm run test:persistence
```

It checks bridge/engine restart, actual KV restoration, a missing snapshot, Chat
JSON/SSE, a pending tool result across forced process termination, missing-session
recovery, a deliberately damaged snapshot and interruption during generation.
Only its own isolated snapshots are damaged; original files are retained.
Use `XENOLITH_BRIDGE_PERSISTENCE_PHASES=responses` or `chat` to select a group;
the default runs both.

The Chat group also compares identical requests in a continuing session and a
fresh session. It records native input computations, cache reuse, time to first
text and total request time. A single sequential pair is a diagnostic measurement,
not a general throughput benchmark. Snapshot restoration, incremental reuse and
history reconstruction are distinct; inspect native reports rather than assuming
one from another. Results, prompts and environment details remain private and
ignored by Git.

For repeated context-size and changed-history diagnostics:

```sh
XENOLITH_BIN=/absolute/path/to/xenolith \
XENOLITH_MODEL=/absolute/path/to/model.gguf npm run test:kv
```

This launcher uses the same memory/context preflight as the real Aider test.
The default runs two conversations at each of 32, 128 and 512 ledger records.
Override these with `XENOLITH_BRIDGE_KV_SIZES` (comma-separated record counts) and
`XENOLITH_BRIDGE_KV_REPETITIONS`. Each conversation compares an incremental
continuation with an identical request in a fresh session, then changes an early
history entry and compares the rebuild with another fresh session. It verifies
answers, native usage and the rebuild event, recording first-text and total time.
A fresh session can still report native cache reuse; inspect `cache_read` rather
than assuming an empty cache. Runs are sequential and warm-first; results are diagnostics for the selected
engine and synthetic text, not a randomized benchmark or general savings claim.

## Validation and remaining scope

The real-model roadmap for multi-file Aider feedback, coding-context measurements
and the base/LNL engine comparison is complete. Both builds passed the Aider
error/correction scenario, the Codex coding/compaction/restart lifecycle and the
Chat crash/recovery battery. These are bounded acceptance checks on one Gemma
model and host; they do not establish general model quality or engine performance.

The Responses JSON path is additionally checked through the official SDK with a
wire simulator: tool-result continuation after restart, output caps, errors,
cancellation and commit-before-publication. Package checks install a packed CLI
offline in an empty directory and exercise both APIs. CI runs on Linux/macOS with
Node 22/24. Detailed real-model reports and raw requests remain private.

The release scope is the two documented text/tool APIs. Other clients, model builds
and edit formats need acceptance checks against their actual requests.

Reasoning/history reasoning, images/audio, hosted/deferred tools, nested namespaces,
constrained JSON/verbosity, compressed requests, WebSocket, `previous_response_id`,
Responses storage, rewind and encrypted remote compaction are unsupported.
Unsupported features are rejected explicitly. Xenolith services advertising
protocol v2 (including vision services started with `--mmproj`) are not supported;
use a text-only v1 service for this bridge.

## License

The independent HTTP bridge is [MIT](LICENSE).
The separate Codex fork retains Apache-2.0 and its upstream notices.
