import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderVoiceBubble, type VoiceBubbleModel, type VoiceBubbleState } from '../lib/shell-voice-bubble.ts';

// Every role gets its own 256-colour code so tests read roles back without tags that would count as cells.
const ROLES = ['accent', 'warning', 'success', 'borderAccent', 'mdLink', 'muted', 'text', 'dim'];
const tagged = { fg: (role: string, text: string) => `\x1b[38;5;${ROLES.indexOf(role) + 100}m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const ansi = tagged;
const plain = (row: string) => row.replace(/\x1b\[\d+(;\d+)*m/g, '');
const codeOf = (role: string) => `\\x1b\\[38;5;${ROLES.indexOf(role) + 100}m`;
const base: VoiceBubbleModel = { state: 'listening', levels: [], session: 'voice-control', language: 'es', englishMode: false };
const model = (patch: Partial<VoiceBubbleModel>): VoiceBubbleModel => ({ ...base, ...patch });
const ACTIVE: VoiceBubbleState[] = ['listening', 'transcribing', 'reading', 'confirm'];
const confirm = { state: 'confirm' as const, text: 'Sí, seguí con la ventana de la onda.', countdownMs: 2000 };

test('off draws nothing and asleep draws one row; every active state draws four', () => {
 assert.deepEqual(renderVoiceBubble(model({ state: 'off' }), 105, tagged, 0), []);
 assert.equal(renderVoiceBubble(model({ state: 'asleep' }), 105, tagged, 0).length, 1);
 for (const state of ACTIVE) assert.equal(renderVoiceBubble(model({ state, ...(state === 'confirm' ? confirm : {}) }), 105, tagged, 0).length, 4, state);
 assert.equal(renderVoiceBubble(model({ englishMode: true }), 105, tagged, 0).length, 4);
});

test('every row is exactly the width in cells at 105 and 60 columns, and never wider below', () => {
 const models: VoiceBubbleModel[] = [
  ...ACTIVE.map((state) => model({ state, levels: [0, 0.3, 1], ...(state === 'confirm' ? confirm : {}) })),
  model({ state: 'listening', englishMode: true, language: 'en', session: 'a-very-long-session-label-that-keeps-going' }),
  model({ state: 'reading', session: 'a-very-long-session-label-that-keeps-going' }),
  model({ state: 'confirm', text: 'x'.repeat(300), countdownMs: 3000 }),
  model({ state: 'asleep' }),
 ];
 for (const width of [105, 80, 60]) {
  for (const item of models) {
   for (const row of renderVoiceBubble(item, width, ansi, 1234)) assert.equal(visibleWidth(row), width, `${item.state} @${width}: ${plain(row)}`);
  }
 }
 for (let width = 1; width < 60; width++) {
  for (const item of models) for (const row of renderVoiceBubble(item, width, ansi, 0)) assert.ok(visibleWidth(row) <= width, `${item.state} @${width}`);
 }
});

test('the wave maps levels to ▁..█ across the inner width, newest on the right', () => {
 const rows = renderVoiceBubble(model({ levels: [0, 1] }), 105, tagged, 0).map(plain);
 const wave = rows[1]!;
 assert.match(wave, /^ │ ▁+█ │ $/);
 assert.equal(wave.length, 105);
 const steps = renderVoiceBubble(model({ levels: [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1] }), 105, tagged, 0).map(plain)[1]!;
 assert.ok(steps.includes('▁▂▃▄▅▆▇█'), steps);
 // More levels than cells: only the newest fit.
 const many = Array.from({ length: 400 }, (_, i) => (i < 300 ? 0 : 1));
 const crowded = renderVoiceBubble(model({ levels: many }), 105, tagged, 0).map(plain)[1]!;
 assert.equal(crowded, ` │ ${'█'.repeat(99)} │ `);
 // Out-of-range values clamp instead of throwing.
 assert.doesNotThrow(() => renderVoiceBubble(model({ levels: [-1, 5, Number.NaN] }), 105, tagged, 0));
});

test('empty levels draw a flat resting line, not motion', () => {
 const a = renderVoiceBubble(model({ levels: [] }), 105, tagged, 0).map(plain)[1]!;
 const b = renderVoiceBubble(model({ levels: [] }), 105, tagged, 99999).map(plain)[1]!;
 assert.equal(a, ` │ ${'▁'.repeat(99)} │ `);
 assert.equal(b, a);
 const reading = renderVoiceBubble(model({ state: 'reading', levels: [] }), 105, tagged, 0).map(plain)[1]!;
 assert.equal(reading, a);
});

test('command hints and labels per state follow the artboard copy', () => {
 const at = (patch: Partial<VoiceBubbleModel>) => renderVoiceBubble(model(patch), 105, tagged, 0).map(plain);
 const listening = at({});
 assert.match(listening[0]!, /^ ╭─  ● ESCUCHANDO  · → voice-control ─+  ES  ─╮ $/);
 assert.ok(listening[2]!.includes('«Gentle Voice off» apaga · «cancel» / «stop» descarta'), listening[2]);
 assert.match(listening[3]!, /^ ╰─────▾─+╯ $/);
 const english = at({ englishMode: true, language: 'en' });
 assert.ok(english[0]!.includes('● MODO INGLÉS') && english[0]!.includes(' EN '), english[0]);
 assert.ok(english[2]!.includes('«English off» sale del inglés · «cancel» / «stop» descarta'), english[2]);
 const transcribing = at({ state: 'transcribing' });
 assert.ok(transcribing[0]!.includes('TRANSCRIBIENDO'));
 assert.ok(transcribing[2]!.includes('micrófono cerrado · el texto aparece en el cuadro'));
 const reading = at({ state: 'reading' });
 assert.match(reading[0]!, /▶ LEYENDO  · de voice-control · te estoy hablando/);
 assert.ok(reading[2]!.includes('«cancel» / «stop» corta y escucha'), reading[2]);
 const sending = at(confirm);
 assert.ok(sending[0]!.includes('▸ ENVIANDO EN 2… '), sending[0]);
 assert.ok(sending[1]!.includes('«Sí, seguí con la ventana de la onda.»'), sending[1]);
 assert.ok(sending[2]!.includes('silencio envía · «cancel» descarta'), sending[2]);
 const asleep = at({ state: 'asleep' });
 assert.equal(asleep[0], `${'  ○ DORMIDO  di «Gentle Voice on» para despertar'.padEnd(105)}`);
});

test('the confirm countdown shortens the bottom border and the label counts seconds', () => {
 const bottom = (countdownMs: number) => renderVoiceBubble(model({ ...confirm, countdownMs }), 105, tagged, 0).map(plain)[3]!;
 const heavy = (row: string) => [...row].filter((ch) => ch === '━').length;
 assert.equal(heavy(bottom(3000)), 101);
 assert.equal(heavy(bottom(0)), 0);
 assert.ok(heavy(bottom(1500)) > 40 && heavy(bottom(1500)) < 60);
 assert.ok(renderVoiceBubble(model({ ...confirm, countdownMs: 2100 }), 105, tagged, 0)[0]!.includes('ENVIANDO EN 3…'));
 assert.ok(renderVoiceBubble(model({ ...confirm, countdownMs: 0 }), 105, tagged, 0)[0]!.includes('ENVIANDO EN 1…'));
});

test('transcribing animates with now through the spinner and the sweep', () => {
 const frame = (now: number) => renderVoiceBubble(model({ state: 'transcribing' }), 105, tagged, now).map(plain);
 assert.notEqual(frame(0)[0], frame(90)[0]);
 assert.notEqual(frame(0)[1], frame(90 * 5)[1]);
 assert.deepEqual(frame(1000), frame(1000));
});

test('60 columns drop a session label that no longer fits, then shorten the hints, and keep the state', () => {
 const at = (patch: Partial<VoiceBubbleModel>) => renderVoiceBubble(model(patch), 60, tagged, 0).map(plain);
 const listening = at({});
 assert.ok(listening[0]!.includes('ESCUCHANDO') && listening[0]!.includes(' ES '));
 const long = at({ session: 'a-very-long-session-label-that-keeps-going' });
 assert.ok(long[0]!.includes('…'), 'a long label is cut with an ellipsis: ' + long[0]);
 const tight = renderVoiceBubble(model({ session: 'voice-control' }), 44, tagged, 0).map(plain);
 assert.ok(tight[0]!.includes('ESCUCHANDO') && !tight[0]!.includes('voice-control'), tight[0]);
 const reading = at({ state: 'reading', session: 'a-very-long-session-label-that-keeps-going' });
 assert.ok(reading[0]!.includes('LEYENDO') && reading[0]!.includes('de a-very'), reading[0]);
 assert.ok(listening[2]!.includes('«Gentle Voice off» apaga'), listening[2]);
 const english = at({ englishMode: true, language: 'en' });
 assert.ok(english[2]!.includes('«English off»') && english[2]!.includes('«cancel»'), english[2]);
 assert.ok(!english[2]!.includes('sale del inglés ·'), 'shortened');
 const short = renderVoiceBubble(model({ session: 'ab' }), 60, tagged, 0).map(plain);
 assert.ok(short[0]!.includes('→ ab'), 'a short label still fits at 60');
 for (const state of ACTIVE) for (const row of renderVoiceBubble(model({ state, ...(state === 'confirm' ? confirm : {}) }), 60, tagged, 0)) assert.equal(plain(row).length, 60);
});

test('colour comes only from theme roles; the only raw escapes are the label invert pair', () => {
 for (const state of ['listening', 'transcribing', 'reading', 'asleep', 'confirm'] as const) {
  const rows = renderVoiceBubble(model({ state, levels: [0.5], ...(state === 'confirm' ? confirm : {}) }), 105, tagged, 0);
  const raw = rows.join('\n');
  assert.equal(raw.replace(/\x1b\[(7|27|1|22|39|38;5;\d+)m/g, '').includes('\x1b'), false, state);
  assert.ok(raw.includes('\x1b[38;5;'), state);
  assert.ok(raw.includes('\x1b[38;5;') && !raw.includes('<'), state);
 }
 const roleOf = (state: VoiceBubbleState, patch: Partial<VoiceBubbleModel> = {}) =>
  ROLES[Number(/^ \x1b\[38;5;(\d+)m╭/.exec(renderVoiceBubble(model({ state, ...patch }), 105, tagged, 0)[0]!)?.[1]) - 100];
 assert.equal(roleOf('listening'), 'accent');
 assert.equal(roleOf('transcribing'), 'warning');
 assert.equal(roleOf('reading'), 'success');
 assert.equal(roleOf('confirm', confirm), 'borderAccent');
 assert.equal(roleOf('listening', { englishMode: true, language: 'en' }), 'mdLink');
 assert.match(renderVoiceBubble(model({ state: 'asleep' }), 105, tagged, 0)[0]!, new RegExp(`\\x1b\\[7m${codeOf('muted')}`));
});
