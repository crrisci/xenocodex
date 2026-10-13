import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireStateLock } from '../src/state-lock.js';
import { testRoot } from './helpers/codex.js';

async function directory() {
  const root = await testRoot('state-lock');
  const path = join(root, 'state');await mkdir(path, { mode: 0o700 });return path;
}

const childScript = `
import { acquireStateLock } from './src/state-lock.js';
try {
  const lock = await acquireStateLock(process.argv[1]);
  console.log(JSON.stringify({ ok: true, owner: lock.owner }));
} catch (error) { console.log(JSON.stringify({ ok: false, message: error.message }));process.exitCode = 1; }
`;
function contender(t, path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');await exit; });
  let output = '', errors = '';
  child.stderr.on('data', b => { errors += b; });
  const ready = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', b => { output += b;if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); });
    child.on('exit', () => { if (!output.includes('\n')) reject(new Error('Lock child exited: ' + errors)); });
  });
  return { child, ready, exit };
}

test('concurrent process recovery has one owner; SIGSTOP retains ownership, SIGKILL releases it', { timeout: 15000 }, async t => {
  const path = await directory();
  const first = contender(t, path);assert.equal((await first.ready).ok, true);
  first.child.kill('SIGSTOP');
  const blocked = contender(t, path);assert.equal((await blocked.ready).ok, false);await blocked.exit;
  first.child.kill('SIGKILL');await first.exit;
  const attempts = Array.from({ length: 6 }, () => contender(t, path));
  const replies = await Promise.all(attempts.map(a => a.ready));
  assert.equal(replies.filter(r => r.ok).length, 1);
  const winner = attempts[replies.findIndex(r => r.ok)];
  const metadata = JSON.parse(await readFile(join(path, '.bridge.lock'), 'utf8'));
  assert.equal(metadata.pid, winner.child.pid);
  winner.child.kill('SIGKILL');await winner.exit;
  const final = contender(t, path);assert.equal((await final.ready).ok, true);
});

test('directory aliases share ownership and guard port collisions fail without rewriting state', async t => {
  const path = await directory();const alias = path + '-alias';await symlink(path, alias);
  const lock = await acquireStateLock(path);t.after(() => lock.close());
  await assert.rejects(acquireStateLock(alias), /locked/);
  await lock.close();
  const saved = await readFile(join(path, '.bridge.lock'), 'utf8');
  const occupied = createServer();occupied.listen(lock.owner.port, '127.0.0.1');await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  await assert.rejects(acquireStateLock(path), /guard port/);
  assert.equal(await readFile(join(path, '.bridge.lock'), 'utf8'), saved);
});

test('legacy, corrupt and foreign lock records are preserved for explicit migration', async () => {
  const path = await directory();
  const initial = await acquireStateLock(path);await initial.close();
  for (const content of ['', '{bad', JSON.stringify({ pid: 999999, token: 'old' }),
    JSON.stringify({ ...initial.owner, host: 'different-host' })]) {
    await writeFile(join(path, '.bridge.lock'), content);
    await assert.rejects(acquireStateLock(path), /lock/i);
    assert.equal(await readFile(join(path, '.bridge.lock'), 'utf8'), content);
  }
  await writeFile(join(path, '.bridge.lock'), JSON.stringify(initial.owner));
  const recovered = await acquireStateLock(path);await recovered.close();
});
