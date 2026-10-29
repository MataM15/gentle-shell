import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { CardTheme } from './shell-card.ts';
import type { SidebarVoiceState } from './shell-voice-state.ts';

const BADGE: Record<Exclude<SidebarVoiceState, 'idle'>, { label: string; dotRole: string }> = {
 preparing: { label: 'Preparando', dotRole: 'warning' },
 listening: { label: 'Escuchando', dotRole: 'error' },
 transcribing: { label: 'Transcribiendo', dotRole: 'warning' },
};
const INVERT = '\x1b[7m';
const INVERT_OFF = '\x1b[27m';

/**
 * A single, passive pinned row; it neither owns focus nor controls voice.
 * Renders a right-aligned light badge: colored dot, inverted bold label.
 */
export function renderVoiceIndicator(state: SidebarVoiceState | undefined, theme: CardTheme, width: number): string[] {
 const target = Math.floor(width);
 if (!state || state === 'idle' || target < 1) return [];
 const { label, dotRole } = BADGE[state];
 const plain = truncateToWidth(` ${label} `, Math.max(0, target - 2), '…');
 const text = theme.bold ? theme.bold(plain) : plain;
 const badge = target >= 3 ? `${theme.fg(dotRole, INVERT + '●')}${INVERT}${text}${INVERT_OFF}` : truncateToWidth('●', target, '');
 const pad = Math.max(0, target - visibleWidth(badge));
 return [' '.repeat(pad) + badge];
}
