# Acceptance and reporting

## Validation scope

The upcoming `0.4.0-rc.1` is a development candidate, not a published release.
It adds diagnostics/reporting and protocol hardening to the 0.3.0 text/tool
contract. Current verification uses wire simulators and real client software;
no new real-engine run is claimed. The earlier 0.3.0 base/LNL evidence remains
historical. The test machine is no longer available. Independent feedback is
welcome, not required for publication; persistent bindings remain experimental.

A simulator can check HTTP translation, protocol failures and recovery decisions.
It cannot establish model quality, native KV restoration or performance.

## Install a candidate in a clean prefix

Use Node.js >=22 on Linux/macOS, or WSL. From this checkout, prepare a local
archive without publishing:

```sh
npm pack --ignore-scripts
npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix "$PWD/install" "$PWD/xenolith-bridge-0.4.0-rc.1.tgz"
./install/node_modules/.bin/xenolith-bridge --version
```

Expect `xenolith-bridge 0.4.0-rc.1`. No npm registry account or global installation
is needed. The package bundles neither an engine nor a model. Published archives
and SHA256 sidecars are available from
[GitHub Releases](https://github.com/crrisci/xenolith-bridge/releases);
the latest stable release is 0.3.0. Before installing a downloaded archive,
verify its matching sidecar with `sha256sum -c ARCHIVE.sha256` on Linux or
`shasum -a 256 -c ARCHIVE.sha256` on macOS.

## Check an existing engine without generation

Start your engine separately, then run:

```sh
./install/node_modules/.bin/xenolith-bridge doctor \
  --socket /absolute/path/to/wire.sock --timeout-ms 3000 --report doctor-summary.json
```

The command only inspects the socket and sends `describe`. It neither creates
sessions nor performs inference. Exit code 0 means a valid reachable wire v1
service, not a passing real-model test. Exit code 1 means a failed check or
an invalid invocation; missing/incompatible/silent peers are reported explicitly.
Use a fresh report filename each time. Existing files and symlinks are refused.

`doctor --json` prints detailed local output, potentially including arbitrary
engine-provided fields. Share `doctor-summary.json` instead. That file contains
only versions, platform, check outcomes and capacity/KV capability values.
It omits model identity, local paths and raw error messages.

## Optional real-engine battery for hardware owners

Use Linux or WSL, an existing Xenolith wire v1 binary with durable sessions and
checkpoints, and a compatible local text model. The battery owns one engine at a
time, requires 21 GiB available RAM and a 65536-token context, and refuses to
start when another Xenolith engine is running. It does not download weights or
change the existing engine installation. Stop manually started engines/bridges
before this battery. Keep the checkout path short enough for Unix socket paths.

From this checkout, pointing to the independent installation created above:

```sh
export XENOLITH_BRIDGE_INSTALL_ROOT=/absolute/path/to/install
export XENOLITH_BRIDGE_PACKAGE_ARCHIVE=/absolute/path/to/xenolith-bridge-0.4.0-rc.1.tgz
export XENOLITH_BIN=/absolute/path/to/xenolith
export XENOLITH_MODEL=/absolute/path/to/model.gguf
npm run test:release:real
```

The driver uses the **installed package**, not the checkout's server. It tests
Responses JSON/SSE and Chat Completions JSON/SSE. Each case must request exactly
one `read_file` call, receive actual random fixture contents, and return them
exactly after bridge and engine restart. A saved checkpoint, explicit
`resume.loaded:true` and positive cached-token accounting are required. Each SSE
case cancels while a generation is uncommitted, restarts and recovers using
committed history without executing the tool again.

Expect four `API_ACCEPTANCE_PASS` lines and `RELEASE_TEST_FINISHED passed`.
A failing assertion is a failed check, including model instruction failures.
Run sequentially for each engine build. `RELEASE_TEST_ROOT` identifies a private
evidence directory. `release-result.json`, case responses and logs are private;
they may contain prompts, file contents and local paths.

The battery also writes **`release-summary.json`**. This field-limited report
retains per-case pass/fail/not-run, restart/cancellation/snapshot booleans,
package/Node versions, platform/architecture and optional engine/archive hashes. Partial failures preserve
already completed cases. Unknown fields and raw exception text are omitted.
The summary explicitly says **self-reported real-engine evidence**; it is not
signed proof and does not independently certify what was run.

For older raw results, create a summary locally:

```sh
xenolith-bridge report --input /private/release-result.json --output acceptance-summary.json
```

This accepts the real battery's result format and refuses simulator formats.
Exit code 0 means that exporting succeeded; read `status` and `complete_matrix`
to determine the reported acceptance outcome.
A claimed pass without all four complete cases is not exported as a passed
matrix. The command does not contact GitHub or upload data.

## Submit useful results

Review the summary before sharing: versions, capacities and hashes may identify
an environment. Open a Bug report issue with the summary, client/version,
expected/actual behavior and a minimal request containing invented data.
Do not attach the private raw reports, engine logs, credentials, session state,
prompts or tool results. Report whether a simulator or real engine was used.
No founder approval is assumed or necessary.

The driver itself is tested against a simulator by `npm test`. To validate an
archive's installation and both JSON interfaces without weights:

```sh
XENOLITH_BRIDGE_PACKAGE_ARCHIVE=/absolute/path/to/archive.tgz npm run test:package
```

This is a package/HTTP check, not evidence of real-model compatibility.

## Candidate publication checklist

1. Run unit/protocol, SDK, Codex, Aider and offline package suites. Verify that
   reports do not copy arbitrary native strings or private fixture data.
2. Require the pinned Linux/macOS Node 22/24 CI matrix. Review early-warning
   results for newer clients separately; see COMPATIBILITY.md.
3. Preserve explicit unsupported-feature and experimental-session boundaries.
   Disclose the absent new real-engine run in the README and release notes.
4. Review the candidate version, notes and packed contents before tagging.
   After publication, download both archives, verify checksums/content and test
   clean installation. Preparing this candidate does not publish its tag.
