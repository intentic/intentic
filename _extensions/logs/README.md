# @intentic/ext-logs

The archive of what this box recorded: terminal captures, intentic runs, and the daemon's own log.

## Responsibilities

- List what has been recorded, and open any of it read-only.
- Nothing else. This is forensics, not a live tail.

## Key files

- [src/useLogs.ts](src/useLogs.ts) — listing and reading the recorded files.
- [src/LogsView.vue](src/LogsView.vue) — the view, as a Sandbox hub tab.
- [src/extension.ts](src/extension.ts) — activation, and the argument for the hub over the rail.

## How it fits

A **Sandbox hub tab** (`/sandbox/logs`), not a rail tile. These files are read-only forensics ABOUT THE BOX, read
on the rare occasion something broke — the same class of object as the hub's Status, Usage and Environment tabs.
The rail is for surfaces you act from, and a permanently present tile that never carries a badge spends a fixed
icon slot to say nothing.

The live log surface that failure paths link to is the terminal panel. This is the archive behind it.

## Conventions & gotchas

- The daemon records these unconditionally, so the view detects unconditionally too — one activation, no repo or
  capability evidence needed.
