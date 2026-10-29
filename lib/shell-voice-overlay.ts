import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { CardTheme } from './shell-card.ts';
import type { SidebarVoiceState } from './shell-voice-state.ts';

/** One transient notice about a voice transition; `at` is when it was raised. */
export interface VoiceOverlay { text: string; sub: string; at: number }
export interface VoiceOverlayEvent { state: SidebarVoiceState; at: number }

export const VOICE_OVERLAY_TTL_MS = 1500;
const FRAME_ROLE = 'error';
const TEXT_ROLE = 'text';
const SUB_ROLE = 'dim';
const MAX_BOX_WIDTH = 28;

/**
 * Pure reducer: raises a notice only on the transitions the owner wants to
 * notice (microphone opens, transcription starts, microphone closes) and
 * keeps the previous record otherwise, so repeated events never flicker.
 */
export function reduceVoiceOverlay(prev: VoiceOverlay | undefined, event: VoiceOverlayEvent, prevState?: SidebarVoiceState): VoiceOverlay | undefined {
 const before = prevState ?? stateOf(prev);
 if (event.state === 'listening' && before !== 'listening') return { text: 'Escuchando…', sub: 'micrófono abierto', at: event.at };
 if (event.state === 'transcribing' && before === 'listening') return { text: 'Transcribiendo…', sub: '', at: event.at };
 if (event.state === 'idle' && before === 'listening') return { text: 'Micrófono cerrado', sub: '', at: event.at };
 return prev;
}

/** The state a notice was raised for, used when the caller tracks no state. */
function stateOf(record: VoiceOverlay | undefined): SidebarVoiceState {
 if (!record) return 'idle';
 if (record.text === 'Escuchando…') return 'listening';
 if (record.text === 'Transcribiendo…') return 'transcribing';
 return 'idle';
}

export function visibleVoiceOverlay(record: VoiceOverlay | undefined, now: number, ttlMs = VOICE_OVERLAY_TTL_MS): boolean {
 return !!record && now >= record.at && now - record.at < ttlMs;
}

/** A small neon-bordered box centered in `width`; never wider than it. */
export function renderVoiceOverlay(record: VoiceOverlay, width: number, theme: CardTheme): string[] {
 const target = Math.floor(width);
 if (target < 6) return [];
 const rows = [`● ${record.text}`, ...(record.sub ? [`  ${record.sub}`] : [])];
 const inner = Math.min(MAX_BOX_WIDTH - 4, target - 4, Math.max(...rows.map((row) => visibleWidth(row))));
 const boxWidth = inner + 4;
 const left = Math.floor((target - boxWidth) / 2);
 const right = target - boxWidth - left;
 const frame = (text: string) => theme.fg(FRAME_ROLE, text);
 const line = (content: string) => ' '.repeat(left) + frame('│') + ' ' + content + ' ' + frame('│') + ' '.repeat(right);
 const fit = (row: string) => {
  const cut = truncateToWidth(row, inner, '…');
  return cut + ' '.repeat(Math.max(0, inner - visibleWidth(cut)));
 };
 const [, ...rest] = rows;
 const dot = theme.fg(FRAME_ROLE, '●');
 const headCut = truncateToWidth(` ${record.text}`, inner - 1, '…');
 const headText = headCut + ' '.repeat(Math.max(0, inner - 1 - visibleWidth(headCut)));
 const styledHead = dot + theme.fg(TEXT_ROLE, theme.bold ? theme.bold(headText) : headText);
 return [
  ' '.repeat(left) + frame(`╭${'─'.repeat(inner + 2)}╮`) + ' '.repeat(right),
  line(styledHead),
  ...rest.map((row) => line(theme.fg(SUB_ROLE, fit(row)))),
  ' '.repeat(left) + frame(`╰${'─'.repeat(inner + 2)}╯`) + ' '.repeat(right),
 ];
}
