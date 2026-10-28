import { VOICE_STATE_EVENT, VOICE_STATE_SCHEMA } from './voice-status-event.ts';
export type SidebarVoiceState = 'idle' | 'preparing' | 'listening' | 'transcribing';
/** Accept only the agreed display-only event from the active session. */
export function acceptedVoiceState(sessionId: string | undefined, value: unknown): SidebarVoiceState | undefined {
 if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
 const record = value as Record<string, unknown>;
 const keys = Object.keys(record);
 if (keys.length !== 3 || !['schema','sessionId','state'].every(key => Object.hasOwn(record,key))) return undefined;
 if (record.schema !== VOICE_STATE_SCHEMA || record.sessionId !== sessionId) return undefined;
 return record.state === 'idle' || record.state === 'preparing' || record.state === 'listening' || record.state === 'transcribing' ? record.state : undefined;
}
export function createVoiceReceiver(events: { on(name: string, listener: (value: unknown) => void): () => void }, currentSession: () => string | undefined, changed: () => void) {
 let snapshot: { sessionId: string; state: SidebarVoiceState } | undefined;
 const unsubscribe = events.on(VOICE_STATE_EVENT, (value) => {
  const sessionId = currentSession();
  const state = acceptedVoiceState(sessionId, value);
  if (!sessionId || !state) return;
  if (snapshot?.sessionId === sessionId && snapshot.state === state) return;
  snapshot = { sessionId, state }; changed();
 });
 return {
  current: () => snapshot?.sessionId === currentSession() && snapshot?.state !== 'idle' ? snapshot?.state : undefined,
  reset: () => { if (snapshot) { snapshot = undefined; changed(); } },
  dispose: () => { unsubscribe(); snapshot = undefined; },
 };
}
