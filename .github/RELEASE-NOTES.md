Xenolith Bridge 0.4.0-rc.1 — candidate for diagnostics and protocol hardening.

This candidate is prepared for review; it has not been tagged or published.
The supported Responses and Chat Completions text/tool contract remains the
same as 0.3.0, with JSON by default and SSE when `stream:true`.

- Add `xenolith-bridge doctor --socket PATH`: check Node, Unix socket and wire v1
  describe capabilities without loading a model, mutating sessions or generating.
  Print capacity/KV information and return a nonzero exit on failed checks.
- Add `doctor --report NEW_FILE` and `report --input release-result.json --output
  NEW_FILE` for field-limited, private summaries. No automatic uploads or
  overwrites; raw errors, native strings, paths, model names, prompts and results
  are excluded. Real-battery summaries are explicitly self-reported evidence.
- Retain partial acceptance outcomes and generate `release-summary.json` beside
  private real-battery logs. Describe-only and simulator results cannot become
  real-inference compatibility claims.
- Reject malformed native UTF-8 and discard queued data on wire failure so a
  plausible reply/tool/terminal cannot hide corruption in the same packet.
- Extend fault tests across both JSON/SSE APIs, failed checkpoints, frame/queue
  limits, silent peers and cancellation acknowledgements without terminals.
- Add compatibility/patch policy, a report issue form and separate weekly/manual
  probes of latest client packages. Release CI retains pinned reference clients:
  SDK 7.32.0, Codex 0.162.1 and Aider 0.86.2 on Linux/macOS with Node 22/24.

Validation uses wire simulators and actual client software. No new real-engine
run has been performed: the previous test host is no longer available. Earlier
0.3.0 base/LNL Aider, Codex and recovery results are historical evidence, not
verification of the new diagnostic or transport changes on a real engine.
Persistent bindings remain experimental. Independent feedback is optional.

Requires Node.js >=22 and an existing text-only Xenolith wire v1 engine; Windows
requires WSL. No runtime dependencies, engine or model are bundled. Local source
packaging produces `xenolith-bridge-0.4.0-rc.1.tgz`; the package is not published to
the npm registry. When tagged, GitHub CI produces npm/source archives and SHA256
sidecars only after its pinned matrix passes. See ACCEPTANCE.md for installation,
reporting and the publication checklist; COMPATIBILITY.md defines client scope.

Reasoning, media, hosted/deferred tools, forced tool choice, strict/structured
outputs, Responses storage/retrieval and WebSockets remain unsupported. Complete
client history is required; persistent identity alone does not guarantee cache
reuse. MIT; CodeXe remains a separate Apache-2.0 project.
