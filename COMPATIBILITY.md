# Client compatibility and maintenance

Bridge supports the text/tool subset in the README, not entire client products
or every option they expose. Real-engine behavior also depends on the Xenolith
build, model and supplied history. Persistent bindings remain experimental.

## Release reference clients

| Client | Reference version | Automated coverage |
| --- | --- | --- |
| OpenAI JavaScript SDK | 7.32.0 | Responses and Chat JSON/SSE, tool-result history, limits and failures |
| Codex CLI | 0.162.1 | Responses coding/tool loop, compaction, restart and isolated launcher |
| Aider | 0.86.2 | Chat coding loop with test failure, feedback and correction |

These versions are pinned in the release CI. Tests run against a wire simulator
without hosted inference or API credentials, on Linux/macOS with Node 22/24.
Aider runs in an isolated Python 3.12 environment on the Node 22 jobs. Earlier
base/LNL real-engine evidence belongs to the 0.3.0 release history; no new
real-engine compatibility is claimed for the diagnostic changes in 0.4.0-rc.1.

The separate **Upcoming client compatibility** workflow can be run manually and
runs weekly and when its workflow changes against the latest client packages. It prints resolved package
versions and runs the same integration suites on Linux/Node 22. Its failures are
early warnings, not evidence that the pinned release contract is broken. Newer
versions do not become supported just because their packages can be installed.
Promote a newer reference version only after reviewing actual request behavior
and passing the relevant tests; record the version change in the changelog.

## Candidate observations (2026-10-16)

Codex 0.163.0 passed all eight integration cases on the local Mac. On Linux,
two early-warning runs failed three tool-result/compaction cases because the
expected file contents were absent from the returned tool history. A later run
passed after adding diagnostic logging; no runtime fix was made and the cause
has not been established. Treat this as an unresolved intermittent observation,
not a proven Bridge regression or a verified client fix. Keep 0.162.1 as the
release reference until the behavior can be reproduced and explained. Tests
still require actual file results and successful tool execution; no assertions
were removed to obtain a pass.

## Report a failure

Use the repository's Bug report issue form with a minimal request containing
invented data. Include Bridge and client versions, the expected result and the
actual error. Distinguish a real engine from a simulator explicitly.

`doctor --report NEW_FILE` exports only structural diagnostics. `report --input
release-result.json --output NEW_FILE` exports an acceptance summary. Neither
command uploads anything. Avoid sharing local `doctor --json` output, raw
acceptance reports, prompts, tool results, session state or engine logs. Review
the generated summary too: it includes versions, capacity values, boolean
outcomes and optional engine/archive hashes that can identify a build.

## Patch and release policy

- Reproduce protocol defects with a small native-wire fixture and add a
  regression that checks the failure and recovery behavior across affected APIs.
- Keep transport/JSON corruption and uncertain checkpoints fail-closed; do not
  publish executable tools before a successful durable commit.
- Keep changes that require unverified native capabilities experimental or
  unsupported. A passing simulator cannot validate model quality, native KV
  restoration, performance or a new engine build.
- Run unit/protocol, SDK, Codex, Aider and package suites before a candidate.
  Require the pinned Linux/macOS Node 22/24 CI matrix before publishing a tag.
- Publish protocol fixes as patches; review new client features separately.
  Disclose absent real-engine verification in candidate and release notes.
- After publication, check both downloaded archives/checksums and install the
  published package in an empty prefix. The `v*` workflow publishes only after
  its own pinned test matrix passes.

The upcoming-client workflow is separate from the release gate. It does not
publish releases, edit dependencies or change reference versions automatically.
