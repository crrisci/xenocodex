# Release acceptance: 0.3.0

The published `0.3.0-rc.1` is a candidate for the README's text/function-tool
contract. Stable publication requires the installed-artifact real-engine checks
and independent founder feedback below. Passing simulator tests alone does not
satisfy either gate.

## Install the published candidate in a clean prefix

Use Linux or WSL, Node.js >=22, an existing Xenolith wire v1 binary with durable
sessions/checkpoints, and a supported local text model. The real test owns one
engine at a time, requires 21 GiB available RAM and a 65536-token context, and
refuses to start when another Xenolith engine is running. It does not download
weights or change the existing engine installation.

Download these assets from the
[RC release](https://github.com/crrisci/xenolith-bridge/releases/tag/v0.3.0-rc.1)
into an empty directory:

- `xenolith-bridge-0.3.0-rc.1.tgz`
- `xenolith-bridge-0.3.0-rc.1.tgz.sha256`

From that directory:

```sh
sha256sum -c xenolith-bridge-0.3.0-rc.1.tgz.sha256
npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix "$PWD/install" "$PWD/xenolith-bridge-0.3.0-rc.1.tgz"
./install/node_modules/.bin/xenolith-bridge --version
```

Expect `xenolith-bridge 0.3.0-rc.1`. No npm registry account, API key or global
installation is needed. The archive does not bundle an engine or model.
For manual client testing, start your engine separately, then run:

```sh
./install/node_modules/.bin/xenolith-bridge serve \
  --socket /absolute/path/to/wire.sock --state-dir "$PWD/manual-bindings"
```

The printed JSON supplies the local `base_url` and `model` for clients.

## Reproduce the real API battery

The acceptance driver was added after the RC tag. Obtain the current repository
separately; it drives the **installed candidate**, rather than running the
checkout's server. Stop the manual bridge/engine before this battery.

```sh
git clone https://github.com/crrisci/xenolith-bridge.git acceptance-source
cd acceptance-source
export XENOLITH_BRIDGE_INSTALL_ROOT=/absolute/path/to/install
export XENOLITH_BRIDGE_PACKAGE_ARCHIVE=/absolute/path/to/xenolith-bridge-0.3.0-rc.1.tgz
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
XENOLITH_BRIDGE_PACKAGE_ARCHIVE=/absolute/path/to/xenolith-bridge-0.3.0-rc.1.tgz \
  npm run test:package
```

That command is a packaging check, not evidence of real-model compatibility.

## Independent founder feedback

Please test the published package in a fresh installation and report:

- OS, Node version, bridge version, engine commit/build and model identity.
- Installation result and outcome of the four API cases above.
- Outcome with at least one actual client and its version/configuration.
- Any failure: minimal reproducible request, expected/actual behavior and error.
- Whether the documented text/tool scope is acceptable for stable `0.3.0`.

A maintainer running the battery is not a substitute for this independent test.
No founder approval has been recorded in this checklist. Share results through
the repository owner; this workflow does not contact anyone automatically.

## Stable publication gate

1. Verify downloaded release archives against their SHA256 sidecars and install
   the published npm archive in an empty prefix.
2. Pass real-engine acceptance on the supported base and LNL builds, retaining
   private evidence and provenance.
3. Record independent founder feedback and resolve reproducible release blockers.
4. Set version/release notes to `0.3.0`, run the relevant local suites and CI,
   then publish the stable tag. Verify the published assets and checksums again.

If fixes change runtime behavior, publish another RC and repeat affected
acceptance checks before promoting it. Keep unsupported features explicit in the
README. Stable `0.3.0` does not imply full OpenAI API compatibility.
