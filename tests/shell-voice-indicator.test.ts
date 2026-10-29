import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderVoiceIndicator } from '../lib/shell-voice-indicator.ts';

const calls: string[] = [];
const theme = { fg: (role: string, text: string) => { calls.push(role); return text; }, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

test('voice badge names each active state in Spanish, colors the dot and vanishes on idle', () => {
 for (const [state, label, role] of [['preparing', 'Preparando', 'warning'], ['listening', 'Escuchando', 'error'], ['transcribing', 'Transcribiendo', 'warning']] as const) {
  calls.length = 0;
  const lines = renderVoiceIndicator(state, theme, 40);
  assert.equal(lines.length, 1);
  assert.match(strip(lines[0]!), new RegExp(`● ${label} $`));
  assert.match(lines[0]!, /\x1b\[7m/, 'badge text is an inverted (light) block');
  assert.match(lines[0]!, /\x1b\[1m/, 'badge text is bold');
  assert.equal(calls[0], role, 'dot role');
 }
 assert.deepEqual(renderVoiceIndicator(undefined, theme, 40), []);
 assert.deepEqual(renderVoiceIndicator('idle', theme, 40), []);
});

test('voice badge is right-aligned and fits narrow widths without adding rows', () => {
 const wide = renderVoiceIndicator('listening', theme, 40);
 assert.equal(visibleWidth(wide[0]!), 40);
 assert.match(strip(wide[0]!), /^\s+● Escuchando $/);
 for (let width = 0; width <= 32; width++) {
  const lines = renderVoiceIndicator('transcribing', theme, width);
  assert.ok(lines.length <= 1);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}`);
 }
});
