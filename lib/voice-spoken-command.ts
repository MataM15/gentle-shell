// Spoken commands (S4, S10). Voice never runs free text: a transcript runs a
// command only when the whole utterance is one of these fixed entries, and the
// same words inside a longer sentence are ordinary text that goes to the model.
//
// Each entry declares the words accepted at each position, so a likely
// transcription still matches ("gentel voice of") without ever matching a
// different sentence. Later phases add "gentle voice on", agent navigation and
// English mode by extending this list, never by matching free text.

export type SpokenCommandName = "voice-off";

interface SpokenCommandDefinition {
	readonly name: SpokenCommandName;
	// One set of accepted words per position of the whole utterance.
	readonly words: readonly (readonly string[])[];
}

const COMMANDS: readonly SpokenCommandDefinition[] = [
	{
		name: "voice-off",
		words: [
			["gentle", "gentel", "gentl", "yentel", "yentl"],
			["voice", "voz", "vois"],
			["off", "of"],
		],
	},
];

// Case, accents and punctuation never decide whether a command was spoken, and
// punctuation separates words instead of joining them so "gentle-voice off"
// reads like "gentle voice off".
export function normalizeSpoken(input: string): string {
	return input
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

// The command this transcript is, or undefined for anything else: only a whole
// utterance from the list is a command.
export function matchSpokenCommand(transcript: string): SpokenCommandName | undefined {
	const normalized = normalizeSpoken(transcript);
	if (!normalized) return undefined;
	const words = normalized.split(" ");
	for (const command of COMMANDS) {
		if (words.length !== command.words.length) continue;
		if (command.words.every((accepted, index) => accepted.includes(words[index]!))) return command.name;
	}
	return undefined;
}
