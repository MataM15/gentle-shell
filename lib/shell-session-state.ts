import { listPresence, sanitizeDisplayLabel, sessionHash, type PresencePage } from './orchestrator-presence.ts';

/** Display-only metadata; never session ids, transport handles, threads or prompts.
 * `lastSeen` is the peer heartbeat timestamp, so ages stay per session; rows without
 * one (older payloads) are aged from the snapshot's `observedAt` instead. */
export interface SessionRow { name: string; freshness: 'recent' | 'stale'; active: number; lastSeen?: number }
export type SessionSnapshot = { kind: 'unavailable' } | { kind: 'ready'; rows: SessionRow[]; incomplete: boolean; observedAt: number };
export interface SessionRowsOptions { staleAfterMs?: number }
const MAX_ROWS = 8;
const MAX_TIME = 8640000000000000;
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const SESSIONS_CARD_TITLE = 'Otras sesiones';
export const SESSION_REFRESH_EVENT = 'gentle-ai:sessions-sidebar-refresh';
export const SESSION_SNAPSHOT_EVENT = 'gentle-ai:sessions-sidebar-snapshot';

/** Validate the entire display-only payload before accepting it for this session. */
export function acceptedSessionSnapshot(sessionId: string | undefined, value: unknown): SessionSnapshot | undefined {
 if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
 const event = value as {sessionId?:unknown; snapshot?:unknown};
 if (event.sessionId !== sessionId || !event.snapshot || typeof event.snapshot !== 'object' || Array.isArray(event.snapshot)) return undefined;
 const snapshot = event.snapshot as Record<string,unknown>;
 if (snapshot.kind === 'unavailable' && Object.keys(snapshot).length === 1) return {kind:'unavailable'};
 if (snapshot.kind !== 'ready' || Object.keys(snapshot).length !== 4 || typeof snapshot.incomplete !== 'boolean' || !Number.isSafeInteger(snapshot.observedAt) || (snapshot.observedAt as number) < 0 || (snapshot.observedAt as number) > MAX_TIME || !Array.isArray(snapshot.rows) || snapshot.rows.length > MAX_ROWS) return undefined;
 // A row is the original three display fields, plus an optional per-session last-seen.
 if (!snapshot.rows.every((row) => row && typeof row === 'object' && !Array.isArray(row) &&
  (Object.keys(row).length === 3 || (Object.keys(row).length === 4 && Number.isSafeInteger(row.lastSeen) && row.lastSeen >= 0 && row.lastSeen <= MAX_TIME)) &&
  typeof row.name === 'string' && row.name.length > 0 && sanitizeDisplayLabel(row.name) === row.name &&
  (row.freshness === 'recent' || row.freshness === 'stale') && Number.isSafeInteger(row.active) && row.active >= 0)) return undefined;
 return {kind:'ready', rows:snapshot.rows.map(({name,freshness,active,lastSeen})=>(
  lastSeen === undefined ? {name,freshness,active} : {name,freshness,active,lastSeen})), incomplete:snapshot.incomplete, observedAt:snapshot.observedAt as number};
}
const minutesSince = (seenAt: number, now: number) => Math.max(0, Math.floor((now - seenAt) / 60_000));
/** Ages are coarse human language: minutes under an hour, whole hours above. */
const ageLabel = (seenAt: number, now: number) => {
 const minutes = minutesSince(seenAt, now);
 return minutes >= 60 ? `hace ${Math.floor(minutes / 60)} h` : `hace ${minutes} min`;
};
const agentLabel = (active: number) => `${active} ${active === 1 ? 'agente' : 'agentes'}`;
const thresholdLabel = (staleAfterMs: number) => {
 const hours = staleAfterMs / 3_600_000;
 return hours >= 1 && Number.isInteger(hours) ? `${hours} h` : `${Math.round(staleAfterMs / 60_000)} min`;
};
/** Two plain strings per session keep existing callers source compatible; the dot's
 * tone is the card renderer's concern, not this projection's. */
export function sessionRows(snapshot: SessionSnapshot | undefined, now = Date.now(), options: SessionRowsOptions = {}): string[] {
 if (!snapshot || snapshot.kind === 'unavailable') return ['Sessions unavailable'];
 const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
 const seenAt = (row: SessionRow) => row.lastSeen ?? snapshot.observedAt;
 const lines: string[] = [];
 let hidden = 0;
 for (const row of snapshot.rows) {
  const seen = seenAt(row);
  if (row.freshness === 'stale' && now - seen > staleAfterMs) { hidden++; continue; }
  lines.push(`● ${row.name}`, row.freshness === 'stale'
   ? `  inactiva · ${ageLabel(seen, now)}`
   : `  ${ageLabel(seen, now)} · ${agentLabel(row.active)}`);
 }
 // Heartbeat freshness is not liveness: the count hides old metadata, it does not assert death.
 if (hidden) lines.push(`● +${hidden} inactivas (más de ${thresholdLabel(staleAfterMs)})`);
 if (!lines.length) lines.push('Sin otras sesiones');
 lines.push(`visto hace ${Math.max(0, Math.floor((now - snapshot.observedAt) / 1000))} s${snapshot.incomplete ? ' · lista parcial' : ''}`);
 return lines;
}
export function projectSessionPage(page: PresencePage, selfHash: string, observedAt = Date.now()): SessionSnapshot {
 if (page.unavailable) return {kind:'unavailable'};
 const candidates=page.entries.filter((entry)=>entry.sessionHash !== selfHash);
 const counts=new Map<string,number>();
 for (const entry of candidates) counts.set(entry.sessionHash,(counts.get(entry.sessionHash) ?? 0)+1);
 const peers=candidates.filter((entry)=>counts.get(entry.sessionHash) === 1);
 peers.sort((a,b)=>Number(b.recent)-Number(a.recent));
 return {kind:'ready', observedAt, rows:peers.slice(0,MAX_ROWS).map((entry)=>({
  name:entry.label || 'Unnamed session', freshness:entry.recent ? 'recent' : 'stale',
  active:Math.min(Number.MAX_SAFE_INTEGER,entry.counts.running + entry.counts.queued + entry.counts.waiting),
  lastSeen:entry.heartbeat,
 })), incomplete:page.overflow || page.rejected > 0 || peers.length > MAX_ROWS || peers.length !== candidates.length};
}
/** One bounded, read-only presence-header page; heartbeat freshness is not liveness. */
export function readSessionSnapshot(profile: string, currentSession: string, now = Date.now()): SessionSnapshot {
 if (!profile || !currentSession) return {kind:'unavailable'};
 return projectSessionPage(listPresence(profile, now), sessionHash(currentSession), now);
}
/** Single-generation async refresh. Neither stale success nor stale failure may publish. */
export function createSessionRefresh(currentSession: () => string | undefined, read: (id:string) => Promise<SessionSnapshot>, publish: (id:string, snapshot:SessionSnapshot) => void) {
 let generation=0, closed=false;
 return {
  request() {
   const id=currentSession(); if (closed || !id) return;
   const ticket=++generation;
   void Promise.resolve().then(()=> closed || generation!==ticket || currentSession()!==id ? undefined : read(id)).then(
    (snapshot)=>{ if (snapshot && !closed && generation===ticket && currentSession()===id) publish(id,snapshot); },
    ()=>{ if (!closed && generation===ticket && currentSession()===id) publish(id,{kind:'unavailable'}); },
   );
  },
  reset() { generation++; },
  dispose() { closed=true; generation++; },
 };
}
