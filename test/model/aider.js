import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startRealEngine, stop } from './engine.js';

// Opt-in real inference; the launcher owns only this isolated engine/client.
const python = process.env.XENOLITH_BRIDGE_AIDER_PYTHON;
assert.ok(python?.startsWith('/'), 'Explicit absolute Aider Python path required');
await access(python);
let engine, client;
try {
  engine = await startRealEngine('aider-engine');
  console.log('AIDER_ENGINE_ROOT ' + engine.root);
  client = spawn(process.execPath, ['--test', 'test/harness/aider.test.js'], {
    env: { ...process.env, XENOLITH_BRIDGE_AIDER_REAL_SOCKET: engine.socket }, stdio: 'inherit',
  });
  const [code] = await once(client, 'exit');
  process.exitCode = code ?? 1;
} finally {
  await stop(client);await engine?.close();
}
