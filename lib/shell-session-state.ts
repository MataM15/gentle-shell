import { listPresence, sanitizeDisplayLabel, sessionHash, type PresencePage } from './orchestrator-presence.ts';

/** Display-only metadata; never session ids, transport handles, threads or prompts. */
export interface SessionRow { name: string; freshness: 'recent' | 'stale'; active: number }
export type SessionSnapshot = { kind: 'unavailable' } | { kind: 'ready'; rows: SessionRow[]; incomplete: boolean; observedAt: number };
const MAX_ROWS = 8;
export const SESSION_REFRESH_EVENT = 'gentle-ai:sessions-sidebar-refresh';
export const SESSION_SNAPSHOT_EVENT = 'gentle-ai:sessions-sidebar-snapshot';

/** Validate the entire display-only payload before accepting it for this session. */
export function acceptedSessionSnapshot(sessionId: string | undefined, value: unknown): SessionSnapshot | undefined {
 if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
 const event = value as {sessionId?:unknown; snapshot?:unknown};
 if (event.sessionId !== sessionId || !event.snapshot || typeof event.snapshot !== 'object' || Array.isArray(event.snapshot)) return undefined;
 const snapshot = event.snapshot as Record<string,unknown>;
 if (snapshot.kind === 'unavailable' && Object.keys(snapshot).length === 1) return {kind:'unavailable'};
 if (snapshot.kind !== 'ready' || Object.keys(snapshot).length !== 4 || typeof snapshot.incomplete !== 'boolean' || !Number.isSafeInteger(snapshot.observedAt) || (snapshot.observedAt as number) < 0 || (snapshot.observedAt as number) > 8640000000000000 || !Array.isArray(snapshot.rows) || snapshot.rows.length > MAX_ROWS) return undefined;
 if (!snapshot.rows.every((row) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === 3 &&
  typeof row.name === 'string' && row.name.length > 0 && sanitizeDisplayLabel(row.name) === row.name &&
  (row.freshness === 'recent' || row.freshness === 'stale') && Number.isSafeInteger(row.active) && row.active >= 0)) return undefined;
 return {kind:'ready', rows:snapshot.rows.map(({name,freshness,active})=>({name,freshness,active})), incomplete:snapshot.incomplete, observedAt:snapshot.observedAt as number};
}
export function sessionRows(snapshot: SessionSnapshot | undefined): string[] {
 if (!snapshot || snapshot.kind === 'unavailable') return ['Sessions unavailable'];
 const rows = snapshot.rows.length ? snapshot.rows.flatMap((row) => [row.name, `  ${row.freshness} at snapshot · ${row.active} tasks`]) : ['No other sessions in scanned page'];
 const observed = new Date(snapshot.observedAt).toISOString().replace('T',' ').replace('.000Z',' UTC').replace(/\.\d{3}Z$/, ' UTC');
 return [`Snapshot: ${observed}`, 'Last observed metadata; not verified live', 'Tasks: running + queued + waiting', ...rows, ...(snapshot.incomplete ? ['Results incomplete'] : []), 'State and reachability unknown'];
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
