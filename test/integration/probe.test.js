import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testRoot, runCodex } from '../helpers/codex.js';

test('capture the installed Codex HTTP request without remote inference', async () => {
  const root = await testRoot('probe');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url,
      headers: { 'content-type': req.headers['content-type'], 'user-agent': req.headers['user-agent'],
        'content-encoding': req.headers['content-encoding'] }, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    emit({ type: 'response.created', response: { id: 'resp_probe' } });
    emit({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: 'msg_probe', role: 'assistant', content: [] } });
    emit({ type: 'response.output_text.delta', item_id: 'msg_probe', output_index: 0,
      content_index: 0, delta: 'XENOLITH_BRIDGE_PROBE_OK' });
    emit({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: 'msg_probe', role: 'assistant',
        content: [{ type: 'output_text', text: 'XENOLITH_BRIDGE_PROBE_OK', annotations: [] }] } });
    emit({ type: 'response.completed', response: { id: 'resp_probe', usage: {
      input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const result = await runCodex(root, `http://127.0.0.1:${server.address().port}/v1`, 'Reply briefly.');
    await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.ok(result.stdout.includes('XENOLITH_BRIDGE_PROBE_OK'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].path, '/v1/responses');
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.store, false);
    assert.ok(Array.isArray(requests[0].body.input));
    console.log(`Probe artifacts: ${root}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
