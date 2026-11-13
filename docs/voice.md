# Optional local voice dictation

Voice dictation is optional. It transcribes speech locally with NVIDIA Parakeet
through sherpa-onnx, with no API key and no cloud inference. Everything happens
from `/gentle:voice`; nothing described here runs at startup.

## Quick path

1. Run `/gentle:voice` and choose **Download voice dictation**. The
   confirmation lists each component, its size, the destination directory,
   the licenses and the platform limitations. Esc during the download cancels it.
2. Run `/gentle:voice` again and choose **Start dictation**. Speak, then press
   Enter to stop, or let the 2-minute limit stop it. Esc cancels at any point.
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
| End of speech | Not for this command: **Start dictation** records until Enter or the 2-minute limit. Only the dictation shortcut (`alt+m`) ends on silence; see End of speech under Conversation. |
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
transcribing; no overlay opens, so the editor keeps the focus. In a wide fullscreen sidebar, a voice line pinned under the rail's tabs, on every tab, shows preparing, listening, or transcribing while active. It uses session-scoped voice events and hides when idle; listening is published after recording starts. The indicator is tested with simulated sessions, not a real microphone or keypress.

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
| End of speech | The recording also ends by itself after 2.5 seconds of quiet that follow speech, and the transcript is pasted with no second press. 8 seconds without any speech end it with "No speech was heard; nothing was pasted." The 2-minute limit stays. A conversation turn uses the same two thresholds; see End of speech under Conversation. |
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

## Voice in a session

Voice is turned on per Pi session, so only the sessions you care about talk
and listen, for example a coordinating session and the one you work in. Open
`/gentle:voice` in that session and choose **Voice in this session (off): turn
on**; the same entry, then reading **(on): turn off**, turns it off. Every
entry names the current state in parentheses, then the action. The choice is
saved by session id in `voice-sessions.json` in the Gentle AI config home
(the newest 64 sessions), so it survives `/reload` and applies at once in every
Pi process. Delegated child sessions never speak or listen.

Voice needs the Windows voice (OneCore, through the WinRT API), so it works on
Windows and on WSL only. A machine without `powershell.exe` reachable from here
has no voice, and spoken replies need no download. Elsewhere, turning it on is
refused with "Spoken replies need the Windows voice (Windows or WSL)." A session
without an id is refused too.

In a voice session:

- A settled reply is read aloud only in the pane you are looking at (S12). A
  session whose pane is not focused in herdr holds its reply instead of reading
  it, and reads it when you focus that pane, as long as it settled less than ten
  minutes before; an older one is dropped and never read, and its text stays on
  screen. Each session keeps only its newest held reply, so a newer one replaces
  the older, and a new message, voice off and the end of the session drop it
  too. A focus herdr cannot report counts as focused, so a broken lookup never
  silences a reply; outside herdr there is one terminal and it counts as
  focused.
- Readings take turns through the voice listener, so two sessions never speak
  at once: the one that asks first reads, and the others wait with the footer
  `Waiting to read · esc skip`, behind the turn for at most three minutes. The
  reading session renews its turn while it speaks; a turn whose session stopped
  renewing, went away or ended is free again within seconds, and any session can
  cut the reading (turning voice off in one does). Without a listener to reach,
  a session falls back to its own turn: one reading at a time inside it, exactly
  as before the listener existed.
- The dictation shortcut starts a hands-free conversation instead of pasting
  (see Conversation below). In a session without voice it keeps dictating into
  the draft exactly as before.

### Reading replies

| Topic | Behavior |
|-------|----------|
| When | Once a run has settled, with no retry, compaction or queued message left. An aborted run, a delegated child session, RPC and print modes read nothing. |
| Focus | Only in the pane herdr reports focused, asked when the run settles. A reply that settles in another pane is held (`reading.held`, with its session and size) and read when that pane comes back, with the whole reading below unchanged; one that settled ten minutes earlier is dropped instead (`reading.dropped reason=stale`) and its text stays on screen. Each session keeps only its newest held reply, so a burst of background replies replaces the older one; a new message, voice off, the end of the session and `alt+m` drop it. A focus herdr cannot report counts as focused, so a herdr that is down never silences a reply. |
| What is read | The text of the last assistant message that has any. Thinking, tool calls and tool results are never read. |
| What is skipped | Code blocks, table rows, link targets, bare URLs and Markdown markers. A path keeps only its last segment, so `lib/voice-speech.ts` is read as `voice-speech.ts`. List items and headings become separate sentences. A reply is read whole: it streams sentence by sentence, and only a runaway reply is cut, at a sentence boundary after about 8,000 characters. |
| Voice | Each reply is checked for Spanish or English: Spanish and undecided replies are read by **Microsoft Raul** (es-MX) and English ones by **Microsoft David** (en-US), both through the same robot effect and leveler (see [Robot voice](#robot-voice)). No other voice reads a reply. |
| Rate | `GENTLE_PI_VOICE_RATE_ES` and `GENTLE_PI_VOICE_RATE_EN` are one speech-rate multiplier per language: `1` (the default) keeps the voice's own pace, `0.5` is the slowest and `2` the fastest, and anything else reads as `1`. English can be slowed down without touching Spanish (`GENTLE_PI_VOICE_RATE_EN=0.6`). It reaches the synthesizer as its own `SpeakingRate`, and it is read when the session builds its voice chain, so a change applies to the next session. |
| Volume | `GENTLE_PI_VOICE_VOLUME` turns the reply down, from `0` (silent) to `1` (full, the default), for example `0.8` for a fifth quieter. It scales the reply's own audio, so the machine's volume and every other sound stay as they are: the robot voice scales the samples before the player gets them. A value that is not a number from 0 to 1 reads as full volume, so a typo never mutes a reply or makes it louder. It is read when the session builds its voice chain, so a change applies to the next session. |
| Retry | A failure before any of the reply was heard (a missing voice, a synthesizer that did not start, a timeout) is read again once from the start by the same voice. A second failure ends the reading with `error` and the voice's one fixed message: there is no fallback to Miro, Kokoro or the plain Windows voice. A failure after part of the reply was heard stops there, so the reply is never repeated from the start. |
| Stop | Esc stops the reading and is consumed, so it never reaches the editor or the agent. **Stop reading** in `/gentle:voice` does the same. Your own message, typed or spoken, stops it too. A run that a background notice or another extension starts does not: its reply waits until the reading ends, and only the newest reply waits. Esc, Stop reading, voice off, the end of the session and your own message also drop the waiting and the held reply. |
| Talk over it | The dictation shortcut (`alt+m`) stops the reading and starts a dictation at once. |
| Footer | `Reading reply · esc stop · alt+m talk` while it reads. No reading state is published on the voice-state event; the speech event below covers what is playing. |
| Process | Each reading runs two PowerShell processes with fixed scripts; the reply goes only through standard input, as base64 JSON, never as an argument. PowerShell takes about 1.5 seconds to start before the voice is heard. Of its output, only the one word the player writes before each line it plays is read, to report that chunk as it starts; everything else is discarded and a failure shows one fixed message. Each chunk is written to it only after it reported the previous one began, because its input and output share one relay. A reading is killed after 60 seconds plus about 0.15 second per character. |

### Speech events

While a reply is read aloud, the extension publishes what is playing on the
extension event bus, so an animation, a visualizer or any other consumer can
follow the voice without touching the voice command:

```ts
type VoiceSpeechEvent =
	| { schema: "gentle-pi.voice-speech/v1"; phase: "start"; engine: string }
	| { schema: "gentle-pi.voice-speech/v1"; phase: "chunk"; engine: string; frameMs: number; durationMs: number; levels: number[] }
	| { schema: "gentle-pi.voice-speech/v1"; phase: "end"; engine: string; outcome: string };

pi.events.on("gentle-ai:voice-speech", (event: VoiceSpeechEvent) => {
	// start: a reading began. chunk: one chunk is playing now. end: it is over.
});
```

| Topic | Behavior |
|-------|----------|
| Channel | `gentle-ai:voice-speech`, schema `gentle-pi.voice-speech/v1`. Subscribing is the only setup, and a session may subscribe or not. |
| `phase: "start"` | Published once, right before the engine is asked to speak. `engine` names the voice that speaks, not the chain: `Microsoft Raul` for Spanish and undecided replies, `Microsoft David` for English ones. An engine that names no voice reports its id (the `fake` of the tests does). |
| `phase: "chunk"` | One per chunk the player really begins, in the order the chunks were queued, so a chunk still waiting in the player is never reported. `levels` is one RMS value per 50 ms of that chunk (`frameMs: 50`), normalized to the loudest frame of that chunk, so the peak frame is `1` and a silent chunk is all zeros. `durationMs` is the length of the chunk. Scale `levels` to your own effect; they are relative per chunk, never absolute loudness. |
| One chunk at a time | The player gets the first chunk at once and each next one only once it reported it began the previous one, and each chunk is measured then. Under WSL a player's input and output share one interop relay, which holds the report back while chunk bytes are still to be delivered: a player fed a chunk ahead reported every chunk about one chunk late (measured over four 4 s chunks, the second event arrived 4.1 s after the audio it named, and two events arrived 3 ms apart). One chunk in the player keeps that relay idle, so every event lands with the audio it names (measured against the player's own clock: 0, 3, 10 and 17 ms). |
| `phase: "end"` | Published exactly once per reading, whatever ended it, with the outcome the reading log records: `done`, `skipped` (Esc), `cancelled` (Stop reading or your own message), `empty`, `unavailable` or `error`. A failed reading still reports `error` and still shows its one message. |
| Which voices report chunks | The robot voice plays audio that Node already holds, so it reports one chunk per chunk the player begins, for Spanish and English alike. A voice that hands the text to PowerShell instead, such as the plain Windows voice, reports only `start` and `end`: there is no audio in Node to measure. |
| What it never carries | Reply text, file paths, transcript and error messages. Only the voice name, the loudness of audio that already played, and the outcome. |
| Safety | The event is advisory: a listener that throws, and a session with no event bus, never break, delay or silence a reading. Publishing starts no process and opens no file. |

### Conversation

In a voice session the dictation shortcut turns dictation and spoken replies
into a hands-free loop: you speak, the transcript is sent, the reply is read
aloud, and the microphone reopens. It needs voice dictation installed.

| Topic | Behavior |
|-------|----------|
| Start | Press `alt+m` and speak. Recording ends by itself after 2.5 seconds of quiet that follows speech, room to think between sentences, so no second press is needed. |
| Send | The transcript is sent as the next prompt, never pasted. Whatever is in the draft goes with it, draft first, then a blank line and the transcript, and the draft is cleared: a pasted image is a file path in the draft, so it is sent exactly as a typed submit would send it. A blank draft sends the transcript alone; a turn that hears nothing sends nothing and keeps the draft. While the agent is still busy it is queued as a follow-up instead of interrupting the run. |
| The loop | When the reply to something you said has been read to the end, the microphone reopens the same way, but only in the pane herdr reports focused (`herdr pane get`, from `HERDR_PANE_ID`); outside herdr the pane counts as focused. In another pane it stays closed with "Conversation paused in this pane. Press alt+m to talk." A reply that settled while you were in another pane is held and read when you come back to this one (see [Reading replies](#reading-replies)), and it reopens the microphone by the same rule once it is read. A reply with nothing readable reopens it too. A reply to a typed message is read but never reopens the microphone. The spoken turn stays pending until the microphone reopens, so a run that a background notice starts, and that cuts the reading, does not lose it: the next reply reopens the microphone. Typing a message, Stop reading and a failed reading end the spoken turn. Esc on a reading skips the rest of it and reopens the microphone after a spoken turn, exactly as reading it to the end does (recorded as `outcome=skipped`, `mic.reopen result=opened`); esc on the reading of a typed message stops it and leaves the microphone closed, because a typed turn has nothing to answer. A failed herdr lookup keeps it closed. |
| Dictated turn | A message whose text came from a dictation counts as a spoken turn too. A dictation inserts its transcript into the editor; when you then send that message with Enter, Pi reports it as an ordinary interactive message, and the reply is still read aloud **and** reopens the microphone, exactly like a hands-free turn. The rule is conservative: the message counts as spoken only while the transcript this session inserted is still in it, so editing the dictation away or typing a message of your own leaves a read-only typed turn, which never reopens the microphone. Each dictation answers for one turn; after that the microphone does not reopen for a later typed message. |
| Spoken commands | A whole utterance from a fixed list runs a command instead of being sent; see [Spoken commands](#spoken-commands). |
| Pause | Esc while listening cancels the recording and pauses the conversation. Esc while the reply to something you said is read skips the rest of the reading and reopens the microphone, so you can correct what you already heard; `alt+m` then closes it without sending. Esc on the reading of a typed message stops it and leaves the microphone closed. Stopping it with `alt+m` before saying anything also pauses it, with "Conversation paused. Press alt+m to talk." With no speech within 8 seconds, it pauses with "Conversation paused: no speech was heard. Press alt+m to talk." Press `alt+m` to go on. |
| Send early | `alt+m` while listening stops the recording and sends at once. |
| Footer | `● Conversation · listening · alt+m send · esc pause` while recording, then transcribing and sending. |
| Other inputs | Hold-Space push-to-talk and **Start dictation** keep pasting into the draft; only the shortcut takes part in the conversation. |
| End of speech | The worker measures the audio in 100 ms windows of audio time, never per device chunk: a WSLg microphone delivers 10 ms chunks whose levels scatter two to four times around the floor. The noise floor is the quietest window heard so far, and a window counts as speech when it is at least three times that floor and above a fixed minimum of 0.005 RMS, above the loudest ambient window measured on a low-gain WSLg microphone (0.0031; speech there starts at 0.016). Speech counts once 150 ms of it were heard. The quiet period then runs from the last speech window and forgives one isolated loud window (a click, an ambient spike) in every eight, so the 2.5 s pause survives three such windows; the tail of the speech itself is never forgiven. The request carries `endpoint: { endOfSpeechMs, noSpeechMs }`, bounded to 300–5000 ms and 1–60 s. A conversation turn and a dictation that pastes carry the same two values (`CONVERSATION_ENDPOINT` and `DICTATION_ENDPOINT` in `lib/voice-command.ts`); what happens when nothing was heard differs: a conversation pauses, a dictation reports that nothing was pasted. Without the field a recording never ends on silence, exactly as before. |

The thresholds are tested with synthetic audio only. A loud room or a quiet
microphone may need the shortcut to send; tuning them on real microphones is
still open.

### Spoken commands

Some whole utterances are commands. Only an utterance that is exactly one of
them runs one: the same words inside a longer sentence are sent to the model as
ordinary text. The current list has two commands:

| Said | Effect |
|------|--------|
| `Gentle Voice off` | Turns voice off in this session, exactly as **Voice in this session (on): turn off** does in `/gentle:voice`: spoken replies stop being read, a reading in progress is cut, the pending spoken turn is cleared and the kept-alive dictation worker is closed. Nothing is sent to the model and nothing is pasted. The draft is left as it was. Voice goes off in every session, not only in this one, and the microphone stays owned by the listener, which listens for `Gentle Voice on` from then on. |
| `Gentle Voice on` | Works only while voice is asleep, and wakes only the session herdr reports focused. That session turns voice on, as **turn on** does in `/gentle:voice`, and starts listening on its own: the same hands-free conversation the `alt+m` shortcut starts, with the same end-of-speech endpoint, the transcript sent to the model and the microphone reopened after the reply is read. The open cue is the capture's own and plays once the microphone really records; the window has no resting form to draw before that. When the session cannot record right now (a dictation is already running, or a reading holds the turn) it only turns voice on: nothing plays and nothing is claimed. With no focused session connected nothing turns on and the listener keeps listening. Said while voice is already on, it does nothing. |

Case, accents, punctuation and extra spaces never decide whether a command was
spoken: `gentle voice, off.` and `Gentle  voice  OFF` are the same command. A
likely transcription still counts, such as `gentle voz off`, `yentel voice off`
or `gentel voice of`, because the transcription matcher accepts a small fixed
set of words at each position. It never accepts a different sentence: `quiero
que digas gentle voice off`, `gentle voice offset` and `gentle voice` are all
text.

Two things hear a command, and only one of them can fire for a single recording.
The keyword spotter inside the worker hears the phrase in every capture the
listener starts, hands-free or not, and ends that capture with the command
instead of a transcript, so no text exists to match. The text matcher above is
the fallback for a recording that was transcribed: a session that reached no
listener and records itself, or a phrase the spotter did not catch.

The command is checked in every place a transcript arrives: a hands-free
conversation turn, the dictation shortcut when voice is off (which pastes), a
Space hold and **Start dictation**. It never enters the editor and never becomes
a prompt. The log keeps one `voice.command` event with the command `name`, never
the transcript.

Voice never runs free text as a command. The list is fixed in
`lib/voice-spoken-command.ts` and only a matcher hit does anything, so nothing
you say can invent an action; later phases (agent navigation, English mode) add
entries to that same list instead of matching free text.

### Microphone cues

Two short rising notes play when the microphone really starts recording,
after the worker reports it, and one longer falling note when recording stops:
at the end of speech, on the dictation shortcut, or on Esc. A capture cancelled
before it recorded plays neither. Both shortcut dictation and hands-free turns
play them.

| Cue | Tone |
|-----|------|
| Open | G5 then D6, 120 ms each with a 40 ms silent gap (280 ms) |
| Close | One note falling from E5 to A4 (260 ms) |

The tones are generated in `lib/voice-cues.ts` at 60% of full scale.
`GENTLE_PI_VOICE_CUE_VOLUME` sets that level from `0` (silent) to `1` (full
scale); anything else keeps `0.6`. It is read when the session creates its cue
player, so a change applies to the next session.

Under WSL the cues play on Windows, on the same output the reply voice uses,
because WSLg's PulseAudio output can be another device or a quieter one: with
the replies on the speakers, the PulseAudio cues were not heard. One
PowerShell host (`lib/voice-cues-windows.ts`) stays warm: the tones reach it
once over stdin as base64 lines, never on the command line, and each cue is
one `play open` or `play close` line that the host answers once the tone has
played. Started cold it answers in about 1.5 s; warm, a cue takes about its
own length (about 325 ms measured). A voice session warms it at session start
and when voice is turned on, and it retires after 30 idle minutes. When the
Windows host fails, the cue plays through the native PulseAudio player the
notifications use. On plain Linux the cues play only through PulseAudio. On
native Windows they stay silent. The players and their files are released when
the Pi session ends.

A cue stays advisory: it never blocks the microphone, and a player that throws
or answers with nothing never breaks the capture it announced. Each cue does
report what became of it, as a `cue` event in `voice-events.log` with its
`name`, its `outcome`, how many milliseconds the player took, the `mode` that
asked for it (`conversation` or `dictation`), and `sinceReadingMs` when the
session has already read a reply: how long before the cue the last reading
ended. The two modes play the same tones through the same player, and those two
fields exist so a difference heard between them can be traced from the log
instead of guessed.

Each outcome means:

| Outcome | Meaning |
|---------|---------|
| `done` | The Windows host played the tone, or the Pulse player drained it into the sink. Whether it reached the ears is then up to the output device; the log cannot tell. |
| `failed` | The player was asked and did not confirm the tone. |
| `unavailable` | No player is reachable, so nothing was played. |

Whoever holds the microphone plays the cues: the listener, once a capture runs
through it, and the session itself only when it records on its own because no
listener could be reached. Whichever plays them, one capture plays one open cue
and at most one close cue, and the log says which process played it.

A cue that comes back `failed` is played once more after about 150 ms: the
Pulse worker retires after a minute idle, so the first cue after a long reading
can reach a worker that is already on its way out. A cue that played is never
played twice. On a cold player the first cue also pays the worker's start-up:
measured here, 527 ms end to end, and the monitor capture of the same run shows
the tone reaching the RDP sink.

### Faster transcription

A dictation worker started for one recording verifies the 670 MB model digests
and loads the recognizer every time: on the owner's machine about 3 seconds
for the digests and 3.3 seconds for the load, before a 0.4-second decode of 3
seconds of audio. The listener therefore starts one worker and keeps it alive
between recordings (`keepAlive: true` in its start request), so both kinds of
recording reuse it, and a session that records on its own because no listener
answers reuses its own worker the same way:

| Topic | Behavior |
|-------|----------|
| First recording | Verifies and loads the model as before: about 4.6 seconds from the end of speech to the transcript, measured. |
| Next recordings | Reuse the verified model and the loaded recognizer, with 4 decoding threads: 0.3 to 0.6 seconds, measured. The install is still checked before each one. |
| Microphone | Opened only while recording and released after each one; the worker keeps only the model. |
| Memory | The loaded model, about 1 GB, stays in that one worker process, on the CPU only. |
| Release | The worker closes after 10 idle minutes, when voice is turned off in every session and when the listener exits. On its own, a session follows the same rules and ends with the Pi session. A cancel or any error ends it, and the next recording starts a fresh one. |
| Noise | With no speech heard by the end-of-speech detector, the recognizer is not asked at all and the transcript is blank, because Parakeet can turn noise into a word such as "Yeah." that would otherwise be sent. |

## Voice listener

One listener per user owns the microphone for every session, so a session that
is not focused still hears nothing and two panes never record at once. It owns
the process, the lock and the socket, and the microphone itself: the warm
dictation worker, its transcription and the microphone cues all live in it, and
a session that asks for a capture only receives the transcript.

- **Single instance.** The listener binds `listener.sock` in the voice directory
  and holds `listener.lock` (an exclusive create of the same kind the reading
  turn uses). A second listener refuses with `voice_listener_busy`; a lock left
  by a process that is gone, or one whose heartbeat stopped, is taken over.
- **No session, no listener.** With no client connected it exits after a
  minute; asleep with no session that has voice on, it ends after ten minutes
  (turning voice off in any session turns it off everywhere), and it removes its
  socket and lock on the way out.
- **Protocol.** `gentle.voice-listener/v1`, JSON on one line each way, at most
  64 KiB per line. A connection starts with a hello carrying the session id and
  the herdr pane id, then answers status and reports the state:
  `asleep`, `listening`, `transcribing`, `reading`. One session holds two
  connections at once: its own long-lived one (the microphone, the wake, the
  voice frames) and the one a reply is read on. Only the reading connection
  names itself (`role: "reading"`); the session's own sends no role at all, which
  is what every peer wrote before the field existed and what an older listener
  still reads as the session's own. The listener replaces a socket only with one
  of the same session and role, so a hello never evicts the connection its own
  reading is held on. A replaced connection is told why (`bye` with `replaced`)
  and never reconnects; it joins again with a new one.
  The reading turn is part of
  it: `read-begin` asks for it, `read-heartbeat` renews it, `read-end` gives it
  back with how the reading ended (`done`, `skipped`, `cancelled`) and
  `read-cut` takes it from any session. The answer is one `granted` or a `busy`
  naming the session that holds it (or `asleep`, when nothing has voice on),
  and every session hears the `reading` events, so a waiting one knows the turn
  is free.
- **One target.** A transcript goes only to the session whose pane herdr
  reports focused when the recording ends; with nobody focused it goes to the
  single registered session, and otherwise it is dropped and logged. A failed
  herdr lookup never guesses, so it never opens a microphone for the wrong pane.
- **One reading.** The listener hands the reading turn to one session at a time
  and never speaks itself: the session reads through PowerShell exactly as it
  did before. The turn is renewed every 5 seconds against a 15-second lease, so
  a session that crashed, was closed or lost its listener frees it without
  anybody waiting for the lease, and the state stays `reading` for a short tail
  after the end so the next reading never starts over the last sentence. A
  session starts the listener when none is running, and reads through its own
  local turn only when no listener can be reached at all.

- **Capture.** `dictate` asks for the microphone with a mode (`dictation` or
  `conversation`, the latter carrying the conversation endpoint), `stop` ends
  the recording and `cancel` throws it away. The listener answers every step
  with a `capture` frame naming its phase: `recording`, `transcribing`,
  `delivered`, `elsewhere` (another pane had the focus, and it got the
  transcript), `dropped` (nobody could take it), `cancelled` or `failed` with a
  code. The warm worker is started once and reused, so the model is loaded
  before the first recording, and the cues play next to it: the open cue when
  the recording starts and the close cue when it ends.
- **One capture at a time.** A second `dictate` is refused with `busy` naming
  the session that holds the microphone, and so is a reading begun while a
  capture is live; `stop` and `cancel` from any other session are refused too.
  A session that leaves frees the microphone at once.
- **Levels for a display.** The worker publishes its microphone level only when
  something draws it: the listener starts a capture with the worker's `levels`
  option when an overlay is present or a session subscribed, and without it the
  worker speaks exactly the messages it always did. A session subscribes with
  `levels { on: true }` (answered with an `ok`) and receives `level` frames
  while the capture records: `{ rms, at }`, one per 50 ms of audio and never
  more than twenty a second, whatever the device chunk size is. Unsubscribing,
  disconnecting or the recording ending stops them for that session. The value
  is a number and nothing else: it is never logged, and no audio is stored.
- **One label per session.** The hello always carried a `label` that production
  never set. A session now sends a short display label — the name Pi keeps for
  it, or the last segment of the directory it runs in, stripped of control
  characters and cut to 48 characters — and every `state` frame names the
  language and the session that owns the capture or the reading (`language`
  with its `paneId` and `label`), so a window labels the microphone without
  asking. Display only: nothing routes a transcript by it.
- **The reading's own loudness.** While a reply is read aloud, the session that
  holds the reading turn sends the loudness of each chunk its player begins
  (`read-levels`: the reading id, the frame width and a bounded list of values),
  and the listener draws it in audio time, at most twenty values a second. Only
  the holder of that reading is accepted, and the end of the reading, a cut, a
  lapsed lease or a disconnect stops it at once. The microphone meter and the
  speech events outside consumers receive are unchanged.
- **Spoken commands in the worker.** Every capture the listener starts carries a
  `kws` option: the pinned keyword spotter model with its digests, the keyword
  lines with the command each one stands for, and the tuning values (score 2,
  threshold 0.25, 16 active paths, 2 trailing blanks). The worker verifies that
  model before the microphone opens and runs one keyword spotter on the same
  audio it records. The spotter fires on a phrase wherever it is said, so the
  worker applies the whole-utterance rule itself: a hit is a command only when
  no more speech came before it than the phrase takes (2.6 s from the start of
  the utterance) and 0.4 s of silence follows within a second, or the recording
  ends. A command ends that capture with a `command` message naming it
  (`voice-on`, `voice-off`, `cancel`) in place of a transcript, so the phrase
  never reaches the dictation model; a phrase inside a sentence changes nothing
  and is dictated like any other words. Without the option the worker loads no
  spotter and its output is unchanged. With `spot: true` as well, the capture is
  for the spotter alone: it answers `spotting`, keeps no audio, has no time
  limit, never verifies or loads the dictation model, and ends with a `command`,
  or with `stopped` when it is told to stop. It is what listens while voice is
  asleep. The warm worker (`lib/voice-warm.ts`) carries both: a session given
  `kws` resolves with `command` set and an empty text when the capture ended on a
  command, and `spot()` opens a spot-only capture whose `heard()` resolves with
  the command, or with nothing when it was stopped. A session that did not ask
  ignores a stray `command`.
- **A spoken command ends its capture, not a text.** A capture that ends on a
  command delivers nothing: no transcript to the focused pane, so the text
  matcher in the session can never also fire for it, and the requester gets
  exactly what a recording that heard nothing gets (a `failed` capture with
  `no-speech`). `Gentle Voice off` turns voice off in every session and cuts a
  reading, exactly as a session's own voice off does, and the listener stays
  asleep with the microphone for the keyword only. Any other command leaves
  voice as it was. The log carries one `capture.command` event with the session,
  the mode and the command id: never audio, never a level, never a transcript.
- **Asleep keeps listening.** While the listener is asleep and the spotter is
  installed, it keeps a spot-only capture open: the microphone stays open for the
  keyword alone, with no transcript and no cue. `Gentle Voice on` wakes the
  session herdr reports focused, and only that one: its voice turns on, it starts
  the same hands-free conversation `alt+m` starts (voice `on`, the listener's
  capture records, transcribes and sends, and the microphone reopens after the
  reply is read), the listener state becomes `listening`, and that session alone
  is told the frame was a wake (`command: voice-on` with `wake: true`) while every
  other session hears the plain broadcast it already knew. The open cue is the
  capture's own, played once the microphone really records: the wake plays none,
  so nothing beeps before there is something to hear. A woken session that cannot
  record (a dictation already running, a reading holding the turn) only turns
  voice on: nothing beeps and nothing is claimed, and voice stays on for it. A
  wake followed by silence is an ordinary hands-free turn and invents no rule of
  its own: the capture reports `no-speech`, nothing is sent, and the session
  notifies `Conversation paused: no speech was heard. Press alt+m to talk.`. With
  no focused pane, a failed lookup or a focused pane with no session, nothing
  turns on and the listener opens another spot-only capture; anything else it
  hears (a `voice-off`, a `cancel`, an unknown id) changes nothing and listens
  again. Ten minutes of being asleep with no session that has voice on still
  closes the listener, and the spot-only capture closes with it.
- **One microphone.** The spotter owns the microphone only while nothing else
  needs it: a `dictate` from any session stops the spot-only capture and waits
  until it closed before the recording opens, and spotting resumes when that
  recording ends with no session that has voice on (a wake, or voice that was on,
  leaves the listener awake instead). A reading stops the spotter too: a reply is
  never read while the microphone is open for a keyword, and spotting starts
  again after the reading's tail. Leaving `asleep` for any reason stops it, and
  so does closing the listener. A spotter that cannot open the microphone, or
  that dies, is logged once (`kws.failed`, the event name only) and dropped for
  the rest of the listener's life: it stays asleep without spotting, and capture,
  transcripts, cues and readings carry on as before.
- **No spotter, no keyword.** The option is built by
  `buildVoiceKeywordOption()` from the installed component, the pinned digests
  and `assets/voice/kws-keywords.txt`. When the spotter is not installed, is half
  extracted, or the keyword file does not parse, the listener gets no keyword at
  all, logs `listener.keyword-unavailable` once at startup and behaves exactly
  as it did before the spotter existed. Keyword hits and wakes are logged as
  event names, command ids and session ids only: no audio, no text and no
  level is ever stored.
- **The overlay port.** `lib/voice-overlay.ts` is the seam the window plugs into:
  the listener hands it a snapshot of the display (state, language, owning session) on every change and the smoothed level while recording. The
  meter lives there, never in the detector: the same worker RMS is normalized
  between the measured WSLg floor (0.0031) and measured speech (0.016) and
  smoothed fast up, slow down, so the endpointer's own thresholds are
  untouched. A reading has its own output meter (floor 0.02, full bar at 0.25),
  because the played speech is an RMS on a 0..1 scale and silent between words.
  An overlay that throws, rejects or never answers is logged once
  (`overlay.failed`, the event name only, never a level or a transcript) and
  dropped for good; capture, transcripts, cues and readings carry on without
  it.

- **The overlay window.** Under WSL or Windows the listener owns a small window
  (`lib/voice-overlay-windows.ts`, `scripts/voice-overlay-window.ps1`, the design
  `design/voice-overlay/03-bordes-y-pildora.html`). It is a WPF window started
  through PowerShell on the cue host's shape: one warm process, one short line
  per command on stdin, a state change acknowledged and the levels fire and
  forget, at most one every 40 ms with only the newest kept. A state line is
  followed by `rec 1` or `rec 0`: the snapshot's `recording` flag is the only
  truth about an open microphone, so the window never has to infer it from the
  audio. It is always on top,
  click-through (a click on it reaches the window underneath), never takes the
  focus, and is absent from the taskbar and Alt+Tab. There is no resting form: it
  appears on the monitor that holds the foreground window when a state starts, and
  draws nothing while nothing is under way. Everything is local:
  nothing leaves the machine, and no level, session name or transcript is ever
  logged.
  - **Listening** (the microphone really records): the four screen edges glow in
    rose and breathe with the microphone level, and the pill shows a mic badge,
    "ESCUCHANDO", the session label, a mirrored wave and the language chip.
  - **No resting form:** voice on with nothing under way draws nothing. There is
    no pill, no badge and no glow for an armed microphone, and a wake draws no
    window of its own; the listening form appears with the recording and goes with
    it. The full listening
    look is drawn from the snapshot's explicit `recording` flag, never guessed
    from the audio: the listener sets it when the worker reports that it is
    recording and clears it when that recording ends (a stop, a cancel, a
    failure, the session closing or the listener leaving), in every state. Levels
    never turn it on and a quiet microphone never turns it off, so the window
    cannot say the microphone is open when it is not, and a silent moment never
    hides an open microphone.
  - **Transcribing:** an amber bar sweeps along the top edge and the pill shows a
    spinner and "TRANSCRIBIENDO…".
  - **Reading:** a green glow along the bottom edge only, a speaker badge,
    "LEYENDO", "de" plus the session label, and bars rising from the baseline that
    follow the level of the speech the player actually started. If no level has
    arrived for 300 ms the bars fall back to a gentle synthesized motion.
  - **Asleep:** nothing is drawn. The keyword is still heard by the listener,
    which is the only thing awake, and the window has no form to show for it.
  - **Language:** the chip shows `ES`; `EN` is drawn as the filled blue English
    chip. The rest of the English mode (blue edges) and the confirmation state are
    designed but not wired yet.
  - **Turn it off:** `GENTLE_PI_VOICE_OVERLAY=off` before the listener starts
    (there is no settings key). With no PowerShell, or off Windows and WSL, no
    window is built and voice is unchanged. If the window process exits, refuses
    or hangs, the listener logs `overlay.failed` once, drops it for the rest of
    its life and carries on; it is never restarted in a loop. The window closes
    with the listener, and closes by itself if the listener dies.
  - **Known limits:** the window follows the Windows "show animations" setting
    (off: a still spinner and sweep, no synthesized reading motion). It is drawn
    at the DPI of the monitor it opens on; only 100% scaling was exercised. The
    PowerShell host costs about 4 to 5% of one core while listening with a moving
    wave (about 1% once warm), 1 to 2% while transcribing or reading, and nothing
    when idle, and holds about 150 MiB. A full-screen game or a window that
    outranks topmost windows can cover it.
  - **See it without talking:**
    `node --experimental-strip-types scripts/voice-overlay-demo.mjs` shows the
    real window state by state for about 36 seconds with synthetic levels. It
    opens no microphone, plays no audio and closes the window when it ends.

A session dictates through the listener: the lock, the socket, the turn and the
microphone are live, and a reply is read only in the pane herdr reports focused
(S12). A session that cannot reach a listener records itself, exactly as
described above, and a session that is not focused receives neither a transcript
nor a reading. The keyword spotter is live for the spoken commands and the wake
word; the echo cancellation the design defers (§5) is still to come, and with it
a phrase that cuts a reply being read: nothing listens while a reading speaks, so
`Gentle Voice off` does not cut a reply aloud yet. The capture path is shaped so
a reference stream can be tapped into it when it arrives.

## Natural voice with Kokoro

The Windows voice works with no download but sounds robotic. Once the voice
runtime is installed, `/gentle:voice` offers **Download natural voice (Kokoro,
about 355 MB)**. The confirmation lists the files, the destination, the sizes
and the licenses; nothing is fetched before you accept, and Esc cancels.

| Component | Source | Size | Verified by |
|-----------|--------|------|-------------|
| `model.onnx`, `voices.bin`, `tokens.txt`, `LICENSE` | Hugging Face `csukuangfj/kokoro-multi-lang-v1_0`, commit `f7b96bb6bef5` | about 354 MB | per-file size and SHA-256 |
| espeak-ng phoneme data: `phontab`, `phonindex`, `phondata`, `intonations`, `es_dict`, `en_dict`, `lang/roa/es`, `lang/roa/es-419`, `lang/gmw/en`, `lang/gmw/en-US` | same commit | under 1 MB | per-file size and SHA-256 |

Only Spanish and English phoneme data is downloaded, not the 355 files
upstream ships. Every size and digest was checked against the upstream
`kokoro-multi-lang-v1_0.tar.bz2` release asset, whose files are identical. The
pins live in `lib/voice-kokoro.ts`.

The installer accepts flat file names only, and that guard is kept. The
phoneme data comes from nested folders, so it is installed as three flat
components, one per folder, under `models/` next to Parakeet; the speech worker
rebuilds the folder tree espeak-ng expects in a private temporary directory.

Once it is installed, it stays offered in `/gentle:voice`, but a spoken reply
no longer uses it: the robot voice reads every reply, in both languages (see
[Robot voice](#robot-voice)). The engine is kept for the voice workers and for
any future use, and nothing reads a reply with it today.

| Topic | Behavior |
|-------|----------|
| Voices | Spanish replies are read by `ef_dora` (speaker 28) with espeak-ng language `es`, English replies by `af_heart` (speaker 3) with `en-us`. |
| How it plays | `scripts/voice-tts-worker.cjs` runs in its own Node process with a scrubbed environment and synthesizes chunk by chunk: the first sentence alone, then one sentence per chunk, short ones merged up to 40 characters and none past 160, so each chunk is ready before the previous one ends. It reads 8% faster than the voice's normal pace. Each chunk goes as a 16-bit mono WAV line to one PowerShell process that plays it with `System.Media.SoundPlayer`. PowerShell starts while the first sentence is synthesized. |
| Speed | On an idle CPU with 4 threads, synthesis ran at about a third of real time; under heavy load it ran slower than real time, which leaves pauses between chunks. |
| Checks | Before anything native loads, the worker checks that every model and phoneme file is a regular file of the pinned size. Digests are verified at download, and the parent checks the install marker before each reading. The worker's temporary phoneme tree is removed whenever it ends. |
| Failure | A natural-voice failure before any audio was played falls back to the Windows voice, silently. A failure after part of the reply was heard stops there with "The reply could not be read aloud." instead of reading it again from the start. No reply chain reaches this voice today, so neither case is reachable from a reading. |
| Stop | Esc and the dictation shortcut kill both processes. The worker handles the termination signal, so its temporary phoneme tree is still removed; a chunk being synthesized at that moment finishes first, so the worker can outlive the stop by a few seconds while the player is already silent. |

Licenses: the Kokoro-82M weights by hexgrad are Apache-2.0, exported for
sherpa-onnx by csukuangfj. The espeak-ng phoneme data is GPL-3.0-or-later. It
runs on the pinned sherpa-onnx 1.13.8 runtime; sherpa-onnx 2.x drops espeak-ng,
so that pin must not move without replacing the phonemizer.

## Robot voice

The owner's pick reads every reply. Spanish and undecided replies are read by
the Windows OneCore voice **Microsoft Raul** (es-MX) and English ones by
**Microsoft David** (en-US), both with the same metallic robot effect and
leveler. Everything runs on this machine; no text leaves it. It needs no
download: both voices ship with Windows' speech packs.

| Topic | Behavior |
|-------|----------|
| Which voice | A `es` reading (or one whose language is undecided) asks for `Microsoft Raul`; an `en` reading asks for `Microsoft David`. Both come from the same engine, so the effect, the leveler, the volume and the chunk reporting are identical. There is no other voice in the chain: Miro, Kokoro and the plain Windows voice never read a reply. |
| Rate | Each reading carries its language's multiplier (`GENTLE_PI_VOICE_RATE_ES`, `GENTLE_PI_VOICE_RATE_EN`, default `1`) and the synthesizer sets it as its `SpeakingRate`: `0.5` is the slowest, `2` the fastest, and the bounds are clamped in both Node and the script. |
| How it plays | One PowerShell process synthesizes the reply sentence by sentence through the WinRT speech API (`lib/voice-onecore.ts`) and writes each sentence as a base64 WAV line; the reply and its rate reach it only through standard input, as base64 JSON lines. Each sentence is processed in code and handed to a second PowerShell process that plays them in order. |
| Effect | `lib/voice-robot.ts` reproduces ffmpeg's `afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,volume=1.6` step by step from `af_afftfilt.c` (ffmpeg 6.1): on a real reply it matches ffmpeg's output within 0.00002, less than one 16-bit step, and processes 20 seconds of audio in about 0.3 seconds. ffmpeg is not needed. |
| Level | The effect leaves speech low and uneven, so a leveler brings every 50 ms of speech toward a steady level (at most 6 times louder, never quieter), keeps pauses as they are, and rounds off peaks instead of clipping. |
| Retry and failure | A failure before any of the reply was heard (no-voice, unavailable, failed, timeout) is retried once by the same voice, from the start. A second failure ends the reading with `error` and the voice's one fixed message (`The Windows voice Microsoft David is not installed.`), and no other voice takes over. A failure after part of the reply was heard stops there, so nothing is repeated. |

## Miro voice (Piper)

Miro is a Spanish (Spain) Piper VITS voice. Once the voice runtime is installed,
`/gentle:voice` still offers **Download Miro voice (Piper, about 64 MB)**, but it
no longer reads replies. The confirmation names the files, the destination and
the license; nothing is fetched before you accept.

| Topic | Behavior |
|-------|----------|
| Source | `es_ES-miro-high.onnx`, `tokens.txt` and its `README.md` license text from Hugging Face `csukuangfj/vits-piper-es_ES-miro-high`, commit `0e1f77356142`, checked against the sherpa-onnx release tarball. Pins live in `lib/voice-kokoro.ts`. |
| Phoneme data | Reuses the Spanish and English espeak-ng parts the natural voice uses; installing Miro fetches them only when missing. |
| Which voice reads | None: no reply is read by Miro. Spanish replies are read by Raúl and English ones by David, both from the robot voice. |
| License | CC BY-NC-SA 4.0: non-commercial use only. It reads replies to the owner inside this personal tool; it is not shipped in any product. |

## Diagnostics

Every voice session appends one JSON line per voice event to
`voice-events.log` in the voice directory (`~/.pi/gentle-ai/voice/`): typed or
spoken input, a spoken turn sent, a reply settled, a reading started and how it
ended, a reply held for the focus or dropped instead of read, and each
microphone reopen decision with its reason (`opened`, or
skipped for `not-focused`, `no-spoken-turn`, `voice-off`, `reading-cancelled`,
`reading-error`, `dictation-running`, `voice-busy`), the wake decision with
its result (`wake.conversation`: `opened`, or skipped with the reason that stopped
it), each microphone cue
with its `name`, `outcome` (`done`, `failed`, `unavailable`), latency, the mode that asked for it and, after a reading, `sinceReadingMs`, and each spoken command
it ran. Lines
carry the time, the process id and the session id, and sizes instead of text:
no reply or transcript text is written. Past 512 KB the log moves to
`voice-events.log.1`.

An `input` line names its `source` and also says `dictated: true` when the
submitted message still carried the transcript a dictation inserted, which is
what makes it a spoken turn. A `voice.command` line carries the command `name`
(`voice-off`) and the session, never the words that were spoken.

The reading lines name the voice that spoke and why a reading changed course:

| Event | Fields |
|-------|--------|
| `reading.start` | `session`, `chars`, `voice` (`Microsoft Raul` or `Microsoft David`) and `language` (`es`, `en`, or absent when the reply's language is undecided). |
| `reading.retry` | `session`, `voice`, `attempt` (`1`) and `failure`, one per retry, written between the start and the end: `no-voice`, `unavailable`, `failed` or `timeout`. |
| `reading.end` | `session`, `outcome` (`done`, `skipped`, `cancelled`, `empty`, `unavailable`, `error`) and `voice`; a failed reading adds `failure` with the same four codes. |

A reading that is retried and then fails writes `reading.start`,
`reading.retry` and one `reading.end { outcome: "error", failure }` naming the
voice that failed. The speech event's `engine` field carries the same voice name,
so a subscriber sees who speaks and the log says why.

A reply the focus moved away from is logged instead of read, so a session that
did not speak can be explained afterwards:

| Event | Fields |
|-------|--------|
| `reading.held` | `session` and `chars`: the reply settled while another pane had the focus. Written again when a newer reply replaces it. |
| `reading.dropped` | `session` and `reason` (`stale`, the only one today): the held reply settled more than ten minutes before and is never read. |

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

### Wake-word keyword spotter

"Gentle Voice on" and "Gentle Voice off" are heard by a local keyword spotter,
and the model it needs is pinned next to the dictation model. The listener uses
it: the wake word is live, so the command is heard while voice is asleep without
any transcription, and installing it is what makes that work.

| Topic | Fact |
|-------|------|
| What it is | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, an English keyword spotter trained on GigaSpeech XL (10,000 h): zipformer transducer, 3.3 M parameters, int8. It can only ever report the keywords this repository pins, never free text. |
| Where it comes from | The k2-fsa sherpa-onnx release tag `kws-models`, one `.tar.bz2` of 17,626,723 bytes. The one redirect followed is `release-assets.githubusercontent.com/github-production-release-asset/...`. |
| What is kept | `encoder-…int8.onnx`, `decoder-…int8.onnx`, `joiner-…int8.onnx` and `tokens.txt`: 5,253,530 bytes in total. `bpe.model` (only needed to encode a new keyword), the fp32 variants, the example `keywords.txt` and the test audio are dropped. |
| Licence | Apache-2.0, stated in the README inside the archive. |
| Extraction | The archive is checked against its pinned size and SHA-256 before anything is unpacked, then unpacked by the system `tar`, which needs bzip2 support, without a shell and with only the pinned member names. Every kept file is then checked against its own size and SHA-256. A missing file, an unexpected entry, a link, a wrong digest, a missing `tar` or bzip2, a non-zero exit and a timeout each fail the install with a fixed message and publish nothing. |
| Where it lands | `models/kws-zipformer-gigaspeech-3.3m-int8-2024-01-01/`, published with the same one-rename-and-marker rule as the other components. Status reports it as installed, absent or invalid, and only when the caller asks for it. |
| Never executed | Nothing from the archive is loaded or run during the install; it is only written to disk. It is also optional: a missing one is never an install failure for dictation. |

### The keyword file

`assets/voice/kws-keywords.txt` ships with the package; it is not downloaded. Each
line names the command it triggers, then the model's pieces, for example
`voice-on: ▁G ENT LE ▁ VO IC E ▁ON`. That standalone `▁` between the words is what
this model emits, and a line whose first piece loses its leading `▁` detects nothing.
One command may appear on several lines, so another pronunciation can be added and
measured without a code change. The known commands are `voice-on`, `voice-off` and
`cancel`; the shipped file has lines for the first two only, because the spoken word
for `cancel` is still being measured, and a file without one is valid. A malformed
line, an unknown command and the same spelling twice are refused by the parser. So
is a per-line suffix: the spotter is tuned globally by the listener (`2`, `0.25`,
`16`, `2`), so `:boost`, `#threshold` and the `@label` the spotter's own files use
ever start a keyword here.

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
  transcribes what it has (`truncated: true`). With an endpoint it also stops
  after 2.5 seconds of quiet that follow speech, or after 8 seconds without
  speech, and transcribes what it has. Starting (runtime checks and
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
| Linux x64, glibc 2.34+ | ALSA `libasound.so.2`; under WSL, a PulseAudio server (WSLg provides one) |
| Linux arm64, glibc 2.34+ | ALSA `libasound.so.2`; under WSL, a PulseAudio server (WSLg provides one) |
| Windows x64 | Microsoft Visual C++ runtime (`vcruntime140.dll`) |

node-cpal requires Node 22 or newer, and a dictation session refuses to start
on an older Node. Gentle AI never downloads or installs the Visual C++ runtime;
a missing runtime is expected to surface as a runtime load failure, which has
not been observed on hardware. `/gentle:voice` then names the runtime to install.

Apart from the user-confirmed WSLg session described below, these targets have not
been verified on real hardware. Linux with a glibc
older than 2.34 is unsupported and the diagnosis names the version found.
Windows ARM64 has no native sherpa-onnx package and is unsupported. musl Linux
is unsupported. On a Microsoft kernel (WSL) the worker selects node-cpal's
shipped PulseAudio backend instead of ALSA, because WSLg exposes audio through
a PulseAudio server and no ALSA device; the backend's own native file is
validated before loading.

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
