# Local keyword spotting for "Gentle Voice on" / "Gentle Voice off" (S7 research)

Research for T6 (`odd/tasks/voice-control.md`, specs S7, S4, S10, context from L8/L9/L10).
Question: can the **already installed** voice runtime listen for the two English wake
phrases locally, cheaply and safely enough to be the floor of the asleep state?

Everything below was measured on this machine, offline, with the runtime already under
`~/.pi/gentle-ai/voice/runtime/`. Nothing was installed, built, added to
`node_modules`, played through a speaker, or committed. **No audio was played at all**:
the test audio was synthesized with the project's own OneCore script and the WAV bytes
were taken before any player process exists, so no player was even spawned.

## 1. Model pin

| | |
|---|---|
| Model | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` |
| Source (verified, HTTP 200) | `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2` |
| Size | 17,626,723 bytes |
| sha256 | `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a` |
| Licence | Apache License 2.0 (model `README.md`: `license: Apache License 2.0`, `tasks: keyword-spotting`) |
| Training data | GigaSpeech XL, 10000 h English; zipformer transducer, 3.3 M parameters, BPE units (`bpe.model`, 500 pieces) |

Apache-2.0 matches every other voice artifact this project pins, so the licence is not a
blocker. Observed download redirect: `github.com` answers **302** to
`https://release-assets.githubusercontent.com/github-production-release-asset/...` with a
short-lived signed query string (`se=` / `sig=`), then **200**. A pinned manifest would
have to allow exactly that origin and prefix, the same way `PARAKEET_MODEL_MANIFEST`
allows its own two redirects (`lib/voice-artifacts.ts`).

The release ships **one tarball**, not per-file assets, and the HuggingFace mirror
(`csukuangfj/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`) answers **401** to an
anonymous request for both the API and every `resolve/main/...` file. So the only
verified source today is the GitHub tarball; per-file pinning was attempted and could not
be verified. That matters, because `installVoiceModel` downloads individual files from
`${baseUrl}/${name}` and has no archive step (`lib/voice-install.ts`).

Extracted contents (verified by re-hashing my own extraction, `tar -tjvf` then
`sha256sum`):

| File | Size | sha256 |
|---|---|---|
| `encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx` | 4,807,159 | `1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678` |
| `decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx` | 277,985 | `e40ff43297abe815e8898494c17e71bba2152d9d40fa3eb803f75d0f7533329a` |
| `joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx` | 163,380 | `eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c` |
| `tokens.txt` | 5,006 | `fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53` |
| `bpe.model` (only needed to *encode* keywords, not to run the spotter) | 244,837 | `c8a2a0129c4ab8e463164c142f82d25649661b122c8cd0b7aab5c9e80b90ad24` |
| `keywords.txt` (shipped example, not ours) | 184 | `b1740c4925d7c83337de2cffa04e8d35450fab2af8f583e65c54aad6257c4bd6` |
| fp32 variants (`encoder`/`decoder`/`joiner` `.onnx`) | 12,174,219 / 1,063,189 / 642,462 | not needed, see §5 |

The four files the spotter actually needs total **5,253,530 bytes** (int8 set + tokens).

## 2. How the keywords are written

`sherpa-onnx-node`'s `KeywordSpotter` takes a `keywordsFile`: one keyword per line,
space-separated **pieces as they appear in `tokens.txt`**. This model is a
sentencepiece **unigram** model (not BPE), so the pieces are not obvious by eye.

Encoding, verified before use: a throwaway sentencepiece-compatible encoder (protobuf
read of `bpe.model` + Viterbi over the unigram lattice, `add_dummy_prefix=true`,
`escape_whitespaces=true`) reproduces **9/9** of the model's own shipped keyword lines
exactly (e.g. `PLAY MUSIC` → `▁P LAY ▁MU S IC`). With that encoder:

```text
▁G ENT LE ▁ VO IC E ▁ON
▁G ENT LE ▁ VO IC E ▁OF F
```

`▁` is the word-boundary piece (U+2581). Two encoding facts cost hours to find and should
not be rediscovered:

- The **standalone `▁` between "gentle" and "voice" is required**. It looks like a typo;
  it is what the acoustic model emits: reading the same audio with this model as an
  ordinary streaming ASR gives tokens `["▁G","ENT","LE","▁","VO","IC","E","▁ON"]`. There is
  no `▁VO` piece in the 500-piece vocab, so the boundary cannot be folded into the next
  word. Encoding the phrase as one word (`GENTLEVOICEON` → `▁G ENT LE VO IC E ON`)
  removes the boundary and drops recall to 5/10 (see §4, table 1).
- The first token must keep its `▁` (`G ENT LE …` detects nothing).

Per-line suffixes also work (`:boost` and `#threshold` after the pieces), and the two
global fields `keywordsScore` / `keywordsThreshold` do the same job for every line; the
per-line form is the one to use once "on" and "off" need different tuning. The measured
global settings are in §4.

The keyword file is tiny and its encoding is *verifiable*: pin the two lines as an
artifact in the repository with `sha256
6cfb2f1428f40838991392eaf13503c2e5d02dd4ccd6c5f1c84c03cf5eba05ce` (that is the two-line
file measured here), and a test can assert the file's bytes. `bpe.model` does not need to
be installed at runtime.

## 3. Method and corpus

Probe: `scripts/probe.mjs` in the scratch directory (§8) loads `KeywordSpotter` from the
installed runtime and feeds PCM in 100 ms chunks through `createStream` /
`acceptWaveform` / `decode` / `getResult`, resetting the stream after each hit, which is
what a live listener will do. No microphone, no speaker, no player.

Test audio, synthesized with `ONECORE_SYNTH_SCRIPTS` from `lib/voice-onecore.ts`
(`Microsoft David` for English, `Microsoft Raul` for Spanish) and never played:

| Group | Clips | Content |
|---|---|---|
| isolated phrase | 20 | both phrases × {David, Raul} × 5 lead/trail silence paddings (200 ms–1.5 s) and rates (0.9/1.0/1.1) |
| robotized | 4 | the same first clip per voice/phrase after `processRobotVoice`, i.e. what a reading sounds like |
| embedded | 10 | the phrase inside a longer sentence, Spanish and English voice (S4's hard case) |
| near miss | 11 | "una voz suave", "her voice sounded gentle", "the voice of the engine came on and off", "a gentle voice, please" |
| ordinary Spanish | 18.05 min | 57 paragraphs × 3 delivery rates, no phrase anywhere |
| ordinary English | 3.92 min | 14 sentences × 3 rates |

Latency is measured from the last energy-flagged 10 ms window of the clip (the dictation
worker's own floor `0.005` and ratio `3`), i.e. from "the words stopped", not from end of
file. False accepts are counted over one continuous stream per language.

Caveat stated up front: `Microsoft Raul` is Castilian Spanish, not the owner's Argentine
accent. It is a stand-in for "an English phrase said by a Spanish-speaking voice", not a
measurement of the owner.

## 4. Measurements

### 4.1 Encoding variants (two-line file unless stated, maxActivePaths 4, boost 2.0, threshold 0.25)

| Keyword line | en voice | es voice |
|---|---|---|
| `▁G ENT LE ▁ VO IC E ▁ON` / `… ▁OF F` | on and off both hit | on and off both hit |
| `▁G ENT LE VO IC E ▁ON` (no boundary piece) | on hits | on misses |
| `▁G ENT LE ▁ON` | misses | misses |
| `G ENT LE ▁ VO IC E ▁ON` (no leading `▁`) | misses | misses |
| `G ENT LE VO IC E ON` (letters only) | misses | misses |
| `VO IC E ▁ON` (tail only) | misses | misses |

Rows two to six carried only the ON keyword, so "misses" means the ON line did not fire on
the ON clip. The phrase spelled as one word (`GENTLEVOICEON` → `▁G ENT LE VO IC E ON`) did
not fire on the English ON clip at boost 1, 2 or 4, and fired only the OFF clip at boost 4.

The exact sequence the model emits (§2) is the only one that keeps recall; every shortened
or letter-only variant lost at least one language.

### 4.2 The decisive knob: `maxActivePaths`

The default is 4. With a 9-piece keyword the beam has to keep the keyword hypothesis
alive across a word boundary, and four paths are not enough for a Spanish voice.

| Configuration | en-on | en-off | es-on | es-off | embedded | near miss | false accepts (ES 18.1 min / EN 3.9 min) |
|---|---|---|---|---|---|---|---|
| boost 2.0, th 0.25, **paths 4** | 5/5 | 5/5 | **2/5** | **1/5** | 6/10 | 0/11 | 0 / 0 |
| boost 1.0, th 0.25, **paths 16** | 5/5 | 5/5 | 5/5 | 5/5 | 9/10 | 1/11 | 0 / 0 |
| **boost 2.0, th 0.25, paths 16** | 5/5 | 5/5 | 5/5 | 5/5 | 10/10 | 1/11 | 0 / 0 |
| boost 3.0, th 0.25, paths 16 | 5/5 | 5/5 | 5/5 | 5/5 | 10/10 | 1/11 | 0 / 0 |
| boost 3.0, th 0.10, paths 16 | 5/5 | 5/5 | 5/5 | 5/5 | 10/10 | 2/11 | **2 (6.6/h)** / 0 |

Threshold 0.05 / 0.10 / 0.25 / 0.30 are **indistinguishable** at boost ≤ 3; the boost is
what actually admits or rejects a hypothesis, and above 3 it starts to hurt both ways: at
paths 16 the Spanish clips begin to drop (boost 8.0, th 0.20: es-on 3/5, es-off 2/5) and
the English voice drops too (at the default paths 4, boost 6.0 / th 0.25: en-off 3/5),
while Spanish false accepts grow. Boost 4.0 / th 0.10 on the earlier, shorter 5.7-minute
Spanish corpus accepted 3 hits there (~32/h), which is why 3.0 is the ceiling kept in the
table.

### 4.3 Latency, recommended configuration

Boost 2.0, threshold 0.25, paths 16, trailing blanks 2, one thread — per-clip detail:

| Group | Hits | Latency after the words stopped (median / max) |
|---|---|---|
| en-on | 5/5 | 350 / 450 ms |
| en-off | 5/5 | 520 / 620 ms |
| es-on | 5/5 | 370 / 470 ms |
| es-off | 5/5 | 540 / 640 ms |

Granularity is the 100 ms feed chunk plus `numTrailingBlanks`. `numTrailingBlanks` 1 gives
the same detections and slightly shorter latency; 3 adds ~100 ms with no gain. On/off
confusions: **0** in all 40 attempts above (every hit named the phrase that was spoken).

### 4.4 Self-hearing and the S4 rule

- Robotized clips (what a reading sounds like through `processRobotVoice`): detected 2/4 —
  both English-voice clips, neither Spanish-voice clip. So the spotter **can** hear a
  reading; the listener must not rely on the model to ignore it.
- Embedded phrases (nothing but the phrase inside a sentence): **10/10 detected**. The
  spotter matches token sequences and has no notion of an utterance, so S4's "only a whole
  utterance that is the command counts" **cannot** come from the model. The listener has to
  require silence before the phrase, an utterance that ends right after it, and then
  discard the text.
- Near miss "He has a very gentle voice, and the children listen to him." fires "GENTLE
  VOICE ON" at boost 2.0/paths 16 (1/11 near misses). "gentle voice" alone is enough; the
  final word is not verified by any second pass.

### 4.5 False accepts

**0 hits in 22.0 minutes** of ordinary synthesized speech (18.05 min Spanish, 3.92 min
English) at boost 2.0 / th 0.25 / paths 16, and 0 at boost 1.0 and 3.0 as well. Rule of
three: with zero events this only bounds the rate below roughly **8 per hour** at 95 %
confidence. It does not prove "never"; a multi-hour run (and the real-mic run) is what
would.

### 4.6 Cost

| | int8 | fp32 |
|---|---|---|
| Model size on disk | 5.25 MB | 22.16 MB |
| Detections (all four groups) | 5/5, 5/5, 5/5, 5/5 | identical |
| False accepts | 0 in 22.0 min | 0 in 22.0 min |
| Load time (fresh process) | 0.76–0.87 s | 0.58–0.70 s |
| RSS, Node baseline → after load | 75 → 111 MB (+36) | 74 → 116 MB (+42) |
| Decode cost, 1 thread | **2.1 % of realtime** | not measured |
| Decode cost, 2 threads | 2.1 % | not measured |
| Decode cost, 4 threads | 2.3 % | 2.7 % |

extra threads buy nothing (a 3.3 M-parameter model on 160 ms chunks), so one thread is the
right choice and leaves the rest of the core alone. Memory is flat while streaming: one
instance decoded 18 minutes of continuous audio with no measurable RSS growth.

One operational detail: the JS wrapper has no `free()`, and building many spotters in one
process grew RSS by ~40 MB each (182 → 386 MB over six). A listener must create **one**
instance for its lifetime, never per utterance.

## 5. Recommended configuration (and the trade-off)

```text
keywordsFile       <pinned two-line keyword file>
keywordsScore      2.0      # boost
keywordsThreshold  0.25
maxActivePaths     16       # the knob that makes a Spanish voice work
numTrailingBlanks  2
numThreads         1
model              int8 encoder/decoder/joiner + tokens.txt (5.25 MB)
```

Trade-off: `maxActivePaths 16` is what lifts Spanish-voice recall from 3/10 to 10/10, and
it is also what lets one near-miss sentence through. Going further (boost 4) starts
accepting ordinary Spanish at ~30/h, which is unusable; staying at the default 4 makes the
phrase fail two times out of three when it is not said by an English voice. int8 over fp32
costs nothing measurable in accuracy and saves 17 MB.

The honest summary for S7: with a **Spanish-accented voice**, a well-tuned English keyword
spotter hears this phrase reliably **in synthetic audio with clean silence around it**;
that is not the same as a real room, and the phrase "gentle voice" alone can fire it.

## 6. What these measurements do NOT establish

- The **real microphone**: no room noise, no fan, no distance, no reverb. Nothing here
  exercises `node-cpal` capture or the 48 kHz → 16 kHz path in the listener.
- The **owner's own pronunciation**. Raul is Castilian, the owner speaks Argentine
  Spanish; the real rate may be better or worse than 10/10.
- **Self-hearing during a real reading** through the speakers. The robotized clips are a
  proxy (2/4 detected) and `odd/notes/voice-echo-bargein.md` §7 records that the speakers
  run has not happened yet, so the reading-versus-command question stays open.
- **Dictation interplay**: the listener will be sharing one device with a Whisper
  dictation path; nothing here measures who owns the stream when both want it.
- **End-to-end wake latency**: 0.25–0.65 s is the spotter's own delay after the words
  stop, before any listener dispatch, cue or overlay update.
- **Hours of ordinary speech.** 22 minutes with zero false accepts bounds the rate below
  ~8/h, nothing stronger.
- French/Russian/etc. other-language false accepts, or music, television and other people
  talking in the same room.

## 7. Proposed T6 implementation slices

1. **Pin and install the model** (`lib/voice-artifacts.ts`, `lib/voice-install.ts`). The
   existing model installer downloads individual files from `${baseUrl}/${name}` and
   verifies `{size, sha256}` per file, then publishes with one rename and a
   `.gentle-voice.json` marker; the tested source is a single `.tar.bz2`, so the manifest
   needs an archive shape (url, size, sha256, `format: "tar.bz2"`, plus the per-entry
   `{name, size, sha256}` list in §1) reusing `readArchive`'s validation rules and the
   same staging/publish path, extracting with `bzip2 -dc` (the runtime installer already
   shells out to nothing today, so this is a real decision, not a detail) — or the
   keywords are pinned alone and the model files come from a future per-file source.
   New id, e.g. `kws-zipformer-gigaspeech-3.3M-int8-<revision>`; the keyword file is a
   repository artifact with its own digest, not a download.
2. **One spotter inside the single listener** (S6). One `KeywordSpotter` instance for the
   process lifetime, its own stream fed from the capture path the listener already owns,
   configuration from §5. Counters: hits, hits closed by silence, hits discarded as
   embedded.
3. **The asleep state** (S7/L8/L10). After "Gentle Voice off": voice off **in every
   session**, mic and readings off, only the spotter listening, overlay shows asleep. "on"
   wakes the listener and turns voice on for the focused session only. Asleep with no
   session that has voice: 10 minutes, then the listener releases the microphone and the
   spotter with it.
4. **The S4 gate in the listener, not in the model.** A hit is a candidate: require
   silence before the phrase, an endpoint within ~0.5 s after it, and nothing else in the
   utterance; otherwise the audio goes to dictation as normal text. Measured need: 10/10
   embedded phrases fire the spotter.
5. **Do not accept a hit from our own reading** (S7 "must not hear its own reading").
   While a reading plays the listener ignores the spotter (it already knows when a reading
   starts and ends); the robotized 2/4 shows the model will otherwise hear it. Confirm with
   the speakers run in `voice-echo-bargein.md` before relying on this alone.
6. **Tournament of states in the overlay** (S5/S10): asleep must be visible; every
   activation is visible and audible; false activations close on silence and are logged.

## 8. S10 safety points for this feature

- Fixed phrase list only, never free text: the spotter can only ever emit the two pinned
  keywords, which is the strongest form of "voice never runs free text as a command".
- Nothing destructive or publishing is reachable from a keyword; a keyword only changes
  who is listening.
- The asleep state releases the microphone instead of leaving it open with a filter on.
- Every activation is visible (overlay state) and audible (S1 cues); false activations
  close on silence and are logged with their counters.
- Alt+M keeps working as fallback regardless of the spotter's state.
- Audio stays local and is not stored: the probe keeps only the chunks still in flight
  (at most four 100 ms buffers), zeroes them on every exit path including
  SIGINT/SIGTERM/SIGHUP, and writes no file, log or transcript; the same rule applies to
  the listener.
- Development probes stay near-silent: this research produced **no audible output at all**
  (no player process was ever spawned; peaks in the WAVs were only read, never played).

## 9. Real-microphone results

Run by the owner on 2026-11-13 with his own voice and microphone, recommended
configuration (boost 2.0, threshold 0.25, `maxActivePaths` 16, one thread, int8). The
probe's `--real` mode originally left `maxActivePaths` at 4; the parent fixed that in the
scratch probe before the run. Numbers only; the audio stayed in memory.

| phrase | attempt 1 | 2 | 3 | 4 | 5 | detected | latency median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gentle Voice on | hit 170 ms | hit 190 ms | hit 140 ms | **no hit** | hit 190 ms | 4/5 | 180 ms |
| Gentle Voice off | hit 430 ms | hit 610 ms | hit 410 ms | **no hit** | hit 260 ms | 4/5 | 420 ms |

- On/off confusions: 0 in 8 detections.
- Free Spanish speech: 0 hits in 1.00 min (one minute bounds nothing useful about the
  hourly rate; it only shows no immediate false accepts).
- Model load 878 ms; RSS 103 MB after load, 119 MB at the end; capture 44100 Hz mono f32.

Reading: the model hears the owner's pronunciation (8 of 10, never the wrong phrase),
faster than on the synthetic voices, but not every time: one miss per phrase in five.
Five attempts cannot tell 80 % from 95 %. It is enough to build T6 on this model, with
three consequences for the implementation: the configuration stays tunable without a
code change; a miss must be cheap (saying the phrase again works, and `alt+m` and the
menu always remain, S10); and the keyword file should be able to carry more than one
spelling per command, so pronunciation variants can be added and re-measured with the
same probe before changing thresholds.

Command, one line, ready to paste (no `--repo`, no build, no install; writes nothing):

```bash
node /tmp/gpLPqO91/voice-kws-probe/scripts/probe.mjs --model /tmp/gpLPqO91/voice-kws-probe/model/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 --real --keywords /tmp/gpLPqO91/voice-kws-probe/keywords/spaced.txt --boost 2 --threshold 0.25 --max-active-paths 16
```

`--dry-run` on the same command prints the plan and returns before any capture module is
required, so it provably opens no microphone.

## 10. Scratch artifacts

Kept outside the repository, in `/tmp/gpLPqO91/voice-kws-probe/`:

- `download/` — the original tarball, unmodified.
- `model/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/` — extracted model.
- `scripts/bpe-tokens.mjs` — the throwaway unigram encoder (9/9 self-check).
- `scripts/synth.mjs`, `scripts/corpus.mjs` — silent OneCore synthesis and its texts.
- `scripts/probe.mjs` — the offline probe and the `--real` mode; `scripts/detail.mjs`,
  `scripts/variant-run.mjs`, `scripts/es-axis.mjs`, `scripts/online-asr.mjs` — the
  measurement helpers behind the tables.
- `keywords/` — the keyword files, `spaced.txt` being the pinned two lines.
- `results-final.jsonl`, `results-spaced.jsonl`, `results-p16.jsonl` — every row behind
  the tables.

The synthesized WAVs were deleted after the run; `synth.mjs` regenerates them in seconds.
