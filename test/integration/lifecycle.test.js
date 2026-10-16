import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startAdapter } from '../../src/server.js';
import { testRoot } from '../helpers/codex.js';
import { appServer } from '../helpers/app-server.js';
import { startFakeWire, done } from '../helpers/fake-wire.js';

test('installed Codex compacts tool history and resumes it after client and adapter restart', async t => {
  const root = await testRoot('lifecycle');
  await mkdir(join(root, 'workspace'));
  await writeFile(join(root, 'workspace/input.txt'), 'ORCHID_6729\n');
  const captured = [], diagnostics = [];
  let generation = 0;
  const fake = await startFakeWire(root, { durable: true, generate: async ({ request, send }) => {
    generation++;
    if (generation === 1) {
      await send({ event: 'toolcall_end', id: 72, name: 'exec_command', arguments: { cmd: 'cat input.txt' } });
      await send(done('tool_use'));
    } else if (captured.at(-1).body.tools?.length === 0) {
      const history = fake.requests.filter(r => r.op === 'rebuild').at(-1).messages;
      assert.ok(history.some(m => m.role === 'tool' && m.text.includes('ORCHID_6729')), 'Expected actual tool result in compact history: ' + JSON.stringify(history.filter(m => m.role === 'tool')));
      await send({ event: 'text_delta', text: 'The file input.txt contains ORCHID_6729. Read it with exec_command if needed.' });
      await send(done());
    } else {
      await send({ event: 'text_delta', text: 'ORCHID_6729' });
      await send(done());
    }
  } });
  let adapter, client;
  const start = () => startAdapter({ socketPath: fake.socketPath, reuseKv: true,
    onRequest: r => captured.push(r), onSessionEvent: e => diagnostics.push(e) });
  t.after(async () => { await client?.close('final'); await adapter?.close(); await fake.close(); });
  adapter = await start(); client = await appServer(root, adapter.baseUrl, adapter.info);
  const { thread } = await client.request('thread/start', { cwd: client.workspace,
    approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false });
  await client.turn(thread.id, 'Read input.txt and report its contents.');
  await client.compact(thread.id);
  const compact = captured.find(r => r.body.tools?.length === 0);
  assert.ok(compact, 'Manual compact must use the real Responses endpoint');
  assert.ok(compact.body.input.some(i => i.type === 'function_call'));
  assert.ok(compact.body.input.some(i => i.type === 'function_call_output'));
  await client.turn(thread.id, 'Repeat the remembered file contents.');
  const afterCompact = captured.at(-1).body;
  assert.ok(afterCompact.input.some(i => i.role === 'user' && JSON.stringify(i.content).includes('The file input.txt contains ORCHID_6729')));
  assert.equal(afterCompact.input.some(i => i.type === 'function_call'), false);
  await client.close('before-restart'); client = null;
  await adapter.close(); adapter = null;
  assert.equal(fake.sessions.size, 0, 'Only owned sessions are deleted on restart');
  adapter = await start(); client = await appServer(root, adapter.baseUrl, adapter.info);
  await client.request('thread/resume', { threadId: thread.id, cwd: client.workspace,
    approvalPolicy: 'never', sandbox: 'workspace-write' });
  const events = await client.turn(thread.id, 'Repeat the remembered file contents once more.');
  assert.ok(events.some(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage' && e.params.item.text === 'ORCHID_6729'));
  const finalRebuild = fake.requests.filter(r => r.op === 'rebuild').at(-1);
  assert.ok(finalRebuild.messages.some(m => m.text.includes('The file input.txt contains ORCHID_6729')));
  assert.equal(fake.errors.length, 0);
  assert.ok(diagnostics.some(e => e.kind === 'hit'));
  assert.equal(generation, 5);
  await writeFile(join(root, 'requests.json'), JSON.stringify(captured, null, 2));
  await writeFile(join(root, 'wire.json'), JSON.stringify(fake.requests, null, 2));
  console.log(`Lifecycle artifacts: ${root}`);
});

test('installed Codex automatically compacts when native usage crosses its configured threshold', async t => {
  const root = await testRoot('auto-compact');
  const captured=[];
  const fake=await startFakeWire(root,{generate:async({request,send})=>{
    const summary=request.tools.length===0;
    await send({event:'text_delta',text:summary?'Summary: retain SILVER_502.':'SILVER_502'});
    const terminal=done();
    if(captured.length===1) terminal.usage={input:55000,cache_read:0,output:4,reasoning:0,total:55004,replayed:0};
    await send(terminal);
  }});
  const adapter=await startAdapter({socketPath:fake.socketPath,onRequest:r=>captured.push(r)});
  let client;
  t.after(async()=>{await client?.close();await adapter.close();await fake.close();});
  client=await appServer(root,adapter.baseUrl,adapter.info);
  const {thread}=await client.request('thread/start',{cwd:client.workspace,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:false});
  await client.turn(thread.id,'Remember SILVER_502.');
  await client.turn(thread.id,'Repeat the word.');
  assert.ok(captured.some(r=>r.body.tools?.length===0),'Usage must trigger a real local compaction request');
  assert.ok(captured.at(-1).body.input.some(i=>i.role==='user'&&JSON.stringify(i.content).includes('Summary: retain SILVER_502.')));
  await writeFile(join(root,'requests.json'),JSON.stringify(captured,null,2));
});
