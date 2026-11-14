import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { CardTheme } from './shell-card.ts';

/**
 * The persistent voice bubble drawn above the input box (S18, S16). Pure: the
 * caller owns the data (state, levels, session, language) and the clock; this
 * file only turns one model into rows exactly `width` cells wide.
 * Visual source: design/voice-bubble/01-sobre-el-cuadro.html.
 */
export type VoiceBubbleState = 'off' | 'listening' | 'transcribing' | 'reading' | 'asleep' | 'confirm';

export interface VoiceBubbleModel {
 state: VoiceBubbleState;
 /** Recent loudness 0..1, newest last (mic while listening, reply while reading); may be empty. */
 levels: readonly number[];
 /** Short label of the session that listens/reads. */
 session?: string;
 language: 'es' | 'en';
 englishMode: boolean;
 /** Confirm only. */
 countdownMs?: number;
 /** Confirm only: the dictated text. */
 text?: string;
}

/** Theme roles per state (sakura: accent pink, warning amber, success green, muted, borderAccent orange, mdLink blue). */
const STATE_ROLE: Record<Exclude<VoiceBubbleState, 'off'>, string> = {
 listening: 'accent',
 transcribing: 'warning',
 reading: 'success',
 asleep: 'muted',
 confirm: 'borderAccent',
};
const ENGLISH_ROLE = 'mdLink';
const TEXT_ROLE = 'text';
const QUIET_ROLE = 'muted';
const RULE_ROLE = 'dim';

const BARS = '▁▂▃▄▅▆▇█';
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const FRAME_MS = 90;
const SWEEP_SEGMENT = 14;
const CONFIRM_MS = 3000;
const MAX_SESSION_CELLS = 24;
const INVERT = '\x1b[7m';
const INVERT_OFF = '\x1b[27m';
/** The artboard keeps one blank cell on each side of the box, like the chat bubbles. */
const MARGIN = 1;
const MIN_BOX = 24;

type Paint = (text: string) => string;
interface Piece { plain: string; paint: Paint }
const piece = (plain: string, paint: Paint = (text) => text): Piece => ({ plain, paint });
const widthOf = (pieces: readonly Piece[]) => pieces.reduce((sum, p) => sum + visibleWidth(p.plain), 0);
const paintAll = (pieces: readonly Piece[]) => pieces.map((p) => (p.plain === '' ? '' : p.paint(p.plain))).join('');
/** Pad or cut a styled row to exactly `width` cells; the last guard against overflow. */
function fit(row: string, width: number): string {
 const cut = visibleWidth(row) > width ? truncateToWidth(row, width, '') : row;
 return cut + ' '.repeat(Math.max(0, width - visibleWidth(cut)));
}
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Rows the bubble adds above the input for a state: the chat shifts by this many. */
export function voiceBubbleRows(state: VoiceBubbleState): number {
 return state === 'off' ? 0 : state === 'asleep' ? 1 : 4;
}

export function renderVoiceBubble(model: VoiceBubbleModel, width: number, theme: CardTheme, now: number): string[] {
 const target = Math.floor(width);
 if (model.state === 'off' || !(target > 0)) return [];
 const english = model.englishMode && model.state === 'listening';
 const role = english ? ENGLISH_ROLE : STATE_ROLE[model.state];
 const bold = (text: string) => (theme.bold ? theme.bold(text) : text);
 const fg = (r: string): Paint => (text) => theme.fg(r, text);
 const state: Paint = fg(role);
 const strong: Paint = (text) => theme.fg(role, bold(text));
 const chip = (text: string): Piece => piece(text, (value) => INVERT + theme.fg(role, bold(value)) + INVERT_OFF);
 const frame = now < 0 || !Number.isFinite(now) ? 0 : Math.floor(now / FRAME_MS);
 const command = (text: string) => piece(text, strong);
 const quiet = (text: string) => piece(text, fg(QUIET_ROLE));
 const strongText = (text: string) => piece(text, (value) => theme.fg(TEXT_ROLE, bold(value)));
 const session = clean(model.session ?? '');
 const sessionText = visibleWidth(session) > MAX_SESSION_CELLS ? truncateToWidth(session, MAX_SESSION_CELLS, '…') : session;

 const label = (): string => {
  switch (model.state) {
   case 'listening': return english ? ' ● MODO INGLÉS ' : ' ● ESCUCHANDO ';
   case 'transcribing': return ` ${SPINNER[frame % SPINNER.length]} TRANSCRIBIENDO `;
   case 'reading': return ' ▶ LEYENDO ';
   case 'asleep': return ' ○ DORMIDO ';
   default: return ` ▸ ENVIANDO EN ${Math.max(1, Math.ceil(Math.max(0, model.countdownMs ?? 0) / 1000))}… `;
  }
 };

 // Asleep: one quiet row, no box (the artboard's pill).
 if (model.state === 'asleep') {
  const tails: Piece[][] = [
   [quiet('di '), command('«Gentle Voice on»'), quiet(' para despertar')],
   [quiet('di '), command('«Gentle Voice on»')],
   [],
  ];
  const head = [piece(' '), chip(label())];
  const tail = tails.find((candidate) => MARGIN + widthOf(head) + (candidate.length ? 1 + widthOf(candidate) : 0) <= target) ?? [];
  return [fit(paintAll([...head, ...(tail.length ? [piece(' '), ...tail] : [])]), target)];
 }

 const box = target - 2 * MARGIN;
 if (box < MIN_BOX) {
  const rows = [fit(paintAll([chip(label())]), target)];
  return [...rows, ...Array.from({ length: 3 }, () => ' '.repeat(target))];
 }
 const inner = box - 4;
 const side = ' '.repeat(MARGIN);
 const rule = (text: string, paint: Paint = state) => piece(text, paint);
 const line = (corner: string, left: Piece[], right: Piece[], fill: (cells: number) => Piece[] | undefined, closing: string): string | undefined => {
  const cells = box - 2 - widthOf(left) - widthOf(right);
  if (cells < 1) return undefined;
  return side + paintAll([rule(corner), ...left, ...(fill(cells) ?? [rule('─'.repeat(cells))]), ...right, rule(closing)]) + side;
 };
 const body = (content: Piece[]): string => {
  const pad = Math.max(0, inner - widthOf(content));
  return side + paintAll([rule('│'), piece(' '), ...content, piece(' '.repeat(pad + 1)), rule('│')]) + side;
 };

 // Top border: inverted state label, session, language chip. The session goes first when space runs out.
 const langText = english || model.language === 'en' ? ' EN ' : ' ES ';
 const sessionTails: Piece[][] = model.state === 'reading'
  ? [
   ...(sessionText ? [[quiet(' · '), piece('de ' + sessionText, fg(TEXT_ROLE)), quiet(' · '), piece('te estoy hablando', fg(TEXT_ROLE))], [quiet(' · '), piece('de ' + sessionText, fg(TEXT_ROLE))]] : [[quiet(' · '), piece('te estoy hablando', fg(TEXT_ROLE))]]),
   [],
  ]
  : [...(sessionText ? [[quiet(' · '), piece('→ ' + sessionText, fg(TEXT_ROLE))]] : []), []];
 const head = (tail: Piece[]): Piece[] => [rule('─ '), chip(label()), ...tail, piece(' ')];
 const lang: Piece[] = [piece(' '), chip(langText), rule(' ─')];
 let top: string | undefined;
 for (const tail of sessionTails) {
  top = line('╭', head(tail), lang, () => undefined, '╮');
  if (top) break;
 }
 top ??= line('╭', head([]), [rule(' ─')], () => undefined, '╮');
 top ??= side + paintAll([rule('╭'), chip(truncateToWidth(label(), Math.max(0, box - 2), '')), rule('╮')]) + side;

 // Middle rows.
 const barAt = (level: number) => {
  const value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return BARS[Math.round(value * (BARS.length - 1))]!;
 };
 const wave = () => {
  const shown = model.levels.slice(-inner);
  return ' '.repeat(0) + '▁'.repeat(inner - shown.length) + shown.map(barAt).join('');
 };
 let middle: string;
 if (model.state === 'transcribing') {
  const span = inner - SWEEP_SEGMENT;
  const travel = Math.abs(((frame * 0.9) % (2 * span)) - span);
  const before = Math.max(0, Math.min(span, Math.round(span - travel)));
  middle = body([rule('─'.repeat(before), fg(RULE_ROLE)), rule('━'.repeat(SWEEP_SEGMENT)), rule('─'.repeat(span - before), fg(RULE_ROLE))]);
 } else if (model.state === 'confirm') {
  const quote = `«${clean(model.text ?? '')}»`;
  middle = body([strongText(visibleWidth(quote) > inner ? truncateToWidth(quote, inner, '…') : quote)]);
 } else {
  middle = body([rule(wave())]);
 }

 // Command hints; the longest candidate that fits wins.
 const gap = quiet(' / ');
 const dismiss = [command('«cancel»'), gap, command('«stop»')];
 const hints: Piece[][] = ({
  listening: english
   ? [
    [command('«English off»'), quiet(' sale del inglés · '), ...dismiss, quiet(' descarta')],
    [command('«English off»'), quiet(' sale · '), ...dismiss, quiet(' descarta')],
    [command('«English off»'), quiet(' · '), command('«stop»'), quiet(' descarta')],
   ]
   : [
    [command('«Gentle Voice off»'), quiet(' apaga · '), ...dismiss, quiet(' descarta')],
    [command('«Gentle Voice off»'), quiet(' apaga · '), command('«stop»'), quiet(' descarta')],
    [command('«Gentle Voice off»'), quiet(' apaga')],
   ],
  transcribing: [
   [quiet('micrófono cerrado · el texto aparece en el cuadro')],
   [quiet('micrófono cerrado · el texto va al cuadro')],
   [quiet('micrófono cerrado')],
  ],
  reading: [
   [...dismiss, quiet(' corta y escucha')],
   [command('«stop»'), quiet(' corta y escucha')],
   [command('«stop»'), quiet(' corta')],
  ],
  confirm: [
   [strongText('silencio'), quiet(' envía · '), command('«cancel»'), quiet(' descarta')],
   [strongText('silencio'), quiet(' envía · '), command('«cancel»')],
   [strongText('silencio'), quiet(' envía')],
  ],
 } as Record<string, Piece[][]>)[model.state] ?? [[]];
 const chosen = hints.find((candidate) => widthOf(candidate) <= inner) ?? hints[hints.length - 1]!;
 let hintRow = body(chosen);
 if (widthOf(chosen) > inner) hintRow = side + paintAll([rule('│'), piece(' ')]) + fit(truncateToWidth(paintAll(chosen), inner, '…'), inner) + paintAll([piece(' '), rule('│')]) + side;

 // Bottom border: an arrow toward the input, or the shrinking countdown on confirm.
 let bottom: string;
 if (model.state === 'confirm') {
  const cells = box - 2;
  const fraction = Math.min(1, Math.max(0, (Number.isFinite(model.countdownMs) ? model.countdownMs! : 0) / CONFIRM_MS));
  const filled = Math.round(fraction * cells);
  bottom = side + paintAll([rule('╰'), rule('━'.repeat(filled)), rule('─'.repeat(cells - filled), fg(RULE_ROLE)), rule('╯')]) + side;
 } else {
  const arrow = [rule('─────▾')];
  bottom = line('╰', box - 2 >= widthOf(arrow) + 1 ? arrow : [], [], () => undefined, '╯')!;
 }
 return [top, middle, hintRow, bottom].map((row) => fit(row, target));
}
