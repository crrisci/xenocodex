import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startFakeWire, description } from './helpers/fake-wire.js';
import { testRoot } from './helpers/codex.js';

async function cli(args) {
  const child = spawn(process.execPath, [resolve('src/cli.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';child.stdout.on('data', b => { out += b; });child.stderr.on('data', b => { err += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject);child.once('close', resolve); });return { code, out, err }; }
  finally { clearTimeout(timer); }
}

test('doctor CLI inspects only describe, prints capabilities and writes a private field-limited report', async t => {
  const root = await testRoot('doctor'), report = join(root, 'summary.json');
  const secret = 'PRIVATE_MODEL_TOKEN';
  const fake = await startFakeWire(root, { info: { ...description, model: secret, extra: { token: secret } } });
  t.after(() => fake.close());
  const alias = join(root, 'alias.sock');await symlink(fake.socketPath, alias);
  const result = await cli(['doctor', '--socket', alias, '--report', report]);
  assert.equal(result.code, 0, result.err);assert.match(result.out, /protocol: passed/);assert.match(result.out, /Context: 65536/);
  assert.deepEqual(fake.requests, [{ op: 'describe' }]);
  const shared = await readFile(report, 'utf8');assert.ok(!shared.includes(secret));assert.ok(!shared.includes(root));
  assert.equal(JSON.parse(shared).evidence, 'describe_only_no_inference');assert.equal((await stat(report)).mode & 0o777, 0o600);
  const again = await cli(['doctor', '--socket', alias, '--report', report]);assert.equal(again.code, 1);assert.match(again.err, /EEXIST/);
  assert.equal(await readFile(report, 'utf8'), shared);
});

for (const scenario of ['missing', 'file', 'protocol', 'timeout']) test(`doctor reports ${scenario} with nonzero exit and no inference`, async t => {
  const root = await testRoot('doctor-fail');let socket = join(root, 'missing.sock'), fake;
  if (scenario === 'file') await writeFile(socket, 'not a socket');
  if (scenario === 'protocol' || scenario === 'timeout') {
    fake = await startFakeWire(root, { info: { ...description, protocol: 2 },
      ...(scenario === 'timeout' ? { faults: { describe: 'silent' } } : {}) });
    socket = fake.socketPath;t.after(() => fake.close());
  }
  const report = join(root, 'share.json');
  const result = await cli(['doctor', '--socket', socket, '--timeout-ms', '50', '--json', '--report', report]);
  assert.equal(result.code, 1, result.out);const local = JSON.parse(result.out);assert.equal(local.status, 'failed');
  assert.equal(JSON.parse(await readFile(report, 'utf8')).status, 'failed');
  if (fake) assert.deepEqual(fake.requests, [{ op: 'describe' }]);
});

test('doctor rejects invalid CLI options before connecting', async () => {
  for (const args of [[], ['--socket', '/not-used', '--timeout-ms', '0'], ['--socket', '/not-used', '--port', '1']]) {
    const result = await cli(['doctor', ...args]);assert.equal(result.code, 1);assert.equal(result.out, '');
  }
});

test('report CLI exports only a summary and refuses simulated result formats', async () => {
  const root = await testRoot('report-cli'), input = join(root, 'raw.json'), output = join(root, 'share.json');
  await writeFile(input, JSON.stringify({ mode: 'installed_release_real_engine', status: 'failed', package_version: '0.3.0', error: 'PRIVATE_TOKEN' }));
  const result = await cli(['report', '--input', input, '--output', output]);assert.equal(result.code, 0, result.err);
  const shared = await readFile(output, 'utf8');assert.ok(!shared.includes('PRIVATE_TOKEN'));assert.equal(JSON.parse(shared).status, 'failed');
  const duplicate = await cli(['report', '--input', input, '--output', output]);assert.equal(duplicate.code, 1);assert.equal(await readFile(output, 'utf8'), shared);
  await writeFile(input, JSON.stringify({ mode: 'simulator', status: 'passed' }));
  const rejected = await cli(['report', '--input', input, '--output', join(root, 'rejected.json')]);
  assert.equal(rejected.code, 1);assert.match(rejected.err, /real-engine result/);
});
