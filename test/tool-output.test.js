import test from 'node:test';
import assert from 'node:assert/strict';
import { shellResult } from '../src/tool-output.js';

test('recognized shell envelope preserves literal header-like stdout and failed exit', () => {
  const stdout = 'Chunk ID: literal content\nOutput: literal line\nλ\n';
  const header = 'Chunk ID: abcd\nWall time: 0.25 seconds\nProcess exited with code 2\nOriginal token count: 17\n';
  const result = JSON.parse(shellResult('exec_command', header + 'Output:\n' + stdout));
  assert.equal(result.stdout, stdout);
  assert.equal(result.execution.exit_code, 2);
  assert.equal(result.execution.header, header);
});

test('running shell results retain the session ID and CRLF payload', () => {
  const text = 'Chunk ID: a\r\nWall time: 1 seconds\r\nProcess running with session ID 123\r\nOutput:\r\nhello\r\n';
  const result = JSON.parse(shellResult('write_stdin', text));
  assert.equal(result.execution.session_id, 123);
  assert.equal(result.stdout, 'hello\r\n');
});

test('unknown wrappers and non-shell tool outputs remain unchanged', () => {
  for (const text of ['stdout\nOutput:\ntext', 'Chunk ID: literal\nOutput:\nliteral', 'Chunk ID: a\nWall time: 1 seconds\nProcess exited with code 0\nWarning: unknown header\nOutput:\ntext']) {
    assert.equal(shellResult('exec_command', text), text);
  }
  const text = 'Chunk ID: a\nWall time: 1 seconds\nProcess exited with code 0\nOutput:\ntext';
  assert.equal(shellResult('read_file', text), text);
});
