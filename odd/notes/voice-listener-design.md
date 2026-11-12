# One voice listener for every Pi session (S6 design)

Design for T5 (`odd/tasks/voice-control.md`), the substrate that later carries T4 (Windows
overlay, S5), T6 (keyword spotter, S7), T7 (herdr navigation, S8) and T8 (English mode, S9).
Read with `docs/voice.md` and `odd/notes/voice-stt-spanish.md` (measurements; L9 = option A:
Whisper base int8 pinned to `es`, English KWS catches both wake phrases).

This note changes no source and no test: it fixes the process model, the wire protocol, the
state machine, the safety rules and the review slices.

## 0. Where voice lives today (evidence)

- Voice is per Pi session: `extensions/gentle-voice.ts:8` registers
  `registerVoiceCommand` in every process (`lib/voice-command.ts:376`).
- Capture, model and decode are a child process per recording, or one kept-alive worker per
  session (`lib/voice-warm.ts:33-40`: `idleMs` 10 min, 4 threads; chosen per session at
  `lib/voice-command.ts:388-395`). Protocol `gentle.voice/v1` with bounded frames
  (`lib/voice-session.ts:16,32-34`; worker side `scripts/voice-worker.cjs:29,78-90`).
- The microphone never publishes a level: `scripts/voice-worker.cjs:210-211` computes
  `lastLevel`/`lastFrames` for the endpointer only (`:510`), and no worker message carries
  them. The reply voice does publish 50 ms levels, but only for TTS it already holds in Node
  (`docs/voice.md`, "Speech events" → `phase: "chunk"`).
- Cross-process coordination is two files in the voice home (`lib/voice-install.ts:102` →
  `<config home>/voice`): the reading turn (`lib/voice-presence.ts:33,67-81`, taken at
  `lib/voice-command.ts:623`) and the per-session on/off list
  (`lib/voice-settings.ts:59-60`, newest 64 ids).
- Focus is asked per session, one `herdr pane get` per reopen (`lib/voice-presence.ts:19-29`,
  called at `lib/voice-command.ts:1448`).
- Cues already keep one warm PowerShell host per session (`lib/voice-cues-windows.ts:69,96`,
  30 idle minutes); display consumers are session-keyed and display-only
  (`lib/voice-status-event.ts:11-12`, `lib/shell-voice-overlay.ts`, `lib/shell-voice-state.ts`).
- Precedent for a local listener with socket safety: `lib/agents-session-transport.ts:6`
  (0700 dir, 0600 file, 100-byte socket path cap), `:112` (random endpoint name), `:528-531`
  (`createServer` + `listen`), `:525` (refuse a pre-existing endpoint path before binding).

## 1. Process model: one daemon, not leader election

**Recommendation: a single-instance local listener process per user, started on demand,
joined by every Pi session that wants voice.**

Reject leader election among Pi sessions because: a leader dies with `/reload` or session
shutdown, which today already tears voice down (`lib/voice-command.ts:1333-1368`); the model
and the microphone would move between processes at random; and an election cannot guarantee
that exactly one process holds the capture device when two sessions start at the same instant.
A daemon also decouples the mic from TUI focus and is the only place a *global* wake word can
live: S7 must hear "Gentle Voice on" when no session is focused at all.

### 1.1 Entry point and identity

- `scripts/voice-listener.mjs` spawned with
  `node --experimental-strip-types <path>` so it can import `lib/*.ts` (verified on this
  machine's Node v22.22.2; the test suite already relies on that flag,
  `scripts/run-test-suite.mjs:19`).
- Shared logic stays in `lib/voice-listener-*.ts` (state machine, registry, protocol codec,
  focus resolution) so units are testable without a process, exactly as `lib/voice-session.ts`
  is tested with a fake worker.
- Environment scrubbed like the dictation worker (`docs/voice.md`, "Dictation session" →
  Environment): home, temp, locale, audio variables only.
- The listener is the only process that touches the microphone, the ASR model, the KWS model,
  the cue PowerShell host and the overlay. Sessions never capture audio again.

### 1.2 Single-instance guarantee

Two guards, in this order, both inside `<voice home>` (mode 0700, files 0600 — the
`lib/agents-session-transport.ts:6` convention):

1. **Lock file `listener.lock`**, created with `flag: "wx"` (same primitive as the reading
   turn, `lib/voice-presence.ts:81`). Only the lock holder may unlink or bind the socket.
   The lock body is `{ schema, pid, socket, startedAt, version }`, written atomically
   (tmp + `renameSync`, the `lib/voice-settings.ts:38-48` pattern).
2. **Socket `listener.sock`** in the voice home (well under the 100-byte socket path cap) —
   binding is the real mutual exclusion: two processes cannot listen on the same path, so a
   second start gets `EADDRINUSE` and stops.

Start sequence (client side, `ensureListener()`):

1. Try to connect to `listener.sock`. Success → read `welcome`, done (join).
2. `ECONNREFUSED`/`ENOENT` → the socket is stale. Take the lock (`wx`); if the lock is taken
   by a live pid, wait for its socket instead of starting.
3. With the lock: `lstat` the socket path; if it exists, it must be a socket owned by the same
   user, otherwise refuse (`unsafe_path`, the `lib/agents-session-transport.ts:47-58` rule).
   Unlink it, spawn the daemon, wait up to 10 s for a connect + `welcome`.
4. The starting client never removes the lock or the socket on success: the daemon owns both
   for its whole life and removes them in its own shutdown path.

Crash and stale recovery:

- The daemon writes `heartbeatAt` into the lock body every 2 s.
- A *client* that finds a lock whose pid is dead (`process.kill(pid, 0)`, the
  `lib/voice-presence.ts:45-52` check) or whose heartbeat is older than 6 s removes the lock
  and restarts the sequence. A killed daemon (`SIGKILL`) therefore costs one retry, never a
  stuck voice.
- A session whose socket closes mid-life reconnects with backoff (250 ms → 2 s, capped) and
  re-sends `hello` with the same `sessionId`; the registry replaces the old socket for that
  session and keeps the state machine running (`asleep`/`listening` survive a client restart).

Shutdown when nobody wants voice:

- Each `hello` registers `{ sessionId, paneId?, voiceOn }`; a closed socket deregisters.
- The listener exits after **60 s with zero clients** and no capture, reading or grant in
  flight, and it exits at once when it has zero clients and `voice-sessions.json` lists no
  session that is still alive. A listener that owns no client cannot deliver a transcript to
  anyone, so keeping the mic for a sleeping wake word with no Pi session would only burn CPU.
- `voice-off` (spoken or from the menu) does **not** stop the listener: it moves to `asleep`
  (L8, `docs/voice.md` "Spoken commands"), which is exactly the state that keeps the KWS alive.
- Idle exit is logged as `listener.exit { reason: "idle" }` and the next `ensureListener()`
  starts a fresh one. Whisper base loads in 1.7 s (L9), so a cold start is invisible next to
  the 4.6 s the owner already waits today (`docs/voice.md`, "Faster transcription").

## 2. IPC: unix socket, JSON lines

Schema `gentle.voice-listener/v1`. One JSON object per line, `\n` terminated, UTF-8, max
64 KB per line, first frame must be `hello` (else close), max 64 registered clients, max 200
frames/second per client. Bounds and exact-key discipline follow the existing worker protocol
(`lib/voice-session.ts:32-34`; `scripts/voice-worker.cjs:376-380`). Requests carry `id`;
events do not. Unknown `type`, unknown field, or a bad field type → one `error` frame and the
connection closes.

### 2.1 Session → listener

| type | payload | answer |
|---|---|---|
| `hello` | `proto: 1`, `sessionId`, `paneId?`, `voiceOn`, `label` (cwd basename, display only) | `welcome { listenerPid, state, language, asleep, proto }` |
| `set-voice` | `voiceOn` | `ok` — mirrors `voice-sessions.json` for this session |
| `wake` / `sleep` | — | `ok { state }` — explicit control (Alt+M, menu) |
| `read-begin` | `readingId`, `chars` | `granted` or `busy`/`asleep` — the one reading turn |
| `read-heartbeat` | `readingId` | `ok` — renews a 15 s lease, ceiling 180 s |
| `read-end` | `readingId`, `outcome` (`done`/`skipped`/`cancelled`/`empty`/`unavailable`/`error`) | `ok` |
| `read-cut` | `readingId?` | `ok` — "cut whatever is speaking" (`voice-off`, own message) |
| `dictate` | `mode: "conversation" \| "dictation"`, `endpoint?: { endOfSpeechMs, noSpeechMs }` | `recording` → `transcribing` → `result { text, truncated }` \| `error { code }` |
| `stop` / `cancel` | — | terminal `result`/`error`/`cancelled` |
| `status` | — | `snapshot`: the `state` fields plus `listenerPid`, `clients`, `reading` holder |
| `levels` | `on` | `ok` — subscribe to `level` events |

### 2.2 Listener → session

| type | when | who receives |
|---|---|---|
| `state` | every transition, plus every 5 s while non-idle | all clients (display only: `state` — one of §3's, including `asleep` —, `language`, `paneId?`, `label?`, `at`) |
| `transcript` | one recording finished and was decoded | **the focused session only, exactly once, never retried, never buffered** |
| `command` | a spoken command that every session must honour (`voice-off`, `voice-on`) | all clients |
| `level` | 20 Hz while recording, only if subscribed: `{ rms, at }` | subscribers |
| `reading` | `granted`/`released` for another session's reading (so the footer says "waiting") | clients waiting on a grant |
| `bye` | `{ reason: "idle" \| "shutdown" \| "error" }` then close | all clients |

Delivery rule for transcripts (S6 in one sentence): a transcript goes to the session whose
`paneId` herdr reports focused at the moment the recording ends; if nobody is focused, it goes
to the single registered client when there is exactly one, and otherwise it is **dropped with
`transcript.undelivered` logged** — the listener never queues speech and never broadcasts it.
The session that *asked* always learns the outcome (`result` for it, `cancelled` otherwise), so
the requester's UI never hangs on a transcript it did not receive.

### 2.3 Focus resolution (one place instead of N)

`herdr agent list` returns `result.agents[].{ pane_id, focused, name?, terminal_title_stripped,
agent_status }` (verified live on this machine: exactly one entry with `focused: true`). The
listener keeps a 300 ms cache, refreshes it only while it needs focus (a transcript is pending,
a reopen is being decided), and maps `pane_id` → registered session. Outside herdr (no client
carries `paneId`) the only registered client counts as focused, the rule
`lib/voice-presence.ts:22` already applies. This replaces one `herdr pane get` per reopen
(`lib/voice-command.ts:1448`) with one call per decision for all sessions, and gives S8 its
agent list for free.

### 2.4 Readings and self-hearing

The listener still lets a **session** speak (it owns the reply text, the language and the Pi
event bus: `lib/voice-command.ts:594-660`) but it owns the *turn*:

1. `read-begin` → granted only when no other grant is live; the listener enters `reading`.
2. `state: reading` mutes the mic path entirely: KWS stops being fed, no capture starts, and a
   capture in flight is cancelled without decoding.
3. `read-heartbeat` every 5 s keeps a 15 s lease; expiry (a crashed session) releases the turn
   and logs `reading.lease-expired`, so a dead reader can never mute voice forever.
4. `read-end` releases the turn and keeps the mute for 250 ms (audible tail) before returning
   to `listening` or `asleep`.

`reading-turn.json` (`lib/voice-presence.ts:33`) is retired by this: one authoritative owner
replaces polling a file (`lib/voice-presence.ts:67-81`) and the 180 s wait at
`lib/voice-command.ts:623`.

## 3. States, transitions, spoken commands

| state | mic | KWS | ASR | overlay | cue |
|---|---|---|---|---|---|
| `off` (no process) | — | — | — | hidden | — |
| `asleep` | open | **running** | unloaded | "Dormido · di «Gentle Voice on»" | — |
| `listening` | recording | **running** (also during dictation, so S4 survives Spanish ASR) | warm, loaded | live level + session + `es`/`en` | open |
| `transcribing` | closed | paused | decoding | spinner | close |
| `reading` | muted | muted | warm | "Leyendo · <session>" | — |

Transitions (`state` published on every edge; each edge logged with no audio and no text):

- `asleep → listening`: KWS `Gentle Voice on`, or `wake`, or Alt+M. Starts a conversation
  capture for the focused session. A hit that arrives while `reading` is ignored, never
  interrupting a reading, and logged as `ignored:reading`.
- `listening → transcribing`: `stop`, endpoint silence (2.5 s of speech-quiet, 8 s of nothing —
  `CONVERSATION_ENDPOINT`/`DICTATION_ENDPOINT`, `lib/voice-command.ts:124,131`), or 2 min cap.
- `transcribing → listening`: transcript delivered, reopen rules say the pane is focused and
  the turn was spoken (today's rules: `lib/voice-command.ts:1426-1451`). Otherwise `→ asleep`.
- `transcribing → asleep`: nothing heard, `error`, or nobody focused.
- `any → reading`: `read-begin` granted.
- `reading → listening`/`asleep`: `read-end`, `read-cut`, or lease expiry; target is the
  state before the reading (spelled out in the grant).
- `listening/transcribing/reading → asleep`: **`Gentle Voice off`** (KWS, or a full-utterance
  ASR match before the Whisper switch) — cancels the capture, `read-cut` broadcast, sessions
  cut readings, mic closes, KWS keeps running. Nothing is sent to the model (`S4`).
- **Alt+M always works** and never depends on the current state: with no listener it spawns
  one; `asleep → wake + dictate`; `listening → stop and insert` (today's toggle);
  `reading → read-cut + dictate` (talk over the reply, `docs/voice.md` "Talk over it");
  `transcribing → ignored` (a second press while transcribing is already ignored today).
  The shortcut stays registered by the session (`lib/voice-command.ts:1375-1379`), so even a
  dead listener only costs a fixed "Voice unavailable; press alt+m to retry" notice.
- The `/gentle:voice` menu keeps its per-session entries (`lib/voice-command.ts:117-119`) and
  gains one: **Listener: sleep now**.

Language: `es` pinned for dictation until S9. `en` only when the owner switches it on
deliberately; the overlay and every `state` frame carry the active language so an accidental
switch is visible.

## 4. Safety (S10)

| Rule | Mechanism |
|---|---|
| Never free text as a command | The only matcher is the fixed list in `lib/voice-spoken-command.ts:18-30`, now called **in the listener** on whole utterances; navigation (S8) adds entries to that list, never a second parser. The KWS matches token sequences from a pinned keyword file, not transcripts. |
| False activation closes | Every accepted activation arms the 8 s no-speech limit (`lib/voice-command.ts:131`) and, on silence, returns to `asleep` with `activation.silence` logged. Every KWS hit logs `kws.hit { keyword, score, decision, reason }` — keyword and decision only, never audio or a transcript. |
| Nothing destructive or publishing | The listener's whole outbound surface is enumerated: `herdr agent list/get/focus`, and (only behind confirmation) `herdr agent prompt`. No shell, no `git`, no file writes outside the voice home. |
| A prompt to another agent asks first | S8 sends nothing without a second, explicit confirmation: the overlay shows target + the text length, the answer must be a fixed phrase ("confirmar"), and the default is navigation only (open question 2). Prompt text is never read back aloud. |
| Audio is never stored | Samples live in memory only, bounded by the 2 min cap (`scripts/voice-worker.cjs`, `maxRecordingMs`), and the buffer is dropped on `stop`/`cancel`. The listener writes no WAV, ever; `scripts/voice-worker.cjs` does not write audio either today. |
| Nothing leaves the machine | No network code in the listener at all (nothing to disable); models come from the voice home; the log keeps sizes, codes and decisions (`lib/voice-diagnostics.ts:11-19`), never text. |
| Activation is visible and audible | `state` on every edge, the open/close cues (`lib/voice-cues.ts`, one warm host in the listener), and the overlay; `asleep` is a visible state, not silence, because S7 runs a mic (L8). |
| Alt+M is the fallback | Independent of `listener.sock`, of the KWS model and of the overlay: the session spawns or retries the listener itself. |
| Dev probes stay silent | Same rule as T1: any real-mic probe uses tones at peak ≤ 20/32767 or none. |

## 5. Migration in reviewable slices (≤ ~400 lines of code each, with its tests)

Each slice keeps the suite green and is reviewable on its own. Text in brackets is what it
leaves behind in the Pi session.

1. **A — listener skeleton, single instance, IPC, focus (T5a).** `scripts/voice-listener.mjs`,
   `lib/voice-listener-lock.ts`, `lib/voice-listener-protocol.ts`,
   `lib/voice-listener-client.ts`, `lib/voice-listener-focus.ts`;
   `hello/welcome/status/bye`, registry, idle exit, stale recovery, reconnect. Voice still
   records inside the session; only `paneFocused` (`lib/voice-command.ts:482`) is routed
   through the listener, as a drop-in for `deps.paneFocused`. Tests: lock contention, stale
   socket, two clients, focus cache, `herdr` failure keeps the mic closed.
2. **B — the reading turn moves (T5b).** `read-begin/heartbeat/end/cut`, `reading` state,
   lease expiry; `reading-turn.json` and `acquireReadingTurn` (`lib/voice-presence.ts:33,67-81`)
   deleted with their call site (`lib/voice-command.ts:623`). [Session keeps: reply text,
   language detection, the PowerShell readers.] Tests: serialization, expired lease, cut.
3. **C — capture and ASR move into the listener (T5c, delivers S6).** `dictate/stop/cancel`,
   the warm worker (`lib/voice-warm.ts` used by the listener instead of the session),
   transcript delivery to the focused session only, the cue host moves in with it. [Session
   keeps: the `alt+m` toggle, insertion vs send, spoken-turn bookkeeping, `voice-sessions.json`.]
   Tests: focus chosen at stop time, dropped transcript when nobody is focused, one capture at
   a time replacing `reserveCapture` (`lib/voice-command.ts:458-473`).
4. **D — Windows overlay with live level (T4, S5).** New `lib/voice-overlay-windows.ts`: one
   PowerShell topmost, click-through, semi-transparent window fed over stdin (the
   `lib/voice-cues-windows.ts:96` warm-host shape, not a new mechanism), driven by `state` +
   `level`. Worker change: `level` message every 50 ms of audio, behind a `levels: true` start
   option so `gentle.voice/v1` still refuses it by default. Tests: overlay frame codec, 20 Hz
   cap, overlay dies → voice survives.
5. **E — English keyword spotter, `asleep` (T6, S7).** Pin
   `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (17.6 MB, Apache-2.0) in
   `lib/voice-artifacts.ts`, install it with the runtime checks, add `keyword-spotter.js` to
   the listener, `keywords.txt` = `gentle voice on|off`. Adds `voice-on` to the fixed list and
   the `asleep` state, the mute-while-reading rule, false-trigger measurement and logging.
   Tests: hit→state, hit while `reading` ignored, silence auto-close, model missing→asleep
   unavailable + Alt+M still works. **This slice must land before Whisper.**
6. **F — Whisper base int8 `es` (S3).** The four touch points already priced in
   `odd/notes/voice-stt-spanish.md` ("What adopting Whisper costs in code"): model `kind` and
   explicit roles in `scripts/voice-worker.cjs:31,78-90,437`, manifest selection in
   `lib/voice-artifacts.ts:143`, `lib/voice-session.ts:467`, `docs/voice.md`. Tests: protocol
   rejects the wrong kind, es-pinned decode of the 14 clips' fixtures.
7. **G — herdr navigation (T7, S8).** Fixed list over `herdr agent list`/`agent focus`
   (`siguiente agente`, `agente anterior`, `ir al agente <n>`, `volver`); the listener answers
   by moving focus and printing the target in the overlay. Prompt-to-agent stays behind the
   confirmation of §4 and off by default. Tests: no agents, one agent, list changes between
   utterance and action (re-resolve before acting), never a free-text target.
8. **H — deliberate English mode (T8, S9).** `language` per listener, `en` for ASR + KWS-off,
   overlay state, menu entry, and one fixed spoken phrase (`English mode` / `Modo español`)
   that is asymmetric on purpose: switching *to* English needs the phrase only, switching back
   also flips the ASR model. Tests: never auto-detected, overlay always names the language.

## 6. Risks

- **Concurrency of one capture.** One mic, many sessions: the listener must serialize
  `dictate` (queue of one, second requester gets `busy`) and decide the transcript's owner at
  stop time, not at request time. Focus changing mid-recording is the case to test.
- **An always-on microphone.** `asleep` keeps capture + KWS running for the whole day: unknown
  CPU cost, a lit mic indicator forever on Windows, and WSLg keeps its PulseAudio stream alive.
  Mitigation to measure in slice E: KWS-on-silence cost per hour, and how long the owner wants
  the mic kept with no session registered (open question 3).
- **Self-hearing.** Speaker-to-mic bleed can trigger "Gentle Voice on" from our own reading,
  so the mute + 250 ms tail must be proven on real hardware; the KWS threshold is the second
  line of defence and needs its false-accept rate on Spanish speech (S7).
- **WSLg audio quirks.** The documented low-gain mic floor (0.0031 RMS) against speech at
  0.016, and 10 ms chunks scattering 2–4× around the floor (`docs/voice.md`, "End of speech"):
  the level meter must be normalized and smoothed in the overlay, not in the detector, or
  silence will look alive.
- **`herdr agent list` cost and shape.** It returns every agent's full record (~10 KB for 11
  agents, verified live) and is an undocumented CLI JSON surface. Cache 300 ms, bound the read,
  and degrade to "closed mic" on any parse change.
- **Two daemons racing a stale socket.** Only the `wx` lock holder may unlink and bind; a
  client that unlinks without the lock could delete a live listener's socket path.
- **A missing listener mid-work.** Sessions must show one fixed message and keep `alt+m`
  working, or a crash looks like voice silently dying.

## 7. Open questions for the owner (max 3)

1. **Does `asleep` pause or cancel the per-session choices in `voice-sessions.json`?**
   Recommended: it pauses readings everywhere and waking resumes exactly the sessions that had
   voice on (the file is never rewritten by voice commands), so "off" cannot silently change
   the configuration.
2. **Navigation only, or also prompting another agent by voice (S8)?** Recommended: ship
   navigation in T7 and keep prompt-by-voice behind the fixed confirmation phrase and off by
   default until it has been used for a while.
3. **Should `asleep` keep the mic for a whole day, or return to `off` after a few idle
   minutes?** Recommended: stay asleep while at least one Pi session is registered and return
   to `off` (no mic, no KWS) after ~10 idle minutes with nobody registered, which keeps the
   wake word for the working day and closes the microphone overnight.
