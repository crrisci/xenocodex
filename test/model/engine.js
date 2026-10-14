import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, readlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WireConnection } from '../../src/wire.js';

async function exclusivePreflight() {
  const mem = await readFile('/proc/meminfo', 'utf8');
  const gib = Number(/MemAvailable:\s+(\d+)/.exec(mem)[1]) / 1024 / 1024;
  assert.ok(gib >= 21, `Need 21 GiB available, have ${gib.toFixed(1)}`);
  for (const pid of await readdir('/proc')) if (/^\d+$/.test(pid)) {
    try { const exe = await readlink(`/proc/${pid}/exe`);assert.ok(!basename(exe).includes('xenolith'), `Another engine is active: ${pid}`); }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
}
export async function stop(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');child.kill(signal);
  if (!await Promise.race([exited.then(() => true), sleep(10000).then(() => false)])) {
    child.kill('SIGKILL');await Promise.race([exited, sleep(5000)]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned process did not exit');
}

export async function startRealEngine(prefix) {
  assert.equal(process.platform, 'linux', 'Run on Linux/WSL');
  const engineBin = process.env.XENOLITH_BIN, model = process.env.XENOLITH_MODEL;
  for (const p of [engineBin, model]) {
    assert.ok(p?.startsWith('/'), 'Explicit absolute engine/model paths required');await access(p);
  }
  await mkdir(resolve('.test-artifacts'), { recursive: true });
  const root = await mkdtemp(resolve(`.test-artifacts/${prefix}-`));
  const socket = join(root, 'w.sock'), label = 'initial';
  await Promise.all(['state', 'cache'].map(n => mkdir(join(root, n), { mode: 0o700 })));
  let engine;
  try {
    await exclusivePreflight();
    const log = createWriteStream(join(root, `engine-${label}.log`));
    engine = spawn(engineBin, ['serve', model, '--ctx', '65536', '--socket', socket,
      '--state', join(root, 'state'), '--cache', join(root, 'cache')], { stdio: ['ignore', 'pipe', 'pipe'] });
    engine.on('error', error => { engine.failure = error; });engine.stdout.pipe(log, { end: false });engine.stderr.pipe(log, { end: false });
    engine.once('close', () => log.end());
    console.log(`ENGINE_START ${engine.pid} ${label}`);
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      if (engine.failure) throw engine.failure;
      assert.equal(engine.exitCode, null, 'Owned engine exited during startup');
      let wire;
      try { wire = await WireConnection.open(socket, 1000);const info = await wire.describe();return { root, socket, info, engine, close: () => stop(engine) }; }
      catch (error) { if (error.code === 'incompatible_protocol') throw error; }
      finally { wire?.close(); }
      await sleep(500);
    }
    throw new Error('Engine startup timeout');
  } catch (error) { await stop(engine);throw error; }
}
