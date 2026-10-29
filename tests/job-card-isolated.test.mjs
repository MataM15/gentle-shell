import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { registerBackgroundJobTools } from '../lib/background-jobs-tools.ts';
import { setCardStyle } from '../lib/shell-card.ts';

function make(status, exitCode, expanded = false, float = false) {
  let renderer;
  const pi = { registerTool() {}, registerMessageRenderer(_name, r) { renderer = r; } };
  registerBackgroundJobTools(pi, { registry: {}, sessionId: () => 'test', now: () => 0 });
  setCardStyle(float ? 'float' : 'neon');
  const theme = { fg: (_role, text) => text, bold: (text) => text, ...(float ? { bg: (_role, text) => `\x1b[40m${text}\x1b[49m` } : {}) };
  const content = 'Background job test exited with code '+exitCode+'.\nCommand: echo hello\nLast output:\nhello';
  return renderer({content, details: {gentleJobs:{label:'build',status,exitCode}}}, {expanded}, theme);
}
for (const float of [false, true]) test(`collapsed hint survives at width 40 (${float ? 'float' : 'neon'})`, () => {
  const rows = make('exited', 0, false, float).render(40).map(stripVTControlCharacters);
  assert.match(rows.join('\n'), /expand/);
});

for (const exit of [0,1]) for (const float of [false, true]) {
  test(`job notice ${exit}, ${float ? 'float' : 'neon'}: aligned frame and preserved details`, () => {
    const card = make('exited', exit, true, float);
    const lines = card.render(80).map(stripVTControlCharacters);
    assert.equal(lines[0].search(/\S/), 2);
    assert.match(lines.join('\n'), new RegExp('exited with code '+exit));
    assert.match(lines.join('\n'), /Command: echo hello/);
    assert.match(lines.join('\n'), /hello/);
    assert.ok(lines.every((line) => line.length <= 80));
  });
}
