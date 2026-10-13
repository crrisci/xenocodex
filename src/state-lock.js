import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { open, link, rename, unlink, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterError } from './errors.js';

const failure = message => new AdapterError('session_state_error', message, 503);

// Advisory ownership for a LOCAL directory, within ONE host/network namespace.
// The inode makes aliases (including symlinks) share the same kernel guard.
// Port collisions fail closed. Never probe-and-unlink or steal by PID/TTL.
export async function acquireStateLock(directory) {
  if (!['darwin', 'linux'].includes(process.platform)) throw failure('Persistent state locking supports local macOS and Linux directories only');
  const metadata = await stat(directory, { bigint: true });
  const key = createHash('sha256').update(`xenolith-bridge-state-v2:${metadata.dev}:${metadata.ino}`).digest('hex');
  const port = 49152 + (Number.parseInt(key.slice(0, 8), 16) % 16384);
  const guard = createServer(socket => { socket.on('error', () => {});socket.destroy(); });
  try {
    guard.listen({ host: '127.0.0.1', port, exclusive: true, reusePort: false });
    await once(guard, 'listening');
  } catch (error) {
    guard.close();
    throw failure(`Session state is locked or its local guard port ${port} is unavailable (${error.code ?? 'listen error'}). No state was changed`);
  }
  let closing;
  const close = () => closing ??= new Promise(resolve => guard.close(resolve));
  const path = join(directory, '.bridge.lock');
  const temporary = join(directory, `.bridge-lock-${randomUUID()}.tmp`);
  let file;
  try {
    let previous;
    try {
      if ((await stat(path)).size > 4096) throw failure('Invalid session lock metadata');
      previous = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure('Cannot recover session lock metadata: ' + error.message);
    }
    if (previous !== undefined && (!previous || previous.version !== 2 ||
        previous.kind !== 'local-tcp-guard' || previous.host !== hostname() ||
        previous.key !== key || previous.port !== port ||
        !Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
        typeof previous.token !== 'string' || !/^[a-f0-9-]{36}$/.test(previous.token))) {
      throw failure('Legacy, foreign or incompatible session lock. Stop all owners and manually remove .bridge.lock before migration');
    }
    const owner = { version: 2, kind: 'local-tcp-guard', host: hostname(), key, port,
      pid: process.pid, token: randomUUID() };
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(owner));await file.sync();await file.close();file = undefined;
    if (previous === undefined) {
      // Atomic no-clobber publication also excludes a concurrent legacy writer.
      await link(temporary, path);
    } else {
      // All v2 writers hold this same kernel guard before replacing metadata.
      await rename(temporary, path);
    }
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
    // Keep the v2 marker on orderly exit too: legacy versions must not bypass
    // this guard. The file is diagnostic metadata, never proof of live ownership.
    return { owner, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    // Private staging files are harmless after a crash or failed cleanup.
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
