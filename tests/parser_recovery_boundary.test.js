// Parser recovery boundary - deterministic, no upstream call, no server.
//
// Classification derived from the live malformed_tool_call reproduction (3/13 rows on the
// deployed proxy, /admin/requests ids 3, 4, 11) and from the project's own DSML fixtures:
// the parser ALREADY recovers every structurally complete form. What it cannot recover is
// structurally INCOMPLETE markup - and reconstructing that would mean inventing argument
// values, which is forbidden. So the boundary is pinned here instead of "fixed" by guessing.
//
// GUARD tests: they must pass on the unmodified and the repaired server.js alike.
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../server.js').__test;
const TOOLS = new Set(['terminal', 'read_file']);
const LONG = 'L'.repeat(3000);

// Canonical DeepSeek DSML (same grammar the project's own unit tests use).
function dsmlCall(name, params) {
  const lines = ['｜DSML｜tool_calls>', '<｜DSML｜invoke name="' + name + '">'];
  for (const [k, v] of Object.entries(params)) {
    lines.push('<｜DSML｜parameter name="' + k + '" string="true">' + v + '</｜DSML｜parameter>');
  }
  lines.push('</｜DSML｜invoke>', '</｜DSML｜tool_calls>');
  return lines.join('\n');
}

test('G1 canonical DSML is already recovered as an OpenAI tool call', () => {
  const call = S.parseToolCall(dsmlCall('terminal', { command: 'echo hi' }));
  assert.ok(call, 'canonical DSML must parse');
  assert.equal(call.name, 'terminal');
  assert.equal(JSON.parse(call.arguments).command, 'echo hi');
});

test('G2 canonical DSML with a 3000-char argument keeps every character', () => {
  const call = S.parseToolCall(dsmlCall('terminal', { command: LONG }));
  assert.ok(call, 'canonical DSML must parse');
  assert.equal(String(JSON.parse(call.arguments).command).length, LONG.length);
});

test('G3 strict JSON, fenced JSON, multi-call and missing-arguments are all recovered', () => {
  const strict = JSON.stringify({ tool_call: { name: 'terminal', arguments: { command: 'a' } } });
  assert.equal(S.selectAgentToolCall(strict, TOOLS).name, 'terminal');

  const fenced = 'Here is the call:\n```json\n' + strict + '\n```';
  assert.equal(S.selectAgentToolCall(fenced, TOOLS).name, 'terminal');

  const two = strict + '\n' + JSON.stringify({ tool_call: { name: 'read_file', arguments: { path: 'x' } } });
  assert.equal(S.collectAgentToolCalls(two, TOOLS).length, 2);

  const noArgs = '{"tool_call":{"name":"terminal"}}';
  assert.equal(S.selectAgentToolCall(noArgs, TOOLS).name, 'terminal', 'a named call with no arguments is still a call');
});

test('G4 truncated markup: a missing closing delimiter is recovered, an unterminated string is not', () => {
  // The captured defect (candidate 9699): every string closed, only the trailing object
  // closers missing. This is the closing-delimiter-only case and IS recovered.
  const missingClosers = '{"tool_call":{"name":"terminal","arguments":{"command":"echo hi"';
  assert.equal(S.looksLikeToolCallMarkup(missingClosers), true, 'recognised as tool markup');
  assert.equal(S.selectAgentToolCall(missingClosers, TOOLS).name, 'terminal', 'a missing closing delimiter is recovered');

  // Genuinely incomplete: the argument string never terminates, so completing it would
  // mean inventing the rest of the value. Must fail closed.
  const truncatedJson = '{"tool_call":{"name":"terminal","arguments":{"command":"echo hi';
  assert.equal(S.looksLikeToolCallMarkup(truncatedJson), true, 'recognised as tool markup');
  assert.equal(S.selectAgentToolCall(truncatedJson, TOOLS), null, 'no call may be invented from truncated JSON');
  assert.equal(S.collectAgentToolCalls(truncatedJson, TOOLS).length, 0);

  // Unclosed DSML wrapper: the invoke/parameter structure never terminates.
  const unclosedDsml = '｜DSML｜tool_calls>\n<｜DSML｜invoke name="terminal">\n<｜DSML｜parameter name="command" string="true">echo hi';
  assert.equal(S.looksLikeToolCallMarkup(unclosedDsml), true);
  assert.equal(S.selectAgentToolCall(unclosedDsml, TOOLS), null, 'no call may be invented from an unclosed wrapper');
});

test('G5 a code-only reply is a code dump, not a tool call (no silent success)', () => {
  const codeOnly = '```python\n' + 'x = 1\n'.repeat(60) + '```';
  assert.equal(S.looksLikeToolCallMarkup(codeOnly), false);
  assert.equal(S.looksLikeCodeDumpInsteadOfTool(codeOnly), true);
  assert.equal(S.selectAgentToolCall(codeOnly, TOOLS), null);
});

test('G6 a DeepSeek-native-only call is classified as native, never as a runnable gateway tool', () => {
  const native = dsmlCall('web_search', { query: 'x' });
  const names = S.listDsmlToolCalls(native).map(c => c.name);
  assert.deepEqual(names, ['web_search']);
  assert.equal(names.every(n => S.isDeepSeekNativeTool(n)), true);
});

// Fullwidth <｜tool_call> wrappers. The opening tag is scanned and the next balanced
// JSON object is taken, so a literal "</tool_call>" inside an argument or an earlier
// unclosed tag does not cut the call short.
const FULLWIDTH_TOOLS = new Set(['bash', 'read']);

test('fullwidth <｜tool_call> wrapper with a bare call is parsed', () => {
  const text = 'Let me check the package descriptions.\n\n'
    + '<｜tool_call>\n{"name":"bash","arguments":{"command":"ls ~/.pi/agent/npm/node_modules | head -3"}}\n</tool_call>';
  const calls = S.collectAgentToolCalls(text, FULLWIDTH_TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls ~/.pi/agent/npm/node_modules | head -3' });
});

test('ASCII <tool_call> wrapper with a bare call is parsed', () => {
  const calls = S.collectAgentToolCalls('<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>', FULLWIDTH_TOOLS);
  assert.deepEqual(calls.map(c => c.name), ['read']);
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: 'a.txt' });
});

test('bare call for a tool the client did not offer is still dropped', () => {
  assert.deepEqual(S.collectAgentToolCalls('<｜tool_call>{"name":"rm","arguments":{}}</tool_call>', FULLWIDTH_TOOLS), []);
});

test('unterminated fullwidth wrapper is detected as markup so repair runs', () => {
  const cut = '<｜tool_call>\n{"name":"bash","arguments":{"command":"ls"';
  assert.deepEqual(S.collectAgentToolCalls(cut, FULLWIDTH_TOOLS), []);
  assert.equal(S.looksLikeToolCallMarkup(cut), true);
});

test('prose that only mentions tool_call is not markup', () => {
  assert.equal(S.looksLikeToolCallMarkup('The model printed a tool_call block instead of calling it.'), false);
  assert.deepEqual(S.collectAgentToolCalls('그냥 <tool_call> 이라는 단어 설명입니다.', FULLWIDTH_TOOLS), []);
});

test('JSON string argument containing </tool_call> is still parsed', () => {
  const text = '<｜tool_call>\n{"name":"bash","arguments":{"command":"printf \'</tool_call>\\\\n\'"}}\n</tool_call>';
  const calls = S.collectAgentToolCalls(text, FULLWIDTH_TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: "printf '</tool_call>\\n'" });
});

test('unclosed <｜tool_call> before a later complete <｜tool_call>{...}</tool_call> still yields the later call', () => {
  const text = [
    'First attempt was cut off:',
    '<｜tool_call>',
    'Retrying with the actual call:',
    '<｜tool_call>',
    '{"name":"bash","arguments":{"command":"ls"}}',
    '</tool_call>',
  ].join('\n');
  const calls = S.collectAgentToolCalls(text, FULLWIDTH_TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' });

  const withMalformedBrace = [
    '<｜tool_call>',
    '{not valid json}',
    '<｜tool_call>',
    '{"name":"read","arguments":{"path":"README.md"}}',
    '</tool_call>',
  ].join('\n');
  const calls2 = S.collectAgentToolCalls(withMalformedBrace, FULLWIDTH_TOOLS);
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].name, 'read');
  assert.deepEqual(JSON.parse(calls2[0].arguments), { path: 'README.md' });
});
