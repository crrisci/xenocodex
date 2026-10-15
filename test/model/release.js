import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { startRealEngine, stop } from './engine.js';
import { runAcceptance } from './api-acceptance.js';

// Deliberately refuses the source checkout: validate an independently installed
// release artifact, while keeping all state/logs private to this invocation.
const install = process.env.XENOLITH_BRIDGE_INSTALL_ROOT;
assert.ok(install && isAbsolute(install), 'Set XENOLITH_BRIDGE_INSTALL_ROOT to an absolute npm install prefix');
const packageRoot = join(install, 'node_modules/xenolith-bridge');
assert.notEqual(await realpath(packageRoot), await realpath('.'), 'Install a release archive; do not link the checkout');
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'xenolith-bridge');
const report = { mode: 'installed_release_real_engine', package_version: pkg.version, package_root: packageRoot,
  engine_binary: process.env.XENOLITH_BIN, model_path: process.env.XENOLITH_MODEL, started_at: new Date().toISOString() };
async function sha256(path) {
  const hash = createHash('sha256');for await (const chunk of createReadStream(path)) hash.update(chunk);return hash.digest('hex');
}
let engine, bridge, address, index = 0;
async function startBridge() {
  const log = createWriteStream(join(engine.root, `bridge-${index++}.log`));
  bridge = spawn(process.execPath, [join(packageRoot, 'src/cli.js'), 'serve', '--socket', engine.socket,
    '--state-dir', join(engine.root, 'bindings')], { cwd: install, stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.stderr.pipe(log);let stdout = '';
  address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Installed bridge startup timed out')), 15000);
    bridge.once('error', e => { clearTimeout(timer);reject(e); });
    bridge.once('exit', code => { clearTimeout(timer);reject(Error(`Installed bridge exited: ${code}`)); });
    bridge.stdout.on('data', b => {
      stdout += b;
      if (stdout.includes('\n')) {
        clearTimeout(timer);
        try { const info = JSON.parse(stdout.split('\n')[0]);resolve({ baseUrl: info.base_url, model: info.model }); }
        catch (e) { reject(e); }
      }
    });
  });
}
async function cleanup() { await stop(bridge);await engine?.close(); }
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  process.exitCode = code;void cleanup();
});
try {
  report.engine_sha256 = await sha256(process.env.XENOLITH_BIN);
  report.installed_cli_sha256 = await sha256(join(packageRoot, 'src/cli.js'));
  if (process.env.XENOLITH_BRIDGE_PACKAGE_ARCHIVE) report.archive_sha256 = await sha256(process.env.XENOLITH_BRIDGE_PACKAGE_ARCHIVE);
  engine = await startRealEngine('rc-api');report.describe = engine.info;
  console.log(`RELEASE_TEST_ROOT ${engine.root}`);
  await startBridge();
  report.cases = await runAcceptance({ root: engine.root, connect: async () => address,
    beforeCancel: async () => {
      const bindings = join(engine.root, 'bindings');
      const records = await Promise.all((await readdir(bindings)).filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(bindings, n), 'utf8'))));
      assert.equal(records.filter(r => r.inFlight).length, 1, 'Cancel must interrupt an uncommitted live generation');
    },
    restart: async label => { console.log(`RESTART ${label}`);await stop(bridge);await engine.restart();await startBridge(); } });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';report.error = error.stack;process.exitCode = 1;console.error(error);
} finally {
  await cleanup();report.finished_at = new Date().toISOString();
  if (engine) await writeFile(join(engine.root, 'release-result.json'), JSON.stringify(report, null, 2));
  console.log(`RELEASE_TEST_FINISHED ${report.status}`);
}
