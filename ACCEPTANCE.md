# Release acceptance: 0.3.0

Release `0.3.0` covers the README's text/tool contract. Its release basis is the
passing automated API/client/package suites plus earlier real-engine Aider,
Codex and recovery checks on base and LNL builds. The test host is no longer
available, so the newly added complete JSON/SSE installed-artifact battery has
not been run with a real engine. Simulator results do not replace that evidence.
Independent founder feedback was not required for this release and no founder
approval is claimed. Persistent session bindings remain experimental.

The procedures below allow users with compatible hardware to reproduce the
outstanding real-engine checks and report failures.

## Install the published release in a clean prefix

Use Linux or WSL, Node.js >=22, an existing Xenolith wire v1 binary with durable
sessions/checkpoints, and a supported local text model. The real test owns one
engine at a time, requires 21 GiB available RAM and a 65536-token context, and
refuses to start when another Xenolith engine is running. It does not download
weights or change the existing engine installation.

Download these assets from the
[stable release](https://github.com/crrisci/xenolith-bridge/releases/tag/v0.3.0)
into an empty directory:

- `xenolith-bridge-0.3.0.tgz`
- `xenolith-bridge-0.3.0.tgz.sha256`

From that directory:

```sh
sha256sum -c xenolith-bridge-0.3.0.tgz.sha256
npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix "$PWD/install" "$PWD/xenolith-bridge-0.3.0.tgz"
./install/node_modules/.bin/xenolith-bridge --version
```

Expect `xenolith-bridge 0.3.0`. No npm registry account, API key or global
installation is needed. The archive does not bundle an engine or model.
For manual client testing, start your engine separately, then run:

```sh
./install/node_modules/.bin/xenolith-bridge serve \
  --socket /absolute/path/to/wire.sock --state-dir "$PWD/manual-bindings"
```

The printed JSON supplies the local `base_url` and `model` for clients.

## Reproduce the real API battery

The acceptance driver ships with this release. Obtain the tagged repository
separately; it drives the **installed release**, rather than running the
checkout's server. Stop the manual bridge/engine before this battery.

```sh
git clone --branch v0.3.0 https://github.com/crrisci/xenolith-bridge.git acceptance-source
cd acceptance-source
export XENOLITH_BRIDGE_INSTALL_ROOT=/absolute/path/to/install
export XENOLITH_BRIDGE_PACKAGE_ARCHIVE=/absolute/path/to/xenolith-bridge-0.3.0.tgz
export XENOLITH_BIN=/absolute/path/to/xenolith
export XENOLITH_MODEL=/absolute/path/to/model.gguf
npm run test:release:real
```

The four cases are Responses JSON, Responses SSE, Chat Completions JSON and Chat
Completions SSE. Each must request exactly one `read_file` call, receive the
actual randomly generated fixture contents, and return them exactly after both
bridge and engine restart. The driver requires a saved checkpoint, explicit
`resume.loaded:true` and positive cached-token accounting. Each SSE case also
cancels after receiving text while a generation is still uncommitted, restarts,
and recovers using committed history without executing the tool again.

Expect four `API_ACCEPTANCE_PASS` lines and `RELEASE_TEST_FINISHED passed`.
`RELEASE_TEST_ROOT` identifies the private evidence directory containing
`release-result.json`, case responses/events and engine/bridge logs. A failing
assertion is a failed acceptance check, including model instruction failures;
do not relabel it as a pass. Run sequentially for each supported engine build.
Keep raw reports private: they can contain prompts, tool results and local paths.

The harness itself is checked against a wire simulator by `npm test`. The
published package can also be installed and checked locally against that
simulator, without loading weights:

```sh
XENOLITH_BRIDGE_PACKAGE_ARCHIVE=/absolute/path/to/xenolith-bridge-0.3.0.tgz \
  npm run test:package
```

That command is a packaging check, not evidence of real-model compatibility.

## Optional independent feedback

Please test the published package in a fresh installation and report:

- OS, Node version, bridge version, engine commit/build and model identity.
- Installation result and outcome of the four API cases above.
- Outcome with at least one actual client and its version/configuration.
- Any failure: minimal reproducible request, expected/actual behavior and error.
- Whether the documented text/tool scope is acceptable for stable `0.3.0`.

Independent testing is welcome and is not a publication prerequisite. Report
reproducible issues through GitHub, keeping credentials and private logs out of
public reports. This workflow does not contact anyone automatically.

## Publication checks for 0.3.0

1. Run the unit/transport, SDK, Codex, Aider and offline package suites; require
   passing CI on Linux/macOS with Node 22/24.
2. Retain the earlier real-engine evidence privately and explicitly disclose the
   outstanding final real-engine matrix in the README and release notes.
3. Set version and release notes to `0.3.0`, publish the stable tag, then verify
   the downloaded source/npm archives, checksum sidecars and clean installation.

The full real-engine battery and independent feedback remain follow-up work
when hardware and testers are available. They are not claimed as completed or
required for this publication. Reproducible runtime defects should receive a
patch release with relevant regression coverage. Keep unsupported features
explicit in the README; stable `0.3.0` does not imply full OpenAI API compatibility.
