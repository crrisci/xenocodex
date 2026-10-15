import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startFakeWire, done } from '../helpers/fake-wire.js';
import { testRoot } from '../helpers/codex.js';

async function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject);child.once('close', resolve); });
    assert.equal(code, 0, stderr + stdout);return stdout;
  } finally { clearTimeout(timer); }
}

test('packed CLI installs offline, resolves through npm exec and serves both JSON APIs', { timeout: 90000 }, async t => {
  const source = resolve('.'), root = await testRoot('package'), install = join(root, 'install'), home = join(root, 'home');
  await mkdir(install);await mkdir(home);await writeFile(join(root, 'npmrc'), '');
  const env = { ...process.env, HOME: home, npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(await run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', root], source, env))[0];
  assert.ok(!packed.files.some(f => /^(docs|native|\.test-artifacts|node_modules)\//.test(f.path)));
  const archive = join(root, packed.filename);
  await run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', install, archive], root, env);
  const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version;
  const prefix = ['exec', '--offline', '--prefix', install, '--', 'xenolith-bridge'];
  assert.equal((await run(npm, [...prefix, '--version'], install, env)).trim(), `xenolith-bridge ${version}`);
  const fake = await startFakeWire(root, { generate: async ({ send }) => {
    await send({ event: 'text_delta', text: 'installed package' });await send(done());
  } });
  let child;
  t.after(async () => {
    if (child?.exitCode === null) { const exited = once(child, 'exit');child.kill('SIGTERM');await exited; }
    await fake.close();
  });
  child = spawn(join(install, 'node_modules', '.bin', 'xenolith-bridge'), ['serve', '--socket', fake.socketPath],
    { cwd: install, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(Error('Installed CLI startup timed out: ' + stderr)); }, 15000);
    child.once('error', e => { clearTimeout(timer);reject(e); });
    child.once('exit', code => { clearTimeout(timer);reject(Error(`CLI exited ${code}: ${stderr}`)); });
    child.stdout.on('data', b => { out += b;if (out.includes('\n')) { clearTimeout(timer);resolve(JSON.parse(out.split('\n')[0])); } });
  });
  for (const [endpoint, input] of [['responses', { input: 'hello' }], ['chat/completions', { messages: [{ role: 'user', content: 'hello' }] }]]) {
    const response = await fetch(info.base_url + '/' + endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: info.model, ...input }) });
    assert.equal(response.status, 200);const body = await response.json();
    assert.equal(endpoint === 'responses' ? body.output[0].content[0].text : body.choices[0].message.content, 'installed package');
  }
  console.log('Installed package:', archive);
});
