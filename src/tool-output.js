// Only the known Codex shell runner envelope is projected. Arbitrary output,
// non-shell tools, literal stdout headers and unknown envelopes are untouched.
export function shellResult(toolName, text) {
  if (!['exec_command', 'write_stdin'].includes(toolName)) return text;
  const match = /^(Chunk ID: [^\r\n]+\r?\nWall time: [^\r\n]+\r?\n(?:Process exited with code -?\d+|Process running with session ID \d+)\r?\n(?:Original token count: \d+\r?\n)?)Output:\r?\n([\s\S]*)$/.exec(text);
  if (!match) return text;
  const header = match[1];
  const exit = /Process exited with code (-?\d+)/.exec(header);
  const session = /Process running with session ID (\d+)/.exec(header);
  return JSON.stringify({ stdout: match[2], execution: { header,
    ...(exit ? { exit_code: Number(exit[1]) } : { session_id: Number(session[1]) }) } });
}
