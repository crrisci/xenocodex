#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAdapter } from './server.js';
import { providerArgs } from './config.js';
import { doctor } from './doctor.js';
import { exportAcceptance } from './report.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const help = `Xenolith Bridge ${version} — local Responses / Chat Completions / Xenolith v1 bridge

  xenolith-bridge doctor --socket PATH [--timeout-ms N] [--json] [--report NEW_FILE]
  xenolith-bridge report --input RELEASE_RESULT_JSON --output NEW_FILE
  xenolith-bridge serve --socket PATH [--port N] [--max-output-tokens N] [--reuse-kv] [--state-dir DIR]
  xenolith-bridge run --socket PATH --codex-home DIR [--reuse-kv] [--state-dir DIR] -- exec [Codex arguments]

Connects to an existing engine; does not spawn or stop Xenolith.
doctor only inspects the socket and describe capabilities; it does not run inference.
report exports a field-limited acceptance summary without prompts, paths or raw errors.
Reports are local files; nothing is uploaded. Existing report files are never overwritten.
run uses an explicit isolated CODEX_HOME and does not load user config/rules.
Responses supports text, function/custom tools and namespaces through JSON or SSE.
Chat Completions supports text and function tools through JSON or SSE.
--reuse-kv enables process-local durable KV reuse for matching prompt_cache_key histories.
Codex persisted resume and local text compaction are supported.
--state-dir enables persistent bindings; requires a stable prompt_cache_key or X-Xenolith-Session.
State must be local to one host/network namespace; v2 locks recover after process crashes.
It takes precedence over --reuse-kv.
Without --state-dir, KV is rebuilt after restart. Remote encrypted compaction is unsupported.
Reasoning and multimodal input are unsupported.
`;

async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  if (argv[0] === '--version') { console.log(`xenolith-bridge ${version}`); return; }
  const command = argv.shift();
  if (command === 'doctor' || command === 'report') {
    const opts = {};
    const allowed = command === 'doctor' ? ['--socket', '--timeout-ms', '--report'] : ['--input', '--output'];
    while (argv.length) {
      const flag = argv.shift();
      if (flag === '--json' && command === 'doctor' && !opts.json) { opts.json = true;continue; }
      if (!allowed.includes(flag) || !argv.length || opts[flag] !== undefined) throw Error(`Unknown, duplicate or incomplete option ${flag}`);
      opts[flag] = argv.shift();
    }
    if (command === 'report') {
      if (!opts['--input'] || !opts['--output']) throw Error('report requires --input and --output');
      await exportAcceptance(resolve(opts['--input']), resolve(opts['--output']));
      console.log('Acceptance summary written. No data was uploaded.');return;
    }
    if (!opts['--socket']) throw Error('doctor requires --socket');
    const timeoutMs = Number(opts['--timeout-ms'] ?? 10000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('--timeout-ms must be an integer from 1 to 60000');
    const result = await doctor({ socketPath: resolve(opts['--socket']), timeoutMs,
      reportPath: opts['--report'] && resolve(opts['--report']), version });
    console.log(opts.json ? JSON.stringify(result) : result.checks.map(c => `${c.name}: ${c.status}`).join('\n') + '\n' + result.message +
      (result.info ? `\nContext: ${result.info.context_window}; max output: ${result.info.max_output}; max frame: ${result.info.max_frame}; durable KV: ${result.info.kvstore}.` : ''));
    if (result.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (!['serve', 'run'].includes(command)) throw new Error('Expected doctor, report, serve or run');
  const options = {};
  let codexArgs = [];
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--reuse-kv') { options.reuseKv = true; continue; }
    if (flag === '--') { codexArgs = argv; break; }
    if (!['--socket', '--port', '--max-output-tokens', '--codex-home', '--codex-bin', '--state-dir'].includes(flag) || !argv.length) throw new Error(`Unknown or incomplete option ${flag}`);
    options[flag.slice(2)] = argv.shift();
  }
  if (!options.socket) throw new Error('--socket is required');
  const port = Number(options.port ?? 0);
  const maxOutputTokens = Number(options['max-output-tokens'] ?? 4096);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('Invalid max-output-tokens');
  if (command === 'run' && (!options['codex-home'] || codexArgs[0] !== 'exec')) throw new Error('run requires --codex-home DIR and -- exec [arguments]');
  const adapter = await startAdapter({ socketPath: resolve(options.socket), port, maxOutputTokens, reuseKv: options.reuseKv, stateDir: options['state-dir'] });
  let child;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    child?.kill('SIGTERM');
    await adapter.close();
  };
  const interrupt = () => { process.exitCode = 130; void stop(); };
  const terminate = () => { process.exitCode = 143; void stop(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  if (command === 'serve') {
    console.log(JSON.stringify({ base_url: adapter.baseUrl, model: adapter.info.model,
      context_window: adapter.info.context_window, max_output: adapter.info.max_output }));
    return;
  }
  try {
    const home = resolve(options['codex-home']);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const args = [codexArgs[0], '--ignore-user-config', '--ignore-rules',
      ...codexArgs.slice(1), ...providerArgs(adapter.baseUrl, adapter.info)];
    child = spawn(options['codex-bin'] ?? 'codex', ['--no-daemon', ...args], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: home } });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (!process.exitCode) process.exitCode = code ?? 1;
  } finally {
    await stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

main(process.argv.slice(2)).catch(error => { console.error(`xenolith-bridge: ${error.message}`); process.exitCode = 1; });
