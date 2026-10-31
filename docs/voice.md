# Optional local voice dictation

Voice dictation is optional. It transcribes speech locally with NVIDIA Parakeet
through sherpa-onnx, with no API key and no cloud inference. Everything happens
from `/gentle:voice`; nothing described here runs at startup.

## Quick path

1. Run `/gentle:voice` and choose **Download voice dictation**. The
   confirmation lists each component, its size, the destination directory,
   the licenses and the platform limitations. Esc during the download cancels it.
2. Run `/gentle:voice` again and choose **Start dictation**. Speak, then press
   Enter to stop. Esc cancels at any point.
3. The transcript is pasted into the editor draft at the cursor. It is never
   sent automatically. Pi collapses pastes over 1,000 characters or 10 lines into
   a `[paste #N …]` marker; the full text is retained and expanded when you submit.
   Long transcripts are therefore not displayed as editable text in the draft.
4. Or hold Space in the editor: push-to-talk is turned on by a successful
   download. See [Push-to-talk](#push-to-talk-hold-space).
5. Or press the dictation shortcut once to start listening and the same
   shortcut again to stop, with no key held down. See
   [Toggle dictation](#toggle-dictation-one-shortcut).

## The command

| Topic | Behavior |
|-------|----------|
| Menu | Built-in select and confirm dialogs. **Show status and notices** reports the target, both components, limitations and licenses. **Disable push-to-talk (hold Space)** appears while it is on; **Enable push-to-talk (hold Space)** appears only when voice is installed. |
| Download | Only after the confirmation; runtime first, then the model. A cancelled download keeps components that already finished. |
| Dictation | A compact overlay shows preparing, recording, transcribing. Enter stops recording; the overlay stays until the transcript is ready. |
| Recording limit | After 2 minutes recording stops by itself, and the transcript is pasted without a key press. |
| Insertion | The recognized text goes through Pi's editor paste pipeline, which may collapse long text into a paste marker. A blank result pastes nothing. |
| One at a time | A second `/gentle:voice` while a download or dictation runs is refused with a notice. A Space hold during either one types spaces as usual. The dictation shortcut is refused the same way. |
| Cancel and shutdown | Esc, reload or session shutdown aborts the download or cancels the session. A transcript that arrives afterwards is dropped. |
| Where it runs | Interactive TUI parent sessions only. RPC, print, JSON and delegated child sessions refuse it. No model-callable tool exists. |
| Errors | Fixed messages with the action to take, such as installing ALSA or the Visual C++ runtime. Gentle AI never runs those installers. |

The command is tested with fake dialogs, downloads and sessions only. No real
download, native load or microphone recording has been exercised through it.

## Push-to-talk (hold Space)

Hold Space in the editor to record; release it to stop. The transcript is
pasted at the cursor and never sent. Esc cancels while recording or
transcribing. A one-line footer status shows preparing, recording and
transcribing; no overlay opens, so the editor keeps the focus. In a wide fullscreen sidebar, a pinned voice line shows preparing, listening, or transcribing while active. It uses session-scoped voice events and hides when idle; listening is published after recording starts. The indicator is tested with simulated sessions, not a real microphone or keypress.

| Topic | Behavior |
|-------|----------|
| Toggle | Stored as `voice-settings.json` (`gentle-pi.voice-settings/v1`) in the Gentle AI config home. A successful download turns it on; the `/gentle:voice` menu turns it off and on, effective immediately. A missing or malformed file means off. |
| When it is armed | Only with the toggle on, in an interactive TUI parent session. Delegated child sessions, RPC, print and JSON modes never arm it. Reload or shutdown disarms it and cancels a running dictation. |
| Startup | Reads the toggle file only. No voice files are checked, nothing is downloaded or loaded, and no worker starts. |
| First hold | Checks that the runtime and model are installed; the spaces keep typing meanwhile. If voice is not installed, a notice points to `/gentle:voice` and push-to-talk stays off for the session; the saved choice is kept. |
| One at a time | A hold while a download or dictation runs types spaces normally. |

### How a hold is recognized

With Pi's keyboard mode, terminals report Space as plain text and never report
its release, so push-to-talk relies on the operating system's key auto-repeat.
Pi lets an extension drop or replace a key as it arrives, but not type one
later, so every space reaches the editor unchanged:

- **Typing:** a tap, several spaces, an indent or Space then a letter are
  typed exactly as without push-to-talk, with no delay.
- **Hold:** auto-repeat has a long initial delay followed by short, regular
  repeats; typing does not. A hold needs a first gap of 180 to 1000 ms (macOS
  allows at least about 225 ms, X11 defaults to 660 ms), then three repeats
  each at most 250 ms apart and regular (the slowest at most 1.6 times the
  fastest), with the first gap at least 1.5 times the slowest repeat. Each
  space must have added exactly one space to the draft. The following repeats
  are turned into Backspace, through the editor's normal key path, until the
  spaces the hold typed are removed; when the hold followed a word, one space
  stays as the separator before the transcript. Later repeats are dropped.
  While recording starts, those spaces can be seen briefly.
- **Release:** no repeat for 2.5 times the observed repeat interval, between
  150 and 400 ms. The decision waits until input already queued is handled, so
  a repeat delayed by a busy moment is not taken for a release.
- **Guards:** only single-space input counts. Pastes, escape sequences and
  multi-character input pass through and end the attempt. If the draft changes
  in any other way, for example Vim NORMAL mode where Space only moves the
  cursor, autocomplete, or another key, the hold is not confirmed, or erasing
  stops, and nothing else is removed. Spaces that were in the draft before the
  hold are never removed.

Limitations: the timing depends on the keyboard repeat settings. An initial
repeat delay under 180 ms or over 1000 ms, or a repeat interval over 250 ms,
prevents a hold from being recognized. Five or more spaces typed with a pause
and then a very even fast rhythm could still look like a hold. Whether a space
precedes the hold is judged as if typing at the end of the draft; in the
middle of existing spaces the separator may be missing. Esc pressed while
repeats are still arriving, and a release right as the hold is confirmed, can
leave a stray space. Recording starts once the hold is confirmed and the
microphone is open; the model is verified while you speak (see below). A hold
while a dialog or overlay has the focus does not change the draft and is
ignored. Push-to-talk is tested with fake terminals, editors and sessions
only.

## Toggle dictation (one shortcut)

Press `alt+m` in the editor to start listening and press it again to stop. The
key is not held down, the editor keeps the focus and no overlay opens, so the
transcript is pasted at the cursor when it is ready and is never sent. Esc
cancels while recording or transcribing. A one-line footer status names the
phase and the key: preparing, recording (`alt+m stop and insert`), transcribing.

| Topic | Behavior |
|-------|----------|
| Shortcut | `alt+m` by default. `GENTLE_PI_VOICE_TOGGLE_KEY` replaces it; an empty value or `off` disables the shortcut. It is read when the session starts, because Pi binds extension shortcuts once, so a change applies to the next session. |
| Independent of the toggle | Turning push-to-talk off leaves the shortcut working: someone who dislikes held keys can use the shortcut and never arm Space. Disable the shortcut on its own with `GENTLE_PI_VOICE_TOGGLE_KEY=off`. |
| First press | Checks that the runtime and model are installed, then records. If voice is not installed, a notice points to `/gentle:voice` and nothing is recorded; the next press checks again. |
| Second press while preparing | Remembered, not dropped: recording stops as soon as the microphone is open. |
| Second press while transcribing | Ignored. No second capture starts and the transcript is pasted once. |
| One at a time | Refused with a notice while a download, a `/gentle:voice` dictation or a Space hold is running, and those are refused while the shortcut records. A Space hold during a toggle dictation types spaces as usual. |
| Cancel and shutdown | Esc cancels and consumes the key, so it does not reach the editor or the agent. Reload or session shutdown cancels the session and drops a transcript that arrives afterwards. |
| Where it works | Interactive TUI parent sessions only. Delegated child sessions, RPC and print modes ignore the shortcut without probing or reading anything. |

### Why this shortcut

`alt+m` is free in both key spaces this extension shares:

- **Pi built-ins** (`tui.input.*`, editor and app keybindings): `alt+m` appears
  in none of them. The nearby letters that look available are not: `alt+d` is
  `deleteWordForward`, `alt+b` and `alt+f` are word motion, `alt+left` and
  `alt+right` are word motion too, and `ctrl+m` arrives as Enter.
- **Gentle shortcuts:** `alt+k` (command palette), `alt+u` (usage), `alt+g`
  (changes), `alt+a` (agents view and selection select-all), `alt+s` (agents
  stop), `alt+e` (selection engine), `ctrl+shift+a`, `ctrl+shift+t`,
  `ctrl+shift+r`. None of them is `alt+m`.
- **Pi extension conflicts:** Pi refuses an extension shortcut that matches a
  reserved app keybinding (interrupt, clear, exit, suspend, thinking, model
  cycle and select, tool expand, external editor, message copy and follow-up,
  and the editor's submit, select, copy and delete-to-line-end keys). `alt+m`
  is not among them, so the registration is not silently skipped.

A user keybinding in `~/.pi/agent/keybindings.json` can still take `alt+m`; it
belongs to the user, so Gentle AI neither reads nor changes it.

### Terminal limitations

- Option must be reported as Meta. In macOS Terminal and iTerm2, enable
  "Use Option as Meta key"; otherwise `alt+m` arrives as `µ` and types that
  character into the draft instead of toggling.
- Terminals and multiplexers that do not distinguish `alt`, or that rewrite
  Alt combinations, cannot deliver the key. `herdr` and `tmux` pass it through
  when their own configuration does not bind `alt+m`; if yours does, the
  shortcut never fires and the draft receives nothing.
- Keyboard-protocol terminals only: `super+…` and `ctrl+shift+letter` need the
  Kitty keyboard protocol. Prefer a plain `alt+…` key when unsure, and set
  `GENTLE_PI_VOICE_TOGGLE_KEY` to one that types nothing in your terminal.
- No shortcut key ever reaches the draft while the shortcut is enabled: the
  key is consumed by the toggle, so it cannot also be typed.

The shortcut is covered by tests with a fake terminal and fake session. No real
key press in a real terminal has been exercised.

## Read replies aloud

Turn it on from `/gentle:voice` with **Read replies aloud: turn on**; the same
entry turns it off. The choice is saved in `voice-speech-settings.json` in the
Gentle AI config home, next to the push-to-talk file, and applies to every
session. Nothing is downloaded: it uses the Windows voice (System.Speech), so it
works on Windows and on WSL only. Elsewhere, turning it on is refused with
"Spoken replies need the Windows voice (Windows or WSL)."

| Topic | Behavior |
|-------|----------|
| When | Once a run has settled, with no retry, compaction or queued message left. An aborted run, a delegated child session, RPC and print modes read nothing. |
| What is read | The text of the last assistant message that has any. Thinking, tool calls and tool results are never read. |
| What is skipped | Code blocks, table rows, link targets, bare URLs and Markdown markers. A path keeps only its last segment, so `lib/voice-speech.ts` is read as `voice-speech.ts`. List items and headings become separate sentences. A reply is cut at a sentence boundary after about 1,200 characters. |
| Voice | Each reply is checked for Spanish or English and read with an installed voice of that language when there is one (for example Microsoft Sabina for Spanish), otherwise with the Windows default voice. |
| Stop | Esc stops the reading and is consumed, so it never reaches the editor or the agent. **Stop reading** in `/gentle:voice` does the same. A new run stops it too. |
| Talk over it | The dictation shortcut (`alt+m`) stops the reading and starts a dictation at once. |
| Footer | `Reading reply · esc stop · alt+m talk` while it reads. No state is published on the voice-state event. |
| Process | Each reading runs PowerShell with a fixed script; the reply goes only through its standard input, as base64 JSON, never as an argument. PowerShell takes about 1.5 seconds to start before the voice is heard. Its output is discarded and a failure shows one fixed message. A reading is killed after 30 seconds plus about 0.1 second per character. |

## Conversation mode

Conversation mode turns dictation and spoken replies into a hands-free loop:
you speak, the transcript is sent, the reply is read aloud, and the microphone
reopens. Turn it on from `/gentle:voice` with **Conversation mode: turn on**.
It needs voice dictation installed and the Windows voice; otherwise it is
refused with a notice and nothing is saved. It is saved in the same
`voice-speech-settings.json` file and reads replies aloud even while **Read
replies aloud** is off.

| Topic | Behavior |
|-------|----------|
| Start | Press `alt+m` and speak. Recording ends by itself after 1.2 seconds of quiet that follows speech, so no second press is needed. |
| Send | The transcript is sent as the next prompt, never pasted. While the agent is still busy it is queued as a follow-up instead of interrupting the run. |
| The loop | When the reply has been read to the end, the microphone reopens the same way. A reply with nothing readable reopens it too. |
| Pause | Esc while listening cancels the recording and pauses the conversation. Esc while a reply is read stops the reading and leaves the microphone closed. With no speech within 8 seconds, it pauses with "Conversation paused: no speech was heard. Press alt+m to talk." Press `alt+m` to go on. |
| Send early | `alt+m` while listening stops the recording and sends at once. |
| Footer | `● Conversation · listening · alt+m send · esc pause` while recording, then transcribing and sending. |
| Other inputs | Hold-Space push-to-talk and **Start dictation** keep pasting into the draft; only the shortcut takes part in the conversation. |
| End of speech | The worker measures each audio chunk in audio time. The noise floor is the quietest chunk heard so far, and a chunk counts as speech when it is at least three times that floor and above a fixed minimum of 0.003 RMS, just over the floor measured on a low-gain WSLg microphone (about 0.002). Speech counts once 150 ms of it were heard. The request carries `endpoint: { endOfSpeechMs, noSpeechMs }`, bounded to 300–5000 ms and 1–60 s; without it a recording never ends on silence, exactly as before. |

The thresholds are tested with synthetic audio only. A loud room or a quiet
microphone may need the shortcut to send; tuning them on real microphones is
still open.

## What gets downloaded

All versions, sizes and digests are pinned in `lib/voice-artifacts.ts`.

| Component | Source | Size | Verified by |
|-----------|--------|------|-------------|
| `sherpa-onnx-node@1.13.8` | npm registry | 12 KB | `dist.integrity` (SHA-512) |
| `sherpa-onnx-<platform>-<arch>@1.13.8` | npm registry | 9–14 MB | `dist.integrity` (SHA-512) |
| `node-cpal@1.0.0` (microphone capture) | npm registry | 7.7 MB | `dist.integrity` (SHA-512) |
| Parakeet TDT 0.6B v3, int8 | Hugging Face, commit `2bda32ec70b0` | about 670 MB | per-file size and SHA-256 |

The model is the sherpa-onnx export
`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`: `encoder.int8.onnx`,
`decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt`.

## Where it is stored

Everything lives in `<Gentle AI config home>/voice` (by default
`~/.pi/gentle-ai/voice`; see `gentlePiConfigHome()`):

```text
voice/
  runtime/sherpa-onnx-1.13.8-node-cpal-1.0.0-<target>/node_modules/
    sherpa-onnx-node/
    sherpa-onnx-<platform>-<arch>/
    node-cpal/
  models/parakeet-tdt-0.6b-v3-int8-2bda32ec70b0/
```

The platform package sits next to `sherpa-onnx-node` because its loader resolves
`../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`. node-cpal loads
`bin/<platform>-<arch>/index.node` from its own directory, or
`bin/backend-pulseaudio/<platform>-<arch>/index.node` when its PulseAudio
backend is selected under WSL. The runtime directory names both native
versions, so a runtime installed with other pins is never reported as the
current one.

## How an install stays safe

- **Explicit only.** Importing the voice modules performs no filesystem or
  network access. Status checks never create the voice directory.
- **Streamed and bounded.** Each file is hashed while it streams to disk and is
  cut off as soon as it exceeds its pinned size. A wrong length or digest fails
  the install.
- **Pinned redirects.** npm tarballs are fetched without redirects. Hugging Face
  redirects are followed only over HTTPS to the paths observed for this revision:
  `huggingface.co/api/resolve-cache/...` and `us.aws.cdn.hf.co/xet-bridge-us/...`.
  Any other host, including other CDN regions, is refused.
- **Cancellable and time-bounded.** An install can be aborted. It also stops
  when no data arrives for 60 seconds, or when it runs past 20 minutes for the
  runtime or 2 hours for the model.
- **Checked archives.** Every tarball is validated before anything is
  extracted. Only regular files under `package/` are accepted, within the
  registry's file count and unpacked size. Links, directories, traversal,
  duplicates and Windows device names are refused. No package script runs, and
  no downloaded code is loaded during installation.
- **Atomic publication.** Work happens in a private `.staging-*` directory. The
  install marker is written last, and one rename publishes the component. A
  failure or cancellation removes only that staging directory. An existing
  installation is never partially overwritten: a valid one is kept as is, and an
  invalid one is replaced only by a complete, verified copy.

## Dictation session

`lib/voice-session.ts` records one dictation and returns its text. It never
submits the text or touches the editor; the caller decides what to do with it.

- **Separate process.** `start()` runs `scripts/voice-worker.cjs` with the same
  Node executable, from the runtime directory, with no shell. Microphone
  capture, the model load and the decode all happen in that process, so a
  native crash or a long decode cannot freeze Gentle AI. Importing the module or
  creating a session does nothing until `start()`.
- **Checked before loading.** `start()` first requires both components to be
  reported installed. The worker then checks the files again before it loads
  the native code that uses them: every entry in the runtime and model
  directories must be a plain directory or regular file, owned by the current
  user and not writable by everyone (ownership and modes are not checked on
  Windows). Each runtime file the session loads must be present, including the
  capture backend it selected: the default facade with `bin/<target>/index.node`,
  or, on a Microsoft kernel, the PulseAudio facade with
  `bin/backend-pulseaudio/<target>/index.node`. That second native file is
  checked because the PulseAudio facade otherwise falls back to the default
  binary when its own file is missing. Each model file
  must match its pinned size and SHA-256. The digests are recomputed on every
  session, which reads the whole model (about 670 MB). Directories above the
  voice home are not checked. These checks catch broken or swapped installs;
  they cannot stop someone with the same user account from replacing the files,
  which is the same as running code as that user.
- **Order.** So that the first words are recorded, the worker validates the
  runtime files, loads node-cpal and opens the microphone, then reports
  `recording` and verifies the model digests while recording, reading each
  file in chunks so capture keeps running. sherpa-onnx and the model are loaded
  only after every digest matched and recording stopped, because that load is
  synchronous and would stall capture. A mismatch found while recording closes
  the microphone at once and reports the model as invalid; one found after stop
  is reported instead of a transcript. Cancel stops the verification and loads
  nothing. The tradeoff: the recognizer load (about 0.85 seconds measured on an
  Apple Silicon Mac) now happens after stop, so a transcript takes that much
  longer to arrive, and any verification still running when you stop is
  awaited too.
- **Lifecycle.** A session is used once: `start()` resolves when recording
  begins, `stop()` resolves with `{ text, truncated }`, and `cancel()` (or
  `dispose()`) discards everything, including a transcript that arrives late.
  `start()` resolves while the worker keeps recording; `stop()`, `cancel()` and
  a failed `start()` settle only after the worker has exited. A worker that does
  not exit within 2 seconds of finishing or being cancelled is killed. If the parent
  disappears, the worker sees its input close and stops capturing.
- **Bounds.** Recording stops by itself after 120 seconds, and the worker then
  transcribes what it has (`truncated: true`). Starting (runtime checks and
  opening the microphone) and transcribing (the rest of the model
  verification, the model load and the decode) each have a 120-second limit. Audio is kept in memory
  only up to the recording limit. All of these are options.
- **Audio.** The worker opens the default input device through node-cpal's
  default (ALSA) backend, or through its PulseAudio backend under WSL,
  preferring 32-bit float samples and otherwise using the device's default
  integer or float format. It mixes all channels down to mono and resamples to
  16 kHz in JavaScript (averaging when downsampling, linear interpolation when
  upsampling). No SoX or FFmpeg is used. Less than 0.1 seconds of audio is
  reported as empty, and a blank transcript as no speech.
- **Errors.** The worker reports a fixed code only, and the session turns it
  into a fixed message. Native error text, file paths and environment values
  are never included, and the worker's stderr is discarded.
- **Environment.** The worker gets only home, temp, locale and audio-session
  variables (`HOME`, `USERPROFILE`, `SystemRoot`, `windir`, `TEMP`, `TMP`,
  `TMPDIR`, `XDG_RUNTIME_DIR`, `PULSE_SERVER`, `PULSE_COOKIE`, `LANG`, `LC_ALL`,
  `LC_CTYPE`). Credentials, `PATH`, `NODE_OPTIONS` and loader variables are
  dropped.
- **Protocol.** JSON lines with schema `gentle.voice/v1`. The parent sends
  `start` (with paths computed from the pinned manifests), then `stop` or
  `cancel`. The worker answers `recording`, `transcribing`, and one final
  `result` or `error`. Any other message, an unknown field, more than 16 lines
  or a line over 64 KB stops the worker.

Automated session tests use scripted fake workers and the real worker with fake
capture and recognizer modules. One user confirmed that dictation works on WSLg
with the PulseAudio backend; this is not automated coverage of native loading,
microphone capture, or transcription on other setups.

## Platform support

All five targets get the pinned runtime and a `node-cpal@1.0.0` capture binary
built for their architecture (checked from the binary headers, not by loading).

| Target | Prerequisites (not checked before loading) |
|--------|--------------------------------------------|
| macOS arm64 | macOS 11 or newer |
| macOS x64 | macOS 10.12 or newer |
| Linux x64, glibc 2.34+ | ALSA `libasound.so.2` |
| Linux arm64, glibc 2.34+ | ALSA `libasound.so.2` |
| Windows x64 | Microsoft Visual C++ runtime (`vcruntime140.dll`) |

node-cpal requires Node 22 or newer, and a dictation session refuses to start
on an older Node. Gentle AI never downloads or installs the Visual C++ runtime;
a missing runtime is expected to surface as a runtime load failure, which has
not been observed on hardware. `/gentle:voice` then names the runtime to install.

Apart from the user-confirmed WSLg session described below, these targets have not
been verified on real hardware. Linux with a glibc
older than 2.34 is unsupported and the diagnosis names the version found.
Windows ARM64 has no native sherpa-onnx package and is unsupported. musl Linux
is unsupported.

### WSL

A Linux kernel whose release names Microsoft (WSL2) has no ALSA hardware device
to record from, so the worker loads node-cpal's PulseAudio facade
(`backend-pulseaudio.js`) instead of the default one, and checks that facade and
its `bin/backend-pulseaudio/<target>/index.node` before loading. The PulseAudio
binaries ship in the same pinned `node-cpal@1.0.0` tarball, so a WSL install
downloads nothing extra. Before this path existed, WSL reported the fixed
message "The default microphone uses an unsupported audio format.", because the
ALSA default device there exposes no usable format. Requirements, none of them
checked before loading:

- WSLg (Windows 11 WSL, audio support enabled), which provides a
  PulseAudio-compatible server, or another PulseAudio server reachable through
  `PULSE_SERVER`. The worker passes `PULSE_SERVER` and `PULSE_COOKIE` through.
- The PulseAudio server socket in the runtime directory named by
  `XDG_RUNTIME_DIR`, also passed through.

Without a reachable PulseAudio server the session reports a microphone or
capture error rather than falling back to ALSA, which cannot record there. One
user confirmed that dictation works with this backend on WSLg. Automated backend
selection tests use fake modules; the current shortcut and sidebar integration
have not yet been verified with a real WSL microphone. The platform limitation and
the ALSA advice in `/gentle:voice` do not change for WSL yet.

## Licenses and attribution

- **Model:** Parakeet TDT 0.6B v3 by NVIDIA, licensed under CC-BY-4.0. The int8
  sherpa-onnx export is by csukuangfj. The export repository has no license file
  of its own; its license is taken from the upstream NVIDIA model.
- **Runtime:** sherpa-onnx, Apache-2.0. The npm tarballs ship no LICENSE or
  NOTICE file. The platform packages bundle onnxruntime (MIT) without its
  license text.
- **Capture:** node-cpal 1.0.0, ISC. The tarball ships no LICENSE or NOTICE file. Its prebuilt
  binaries link Rust crates whose notices are not included.

These gaps are unresolved and are listed in `VOICE_NOTICES`.
