import { isJobsSidebarSnapshot, type RunningJobDisplay } from './jobs-sidebar-state.ts';
import { sanitizeTerminalText } from './terminal-theme.ts';

export interface AgentSummary { active: number; attention: number }
/** The jobs registry defaults its label to the raw command: do not publish that. */
export function safeJobLabel(label: string, command: string): string {
 const value = label.trim(), raw = command.trim();
 return !value || (raw.length > 0 && value.includes(raw)) ? 'Background command' : value;
}
export function acceptedJobs(sessionId: string | undefined, value: unknown): RunningJobDisplay[] | undefined {
 if (!sessionId || !value || typeof value !== 'object') return undefined;
 const event = value as { sessionId?: unknown; snapshot?: unknown };
 if (event.sessionId !== sessionId || !isJobsSidebarSnapshot(event.snapshot)) return undefined;
 // Optional finished-tail fields pass through only when the publisher set
 // them: a running job keeps the exact {id,label,startedAt} shape.
 return event.snapshot.jobs.map(({id,label,startedAt,status,endedAt,exitCode}) => {
  const display: RunningJobDisplay = {id,label,startedAt};
  if (status !== undefined) display.status = status;
  if (endedAt !== undefined) display.endedAt = endedAt;
  if (exitCode !== undefined) display.exitCode = exitCode;
  return display;
 });
}
export interface WaitDisplay { id: string; label: string; startedAt: number }
/** Validation only: do not subscribe until the scoped producer is verified. */
export function acceptedWaits(sessionId: string | undefined, value: unknown): WaitDisplay[] | undefined {
 if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
 const event = value as { sessionId?: unknown; waits?: unknown };
 if (event.sessionId !== sessionId || !Array.isArray(event.waits)) return undefined;
 const safeText = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0 && text.length <= 256 && sanitizeTerminalText(text) === text;
 if (!event.waits.every((item) => item && typeof item === 'object' && safeText(item.id) && safeText(item.label) && typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) && item.startedAt > 0)) return undefined;
 return event.waits.map(({id,label,startedAt}) => ({id,label,startedAt}));
}
export function createWaitsReceiver(events: { on(name: string, listener: (value: unknown) => void): () => void }, currentSession: () => string | undefined, changed: () => void) {
 let snapshot: { sessionId: string; waits: WaitDisplay[] } | undefined;
 const unsubscribe = events.on('background-waits:pending', (value) => {
  const sessionId = currentSession();
  // An old unscoped producer cannot substantiate even a previously known count.
  if (value && typeof value === 'object' && !Array.isArray(value) && (typeof (value as {sessionId?: unknown}).sessionId !== 'string' || !(value as {sessionId: string}).sessionId)) {
   if (snapshot) { snapshot = undefined; changed(); }
   return;
  }
  const waits = acceptedWaits(sessionId, value);
  if (!sessionId || !waits) return;
  if (snapshot?.sessionId === sessionId && JSON.stringify(snapshot.waits) === JSON.stringify(waits)) return;
  snapshot = { sessionId, waits }; changed();
 });
 return {
  current: () => snapshot?.sessionId === currentSession() ? snapshot?.waits : undefined,
  reset: () => { if (snapshot) { snapshot = undefined; changed(); } },
  dispose: () => { unsubscribe(); snapshot = undefined; },
 };
}
export function activitySummary(agents: AgentSummary | undefined, jobs: number | undefined, waits?: number): string {
 const agentText = agents ? `Agents ${agents.active} active · ${agents.attention} waiting` : 'Agents ?';
 const jobText = jobs === undefined ? 'Commands ?' : `${jobs} command${jobs === 1 ? '' : 's'}`;
 const waitText = waits === undefined ? 'Waits ?' : `Waits ${waits}`;
 return `${agentText} · ${jobText} · ${waitText}`;
}
export function waitRows(waits: readonly WaitDisplay[] | undefined, now: number): string[] {
 return waits === undefined ? ['Waits unavailable'] : waits.length === 0 ? ['No local waits'] : waits.map((wait) => `Wait · ${wait.label} · ${Math.max(0, Math.floor((now - wait.startedAt) / 60000))}m`);
}
export function commandRows(jobs: readonly RunningJobDisplay[] | undefined, now: number, waits?: readonly WaitDisplay[]): string[] {
 const rows = jobs === undefined ? ['Commands unavailable'] : jobs.length === 0 ? ['No running commands'] : jobs.map((job) => {
  const elapsed = Math.max(0, Math.floor((now - job.startedAt) / 60000));
  const label = sanitizeTerminalText(job.label).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Command';
  return `${label} · running · ${elapsed}m`;
 });
 return [...rows, ...waitRows(waits, now)];
}
