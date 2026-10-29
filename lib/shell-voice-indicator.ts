import { truncateToWidth } from '@earendil-works/pi-tui';
import type { CardTheme } from './shell-card.ts';
import type { SidebarVoiceState } from './shell-voice-state.ts';

/** A single, passive pinned row; it neither owns focus nor controls voice. */
export function renderVoiceIndicator(state: SidebarVoiceState | undefined, theme: CardTheme, width: number): string[] {
 if (!state || state === 'idle' || width < 1) return [];
 const role = state === 'preparing' ? 'warning' : state === 'listening' ? 'success' : 'accent';
 const text = truncateToWidth(`● Voice · ${state}`, Math.floor(width), '…');
 return [theme.fg(role, theme.bold ? theme.bold(text) : text)];
}
