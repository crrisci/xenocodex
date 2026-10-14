import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startAdapter } from '../../src/server.js';
import { startFakeWire, done, description } from '../helpers/fake-wire.js';
import { testRoot } from '../helpers/codex.js';

const python = resolve(process.env.XENOLITH_BRIDGE_AIDER_PYTHON ?? '.test-artifacts/aider-runtime/bin/python');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function run(args, cwd, env, executable = python) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);child.once('close', resolve);
    });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test('Aider 0.86.2 edits a program, runs tests and returns failure feedback through Chat Completions', { timeout: 120000 }, async t => {
  const root = await testRoot('aider');const workspace = join(root, 'workspace');const clientHome = join(root, 'home');
  await mkdir(workspace);await mkdir(clientHome);
  const nonce = randomUUID();const requests = [];const sessionEvents = [];
  const source = operator => `def add(a, b):\n    return a ${operator} b\n`;
  await writeFile(join(workspace, 'sum_example.py'), source('-'));
  await writeFile(join(workspace, 'test_sum.py'), `import unittest\nfrom pathlib import Path\nfrom sum_example import add\n\nclass TestSum(unittest.TestCase):\n    def test_add(self):\n        with Path('test-runs.txt').open('a') as log:\n            log.write(str(add(3, 2)) + '\\n')\n        self.assertEqual(add(3, 2), 5, '${nonce}')\n`);
  await writeFile(join(root, 'config.yml'), '{}');await writeFile(join(root, 'empty.env'), '');
  await writeFile(join(root, 'gitconfig'), '');
  const model = `openai/${description.model}`;
  await writeFile(join(root, 'model-settings.yml'), JSON.stringify([{ name: model, edit_format: 'whole',
    use_repo_map: false, reminder: 'user', extra_params: { max_tokens: 1024,
      extra_headers: { 'X-Xenolith-Session': 'aider-isolated-test' } } }]));
  await writeFile(join(root, 'model-metadata.json'), JSON.stringify({ [model]: {
    max_tokens: 8192, max_input_tokens: 65536, max_output_tokens: 8192,
    input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'openai', mode: 'chat',
  } }));
  let turn = 0;
  const fake = await startFakeWire(root, { durable: true, persistent: true, generate: async ({ send }) => {
    turn++;
    assert.ok(turn <= 2, 'Harness should finish after receiving the corrected edit');
    if (turn === 2) assert.ok(JSON.stringify(requests.at(-1).body).includes(nonce), 'Real failing test output must reach the bridge');
    // Deliberately make the first suggested edit wrong to exercise client testing
    // and feedback. These scripted replies do not test model coding ability.
    await send({ event: 'text_delta', text: 'sum_example.py\n```python\n' + source(turn === 1 ? '*' : '+') + '```\n' });
    await send(done());
  } });
  let adapter;t.after(async () => { try { await adapter?.close(); } finally { await fake.close(); } });
  adapter = await startAdapter({ socketPath: fake.socketPath, stateDir: join(root, 'state'),
    onRequest: r => requests.push(structuredClone(r)), onSessionEvent: e => sessionEvents.push(e) });
  // Isolated client configuration and cache; no inherited provider credentials.
  const env = { PATH: process.env.PATH, HOME: clientHome, LANG: 'en_US.UTF-8',
    XDG_CACHE_HOME: join(root, 'cache'), OPENAI_API_KEY: 'local-test', OPENAI_API_BASE: adapter.baseUrl,
    TIKTOKEN_CACHE_DIR: join(root, 'cache', 'tiktoken'), GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    LITELLM_LOCAL_MODEL_COST_MAP: 'True', PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1' };
  // Bound Aider's parent-directory discovery to the fixture, even with --no-git.
  assert.equal((await run(['init', '--quiet'], workspace, env, 'git')).code, 0);
  const baseline = await run(['-m', 'unittest', '-v'], workspace, env);assert.equal(baseline.code, 1);
  const result = await run(['-m', 'aider', '--model', model, '--edit-format', 'whole', '--map-tokens', '0',
    '--model-settings-file', join(root, 'model-settings.yml'), '--model-metadata-file', join(root, 'model-metadata.json'),
    '--config', join(root, 'config.yml'), '--env-file', join(root, 'empty.env'),
    '--chat-history-file', join(root, 'chat-history.md'), '--input-history-file', join(root, 'input-history'),
    '--no-git', '--no-auto-commits', '--no-analytics', '--no-check-update', '--no-show-release-notes',
    '--no-pretty', '--no-fancy-input', '--no-auto-lint', '--no-suggest-shell-commands', '--yes-always',
    '--auto-test', '--test-cmd', `${quote(python)} -m unittest -v`,
    '--message', 'Fix add so it adds its arguments. Run the configured tests and fix any failures.', 'sum_example.py'], workspace, env);
  await writeFile(join(root, 'aider.stdout.log'), result.stdout);await writeFile(join(root, 'aider.stderr.log'), result.stderr);
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(root, 'wire.json'), JSON.stringify(fake.requests, null, 2));
  console.log('Aider artifacts:', root);
  assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
  assert.equal(turn, 2, result.stdout);
  assert.equal(await readFile(join(workspace, 'sum_example.py'), 'utf8'), source('+'));
  assert.deepEqual((await readFile(join(workspace, 'test-runs.txt'), 'utf8')).trim().split('\n'), ['1', '6', '5']);
  assert.ok(requests.every(r => r.path === '/v1/chat/completions' && r.body.model === description.model));
  assert.ok(requests[0].body.messages.some(m => typeof m.content === 'string' && m.content.includes(source('-').trim())));
  assert.equal(fake.requests.filter(r => r.op === 'create').length, 1);
  // Aider updates file context between turns, so history no longer has the same
  // prefix. Keeping the native session does not establish KV cache savings.
  assert.equal(fake.requests.filter(r => r.op === 'rebuild').length, 2);
  assert.ok(!fake.requests.some(r => r.op === 'ephemeral'));
  assert.equal(sessionEvents.filter(e => e.kind === 'persistent_commit').length, 2);
  assert.deepEqual(fake.errors, []);
});
