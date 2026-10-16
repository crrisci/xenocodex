import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptanceSummary, exportAcceptance, writeReport } from '../src/report.js';
import { testRoot } from './helpers/codex.js';

const names = ['responses-json', 'responses-sse', 'chat-json', 'chat-sse'];
function complete() { return { mode: 'installed_release_real_engine', package_version: '0.3.0', status: 'passed',
  cases: names.map(name => ({ case: name, status: 'passed', actual_file_reads: 1, restart_before_result: true,
    snapshot_required: true, resume: { loaded: true }, cancellation: name.endsWith('sse') })) }; }

test('acceptance export whitelists fields and never copies secrets from nested results or native strings', async () => {
  const secret = 'PRIVATE_API_KEY_/home/person/prompt';
  const input = complete();Object.assign(input, { engine_binary: secret, model_path: secret, error: secret, describe: { model: secret } });
  input.cases[0].resume.secret = secret;input.cases[0].prompt = secret;
  const report = acceptanceSummary(input);assert.equal(report.complete_matrix, true);assert.equal(report.status, 'passed');
  assert.equal(report.evidence, 'self_reported_real_engine');assert.ok(!JSON.stringify(report).includes(secret));
  input.package_version = secret;input.engine_sha256 = secret;input.node_version = secret;input.platform = secret;input.arch = secret;assert.equal(acceptanceSummary(input).bridge_version, null);
  assert.equal(acceptanceSummary(input).engine_sha256, null);
  assert.equal(acceptanceSummary(input).node_version, null);assert.equal(acceptanceSummary(input).platform, 'other');assert.equal(acceptanceSummary(input).arch, 'other');
});

test('incomplete, duplicate, failed and non-restored cases cannot become a passed matrix', () => {
  for (const mutate of [x => x.cases.pop(), x => x.cases.push(x.cases[0]), x => { x.cases[0].status = 'failed'; },
    x => { x.cases[0].resume.loaded = false; }, x => { x.cases[1].cancellation = false; }]) {
    const input = complete();mutate(input);const report = acceptanceSummary(input);
    assert.equal(report.complete_matrix, false);assert.notEqual(report.status, 'passed');
  }
  assert.throws(() => acceptanceSummary({ ...complete(), mode: 'simulator' }), /real-engine result/);
  const failed = { ...complete(), status: 'failed', cases: [complete().cases[0], { case: names[1], status: 'failed' }] };
  const summary = acceptanceSummary(failed);assert.equal(summary.status, 'failed');assert.equal(summary.cases[0].status, 'passed');assert.equal(summary.cases[2].status, 'not_run');
});

test('report files are private, never overwrite targets and export bounded input', async () => {
  const root = await testRoot('report'), raw = join(root, 'raw.json'), out = join(root, 'share.json');
  await writeFile(raw, JSON.stringify(complete()));await exportAcceptance(raw, out);
  assert.equal((await stat(out)).mode & 0o777, 0o600);assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'passed');
  await assert.rejects(writeReport(out, {}), { code: 'EEXIST' });
  const alias = join(root, 'link');await symlink(raw, alias);await assert.rejects(writeReport(alias, {}), { code: 'EEXIST' });
  assert.equal(JSON.parse(await readFile(raw, 'utf8')).mode, 'installed_release_real_engine');
  await writeFile(raw, ' '.repeat(1024 * 1024 + 1));await assert.rejects(exportAcceptance(raw, join(root, 'too-big.json')), /exceeds/);
});
