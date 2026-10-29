import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { reduceVoiceOverlay, renderVoiceOverlay, visibleVoiceOverlay, type VoiceOverlay } from '../lib/shell-voice-overlay.ts';

const roles: string[] = [];
const theme = { fg: (role: string, text: string) => { roles.push(role); return text; }, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

test('overlay reducer announces listening start, transcribing and microphone close', () => {
 const listening = reduceVoiceOverlay(undefined, { state: 'listening', at: 1000 });
 assert.deepEqual(listening, { text: 'Escuchando…', sub: 'micrófono abierto', at: 1000 });
 const fromPreparing = reduceVoiceOverlay(reduceVoiceOverlay(undefined, { state: 'preparing', at: 500 }), { state: 'listening', at: 1000 });
 assert.deepEqual(fromPreparing, listening);
 const transcribing = reduceVoiceOverlay(listening, { state: 'transcribing', at: 2000 });
 assert.deepEqual(transcribing, { text: 'Transcribiendo…', sub: '', at: 2000 });
 const closed = reduceVoiceOverlay(listening, { state: 'idle', at: 3000 });
 assert.deepEqual(closed, { text: 'Micrófono cerrado', sub: '', at: 3000 });
 // Other transitions keep the previous record: no flicker on repeated events.
 assert.equal(reduceVoiceOverlay(listening, { state: 'listening', at: 4000 }), listening);
 assert.equal(reduceVoiceOverlay(transcribing, { state: 'idle', at: 5000 }), transcribing);
 assert.equal(reduceVoiceOverlay(undefined, { state: 'idle', at: 6000 }), undefined);
});

test('overlay stays visible for the ttl and then hides', () => {
 const record: VoiceOverlay = { text: 'Escuchando…', sub: 'micrófono abierto', at: 1000 };
 assert.equal(visibleVoiceOverlay(record, 1000), true);
 assert.equal(visibleVoiceOverlay(record, 2499), true);
 assert.equal(visibleVoiceOverlay(record, 2500), false);
 assert.equal(visibleVoiceOverlay(record, 1300, 200), false);
 assert.equal(visibleVoiceOverlay(undefined, 1000), false);
});

test('overlay renders a small centered red box that never exceeds the width', () => {
 const record: VoiceOverlay = { text: 'Escuchando…', sub: 'micrófono abierto', at: 0 };
 roles.length = 0;
 const lines = renderVoiceOverlay(record, 44, theme);
 assert.equal(lines.length, 4);
 const plain = lines.map(strip);
 assert.match(plain[0]!, /^\s*╭─+╮\s*$/);
 assert.match(plain[1]!, /│ ● Escuchando…\s+│/);
 assert.match(plain[2]!, /│\s+micrófono abierto\s+│/);
 assert.match(plain[3]!, /^\s*╰─+╯\s*$/);
 for (const line of lines) assert.equal(visibleWidth(line), 44);
 const left = plain[0]!.indexOf('╭');
 const right = 44 - 1 - plain[0]!.lastIndexOf('╮');
 assert.ok(Math.abs(left - right) <= 1, `centered: ${left} vs ${right}`);
 assert.ok(roles.includes('error'), 'red frame and dot use the error role');
 const single = renderVoiceOverlay({ text: 'Micrófono cerrado', sub: '', at: 0 }, 44, theme).map(strip);
 assert.equal(single.length, 3);
 for (let width = 0; width <= 30; width++) {
  for (const line of renderVoiceOverlay(record, width, theme)) assert.ok(visibleWidth(line) <= width, `width ${width}`);
 }
});
