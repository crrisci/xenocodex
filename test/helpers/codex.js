import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { providerArgs } from '../../src/config.js';

export async function testRoot(prefix) {
  const parent = resolve('.test-artifacts');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, `${prefix}-`));
}

export async function runCodex(root, baseUrl, prompt, model = 'xenolith-bridge-sim') {
  const workspace = join(root, 'workspace');
  const home = join(root, 'codex-home');
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  const args = ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json',
    '-C', workspace, ...providerArgs(baseUrl, { model, context_window: 65536 }), prompt];
  const child = spawn(process.env.XENOLITH_BRIDGE_CODEX_BIN ?? 'codex', args, {
    cwd: workspace, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally { clearTimeout(timer); }
  await writeFile(join(root, 'codex.stdout.jsonl'), stdout);
  await writeFile(join(root, 'codex.stderr.log'), stderr);
  return { code, stdout, stderr, events: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
