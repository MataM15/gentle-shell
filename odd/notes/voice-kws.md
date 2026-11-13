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

## 11. The command that cuts a reading (S13)

S13 says a reading is interrupted by a spoken command and by nothing else, `L19` forbids
speech, noise and another person from cutting it, and `L20` says the microphone opens
right after the cut. T11 asks which words the command should be. Everything below is
offline: no microphone, no playback, nothing installed, one process per candidate, and
the configuration of §5 (boost 2.0, threshold 0.25, `maxActivePaths` 16, two trailing
blanks, one thread, int8) unless a row says otherwise. Command clips are synthesized
(Raul es-ES, David en-US) and peak-normalized to the owner's real peak, -14 dBFS
(`voice-echo-bargein.md` §7); readings are the same synthesizer, robotized, and scaled to
the three levels that matter below.

`cancel` is already a `VoiceKeywordCommand` in `lib/voice-artifacts.ts`, and
`assets/voice/kws-keywords.txt` records that it "is a known command with no line yet".
So this section decides one line, `cancel: <pieces>`, not a new vocabulary. The two
existing lines (`voice-on`, `voice-off`) were carried alongside in the cost run of §11.6.

### 11.1 The words and their pieces

| spoken | pieces | count |
| --- | --- | --- |
| Cancel. | `▁CAN CE L` | 3 |
| Gentle cancel. | `▁G ENT LE ▁CAN CE L` | 6 |
| **Gentle Voice cancel.** | `▁G ENT LE ▁ VO IC E ▁CAN CE L` | 10 |
| Gentle stop. | `▁G ENT LE ▁ST O P` | 6 |
| Gentle Voice stop. | `▁G ENT LE ▁ VO IC E ▁ST O P` | 10 |
| Gentle Voice off. (reference) | `▁G ENT LE ▁ VO IC E ▁OF F` | 9 |
| Gentle Voice cancel now. (extra) | `▁G ENT LE ▁ VO IC E ▁CAN CE L ▁NOW` | 11 |

`Gentle Voice off` is not a candidate for S13 (it is the S7 command that puts the listener
to sleep); it is measured here as the reference the other lines have to match. The encoder
reproduced the two shipped lines exactly (9/9 self-check), so the piece sequences above are
the ones this model really uses.

### 11.2 Quiet recall and latency

Five clips per voice, clean silence around the words, no reading:

| candidate | EN detected | median | max | ES detected | median | max |
| --- | --- | --- | --- | --- | --- | --- |
| Cancel. | 5/5 | 640 ms | 710 ms | **0/5** | — | — |
| Gentle cancel. | 5/5 | 530 ms | 630 ms | 4/5 | 530 ms | 680 ms |
| Gentle Voice cancel. | 5/5 | 490 ms | 690 ms | 5/5 | 610 ms | 710 ms |
| Gentle stop. | 5/5 | 580 ms | 710 ms | 4/5 | 580 ms | 730 ms |
| Gentle Voice stop. | 5/5 | 570 ms | 670 ms | 5/5 | 490 ms | 650 ms |
| Gentle Voice off. | 5/5 | 520 ms | 620 ms | 5/5 | 540 ms | 640 ms |
| Gentle Voice cancel now. | 5/5 | 320 ms | 510 ms | 5/5 | 440 ms | 470 ms |

Latency is measured from the moment speech stops, as in §4.3, so it is the spotter's own
delay before any listener dispatch.

The bare word is the only candidate a Spanish voice cannot say: zero out of five, and it
is not a threshold problem, because the same settings hear `Gentle cancel.` 4/5 and
`Gentle Voice cancel.` 5/5 with the same speaker. `gentle` in front gives the decoder a
running start; the isolated English `cancel` with Spanish vowels does not. For a
Spanish-speaking owner this alone rules out `Cancel.` as the whole command.

### 11.3 False accepts: ordinary speech and near-sounds

False accepts on the T6 negative sets, identical for all seven candidates:

| language | audio | hits | rate |
| --- | --- | --- | --- |
| Spanish | 18.05 min | 0 | 0/h (95 % bound ≈ 8/h) |
| English | 3.92 min | 0 | 0/h |

Each candidate also got near-sound sentences built for it: the misspoken command inside a
longer sentence ("embedded", where the surrounding words exist to be rejected) and short
utterances with nothing else around the phrase ("whole", where only the words themselves
can save it).

| candidate | embedded fired | whole fired |
| --- | --- | --- |
| Cancel. | 3/11 (0.80 min) | 0/9 (0.37 min) |
| Gentle cancel. | 0/7 (0.48 min) | 1/6 (0.28 min) |
| Gentle Voice cancel. | 2/6 (0.41 min) | 2/5 (0.27 min) |
| Gentle stop. | 3/9 (0.59 min) | 2/9 (0.40 min) |
| Gentle Voice stop. | 2/6 (0.42 min) | 2/5 (0.25 min) |
| Gentle Voice off. | 1/7 (0.52 min) | 2/5 (0.25 min) |
| Gentle Voice cancel now. | 2/5 (0.37 min) | 2/4 (0.22 min) |

Rates per hour from under a minute of audio mean nothing; the sentences matter:

- **Cancel.** (all Spanish, all in-sentence): "Tengo que cancelar la reunión de mañana a la
  mañana.", "La cancelación del vuelo nos costó bastante caro.", "Cancelaron el partido
  por la lluvia y no avisaron a nadie." One word of Spanish, said anywhere near the
  microphone, is enough. The whole-utterance gate of `S4` rejects all three (there are
  other words in the utterance), so this is a gate-load cost, not a lost case.
- **Gentle cancel.** — "Gentle cancer." (whole: nothing else in the utterance, the gate
  cannot help).
- **Gentle Voice cancel.** — whole: "Gentle voice candles.", "Gentle boys, cancel.";
  embedded: "The gentle voice cancellation feature was announced today.", "A gentle voice
  cancelled the meeting politely."
- **Gentle stop.** — whole: "Gentle stop, please." (extra word, gate-rejectable),
  "Gentle stock." (not rejectable); embedded: "The gentle stock market stopped moving
  today.", "The gentle top of the hill was windy.", "A gentle stop at the corner is all I
  ask."
- **Gentle Voice stop.** — whole: "Gentle voice stock.", "Gentle boys stop."; embedded:
  "The gentle voice stopping feature is written in the docs.", "A gentle voice stopped the
  meeting at noon."
- **Gentle Voice off.** — whole: "Gentle voice off, please." (gate-rejectable), "A gentle
  voice." (not); embedded: "A gentle voice offered to read the whole thing out loud."
- **Gentle Voice cancel now.** — whole: "Gentle voice candles now.", "Gentle boys, cancel
  now."; embedded: "The gentle voice cancelled now and then during the call."

Two things hold across the table. Every near-sound hit in the phrase candidates is the
English voice - no Spanish near-sound fired a phrase in 4.5 minutes of them across the six
phrase candidates, which is the opposite of what the bare word does. And every hit the
gate can repair is one with words around the phrase ("Gentle stop, please.", "Gentle boys,
cancel."); the ones it cannot are whole utterances that mishear a syllable ("candles",
"stock", "cancer", "A gentle voice."). That is the weakness T6 already recorded for
"gentle voice" alone (§4.4), and choosing a different tail does not remove it.

### 11.4 While a reading is playing

The command (peak -14 dBFS, the owner's level) is mixed over a reading at the two echo
levels `voice-echo-bargein.md` §7 measured, plus a third condition: the synthesized
readings have a 17.9 dB crest factor against the real recording's 12.2 dB, so scaling them
by median makes the mask harsher than reality. The third condition matches the real
**peak** (-24.5 dBFS) instead, which is the optimistic bound. Four mixes per condition and
candidate, eight for the finalists; each mix is a 5-9 s passage with the command at a
different fixed offset.

| candidate | ES headphones | EN headphones | ES speakers | EN speakers | ES speakers-peak | EN speakers-peak |
| --- | --- | --- | --- | --- | --- | --- |
| reading level | -53 median | -53 median | -36.7 median | -36.7 median | -24.5 peak | -24.5 peak |
| Cancel. | 1/4 | 3/4 | 0/4 | 0/4 | 0/4 | 2/4 |
| Gentle cancel. | 2/4 | 4/4 | 0/4 | 2/4 | 2/4 | 4/4 |
| Gentle Voice cancel. | 4/4 | 4/4 | 0/4 | 3/4 | 3/4 | 4/4 |
| Gentle stop. | 2/4 | 4/4 | 0/4 | 2/4 | 2/4 | 3/4 |
| Gentle Voice stop. | 4/4 | 4/4 | 0/4 | 1/4 | 2/4 | 4/4 |
| Gentle Voice off. | 4/4 | 4/4 | 0/4 | 1/4 | 2/4 | 4/4 |
| Gentle Voice cancel now. | 4/4 | 4/4 | 0/4 | 0/4 | 3/4 | 4/4 |

Eight mixes per condition for the four that could still win, plus the two knobs worth
re-checking:

| candidate / knob | ES hp | EN hp | ES spk | EN spk | ES spk-peak | EN spk-peak |
| --- | --- | --- | --- | --- | --- | --- |
| Gentle Voice cancel, boost 2.0, paths 16 | 8/8 | 8/8 | 0/8 | 6/8 | 6/8 | 8/8 |
| Gentle Voice cancel, boost 3.0, paths 16 | 8/8 | 8/8 | 0/8 | 6/8 | 6/8 | 8/8 |
| Gentle Voice cancel, boost 2.0, paths 32 | 8/8 | 8/8 | 1/8 | 6/8 | 7/8 | 8/8 |
| Gentle Voice stop, boost 2.0, paths 16 | 8/8 | 8/8 | 0/8 | 2/8 | 6/8 | 8/8 |
| Gentle cancel, boost 2.0, paths 16 | 5/8 | 8/8 | 0/8 | 5/8 | 4/8 | 8/8 |
| Gentle Voice cancel now, boost 2.0, paths 16 | 8/8 | 8/8 | 1/8 | 3/8 | 6/8 | 8/8 |

Latency inside the mix stays in the same band as §11.2, 420-680 ms after the words stop.

Reading: with headphones every phrase is heard every time, in both reading languages, and
the bare word is the only line that already fails there. On speakers at the real median
level the phrase barely survives a Spanish-accented command (0/8 for five of the six
re-run candidates, 1/8 for the sixth) while the English-voice command is heard 6/8: the
Spanish voice is the weaker acoustic match to an English model, so it needs a cleaner
snr. At the real peak the same Spanish-voice command is heard 6/8 - 8/8. Since the real
echo peaks (-24.5 dBFS) sit between the two scaled conditions, speakers are unresolved by
this measurement, and no choice of wording fixes it: all seven candidates behave the same
way there. Boost 3.0
changes nothing at all, and `maxActivePaths` 32 buys one Spanish speaker mix while adding
near-sound hits (whole 2/5 -> 4/5), so the recommended configuration stays as it is.

### 11.5 A reading that says the command

Each candidate's reading text was also fed to the spotter by itself, robotized, with the
command words inside a normal sentence and as a whole short sentence, at both levels. No
command was mixed in. Hits out of four feeds (two languages x two styles):

| candidate | speakers | headphones | what fired |
| --- | --- | --- | --- |
| Cancel. | 1/4 | 0/4 | EN embedded |
| Gentle cancel. | 2/4 | 1/4 | EN embedded, EN whole; EN whole |
| Gentle Voice cancel. | 2/4 | 2/4 | EN embedded, EN whole (both levels) |
| Gentle stop. | 1/4 | 1/4 | EN embedded; EN whole |
| Gentle Voice stop. | 2/4 | 2/4 | EN embedded, EN whole (both levels) |
| Gentle Voice off. | 2/4 | 2/4 | EN embedded, EN whole (both levels) |
| Gentle Voice cancel now. | 2/4 | 2/4 | EN embedded, EN whole (both levels) |

- Plain readings with no command words: 0 hits in 28 feeds (two controls x two levels x
  seven candidates), so the readings do not fire by themselves.
- Spanish-voice feeds: 0 hits in 28. Only the English reading fires, in both styles.

This is the finding that decides the design, and it is not about wording:

- **The whole-utterance rule does not protect a reading that says the phrase as its own
  short sentence.** "Gentle Voice cancel." as a chunk fires at speaker level and at
  headphone level. A reply that mentions the command in a sentence of its own therefore
  cuts itself, no matter which of these phrases is chosen.
- **Level cannot separate the owner from the echo.** The same feed fires at -53 dBFS
  median, 39 dB below the owner's voice, because the spotter's features are normalised for
  level. In the real run the speaker echo peaks (-24.5 dBFS) are only about 10 dB under
  the owner's peaks (-14 dBFS), so the two overlap anyway. Any "ignore quiet hits" or
  "require the owner's level" guard is refuted by both measurements.

So S13 needs a second guard, and it is textual and temporal rather than acoustic: while a
chunk whose text contains a command phrase is being read, drop hits for that chunk's
playback window plus a ~300 ms echo margin. The session already knows each chunk's text
and its playback window (that is what the overlay and the progress bar use), so the cost is
one flag and one deadline per chunk, and a hand-written phrase is still cut normally in
every other chunk. Without it, a reading that says the command cuts itself; with only the
audio, nothing in the audio tells the two apart.

### 11.6 Cost of carrying one more keyword

One spotter holding more lines, over the 18.05 min Spanish set, with each line's own clips
(EN and ES) run through the same instance to see what it reports back:

| lines | real-time factor | load | RSS | false accepts | cross-confusion |
| --- | --- | --- | --- | --- | --- |
| voice-off | 3.09 % | 1173 ms | 187 MB | 0 | — |
| voice-off + cancel | 3.29 % | 1102 ms | 214 MB | 0 | none |
| voice-off + cancel + voice-on | 3.17 % | 1491 ms | 239 MB | 0 | none |
| all seven at once | 2.99 % | 1005 ms | 264 MB | 0 | cancel now -> cancel |

The cost of one or two more lines is under the run-to-run noise: 3.0-3.3 % of real time for
one line and for seven. The RSS column is per spotter instance, not per line - the binding
has no `free()`, as §4.6 records, so each new instance costs about 25 MB. Two real
confusions in the seven-line file: `Gentle Voice cancel now` is reported as
`Gentle Voice cancel` (one line being a prefix of another), so those two must never share a
file, and bare `Cancel.` misses the Spanish voice again. A clean three-line file -
`voice-on`, `voice-off` and the new `cancel` line - has no confusion at all, which is the
file S7 actually ships.

### 11.7 What these measurements do NOT establish

- The **owner's own voice**. Raul is Castilian, not Argentine; `§9` already shows the real
  voice behaves differently from the synthetic one (faster, 8/10).
- The **real room and the real reading**: no reverb, no playback chain, no echo delay, no
  double-talk comb filtering. The mix is arithmetic, not acoustics.
- The **gate itself**. §11.3 reports spotter hits, not gate decisions: whether a given
  near-sound is rejected is my reading of the `S4` rule, not a measurement of an
  implementation that does not exist yet.
- **Speakers.** The two speaker conditions bracket the real echo but neither is it. That is
  exactly what §11.9 is for.
- **Another person in the room**, television, music, and hours of speech. The 18 min bound
  is the same one §6 disclaims.
- The **gate timings** in §11.8 (the silence before, the 0.5 s after, the 300 ms echo
  margin). They are design choices carried over from `S4`, not measurements of a built
  gate.

### 11.8 Recommendation

`Gentle Voice cancel` - one command word, `cancel`, behind the frame the listener already
has, as the line `cancel: ▁G ENT LE ▁ VO IC E ▁CAN CE L` in
`assets/voice/kws-keywords.txt`.

It is the best-recall line in the table (5/5 in both voices, 490 ms and 610 ms medians,
8/8 under a reading on headphones in both reading languages), it adds no Spanish
near-sound, and it is one word different from `Gentle Voice off`, so the owner has one
frame to remember and the spotter still separates the three tails cleanly (§11.6). The
trade-off is length: three words, ten pieces, about a second to say and one piece more than
`voice-off`, against 6-piece alternatives that lose a Spanish-voice attempt in clean audio
(`Gentle cancel.` 4/5, and only 5/8 on headphones) and against the single word, which a
Spanish voice cannot say at all. `Gentle Voice cancel now` detects 150-200 ms sooner and is
rejected anyway: it adds a common trailing word (`now`), its speaker numbers are no better,
and it brings the prefix confusion of §11.6.

Guards that come with the line, in the order they run:

1. Whole-utterance gate (`S4`): silence before the phrase (a few hundred ms), speech that
   ends right after it (within ~0.5 s), nothing else in the utterance. Rejects "el cancel
   de la puerta", "gente", "estoy", "top", "stock", "Cancelaron ..." and "Gentle voice
   candles, please".
2. Reading guard: while a chunk whose text contains a command phrase plays, drop hits for
   that window plus ~300 ms. Required by §11.5, and the reason the whole-utterance rule is
   not enough.
3. Stop the playback, do not mute it, and only then open the microphone (`L20`), with the
   hit shown in the overlay (`S10`) the same way `alt+m` is. A false accept costs a paused
   reading that can be resumed, never a lost paragraph.
4. Keep exactly one spelling per tail in the file (§11.6): `cancel` and `cancel now` must
   not both be lines.

### 11.9 The real-microphone check, one line

The recommended candidate, the owner's voice, the recommended configuration, with
`--max-active-paths 16` from the start (the scratch probe in §9 needed that fixed before
its run):

```bash
node /tmp/gpLPqO91/voice-kws-probe/scripts/real-command.mjs --candidate gentle-voice-cancel --keywords /tmp/gpLPqO91/voice-kws-probe/keywords/cmd/03-gentle-voice-cancel.txt --boost 2 --threshold 0.25 --max-active-paths 16
```

It asks for the phrase five times, then for seven near-sounds said on their own
("Cancelar.", "Cáncer.", "El cancel de la puerta.", "Gente, estoy.", "El stock.", "Stop.",
"Off."), which must not fire, then for 60 s of free Spanish speech. Worth repeating it once
with headphones and once with speakers, and worth saying the phrase over a reading, which
is the case §11.4 leaves open. Numbers only; the audio stays in memory and is dropped on
every exit path.

`--dry-run` on the same command prints the plan and returns before the spotter or the
capture module is required, so it provably opens no microphone: it prints
`native audio libraries loaded in this process: none`, read from the live process, and
lists the two native modules it would load without loading them. `bash
/tmp/gpLPqO91/voice-kws-probe/real-command.sh` runs the same thing and tees the numbers to
`results/real-command.txt`.

Covered here: **S13** (the command and its guards), with **S7** for the keyword family and
the configuration, **S10** for the stop/open/overlay order, **S11** for the `cancel` name
(`cancel` is also the word that discards a pending transcript, and the two cannot collide
because one happens while a reading plays and the other while a transcript is pending),
and `L19`/`L20` for "only a spoken command cuts it" and "the mic opens after the cut".

Scratch, outside the repository in `/tmp/gpLPqO91/voice-kws-probe/`: `scripts/cmd-corpus.mjs`
(the candidates, near-sound sentences and readings), `scripts/cmd-synth.mjs` (silent
OneCore synthesis, 200 clips), `scripts/cmd-probe.mjs` (this section's measurements, with
`--cost`), `scripts/real-command.mjs` and `real-command.sh` (§11.9),
`keywords/cmd/` (one file per candidate and the cost files), `cmd-matrix.sh`,
`cmd-sweep.sh` and `results/s13-cmd.jsonl`, `results/s13-sweep.jsonl`,
`results/s13-cost.jsonl` (every row behind these tables). The `audio/` (258 T6 clips) and
`audio-cmd/` (200 S13 clips) WAVs are still there, 70 MB together; `cmd-synth.mjs`
regenerates them in four minutes.
