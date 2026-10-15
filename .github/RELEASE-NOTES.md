Xenolith Bridge 0.3.0 — stable release for the documented text/tool API contract.

Both `/v1/responses` and `/v1/chat/completions` now return JSON by default and
stream with `stream:true`. The client executes tools; the bridge translates
requests/results to an existing text-only Xenolith wire v1 engine.

- Add complete Responses JSON output, withheld until terminal validation and any
  durable commit succeed; failures return HTTP errors without partial tool output.
- Support `tool_choice:auto|none` on both APIs, preserve historical tool results,
  align temperature to 0–2 and reject strict schemas explicitly.
- Treat unsolicited engine abortion and malformed native calls as errors on both APIs.
- Add official OpenAI SDK Responses tests for JSON, progressive SSE, function-tool
  continuation after restart, output limits and failures.
- Add offline package-install/CLI checks and a precise public API capability matrix.
- Include an installed-release acceptance driver for both APIs, pending-tool
  restart, explicit snapshot restoration and cancellation/recovery.

Runtime behavior is unchanged from `0.3.0-rc.1`; this release promotes its
documented contract with the validation boundary described below.

Install the `.tgz` asset with `npm install -g ./xenolith-bridge-0.3.0.tgz`,
then run `xenolith-bridge serve --socket /absolute/path/wire.sock`. A local prefix
and `npm exec` are also supported. Source and npm archives have separate SHA256
sidecars. No runtime dependencies, engine or model are bundled; this package
has not been published to the npm registry.

Requires Node.js >=22 on Linux/macOS (or Linux inside WSL). Experimental persistent
bindings, checkpoint reports and recovery behavior remain available. Earlier
real-model checks covered Aider feedback, Codex compaction/restart and base/LNL
crash recovery. New JSON serialization and SDK/package checks use a wire simulator.
The final complete JSON/SSE installed-artifact matrix has not been run on a real
engine because access to the test hardware ended. This limitation is accepted
for this release; independent founder feedback is optional and no approval is
claimed. The opt-in `npm run test:release:real` battery is included for subsequent
hardware validation. See ACCEPTANCE.md for reproducible steps and scope.

Reasoning, media, hosted/deferred tools, forced tool choice, strict/structured
outputs, Responses storage/retrieval and WebSockets remain outside the contract.
Complete client history is required; persistent session identity alone does not
guarantee cache reuse. Detailed reports, requests, weights, cache and credentials
are excluded from distribution. MIT; CodeXe remains a separate Apache-2.0 project.
