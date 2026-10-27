# Optional Wellness dock

Wellness is disabled unless `gentle-wellness.json` in Pi's agent directory explicitly sets `enabled: true`. Missing or invalid preferences do not opt in. No preferences are created or changed by the extension. Configure after arranging the owning session's safe handoff, then start a new session or reload extensions.

Spanish and fixed UTC−3 example:

```json
{
  "enabled": true,
  "notifications": true,
  "language": "es",
  "utcOffsetMinutes": -180,
  "waterMinutes": 30,
  "breakMinutes": 60,
  "stretchMinutes": 90,
  "dinnerTime": "21:00"
}
```

English and the host's local timezone are the defaults when language and offset are omitted. Fixed offsets do not follow daylight saving. Intervals must be integers from 1 to 1440 minutes; offsets range from −840 to 840 minutes. Dinner uses a valid 24-hour `HH:MM` time and rolls forward to the next day after that time.

At fullscreen widths of at least 140 columns, the dock is fixed below the model/context header and above the sidebar tabs. It remains visible when switching tabs or scrolling their contents. Narrow and regular mode show it below the editor. At 60 terminal columns or fewer (phone-sized) the dock is not painted at all; reminders, notices, `/gentle-wellness reset` and shared state keep running, and it reappears above 60 columns. It includes the clock, date, and water, break, stretch, and dinner countdowns. Shell-disabled, child-agent, and noninteractive sessions do not mount it.

Click a reminder's `↻` to reset water, break, or stretch. Use `/gentle-wellness reset water|break|stretch|dinner|all` for command resets (select one target). Dinner has no reset glyph: it stays due for one hour after its time, then rolls forward to the next day on its own. Other due reminders remain due until reset; rendering alone never consumes a notice.

Deadlines and revision-scoped notification claims are shared across sessions through `gentle-wellness-state/` in the agent directory. Existing deadlines survive restart; changed intervals apply on subsequent resets. Atomic per-reminder publication prevents partial records; reset-all is not a cross-reminder transaction. Corrupt records fail closed rather than being silently replaced. Claims are retained, so the directory grows with resets that reach their deadlines.

`notifications: false` keeps the dock and resets working without notices. A session still claims due revisions while muted, matching shared deduplication behavior; another session does not replay that claimed notice. Shared notification claims provide at-most-once delivery, not guaranteed delivery after a crash. Preferences themselves are never written by the extension.
