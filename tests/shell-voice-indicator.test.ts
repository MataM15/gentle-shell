import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderVoiceIndicator } from '../lib/shell-voice-indicator.ts';

const calls: string[] = [];
const theme = { fg: (role: string, text: string) => { calls.push(role); return text; }, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };

test('voice indicator highlights each active state and vanishes on idle', () => {
 for (const [state, role] of [['preparing', 'warning'], ['listening', 'success'], ['transcribing', 'accent']] as const) {
  calls.length = 0;
  const lines = renderVoiceIndicator(state, theme, 32);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`Voice · ${state}`));
  assert.match(lines[0]!, /\x1b\[1m/);
  assert.deepEqual(calls, [role]);
 }
 assert.deepEqual(renderVoiceIndicator(undefined, theme, 32), []);
 assert.deepEqual(renderVoiceIndicator('idle', theme, 32), []);
});

test('indicator fits narrow widths without adding rows', () => {
 for (let width = 0; width <= 32; width++) {
  const lines = renderVoiceIndicator('transcribing', theme, width);
  assert.ok(lines.length <= 1);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}`);
 }
});
