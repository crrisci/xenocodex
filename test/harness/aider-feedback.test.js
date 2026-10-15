import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startAdapter } from '../../src/server.js';
import { startFakeWire, done, description } from '../helpers/fake-wire.js';
import { WireConnection } from '../../src/wire.js';
import { testRoot } from '../helpers/codex.js';

const socket = process.env.XENOLITH_BRIDGE_AIDER_REAL_SOCKET;
const python = resolve(process.env.XENOLITH_BRIDGE_AIDER_PYTHON ?? '.test-artifacts/aider-runtime/bin/python');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const initial = {
  'money.py': 'def cents(value):\n    return int(float(value) * 100)\n',
  'invoice.py': 'from money import cents\n\ndef invoice_total(lines, tax_rate):\n    return sum(cents(price) for price, quantity in lines)\n',
};
const fixedMoney = 'from decimal import Decimal, ROUND_HALF_UP\n\ndef cents(value):\n    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))\n';
const fixedInvoice = 'from decimal import Decimal, ROUND_HALF_UP\nfrom money import cents\n\ndef invoice_total(lines, tax_rate):\n    subtotal = sum(cents(price) * quantity for price, quantity in lines)\n    tax = int((Decimal(subtotal) * Decimal(str(tax_rate))).quantize(Decimal("1"), rounding=ROUND_HALF_UP))\n    return subtotal + tax\n';

async function run(args, cwd, env, executable = python) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), socket ? 900000 : 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);child.once('close', resolve);
    });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test('Aider multi-file invoice: an actual failed edit reaches inference and is corrected',
  { timeout: socket ? 960000 : 120000 }, async t => {
    const root = await testRoot('aider-feedback');
    console.log('Aider feedback artifacts:', root);
    const workspace = join(root, 'workspace'), home = join(root, 'home');
    await mkdir(workspace);await mkdir(home);
    const nonce = randomUUID(), requests = [], sessionEvents = [], wireEvents = [];
    const summary = { status: 'failed', mode: socket ? 'real' : 'simulated',
      requestMetrics: [],
      scenario: 'invoice-rounding', contract: 'Round monetary amounts and tax half up to integer cents; apply quantities before tax.' };
    t.after(async () => {
      await writeFile(join(root, 'result.json'), JSON.stringify({ ...summary, sessionEvents, wireEvents }, null, 2));
      await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
    });
    for (const [name, source] of Object.entries(initial)) await writeFile(join(workspace, name), source);
    // Tests are deliberately outside Aider's editable context. Rounding policy is
    // clarified by genuine failing assertions, not by injected/fabricated failures.
    const suite = `import unittest\nfrom money import cents\nfrom invoice import invoice_total\n\nclass InvoiceTests(unittest.TestCase):\n    def test_decimal_half_up(self):\n        for value, expected in [('1.005', 101), ('2.675', 268), ('-1.005', -101), ('0.29', 29)]:\n            with self.subTest(value=value):\n                self.assertEqual(cents(value), expected, '${nonce}: monetary rounding must use decimal half up')\n    def test_quantities_and_tax(self):\n        self.assertEqual(invoice_total([('12.50', 2), ('3.99', 3)], '0.20'), 4436, '${nonce}: apply quantities and round tax half up')\n    def test_tax_half_cent(self):\n        self.assertEqual(invoice_total([('0.05', 1)], '0.10'), 6, '${nonce}: tax rounding must use decimal half up')\n    def test_empty(self):\n        self.assertEqual(invoice_total([], '0.20'), 0)\n`;
    await writeFile(join(root, 'test_invoice.py'), suite);
    const runner = `import hashlib, json, pathlib, subprocess, sys, time\nroot = pathlib.Path(__file__).parent\nfiles = ['money.py', 'invoice.py']\nbefore = {name: pathlib.Path(name).read_text() for name in files}\ntests = root / 'test_invoice.py'\ncheck = hashlib.sha256(tests.read_bytes()).hexdigest()\np = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(root), '-p', 'test_invoice.py', '-v'], capture_output=True, text=True)\nrecord = {'at': time.time(), 'code': p.returncode, 'sources': before, 'sources_after': {name: pathlib.Path(name).read_text() for name in files}, 'tests_sha256': check, 'tests_sha256_after': hashlib.sha256(tests.read_bytes()).hexdigest(), 'stdout': p.stdout, 'stderr': p.stderr}\nwith (root / 'test-runs.jsonl').open('a') as log:\n    log.write(json.dumps(record) + '\\n')\nprint(p.stdout, end='')\nprint(p.stderr, end='', file=sys.stderr)\nsys.exit(p.returncode)\n`;
    await writeFile(join(root, 'run-tests.py'), runner);
    for (const name of ['config.yml', 'empty.env', 'gitconfig']) await writeFile(join(root, name), name === 'config.yml' ? '{}' : '');
    let info = description;
    if (socket) {
      const wire = await WireConnection.open(socket);
      try { info = await wire.describe(); } finally { wire.close(); }
    }
    summary.engine = info;
    const model = `openai/${info.model}`;
    await writeFile(join(root, 'model-settings.yml'), JSON.stringify([{ name: model, edit_format: 'whole',
      use_repo_map: false, reminder: 'user', extra_params: { max_tokens: 3072,
        extra_headers: { 'X-Xenolith-Session': `feedback-${nonce}` } } }]));
    await writeFile(join(root, 'model-metadata.json'), JSON.stringify({ [model]: {
      max_tokens: 8192, max_input_tokens: info.context_window, max_output_tokens: 4096,
      input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'openai', mode: 'chat',
    } }));
    let turn = 0;
    const fake = socket ? null : await startFakeWire(root, { durable: true, persistent: true, generate: async ({ send }) => {
      turn++;assert.ok(turn <= 2);
      if (turn === 2) assert.ok(JSON.stringify(requests.at(-1).body).includes(nonce));
      const money = turn === 1 ? 'def cents(value):\n    return round(float(value) * 100)\n' : fixedMoney;
      await send({ event: 'text_delta', text: `money.py\n\`\`\`python\n${money}\`\`\`\ninvoice.py\n\`\`\`python\n${fixedInvoice}\`\`\`\n` });
      await send(done());
    } });
    let adapter;
    let current;
    t.after(async () => { try { await adapter?.close(); } finally { await fake?.close(); } });
    adapter = await startAdapter({ socketPath: socket ?? fake.socketPath, stateDir: join(root, 'state'),
      onRequest: r => {
        requests.push({ ...structuredClone(r), at: Date.now() / 1000 });
        current = { index: requests.length, started_at: Date.now(), first_wire_text_ms: null,
          wire_done_ms: null, session_events: [] };
        summary.requestMetrics.push(current);
      },
      onWireEvent: e => {
        wireEvents.push(structuredClone(e));
        if (e.event === 'text_delta' && current.first_wire_text_ms === null) current.first_wire_text_ms = Date.now() - current.started_at;
        if (e.event === 'done') Object.assign(current, { wire_done_ms: Date.now() - current.started_at,
          usage: e.usage, inference: e.inference, resume: e.resume ?? null });
      },
      onSessionEvent: e => { sessionEvents.push(structuredClone(e));current?.session_events.push(structuredClone(e)); } });
    const env = { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8',
      XDG_CACHE_HOME: join(root, 'cache'), OPENAI_API_KEY: 'local-test', OPENAI_API_BASE: adapter.baseUrl,
      TIKTOKEN_CACHE_DIR: join(root, 'cache', 'tiktoken'), GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      LITELLM_LOCAL_MODEL_COST_MAP: 'True', PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1' };
    assert.equal((await run(['init', '--quiet'], workspace, env, 'git')).code, 0);
    assert.equal((await run([join(root, 'run-tests.py')], workspace, env)).code, 1);
    const result = await run(['-m', 'aider', '--model', model, '--edit-format', 'whole', '--map-tokens', '0',
      '--model-settings-file', join(root, 'model-settings.yml'), '--model-metadata-file', join(root, 'model-metadata.json'),
      '--config', join(root, 'config.yml'), '--env-file', join(root, 'empty.env'),
      '--chat-history-file', join(root, 'chat-history.md'), '--input-history-file', join(root, 'input-history'),
      '--no-git', '--no-auto-commits', '--no-analytics', '--no-check-update', '--no-show-release-notes',
      '--no-pretty', '--no-fancy-input', '--no-auto-lint', '--no-suggest-shell-commands', '--yes-always',
      '--auto-test', '--test-cmd', `${quote(python)} ${quote(join(root, 'run-tests.py'))}`,
      '--message', 'Implement cents(value) to convert a monetary value to integer cents, rounding to the nearest cent. Implement invoice_total(lines, tax_rate) to sum unit prices times quantities, then add tax rounded to the nearest cent. Return integer cents. Fix both modules, run the configured tests and correct any failures. Keep the test suite and test runner unchanged.',
      'money.py', 'invoice.py'], workspace, env);
    await writeFile(join(root, 'aider.stdout.log'), result.stdout);
    await writeFile(join(root, 'aider.stderr.log'), result.stderr);
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
    const runs = (await readFile(join(root, 'test-runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    summary.testRuns = runs;
    assert.equal(await readFile(join(root, 'test_invoice.py'), 'utf8'), suite, 'Tests must remain unchanged');
    assert.equal(await readFile(join(root, 'run-tests.py'), 'utf8'), runner, 'Runner must remain unchanged');
    for (const record of runs) {
      assert.equal(record.tests_sha256, runs[0].tests_sha256);
      assert.equal(record.tests_sha256_after, runs[0].tests_sha256);
      assert.deepEqual(record.sources_after, record.sources, 'Tests must not modify program sources');
    }
    const verification = await run([join(root, 'run-tests.py')], workspace, env);
    await writeFile(join(root, 'verification.log'), verification.stdout + verification.stderr);
    summary.independentVerification = verification;
    assert.equal(verification.code, 0, verification.stdout + verification.stderr);
    assert.equal(await readFile(join(root, 'test_invoice.py'), 'utf8'), suite);
    assert.equal(await readFile(join(root, 'run-tests.py'), 'utf8'), runner);
    const failed = runs.slice(1).find(r => r.code !== 0 && Object.keys(initial).some(n => r.sources[n] !== initial[n]));
    assert.ok(failed, 'No real failed model edit observed; first-try success does not complete feedback acceptance');
    assert.ok(requests.some(r => r.at > failed.at && JSON.stringify(r.body).includes(nonce)), 'Actual failing test feedback must reach subsequent inference');
    assert.ok(runs.some(r => r.at > failed.at && r.code === 0), 'Aider must run passing tests after the failure');
    for (const name of Object.keys(initial)) assert.notEqual(await readFile(join(workspace, name), 'utf8'), initial[name]);
    assert.ok(requests.every(r => r.path === '/v1/chat/completions' && r.body.model === info.model));
    assert.ok(!JSON.stringify(requests[0].body).includes(nonce), 'Failure marker must not be seeded in the initial prompt');
    assert.ok(sessionEvents.some(e => e.kind === 'persistent_commit'));
    if (fake) { assert.equal(turn, 2);assert.deepEqual(fake.errors, []); }
    summary.status = 'passed';
  });
