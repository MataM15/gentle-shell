# Config snapshot (`/gentle:config-snapshot`)

A human-invoked, one-way backup of fixed Gentle AI preferences. It exists
because the Gentle AI config home is deliberately protected from model tools:
the model cannot read or write it through `bash`, `write`, or `edit`. Only a
person running this command in the interactive TUI can create a snapshot.

The command registers no tool, starts nothing at extension load, and refuses
every non-TUI mode. It does not restore, import, apply, or edit anything.

## Activation

The extension lives at `extensions/config-snapshot.ts` and is loaded
automatically from the package's `extensions/` directory by a Pi session that
starts after this file is installed. An already-running session only sees it
after Pi reloads extensions: restart the session or run `/reload`. Editing this
repository does not activate anything by itself.

Nothing about the model-facing config-home guard changes: it stays in
`lib/auto-permission-runtime.ts` and continues to block model tools and shell
commands that mention the protected config home.

## Usage

```text
/gentle:config-snapshot
    Read-only status. Prints only names, presence/absence, byte counts, and
    SHA256 hashes. File contents are never printed.

/gentle:config-snapshot help
    Show the usage text.

/gentle:config-snapshot create /absolute/new/directory
    After a confirmation dialog, copy the fixed preference files into a new
    private directory and write manifest.json.
```

Requirements for `create`:

- The destination must be absolute and must not exist. The parent directory
  must already exist; nothing is created recursively.
- The destination, and no ancestor of it, may be a symbolic link.
- The destination must be outside the Gentle AI config home, this package's
  source root, and the current project checkout.
- The confirmation dialog must be approved. Declining, or running headless,
  writes nothing.

On success the directory is mode `0700`, every file is mode `0600`, copies are
byte-identical, and `manifest.json` records each file's presence, category,
size, SHA256, and source identity. No source contents are stored in the
manifest or printed by the command.

## What is captured (fixed list, global scope)

| Category | File |
| --- | --- |
| persona | `persona.json` |
| models | `models.json` |
| profiles | `profiles.json` |
| dev binary | `dev-binary.json` |
| channel | `channel.json` |
| rail | `rail.json` |
| visual | `visual-customization.json` |
| banner | `banner.json` |
| animations | `animations.json` |
| card content | `card-content.json` |
| card style | `card-style.json` |
| vim mode | `vim.json` |
| visual profiles | `visual-profiles.json` |
| history capture | `history-capture.json` |
| builtin codemode opt-out | `builtin-codemode-optout.json` |
| voice | `voice-settings.json` |
| notifications | `notifications.json` |
| background subagents | `background-subagents.json` |
| double Esc | `double-esc-cancel.json` |
| permissions (read-only) | `permission-mode.json` |
| runtime guardrails (read-only) | `runtime-guardrails.json` |

Creation and read-only status apply the same per-file and total-size budget and
report the same accurate refusal for an over-budget file.

There is no source-path argument. A file outside this list is never read.

## Deliberate exclusions

- Credentials, auth stores, `.env` files, tokens, and anything else secret. Any
  JSON key that looks secret-bearing (`apiKey`, `secret`, `token`, `password`,
  `credential`, `authorization`, `privateKey`, and similar) fails the whole
  snapshot. It is not copied, silently redacted, or reported by value.
- Engram memory databases, session transcripts, logs, caches, and arbitrary
  config-home files.
- Project-scoped overrides under `<project>/.pi/gentle-ai`.
- Any restore, import, apply, or in-place edit.

This is not a full backup of the Gentle AI/Pi ecosystem. It preserves the
listed preference files only; it does not promise to rebuild a machine.

## Failure rules (fail closed)

A snapshot is refused when:

- a required file is a symbolic link, a nonregular entry, or has more than one
  hard link;
- a file exceeds 256 KiB, or the fixed set exceeds the 1 MiB total budget
  (the refusal names the file, its size, and the exact remaining budget);
- a file is not valid JSON;
- a secret-bearing key name is found;
- the source file's identity or SHA256 changes between the read and the
  post-copy verification;
- the destination appears, changes identity, or gains a symlinked ancestor
  while the snapshot is being written;
- the destination or an ancestor violates the location rules above.

The command uses exclusive creation (`mkdir` without recursion and
`O_CREAT | O_EXCL`) rather than rename-based replacement, so it makes no false
atomicity or no-replace claim. Cleanup is fail closed: it first checks that the
output directory is still the exact directory this run created (by `dev`/`ino`),
and then, for every file it is about to remove, re-checks the recorded
`dev`/`ino` and the SHA256 of the expected bytes. A replaced directory is left
untouched together with everything inside it; a replaced file is left in place,
and the directory is kept because it is no longer empty. Files this run still
owns are removed, and the new directory is removed only if it became empty.
Pre-existing data is never overwritten. Failure output states only the observed
outcome: refusals before creation say nothing was written; after the directory
exists, the message says whether this run removed its partial output, retained
incomplete output, or found a directory it no longer owned and left untouched.
A same-user process can still win the
final race between the last identity/hash check and `unlink`/`rmdir`, or reuse
an inode together with byte-identical content; that residue cannot be removed
without `unlinkat`-style directory handles, which this command does not claim.

## Platform notes

`O_NOFOLLOW` is used where the platform provides it. Where it does not
(notably Windows), symbolic links are refused by `lstat` plus an open-time
`dev`/`ino` identity comparison, which narrows but cannot eliminate the race.
Private `0700`/`0600` modes apply to POSIX filesystems; Windows uses its own
access model. Secret detection is key-name based, so a secret stored under an
innocuous key name cannot be detected; that limitation is recorded in every
manifest.
