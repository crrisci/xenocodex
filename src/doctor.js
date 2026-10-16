import { stat } from 'node:fs/promises';
import { WireConnection } from './wire.js';
import { doctorSummary, writeReport } from './report.js';

export async function doctor({ socketPath, timeoutMs = 10000, reportPath, version }) {
  const result = { bridge_version: version, node_version: process.versions.node, platform: process.platform, arch: process.arch,
    status: 'failed', checks: [] };
  let wire;
  try {
    const supported = Number(process.versions.node.split('.')[0]) >= 22;
    result.checks.push({ name: 'runtime', status: supported ? 'passed' : 'failed' });
    if (!supported) throw Error('Node.js >=22 is required');
    if (!(await stat(socketPath)).isSocket()) throw Error('The supplied path is not a Unix socket');
    wire = await WireConnection.open(socketPath, timeoutMs);
    result.checks.push({ name: 'socket', status: 'passed' });
    result.info = await wire.describe(timeoutMs);
    result.checks.push({ name: 'protocol', status: 'passed' });
    result.status = 'passed';
    result.message = 'Xenolith wire v1 is reachable. No inference or session mutation was performed.';
  } catch (error) {
    const next = result.checks.some(c => c.name === 'socket') ? 'protocol' : 'socket';
    if (!result.checks.some(c => c.status === 'failed')) result.checks.push({ name: next, status: 'failed' });
    result.message = error.message; // Local display only; never exported to a shareable report.
  } finally { wire?.close(); }
  for (const name of ['runtime', 'socket', 'protocol']) if (!result.checks.some(c => c.name === name)) result.checks.push({ name, status: 'not_run' });
  if (reportPath) await writeReport(reportPath, doctorSummary(result));
  return result;
}
