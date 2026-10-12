import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { testRoot } from '../helpers/codex.js';
import { startFakeWire } from '../helpers/fake-wire.js';

test('launcher runs isolated Codex, discovers the engine and exits after completion', async t => {
  const root = await testRoot('launcher');
  const fake = await startFakeWire(root);
  t.after(() => fake.close());
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const child = spawn(process.execPath, [resolve('src/cli.js'), 'run', '--socket', fake.socketPath,
    '--codex-home', join(root, 'codex-home'), '--codex-bin', process.env.XENOLITH_BRIDGE_CODEX_BIN ?? 'codex', '--', 'exec', '--skip-git-repo-check', '--ephemeral',
    '--sandbox', 'workspace-write', '--json', '-C', workspace, 'Reply briefly.'], {
    cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(timer); }
  await writeFile(join(root, 'codex.stdout.jsonl'), stdout);
  await writeFile(join(root, 'codex.stderr.log'), stderr);
  assert.equal(code, 0, stderr + stdout);
  assert.ok(stdout.includes('Ciao 🌋'));
  assert.ok(stdout.includes('turn.completed'));
  assert.ok(fake.requests.some(r => r.op === 'ephemeral'));
  console.log(`Launcher artifacts: ${root}`);
});

test('launcher exec resume restores Codex history across separate adapter processes', async t => {
  const root = await testRoot('launcher-resume');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let generations = 0;
  const fake = await startFakeWire(root, { durable: true, generate: async ({request,send}) => {
    generations++;
    if (generations === 2) assert.ok(fake.requests.filter(r=>r.op==='rebuild').at(-1).messages.some(m => m.role === 'user' && m.text.includes('LANTERN_913')));
    await send({event:'text_delta',text:'LANTERN_913'});
    await send({event:'done',stop:'stop',usage:{input:20,cache_read:0,output:4,reasoning:0,total:24,replayed:0},marker:null});
  }});
  t.after(()=>fake.close());
  async function run(args,label) {
    const child=spawn(process.execPath,[resolve('src/cli.js'),'run','--socket',fake.socketPath,'--reuse-kv',
      '--codex-home',join(root,'codex-home'),'--codex-bin',process.env.XENOLITH_BRIDGE_CODEX_BIN ?? 'codex','--','exec',...args],{cwd:workspace,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',s=>{stdout+=s;});
    child.stderr.setEncoding('utf8').on('data',s=>{stderr+=s;});
    const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
    let code; try {code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});}finally{clearTimeout(timer);}
    await writeFile(join(root,label+'.jsonl'),stdout);await writeFile(join(root,label+'.stderr.log'),stderr);
    assert.equal(code,0,stderr+stdout);
    return stdout.trim().split('\n').map(JSON.parse);
  }
  const first=await run(['--skip-git-repo-check','--sandbox','workspace-write','--json','-C',workspace,'Remember LANTERN_913.'],'first');
  const id=first.find(e=>e.type==='thread.started')?.thread_id;
  assert.ok(id);
  const resumed=await run(['--sandbox','workspace-write','resume','--skip-git-repo-check','--json',id,'Repeat the remembered word.'],'resumed');
  assert.equal(resumed.filter(e=>e.type==='item.completed'&&e.item.type==='agent_message').at(-1).item.text,'LANTERN_913');
  assert.equal(generations,2);
});
