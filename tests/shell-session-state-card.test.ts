import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSIONS_CARD_TITLE, sessionRows, type SessionRow, type SessionSnapshot } from '../lib/shell-session-state.ts';

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const MINUTE = 60_000;
const ready = (rows: SessionRow[], extra: { incomplete?: boolean; observedAt?: number } = {}): SessionSnapshot =>
 ({kind:'ready', rows, incomplete: extra.incomplete ?? false, observedAt: extra.observedAt ?? NOW - 12_000});

test('sessions card pairs every session with a human age and agent count', () => {
 const rows = sessionRows(ready([
  {name:'Auditar pruebas y entrega visual Pagub', freshness:'recent', active:2, lastSeen: NOW - 2*MINUTE},
  {name:'Retomar cola de merges Pagub', freshness:'recent', active:1, lastSeen: NOW - 11*MINUTE},
  {name:'Pagub integrator 20261029', freshness:'recent', active:0, lastSeen: NOW - 120*MINUTE},
 ], {incomplete:true}), NOW);
 assert.deepEqual(rows, [
  '● Auditar pruebas y entrega visual Pagub', '  hace 2 min · 2 agentes',
  '● Retomar cola de merges Pagub', '  hace 11 min · 1 agente',
  '● Pagub integrator 20261029', '  hace 2 h · 0 agentes',
  'visto hace 12 s · lista parcial',
 ]);
 assert.equal(SESSIONS_CARD_TITLE, 'Otras sesiones');
});

test('inactive sessions beyond the threshold collapse into one counted row', () => {
 const rows = sessionRows(ready([
  {name:'Activa', freshness:'recent', active:0, lastSeen: NOW - MINUTE},
  {name:'Reciente inactiva', freshness:'stale', active:0, lastSeen: NOW - 30*MINUTE},
  {name:'Vieja a', freshness:'stale', active:0, lastSeen: NOW - 7*60*MINUTE},
  {name:'Vieja b', freshness:'stale', active:0, lastSeen: NOW - 6*60*MINUTE - MINUTE},
 ]), NOW);
 assert.deepEqual(rows, [
  '● Activa', '  hace 1 min · 0 agentes',
  '● Reciente inactiva', '  inactiva · hace 30 min',
  '● +2 inactivas (más de 6 h)',
  'visto hace 12 s',
 ]);
 assert.equal(rows.some((line) => line.includes('Vieja')), false);
});

test('the hide threshold is configurable and a missing last-seen falls back to the observation time', () => {
 const stale: SessionRow = {name:'Inactiva de ayer', freshness:'stale', active:0, lastSeen: NOW - 2*60*MINUTE};
 assert.deepEqual(sessionRows(ready([stale]), NOW, {staleAfterMs: 6*60*MINUTE}), [
  '● Inactiva de ayer', '  inactiva · hace 2 h', 'visto hace 12 s',
 ]);
 assert.deepEqual(sessionRows(ready([stale]), NOW, {staleAfterMs: 30*MINUTE}), [
  '● +1 inactivas (más de 30 min)', 'visto hace 12 s',
 ]);
 assert.deepEqual(sessionRows(ready([{name:'Sin marca', freshness:'stale', active:0}]), NOW, {staleAfterMs: 30*MINUTE}), [
  '● Sin marca', '  inactiva · hace 0 min', 'visto hace 12 s',
 ]);
});

test('a snapshot without peers states that plainly beside the single footer', () => {
 assert.deepEqual(sessionRows(ready([]), NOW), ['Sin otras sesiones', 'visto hace 12 s']);
 assert.deepEqual(sessionRows(undefined), ['Sessions unavailable']);
});
