// Real-microphone probe for the dictation model's whole-utterance command words.
// Nothing is played or saved; the owner runs this after turning voice off in Pi.
import { createInterface } from "node:readline/promises";
import { resolveVoiceHome } from "../../lib/voice-install.ts";
import { prepareVoiceWorkerLaunch, VoiceSessionError } from "../../lib/voice-session.ts";
import { createWarmVoiceWorker } from "../../lib/voice-warm.ts";

const USAGE = `Uso: node --experimental-strip-types odd/probes/voice-cmd-asr-probe.mjs [--help]

Antes de empezar, apagá la voz en Pi: el listener podría tener el micrófono ocupado.
Se harán 5 intentos de «cancel», 5 de «stop», 5 frases y 3 de silencio.
En cada intento, apretá Enter y esperá «Escuchando» antes de hablar.
No se reproduce ni se guarda audio; las transcripciones solo salen por pantalla.
Ctrl+C interrumpe la prueba y cierra el micrófono.`;

const FIXED = new Map([["cancel", "cancel"], ["stop", "stop"]]);
const LOOSE = new Map([
	["cancel", "cancel"], ["cancell", "cancel"], ["cancels", "cancel"],
	["stop", "stop"], ["stops", "stop"], ["top", "stop"], ["estop", "stop"],
]);
const SENTENCES = [
	"Cancelá la reunión de mañana.",
	"Pará un poco que no te entiendo.",
	"Cuando puedas, confirmame la hora.",
	"El tren sale temprano esta mañana.",
	"Mañana seguimos hablando de ese tema.",
];
const ATTEMPTS = [
	...Array.from({ length: 5 }, () => ({ prompt: "cancel", expected: "cancel" })),
	...Array.from({ length: 5 }, () => ({ prompt: "stop", expected: "stop" })),
	...SENTENCES.map((prompt) => ({ prompt, expected: "frase" })),
	...Array.from({ length: 3 }, () => ({ prompt: "[silencio: no hables durante 6 segundos]", expected: "silencio" })),
];

// Compare the whole normalized transcript, never a substring or free text.
function normalize(text) {
	return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[\p{P}\s]/gu, "");
}

function describeMatch(match, normalized) {
	return match ? `sí: ${match} (${JSON.stringify(normalized)})` : "no";
}

function printSummary(results) {
	const valid = results.filter((result) => !result.truncated);
	console.log("\nResumen: falsas aceptaciones = frases + silencios + confusión con la otra palabra.");
	console.log("Las capturas truncadas se muestran, pero no cuentan en las métricas.");
	console.log("Lista | Palabra | Aciertos / intentos válidos | Fallos | Falsas aceptaciones (frase/silencio/otra palabra)");
	for (const [name, key] of [["fija", "fixed"], ["amplia", "loose"]]) {
		for (const word of ["cancel", "stop"]) {
			const intended = valid.filter((result) => result.expected === word);
			const hits = intended.filter((result) => result[key] === word).length;
			const falseAccepts = valid.filter((result) => result.expected !== word && result[key] === word);
			const phrases = falseAccepts.filter((result) => result.expected === "frase").length;
			const silence = falseAccepts.filter((result) => result.expected === "silencio").length;
			const other = falseAccepts.length - phrases - silence;
			console.log(`${name} | ${word} | ${hits}/${intended.length} | ${intended.length - hits} | ${falseAccepts.length} (${phrases}/${silence}/${other})`);
		}
	}
	console.log("\nTodas las transcripciones, tal como las devuelve el dictado (sin normalizar):");
	console.log("N.º | Se pidió | Transcripción | Fija | Amplia | Estado");
	for (const [index, result] of results.entries()) {
		const state = result.truncated ? "truncada" : result.noSpeech ? "sin habla reconocida" : "válida";
		console.log(`${index + 1} | ${result.prompt} | ${JSON.stringify(result.text)} | ${describeMatch(result.fixed, result.normalized)} | ${describeMatch(result.loose, result.normalized)} | ${state}`);
	}
}

async function runProbe() {
	const target = `${process.platform}-${process.arch}`;
	const voiceHome = resolveVoiceHome();
	const worker = createWarmVoiceWorker({
		target,
		prepare: () => prepareVoiceWorkerLaunch({ target, voiceHome }),
	});
	const input = createInterface({ input: process.stdin, output: process.stdout });
	const inputAbort = new AbortController();
	const results = [];
	let active;
	let interrupted = false;
	let cancelling;

	const interrupt = () => {
		if (interrupted) return;
		interrupted = true;
		inputAbort.abort();
		// cancel() waits for the worker to exit, including while starting or recording.
		if (active) cancelling = active.cancel();
	};
	process.on("SIGINT", interrupt);
	input.on("SIGINT", interrupt);
	input.on("close", () => inputAbort.abort());

	try {
		console.log(USAGE);
		console.log("Lista fija: cancel, stop. Lista amplia: cancel, cancell, cancels, stop, stops, top, estop.\n");
		for (const [index, attempt] of ATTEMPTS.entries()) {
			console.log(`\nIntento ${index + 1}/${ATTEMPTS.length}. Decí: ${attempt.prompt}`);
			try {
				await input.question("Apretá Enter para empezar: ", { signal: inputAbort.signal });
			} catch (error) {
				if (inputAbort.signal.aborted) {
					if (!interrupted) console.log("\nEntrada cerrada; se interrumpe la prueba.");
					break;
				}
				throw error;
			}
			if (interrupted) break;

			let finished;
			const ended = new Promise((resolve) => { finished = resolve; });
			active = worker.session({
				endpoint: { endOfSpeechMs: 900, noSpeechMs: 6000 },
				onStateChange(state) {
					if (state === "recording") console.log("Escuchando…");
					if (state === "transcribing") console.log("Transcribiendo…");
					if (state === "finished") finished();
				},
			});
			let transcript;
			let noSpeech = false;
			try {
				await active.start();
				// stop() in the finished state collects the result without cutting off speech.
				await ended;
				transcript = await active.stop();
			} catch (error) {
				if (interrupted) break;
				if (!(error instanceof VoiceSessionError) || error.code !== "no-speech") throw error;
				transcript = { text: "", truncated: false };
				noSpeech = true;
			} finally {
				active = undefined;
			}
			if (interrupted) break;
			const normalized = normalize(transcript.text);
			const result = {
				...attempt,
				text: transcript.text,
				truncated: transcript.truncated,
				noSpeech,
				normalized,
				fixed: FIXED.get(normalized),
				loose: LOOSE.get(normalized),
			};
			results.push(result);
			console.log(`Transcripción: ${JSON.stringify(result.text)}${noSpeech ? " (sin habla reconocida)" : ""}${result.truncated ? " (truncada; no cuenta)" : ""}`);
			console.log(`Lista fija: ${describeMatch(result.fixed, normalized)}. Lista amplia: ${describeMatch(result.loose, normalized)}.`);
		}
	} finally {
		inputAbort.abort();
		input.close();
		if (cancelling) await cancelling;
		await worker.close();
		process.removeListener("SIGINT", interrupt);
		if (interrupted) {
			console.log("\nInterrumpido; micrófono cerrado.");
			process.exitCode = 130;
		}
		if (results.length) printSummary(results);
	}
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	console.log(USAGE);
} else if (args.length) {
	console.error(`Opción no reconocida.\n${USAGE}`);
	process.exitCode = 2;
} else if (!process.stdin.isTTY) {
	console.error("Esta prueba necesita una terminal interactiva; no se abrió el micrófono.");
	process.exitCode = 1;
} else {
	try {
		await runProbe();
	} catch (error) {
		console.error(`La prueba terminó por un error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
