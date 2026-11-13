# Echo cancellation and barge-in for Gentle Voice

Research for T11 (S13, supporting S7 and S10). Date 2026-11-12. Question: can the
microphone stay open while a reply plays, so the owner can interrupt a reading by
speaking, using only local components and no new reasoning model?

Everything below was measured or read in this worktree; nothing was played and the
microphone was never opened. The probe scripts lived in a scratch directory under
`$TMPDIR` and are not committed.

## The concrete problem

Readings play on Windows through a PowerShell player host (`lib/voice-onecore.ts:166`,
`lib/voice-kokoro-engine.ts` `KOKORO_PLAYER_SCRIPT`; cues use the long-lived host in
`lib/voice-cues-windows.ts:96`), while capture comes from WSLg's
`PulseAudioRDPSource` (`/mnt/wslg/`, verified through `$PULSE_SERVER` and `ldconfig`).
So the speaker echo and the owner's voice arrive on the same mono capture stream, and:

- any VAD on the raw microphone hears the reading and calls it the owner (S7: the
  voice must not hear its own reading);
- barge-in cannot distinguish "owner interrupted" from "the TTS said another word".

Measured (probe, section 3): Silero VAD marked **86 %** of the echo-only stretch as
speech. That is the whole problem in one number.

## 1. How runboubou/boubou does it

MIT, Rust 2024, and it supports **macOS and Linux only** (`src/main.rs:5`: compile
error otherwise), so there is no Windows AEC path to copy.

- **Linux** (`src/audio/linux.rs`, `Cargo.toml` comments): in-process WebRTC AEC3 via
  the `sonora` 0.3 crate, plus noise suppression and a high-pass filter. Speech
  detection is `earshot` 1.2 (small neural VAD), 256-sample windows. Capture 16 kHz
  mono, render 24 kHz mono, 20 ms frames (`FRAME = 320`), 10 ms render chunks; cpal
  talks to the default ALSA/PipeWire/PulseAudio device.
- **Reference signal**: the same in-process playback queue it writes to the device.
  Capture and playback share one process, so the render stream *is* the TTS PCM.
- **Echo-aware gating** (`src/audio.rs`, `Gate`): `CONVERGED = 200` frames (2 s),
  `SETTLED = 50` (0.5 s), `SPEECH = 0.5`, `OVER_REPLY = 0.8`. Rule: if the last 0.5 s
  had no audible playback, VAD score ≥ 0.5 counts; during playback require 2 s of
  convergence *and* score ≥ 0.8. Rationale in the source: AEC needs about a second
  to find the echo path, echo leaks score up to ~0.75, a person scores above 0.8.
- **Barge-in** (`src/main.rs`, `src/modular/chat.rs`): a near-end frame opens a turn;
  if a session is streaming, the app calls `audio.clear()`, clears its backlog,
  silences the panel and calls `session.interrupt()` — exactly our "cut the reading
  like Esc, keep the words that were cut". Esc does the same by hand.
- **macOS** (`native/audio.m`): the OS does it — `AVAudioEngine`
  `setVoiceProcessingEnabled:YES` (VoiceProcessingIO AEC) plus CoreAudio's
  `kAudioDevicePropertyVoiceActivityDetectionState` for an already echo-suppressed
  VAD.
- **Browsers** (`src/audio/remote.rs`): the page records and plays with the browser's
  own echo canceller and exchanges 20 ms / 16 kHz PCM16 with Boubou over a WebSocket,
  reporting playback so Boubou can still mark near-end speech.

Takeaway: nobody in boubou hand-rolls AEC. Every platform borrows the platform's or
WebRTC's canceller, and the hard part is the *gate* that decides when speech counts
while playback is live.

## 2. What can run locally in this setup

Setup: Node 22 in WSL2, microphone from WSLg (RDP source), playback on Windows through
PowerShell. pnpm only, so a package that needs a native build at install time is a
liability, and the runtime we already ship (`~/.pi/gentle-ai/voice/runtime/...`) is
the only pre-approved native surface.

### (a) Node AEC with our exact TTS as the reference — viable, recommended

The reference is already in our hands: `lib/voice-onecore.ts:210` queues exactly the
processed WAV the player receives (`scaleWav(processed, volume)`), and
`lib/voice-speech-events.ts:22` `PLAYBACK_MARKER = "play"` arrives as each sentence
*starts* playing. So we know both the samples and when they began. No clock sync is
needed: the unknown offset (WSLg capture latency + Windows output latency + acoustics)
is what AEC3 estimates by itself.

Candidates:

| package | version | licence | unpacked | build | notes |
| --- | --- | --- | --- | --- | --- |
| `@ai-ecoverse/wasm-webrtc-audio-processing` | 2.1.0-2 | BSD-3-Clause AND Apache-2.0 | ~617 KB (`dist/*.wasm` 536,773 B) | none; sync wasm, no fetch/TLA | WebRTC APM 2.1 (AEC3 + NS + high-pass + GMM VAD), Node entry `node.js`, `cancel(mic, reference)` → mono Float32, `latencySamples`, `stats()` (delayMs, erleDb, delayMedianMs, referenceDropped/Short) |
| `@ennuicastr/webrtcaec3.js` | 0.3.0 | BSD-3-Clause | ~789 KB | none | AEC3 port; README says use 48 kHz, most other rates "don't work"; no stats |
| `agent-voice-aec` | 0.1.1 | MIT | 4 KB | **native napi build** | SpeexDSP AEC; tiny but needs a toolchain at install |

Measured cost of the wasm option in this machine (probe, section 3): **6.3 % of one
core** (0.063× realtime) at 48 kHz mono with the TTS echo, 7 % at 16 kHz, 16 MB of wasm
linear memory, 537 KB of wasm, no native build, deterministic and offline.

### (b) Windows-side capture using the Windows echo canceller — plausible, unverified

Windows applies AEC on *capture* streams for apps that open WASAPI in the
communications category, when the endpoint exposes the voice-processing APO. It would
require a Windows-side capture host (the same shape as `lib/voice-cues-windows.ts`),
streaming PCM16 back to Node, replacing WSLg capture entirely.

Why it is attractive: it is the only option that removes the RDP audio path, and
Windows already owns the speaker that creates the echo. Why it is risky: nothing here
can verify it without playing audio and opening the microphone, which this task
forbids, and the failure is silent — you only learn by listening. It also splits
capture into a second platform path (PowerShell C#/WASAPI host) that has to be
maintained next to the WSLg one.

### (c) PulseAudio `module-echo-cancel` inside WSLg — not viable

Two independent blockers:

1. The module needs a render stream to subtract. Our replies play on **Windows**
   through PowerShell, so the WSLg PulseAudio server never sees them: there is no
   reference at all. This gets worse, not better: S1 moves the cues to the Windows
   output too.
2. No PulseAudio tooling is installed for it (`pactl`, `module-echo-cancel.so` both
   absent) and the WSLg audio server is Microsoft's RDP shim
   (`PulseAudioRDPSink`/`PulseAudioRDPSource`), not a distro PulseAudio we can
   configure.

Only viable if playback moved *into* WSLg, which S1 explicitly decides against.

### (d) Gating only: VAD plus a level threshold above the known TTS level — viable, weakest

Cheapest (zero new dependency: `sherpa-onnx-node` 1.13.8 is already installed and
exposes `Vad` with Silero and TEN configs). But the threshold has to sit above the
echo, and the echo tracks the reading's loudness, the speaker volume and the owner's
distance to the microphone. Measured margin here: near-end speech only 3 dB over the
echo in an adverse case, and the VAD scored the echo 86 % of the time. Gating works
when the owner speaks loudly and fails exactly when they speak quietly, which is when
they are most likely to be interrupted. Not sufficient alone; useful as the second
gate behind AEC.

## 3. Offline probe (no microphone, no playback)

Method, everything synthetic and in scratch: synthesized `Microsoft Raul` Spanish TTS
with the same WinRT pattern `lib/voice-onecore.ts` uses (`far.wav`, 22 s) and a short
`Microsoft David` sentence (`near.wav`) as the "owner". The simulated room delayed the
TTS by 250 ms, added five decaying reflections, one-pole colouration, noise at
-50 dBFS, and mixed the near-end sentence at +3 dB or +9 dB over the echo. Then
WebRTC AEC3 (`@ai-ecoverse/...`, reference = the exact TTS PCM, as in option (a)) and
Silero VAD via the installed `sherpa-onnx-node` ran over the result.

| measurement | result |
| --- | --- |
| AEC3 delay estimate vs injected 250 ms | 244 ms (16 kHz), 244 ms (48 kHz) |
| ERLE, echo only | 22.4-24.3 dB; residual -52 dBFS vs echo -27.8 dBFS |
| ERLE, near-end over echo (double talk) | 1.5-7 dB (near-end is preserved, echo partially) |
| CPU | 0.063× realtime @ 48 kHz, 0.07× @ 16 kHz, 0 errors |
| Silero on raw mic, echo-only stretch | **86 % of windows "speech"** |
| Silero after AEC3, echo-only stretch | **0 %** |
| Silero after AEC3, near-end stretch | 15-29 % of windows, but the same number of speech *segments* as on the raw signal |
| Silero first hit after near-end onset | 320 ms (best case) to ~1.5 s (quiet near-end) |
| Energy gate on the AEC residual at -45 dBFS | 0 % during echo only, fires at the near-end onset |

What this shows: with the exact reference, AEC3 removes the reading by 22-24 dB,
enough that a level gate on its output never fires on the reading and does fire the
moment the owner speaks. Silero stays useful as a confirmation, but its per-window
verdict over the AEC output is sparser than over the raw microphone, and its onset
can lag up to ~1.5 s when the near-end is only 3 dB above the echo — so **the gate,
not the VAD, must be what opens the turn**, exactly like boubou's `Gate`.

What it does not show: real speakers, real room, the WSLg RDP capture path (which adds
its own latency and may drop or reinsert packets), Windows volume changes, and the
double-talk behaviour of the real canceller. The convergence measured here is
optimistic (clean reference, fixed delay): the first 200 ms already reached ~30 dB
ERLE, where boubou still waits 2 s on real hardware.

## 4. Barge-in design

States while a reading plays: `idle` → `listening` (reading audible) → `barge`
(cut and open the mic). Per 20 ms capture frame:

1. Feed the frame and the matching reference slice to AEC3; the reference timeline is
   the queued sentence starting at its `play` marker.
2. Compute the residual level (RMS, or `stats().erleDb` for a sanity check); keep a
   slowly rising noise-floor estimate over frames where no playback is audible.
3. **Open a turn** when the residual is above `max(floor + 12 dB, -45 dBFS)` for ≥ 3
   consecutive frames (60 ms) *and* Silero confirms in the last 500 ms. Silence for
   600 ms closes it.
4. On barge: `audio.clear()` equivalent (abort the player host, which is the existing
   Esc path), close the speech-event stream, then open the microphone exactly the way
   a dictation turn does (`mic.reopen`, S2) with the interrupt context recorded like
   the Esc note in boubou's panel.
5. Guard the first 2 s of every reading (`CONVERGED`): require a higher residual, or
   ignore speech entirely, because the filter has not converged and echo leaks.

False-trigger risks with speakers, and the mitigations:

- **Music, video or another app's audio** in the room: not in our reference, so it is
  near-end by definition. Mitigation: it is the owner's own room; a barge can be
  undone with one word, and the cut reading is reported like the Esc path today.
- **The reading's own reverb tail** after `audio.clear()`: keep the last ~300 ms of
  reference and residual gating through it.
- **RDP capture jitter**: if the reference and capture drift past AEC3's ~500 ms
  delay window (`stats().delayMs` goes to its limit and ERLE collapses), fall back to
  gating only and say so in the overlay rather than cancel a reading everyone can see
  is still playing.
- **S7 interaction**: this is precisely what makes "Gentle Voice off" safe to hear
  while it is being read — with AEC plus the KWS model's own false-accept rate, the
  KWS threshold and the gate reinforce each other (see section 5).

## 5. Recommendation and phasing

Adopt option (a): AEC3 in Node over the reference we already hold, with the level gate
as the opener and Silero (already installed) as confirmation. Do not adopt (b) or (c)
now, and do not ship (d) alone.

- **Phase 0 (documentation only, now)**: this note. No code, no dependency.
- **Phase 1, after slice C** (capture moves into the listener): implement AEC in
  whichever process ends up owning *both* the microphone and the reply playback. That
  is the whole point of ordering it after slice C: today the player lives in the
  parent and the microphone in `scripts/voice-worker.cjs`, so an AEC today would need
  reference frames streamed across `gentle.voice/v1` (line-oriented JSON, 64 KiB per
  line; 48 kHz PCM16 ≈ 96 KB/s, so ~3 frames/s — possible, but it doubles the
  protocol for a component that is about to move). If slice C keeps playback on the
  Windows host and puts capture in the listener, the listener must receive the
  reference from the parent anyway; keep that reference frame shaped like the
  speech-event `chunk` payload (bounded, no text, no paths) so it adds no new privacy
  surface.
- **Phase 2, with KWS (T6, S4/S7)**: barge-in and keyword spotting share the same
  gated stream. Order the gates so "Gentle Voice off" can be heard *during* a reading
  (that is S7's requirement), which needs AEC before KWS, not the other way round.
- **Phase 3, optional**: replace the level gate with AEC3's own `stats().voice` GMM
  VAD, or with the Silero verdict once it is tuned on real recordings from this room.

Not justified: a new reasoning model. The barge-in decision is a threshold on a
20 ms residual, Pi remains the brain (S13's explicit constraint).

## 6. Risks and open questions

1. **RDP capture path.** Everything was measured on synthetic audio. `PulseAudioRDPSource`
   adds latency and can resample or reorder; AEC3 needs a stable delay. Verify first,
   with one real recording of a reading, before writing the design into code.
2. **Reference completeness.** The player host receives one processed sentence at a
   time and plays it synchronously, so the reference is exact — but only if the gate
   path never loses a `play` marker. `stats().referenceDropped`/`referenceShort` exist
   for exactly this and should be surfaced in the overlay during the trial.
3. **Level calibration.** -45 dBFS and floor + 12 dB are probe numbers, not this
   room's. They must be derived from a real session (boubou's 0.5/0.8 VAD thresholds
   came from the same kind of measurement).
4. **Dependency policy.** One new pure-wasm package (617 KB, no build step, no
   transitive deps, BSD-3-Clause/Apache-2.0) against a native build alternative. It
   must be pinned and vendored the way the voice runtime already is, and it belongs in
   the worker/listener process, never in the TUI process.
5. **S10.** Barge-in must keep every existing safety rule: no listening without a
   visible state, the asleep state after "off" still owns the microphone for KWS only,
   and the overlay must show that a reading was cut by voice, not crashed.
