import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { invalid, object } from './errors.js';

const cases = ['responses-json', 'responses-sse', 'chat-json', 'chat-sse'];
const status = value => ['passed', 'failed', 'not_run'].includes(value) ? value : 'not_run';
const version = value => typeof value === 'string' && value.length <= 128 && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value) ? value : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const environment = input => ({ node_version: version(input.node_version),
  platform: ['linux', 'darwin', 'win32'].includes(input.platform) ? input.platform : 'other',
  arch: ['x64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x', 'riscv64'].includes(input.arch) ? input.arch : 'other' });
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;

// Projection, never recursive redaction: arbitrary strings from native output,
// prompts, errors, models, filesystem paths and extra fields cannot pass through.
export function acceptanceSummary(input) {
  if (!object(input) || input.mode !== 'installed_release_real_engine') invalid('Expected an installed-release real-engine result');
  const results = cases.map(name => {
    const matches = Array.isArray(input.cases) ? input.cases.filter(c => object(c) && c.case === name) : [];
    const c = matches.length === 1 ? matches[0] : {};
    return { case: name, status: status(c.status), file_read_once: c.actual_file_reads === 1,
      restarted_before_result: c.restart_before_result === true, snapshot_required: c.snapshot_required === true,
      snapshot_loaded: c.resume?.loaded === true, cancellation_observed: c.cancellation === true };
  });
  const complete = results.every(c => c.status === 'passed' && c.file_read_once && c.restarted_before_result &&
    c.snapshot_required && c.snapshot_loaded && (!c.case.endsWith('sse') || c.cancellation_observed));
  return { schema_version: 1, kind: 'acceptance', evidence: 'self_reported_real_engine',
    bridge_version: version(input.package_version), ...environment(input), claimed_status: status(input.status),
    status: input.status === 'failed' ? 'failed' : complete && input.status === 'passed' ? 'passed' : 'not_run',
    engine_sha256: hash(input.engine_sha256), archive_sha256: hash(input.archive_sha256),
    complete_matrix: complete, cases: results };
}

export function doctorSummary(input) {
  return { schema_version: 1, kind: 'doctor', evidence: 'describe_only_no_inference',
    bridge_version: version(input.bridge_version), ...environment(input),
    status: status(input.status), checks: ['runtime', 'socket', 'protocol'].map(name => ({
      name, status: status(input.checks?.find(c => c.name === name)?.status),
    })), capabilities: input.status === 'passed' ? {
      protocol: 1, context_window: positive(input.info?.context_window), max_output: positive(input.info?.max_output),
      max_frame: positive(input.info?.max_frame), kvstore: input.info?.kvstore === true,
    } : null };
}

export async function writeReport(path, report) {
  // Reports may be deliberately shared; nevertheless create them privately and
  // refuse overwrites/symlinks rather than truncating an unrelated existing file.
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); }
  finally { await file.close(); }
}

export async function exportAcceptance(inputPath, outputPath) {
  const file = await open(inputPath, 'r');
  let input;
  try {
    if ((await file.stat()).size > 1024 * 1024) invalid('Acceptance result exceeds 1 MiB');
    input = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  const report = acceptanceSummary(input);
  await writeReport(outputPath, report);return report;
}
