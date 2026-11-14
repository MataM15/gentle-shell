import { VOICE_STATE_EVENT, VOICE_STATE_SCHEMA, VOICE_DISPLAY_EVENT, VOICE_DISPLAY_SCHEMA, VOICE_LEVEL_EVENT, VOICE_LEVEL_SCHEMA } from './voice-status-event.ts';
import { normalizeLevel, normalizeOutputLevel } from './voice-overlay.ts';
import type { VoiceBubbleModel } from './shell-voice-bubble.ts';
import type { VoiceDisplaySnapshot } from './voice-status-event.ts';

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

const MAX_LEVELS = 160;
// The microphone uses the measured WSLg floor and speech calibration already
// used by T4. Played audio uses the T13 output calibration with 1.7 display gain:
// an RMS of 0.1 fills about 59% of the wave; both mappings clamp to 0..1.
const displayLevel = (source: 'listening' | 'reading', rms: number) => source === 'reading'
 ? Math.min(1, 1.7 * normalizeOutputLevel(rms))
 : normalizeLevel(rms);

function acceptedDisplay(sessionId: string | undefined, value: unknown): VoiceDisplaySnapshot | undefined {
 if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
 const r = value as Record<string, unknown>;
 if (Object.keys(r).some(k => !['schema','sessionId','state','language','label'].includes(k))) return undefined;
 if (r.schema !== VOICE_DISPLAY_SCHEMA || r.sessionId !== sessionId) return undefined;
 if (!['off','asleep','listening','transcribing','reading'].includes(r.state as string)) return undefined;
 if (r.language !== 'es' && r.language !== 'en') return undefined;
 if (r.label !== undefined && (typeof r.label !== 'string' || r.label.length > 256)) return undefined;
 return { state: r.state as VoiceDisplaySnapshot['state'], language: r.language, ...(r.label === undefined ? {} : { label: r.label as string }) };
}

export function createVoiceReceiver(events: { on(name: string, listener: (value: unknown) => void): () => void }, currentSession: () => string | undefined, changed: () => void) {
 let snapshot: { sessionId: string; state: SidebarVoiceState } | undefined;
 let display: { sessionId: string; snapshot: VoiceDisplaySnapshot; levels: number[] } | undefined;
 const unsubState = events.on(VOICE_STATE_EVENT, (value) => {
  const sessionId = currentSession();
  const state = acceptedVoiceState(sessionId, value);
  if (!sessionId || !state) return;
  if (snapshot?.sessionId === sessionId && snapshot.state === state) return;
  snapshot = { sessionId, state }; changed();
 });
 const unsubDisplay = events.on(VOICE_DISPLAY_EVENT, value => {
  const sessionId = currentSession();
  const next = acceptedDisplay(sessionId, value);
  if (!sessionId || !next) return;
  if (display?.sessionId === sessionId && JSON.stringify(display.snapshot) === JSON.stringify(next)) return;
  const levels = display?.sessionId === sessionId && display.snapshot.state === next.state && display.snapshot.label === next.label ? display.levels : [];
  display = { sessionId, snapshot: next, levels }; changed();
 });
 const unsubLevel = events.on(VOICE_LEVEL_EVENT, value => {
  const sessionId = currentSession();
  if (!sessionId || !display || display.sessionId !== sessionId || !value || typeof value !== 'object' || Array.isArray(value)) return;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 4 || !['schema','sessionId','source','rms'].every(k => Object.hasOwn(r,k))) return;
  if (r.schema !== VOICE_LEVEL_SCHEMA || r.sessionId !== sessionId || r.source !== display.snapshot.state) return;
  if ((r.source !== 'listening' && r.source !== 'reading') || typeof r.rms !== 'number' || !Number.isFinite(r.rms) || r.rms < 0 || r.rms > 1) return;
  display.levels.push(displayLevel(r.source, r.rms));
  if (display.levels.length > MAX_LEVELS) display.levels.splice(0, display.levels.length - MAX_LEVELS);
  changed();
 });
 const current = () => snapshot?.sessionId === currentSession() && snapshot?.state !== 'idle' ? snapshot?.state : undefined;
 const model = (): VoiceBubbleModel => {
  const view = display?.sessionId === currentSession() ? display : undefined;
  const local = current();
  if (view && view.snapshot.state !== 'off') return {
   state: view.snapshot.state, levels: [...view.levels], language: view.snapshot.language, englishMode: false,
   ...(view.snapshot.label === undefined ? {} : { session: view.snapshot.label }),
  };
  return { state: local === 'transcribing' ? 'transcribing' : local ? 'listening' : 'off', levels: [], language: view?.snapshot.language ?? 'es', englishMode: false };
 };
 return {
  current, model,
  reset: () => { if (snapshot || display) { snapshot = undefined; display = undefined; changed(); } },
  dispose: () => { unsubState(); unsubDisplay(); unsubLevel(); snapshot = undefined; display = undefined; },
 };
}
