# Spanish speech-to-text for Gentle Voice (S3 research)

Research for T2 (`odd/tasks/voice-control.md`). Question: what is the best **fully
local** way to transcribe the owner's speech **always in Spanish**?

Today the worker pins Parakeet TDT 0.6B v3 int8 (`scripts/voice-worker.cjs`,
`lib/voice-artifacts.ts`). That model auto-detects the language of every utterance and
cannot be told which one to use, so short Spanish utterances flip to English or Russian
(L5: «sí, siguiente» transcribed as "And they're"). Everything below was measured on
this machine, offline, with the already installed runtime; nothing was installed,
modified, played or committed.

## What the worker can load today

`sherpa-onnx 1.13.8` (installed at
`~/.pi/gentle-ai/voice/runtime/sherpa-onnx-1.13.8-node-cpal-1.0.0-linux-x64`) ships one
`OfflineRecognizer` whose `modelConfig` accepts **one** of these families
(`node_modules/sherpa-onnx-node/types.js`, `OfflineModelConfig`):
`transducer`, `nemoCtc`, `whisper` (with `language` + `task`), `canary`
(`srcLang`/`tgtLang`), `paraformer`, `zipformerCtc`, `wenetCtc`, `dolphin`,
`senseVoice`, `moonshine`, `fireRedAsr`, `tdnn`, `omnilingual`, `medasr`,
`cohereTranscribe`. The same package also ships `keyword-spotter.js`,
`streaming-asr.js` and `spoken-language-identification.js`.

So a fixed Spanish language is reachable in three shapes: a **Spanish-only export**
(no language decision exists at all), **Whisper with `language: "es"`**, and
**Canary/nemo with an explicit source language**.

## Method

- **Audio (no human, no microphone, nothing played):** 12 phrases synthesized with the
  Windows OneCore voice `Microsoft Raul` (es-MX) through the same WinRT path used by
  `lib/voice-onecore.ts`, written straight to WAV files. OneCore already emits
  16 kHz mono `pcm_s16le`, so no resampling was needed. Two extra clips were made by
  adding deterministic noise at 10 dB SNR (`addnoise.cjs`). 14 WAVs total:
  «sí, siguiente», «no», «dale», «sí», «gentle voice off», «gentle voice on»,
  «ir al agente pagub», «siguiente agente», two ~16-word dictation sentences,
  «sí, siguiente» at 1.25× and 0.85× rate, plus noisy copies of «sí, siguiente» and
  dictation 1.
- **Scoring:** transcripts normalized (case, accents, punctuation stripped), word-level
  edit distance. The two English phrases are scored apart: a model pinned to Spanish is
  expected to render them phonetically, so counting them as Spanish word errors would
  punish the correct behaviour.
- **Measurement:** one process per model, `numThreads: 4`, `provider: "cpu"`,
  `featureDim: 80`, 16 kHz input. Reported: recognizer construction time ("first
  load"), RSS after load, peak RSS, per-clip decode time and RTF (decode seconds per
  audio second). RTF on 1 s clips includes a fixed per-call overhead, so the ~5.5 s
  dictation clips are the honest speed figure.

## Candidates and measured results

Sizes are the exact byte count of the files that would be downloaded.
`exact` counts normalised phrase matches over the 12 Spanish clips.

| Candidate | API config | Download | Load | Peak RSS | RTF (dictation) | Word errors | Conv. |
|---|---|---|---|---|---|---|---|
| **Parakeet TDT 0.6B v3 int8** (today) | `transducer` | 670,478,772 B (639 MiB) | **43,699 ms** | 1,576 MB | 0.39–0.60 | 6/67 = 9.0% | 9/12 |
| **Whisper base int8, `language:"es"`** | `whisper` | **160,609,290 B (153 MiB)** | **1,733 ms** | **461 MB** | 0.39–0.73 | 10/67 = 14.9% | 9/12 |
| Whisper small int8, `language:"es"` | `whisper` | 375,485,327 B (358 MiB) | 3,352 ms | 954 MB | **1.10–2.32** | 6/67 = 9.0% | 9/12 |
| Whisper tiny int8, `language:"es"` | `whisper` | 103,609,903 B (99 MiB) | 1,310 ms | 343 MB | 0.23–0.36 | 32/67 = 47.8% | 5/12 |
| NeMo FastConformer CTC es-1424 int8 | `nemoCtc` | 131,663,316 B (126 MiB) | 4,132 ms | 347 MB | **0.07–0.08** | 16/67 = 23.9% | 6/12 |
| Canary 180m flash int8, `srcLang:"es"` | `canary` | 207,170,046 B (198 MiB) | 4,398 ms | 483 MB | 0.35–0.52 | 19/67 = 28.4% | 6/12 |
| Kroko es streaming zipformer fp32 | streaming | 155,838,792 B (149 MiB) | 7,063–11,373 ms | 353 MB | **0.07–0.13** | 6/67 = 9.0% | 9/12 |

### The phrase that started this (L5)

| Candidate | «sí, siguiente» | «no» | «dale» | «sí» |
|---|---|---|---|---|
| Parakeet v3 int8 | "Sí. Siguiente." | "No." | **"Далее."** (Russian) | **"See."** (English) |
| Whisper base int8 es | "Sí, siguiente." | "no" | "dale" | "Sí" |
| Whisper small int8 es | "Sí, siguiente." | "No." | "¿Dali?" | **"¡Siempre!"** |
| Whisper tiny int8 es | **"Si, si, y y y de."** | "No." | "Dale" | "si" |
| FastConformer CTC es int8 | "síí, siguiente" | "no" | "dale" | "Sí." |
| Canary 180m int8 es | **"Si."** (word lost) | "No." | "Dali" | "Si." |
| Kroko es streaming | "Sí, siguiente" | **"" (empty)** | "Dale" | "Sí" |

### English phrases, which every Spanish-pinned model mangles

| Candidate | «gentle voice off» | «gentle voice on» |
|---|---|---|
| Parakeet v3 int8 | "Gentle Boys of" | "Gentle Boyson." |
| Whisper base int8 es | "y entre el boys of" | "Yente el boy son." |
| FastConformer CTC es int8 | "Gentel Boyissof" | "Yentel Boisson" |
| Canary 180m int8 es | "Viente el Boy Soft." | "Yente el Boyson." |
| Kroko es streaming | "Gentle boys of" | "Gentle Boison" |

Re-running Whisper base with `language: "en"` does **not** rescue them: it produced
"Yente el Boisov" and "Yente el Boyson", and it translated «sí, siguiente» into
"Yes, next." (Whisper's `task` follows the audio, not the request). So an English retry
pass is not a fix for S4/S7.

### Dictation sentences

Both ~16-word sentences, verbatim reference:

- Parakeet: perfect on both (and on the noisy copy).
- Whisper base: 1 error each set (`worker de boss`, `pull de quest del bórquer de boss`,
  4 errors on the noisy copy).
- Whisper small: perfect on both and on the noisy copy, but at 1.8–2.3 RTF.
- FastConformer CTC es int8: `puulrequest del Walker Devos`, `pulvequest del Walker de
  vos` — word merges on English loanwords and no capitalisation.
- Canary: lost the ñ (`Ma ana`) even on clean audio.
- Kroko streaming: perfect except `pool request` on the noisy copy; no punctuation at all.

## Findings

1. **Fixing the language removes the failure the owner reported.** No candidate that
   pins Spanish ever answered in Russian or English. The baseline Parakeet flipped
   language on 2 of 8 short Spanish commands on clean TTS audio («dale» → "Далее.",
   «sí» → "See.") and turned «ir al agente pagub» into the Spanish homophone "Irá la
   gente PagUp.", so the defect is not speaker-specific; it is short-utterance language
   detection, and the owner's 2026-11-12 «sí, siguiente» → "And they're" is the same
   failure on real speech.
2. **Whisper base int8 with `language: "es"` is the best trade-off.** 153 MiB
   (a quarter of today's download), 1.7 s load instead of 43.7 s, 461 MB peak instead of
   1,576 MB. Decoding speed is comparable, not worse: 0.39–0.73 RTF against Parakeet's
   0.39–0.60 on the same clips, so a 5.5 s dictation costs ~2.2 s instead of ~3.4 s on
   the longest one, and the whole 43 s cold start disappears. It returns punctuation and
   capitalisation, which the worker's text path already expects.
3. **Whisper is only accurate from base up.** tiny destroys exactly the case that
   matters ("Si, si, y y y de." condition, 5/12).
4. **Whisper small is not usable interactively on this CPU:** 1.1–2.3 RTF at 4 threads
   means a 5.5 s dictation costs 6–13 s before the text appears; it also hallucinated
   "¡Siempre!" for «sí» and "¿Dali?" for «dale».
5. **The Spanish-only NeMo CTC is the fastest, not the most accurate.** 0.07 RTF,
   126 MiB, 347 MB peak, but 23.9% word errors, lowercase, occasional duplicated
   accents ("síí"), and joined English loanwords.
6. **No int8 Spanish transducer export exists.** `sherpa-onnx-nemo-fast-conformer-transducer-es-1424`
   is fp32 only (456 + 15.8 + 5.6 MB ≈ 477 MB); its `…-int8` sibling repository is
   empty apart from `.gitattributes`. So a Spanish-only, transducer-shaped, drop-in
   replacement would require a custom export and is bigger than Whisper base.
7. **The Spanish streaming model is the most accurate and the fastest, but it is a
   streaming model** (OnlineRecognizer, not the worker's offline API), emits no
   punctuation, and returned an **empty transcript for the single word «no»** — checked
   with 0.1 s, 0.32 s, 1 s and 5 s chunking and with 0.5 s of leading silence. One-word
   replies are exactly what S8 voice navigation would use, so it cannot be the only
   recogniser without that risk being tested on real speech.
8. **English wake/command phrases cannot be read by a Spanish-pinned ASR.** They come
   out phonetically in every candidate, and forcing English translates the Spanish. S4
   («gentle voice off») and S7 («gentle voice on») therefore need keyword spotting, or
   Spanish wording, not transcript matching of English text.

## Keyword spotting (S7) — available, but not for Spanish

`sherpa-onnx 1.13.8` ships `KeywordSpotter` (`keyword-spotter.js` in the installed
runtime), a streaming transducer that matches token sequences given as
`keywords.txt`. Its keyword list is regenerated at will, so no retraining is needed to
change the phrase.

Official model zoo (`https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html`):

| Model | Languages | Release asset | Notes |
|---|---|---|---|
| `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` | English | 17,626,723 B tarball (`kws-models` release, bz2, fp32 + int8) | the smallest pinnable option for an English phrase such as "gentle voice"; the int8 files inside are ~5 MB by the release layout; Apache-2.0 (icefall recipe) |
| `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` | Chinese + English | 32,885,699 B tarball | phone+ppinyin keyword input, larger |
| `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` | Chinese | ~18 MB tarball | not usable here |

**There is no official Spanish KWS model.** The only Spanish one found is a
third-party upload, `jguerrisi/sherpa-onnx-kws-zipformer-es-3M-2026-08-08`
(revision `b55eae785857eba4af1e24b200104354be23a975`): ~4.6 MB int8 encoder +
0.3 MB decoder + 0.2 MB joiner + `tokens.txt` + 0.2 MB `bpe.model` ≈ 5.3 MB (sizes as
reported by the Hugging Face API, not re-verified byte by byte), self-declared
`apache-2.0`, single unverified contributor, no training code link.
I would not pin it without the S7 real-voice test, and its licence claim is
unverifiable from the repository.

Practical consequence for S7: an English KWS model is the safe, pinnable choice while
the wake phrase stays English, because the phrase is matched as tokens by the spotter
itself and never passes through the Spanish ASR. With the owner's L8 decision (after
«Gentle Voice off» the system stays asleep — mic, readings and dictation off, only the
local spotter listening), the spotter is the one component that runs the whole time, so
its download size, its memory and its false-accept rate matter more than its Spanish
accuracy.

## Recommendation

**Pin Whisper base int8 (multilingual, `language: "es"`) as the dictation model**, and
keep a Spanish-only model as the documented alternative if download size must drop
below 130 MiB.

Pin, from `csukuangfj/sherpa-onnx-whisper-base`, revision
`bb53ee204431c90d314c1cc08d28d23e5b7927cc`
(base URL `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc`):

| File | Bytes | sha256 |
|---|---|---|
| `base-encoder.int8.onnx` | 29,120,534 | `0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11` |
| `base-decoder.int8.onnx` | 130,672,026 | `9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d` |
| `base-tokens.txt` | 816,730 | `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126` |

Total 160,609,290 B (153.2 MiB). Checked as one unit: the three files transcribe all
14 clips with the config below.

```js
new asr.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    whisper: {
      encoder: "<root>/base-encoder.int8.onnx",
      decoder: "<root>/base-decoder.int8.onnx",
      language: "es",
      task: "transcribe",
      tailPaddings: -1, // let sherpa pad; measured with -1
    },
    tokens: "<root>/base-tokens.txt",
    numThreads: 4,
    provider: "cpu",
    debug: 0,
  },
});
```

Licence: the upstream model card `openai/whisper-base` declares **Apache-2.0**; the
`csukuangfj` export repository carries no LICENSE file of its own, the same gap already
recorded for the Parakeet export in `VOICE_NOTICES`.

Alternative, if the download must stay under 130 MiB and speed matters more than
accents/loanwords: `csukuangfj/sherpa-onnx-nemo-fast-conformer-ctc-es-1424-int8`,
revision `05a9908f7571fd39c774445806dfb8189bcdb43d`:

| File | Bytes | sha256 |
|---|---|---|
| `model.int8.onnx` | 131,652,445 | `9539b206ba7cb46231e24eb1f1d7269370bfd45209c549d70e2bfd0e9f3b021a` |
| `tokens.txt` | 10,871 | `6191b4853e3654f053c42f6fd184ca53b402987aefdd6ff6baa68034d803ee85` |

Config: `modelConfig: { nemoCtc: { model }, tokens, numThreads: 4, provider: "cpu" }`.
Its provenance is almost certainly `nvidia/stt_es_fastconformer_hybrid_large_pc`
(es, `cc-by-4.0`, 1424 h of Fisher/VoxPopuli/MLS/CommonVoice, punctuated+capitalised
variant), but the export states neither the source model nor a licence, so the mapping
is inferred from name and architecture — worth an `unresolved` notice if adopted.

### What adopting Whisper costs in code (not done here, for the follow-up task)

Four touch points, all of them small but all of them contract-shaped:

1. `scripts/voice-worker.cjs:31` — `MODEL_ROLES` is the fixed set
   `["encoder","decoder","joiner","tokens"]` and `parseStart()` requires exactly those
   keys. Whisper has no `joiner`, so the start request needs a model *kind* (or a
   per-model role list) and the schema `gentle.voice/v1` changes shape.
2. `scripts/voice-worker.cjs:437` `loadRecognizer()` always builds a `transducer`
   model config with `modelType: "nemo_transducer"`; Whisper needs the `whisper` branch
   with `language: "es"`.
3. `lib/voice-session.ts:467` maps files by name prefix (`pick("encoder.")`,
   `pick("joiner.")`, …); the Whisper files are `base-encoder.int8.onnx`,
   `base-decoder.int8.onnx`, `base-tokens.txt`, so the manifest needs explicit roles
   instead of prefixes (or the files must be renamed on install; renaming is worse for
   digest bookkeeping).
4. `lib/voice-artifacts.ts:143` `PARAKEET_MODEL_MANIFEST` is the single model constant
   (`lib/voice-command.ts:305`, `lib/voice-install.ts:162`, `lib/voice-session.ts:442`
   all read it) plus a `VOICE_NOTICES` entry; a Whisper model means a second manifest,
   a selector, a size/notice update, and `docs/voice.md`.

Per-session decoding cost with Whisper base int8 is in the same range as Parakeet's:
a 5.5 s dictation takes ~2.2–3.4 s to decode at 4 threads, against ~2.7–3.4 s for the
current model, and the 43 s cold load becomes 1.7 s. Whisper also knows how to
"transcribe" silence into text; the worker's existing endpointer guard
(`scripts/voice-worker.cjs`, `endpointer.heardSpeech` short-circuit before the model is
asked) is what prevents that and must stay in place.

## Limits of this evidence

- The audio is **synthetic TTS from `Microsoft Raul`**, not the owner's voice and not a
  real microphone. TTS is cleaner than a room, so absolute error rates will be better
  than reality; what transfers is the *language behaviour* — a Spanish-pinned model
  cannot answer in Russian or English, while Parakeet can and does.
- Parakeet already failed on the owner's real «sí, siguiente» while it succeeded on the
  TTS version, so the flip is data-dependent. The conclusion "fix the language" does
  not depend on it; the *ranking* between Whisper base and FastConformer CTC es should
  still be confirmed on the owner's own voice (8 phrases, ~1 minute) before the swap
  ships.
- One microphone, one accent (es-MX TTS), one noise condition (10 dB SNR synthetic
  pink noise). "pagub", "herdr" and other invented proper nouns are the kind of token
  every model will mangle; the command matcher should not depend on their exact form.

## Where the evidence is

Fresh directory outside the worktree: `/tmp/stt-es-wovkL4/` — `synth.cjs` (OneCore
WAV writer, never plays), `addnoise.cjs`, `run.cjs` (offline harness),
`run-streaming.cjs`, `score.cjs`, `wav16/` (the 14 clips), and the per-model JSON
results (`base.json`, `ctc.json`, `canary.json`, `tiny.json`, `base-w.json`,
`small.json`, `kroko3.json`). The recommended Whisper base int8 files are kept under
`/tmp/stt-es-wovkL4/models/whisper-base/` (153 MiB); every other model download is
still under `/tmp/stt-es-wovkL4/models/` (Whisper tiny/small, FastConformer CTC es,
Canary, Kroko — about 930 MiB) because deleting files is outside the research worker's
safety envelope: the parent should remove `/tmp/stt-es-wovkL4/models/` except
`whisper-base/`, or the whole scratch directory once the numbers above are transcribed
into the task. The Windows temp folder used for synthesis
(`C:\Users\pablo\AppData\Local\Temp\stt-es-synth`, ~1 MB of WAVs) is likewise still
there and can be deleted the same way.
