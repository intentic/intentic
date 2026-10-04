# intentic plugin for Claude Code

Trims Bash output before Claude reads it, opens each session with a map of the project and its field notes, teaches the `fileq` and `iq` CLIs, and reports what each of these saved. Every mechanism is a switch in `/config`.

```
/plugin marketplace add intentic/intentic
/plugin install intentic@intentic
```

The hooks and the bundled commands run on Node.js 20.11 or later, which has to be on `PATH`. Without it the plugin does nothing, and each session opens with one line saying so. Claude Code fetches the plugin from npm (`@intentic/claude-plugin`), so `npm` has to be installed too.

## What it does

| When | What happens | Switch |
| --- | --- | --- |
| A session opens | Claude gets a map of the project: its areas, what each is for, and where the session started. It is recomputed from the tree for every session. | `project_map` |
| A session opens | Claude gets this project's field notes, cut by rank to 4,000 characters, if `/intentic:field-notes` has written them. | `field_notes` |
| A session opens | Claude is taught `iq`, a code search that answers a question with ranked `path:line` anchors, if `iq` is installed. | `iq` |
| A prompt is sent | `iq` points a prompt that matches earlier work at the session that did it. | `iq` |
| A Bash command succeeds | The output is cleaned before Claude reads it: progress bars, install chatter, repeated lines, the middle of huge logs. A footer names the command that reads the full text back. | `output_cleaners`, `cleaners` |
| Claude reads a document | `fileq` turns docx, pdf, xlsx, pptx, epub, ipynb, images, audio and archives into markdown. | `fileq` |
| Claude makes a document | `fileq check` lists what is wrong with a docx, pptx, xlsx or pdf by slide, page or cell, and `fileq render` draws its pages as PNGs for Claude to look at (with LibreOffice and poppler installed). The fileq skill says to run both before handing the file over. | `fileq` |

| A Bash command succeeds, in Claude Code 2.1.287 or later | A line under the prompt says what the cleaners saved so far this session, and `/intentic-pane` shows the full report in a pane. See [In the interface](#in-the-interface). | `output_cleaners` |

A failed command reaches Claude unchanged. Outside an Intentic sandbox there is no secret store to mask values from, so the cleaners mask only text that looks like a credential: an assignment to a name like `API_KEY` or `TOKEN` whose value looks generated, bearer tokens, AWS access keys, and passwords in URLs.

The `intentic:Intentic` output style adds three working habits to Claude Code's own instructions: batch independent lookups, reuse what is already in context, and run long commands in the background instead of sleeping. Pick it in `/output-style`. It is off until you do.

## Switches

Open `/config` and find the rows under intentic. The switches read at session start (`project_map`, `field_notes`, `iq`, `fileq`, `holdout`) apply from the next session.

| Key | Default | Effect |
| --- | --- | --- |
| `output_cleaners` | on | Clean successful Bash output, ledger what each cleaner saved, and show the saving under the prompt. Off, none of the three happens |
| `cleaners` | empty (all) | Which cleaners run: `-cap,-wide` switches some off, `git,pnpm` allows only those |
| `output_holdout` | 0 | Share of commands left uncleaned, to measure the saving against real output |
| `project_map` | on | Send the project map at session start |
| `field_notes` | on | Send this project's field notes at session start |
| `iq` | on | Teach `iq` and run its session recall, when `iq` is installed |
| `fileq` | on | Let the bundled `fileq` run. Off, it refuses, and its skill stays listed because a plugin cannot hide its own skills |
| `holdout` | 0.1 | Share of sessions opened without the map, the notes and the iq teaching, so the report can compare |

## What it saved

Run `/intentic:stats` for this project, or `/intentic:stats all` for every project the plugin has seen.

```
## Bash output
412 commands trimmed: 1.9M tokens of output became 310k (84% saved, exact per command).
Biggest cleaners: cap 1.1M (96 commands), pnpm 210k (40 commands), dedup 88k (131 commands).

## Session context
Project map, root listings in the opening turn: -71.4% ±18.2pp (95%): 0.4 with it vs 1.4 without, over 118 and 31 opening turns.
Field notes, failed tool calls per turn: no difference yet beyond ±24.1pp (95%): 0.6 with it vs 0.7 without, over 104 and 33 conversations.
iq teaching, search calls per turn: measuring, 12 of 30 conversations in the smaller arm: 2.1 with it vs 2.9 without, over 96 and 12 conversations.
```

The numbers above are an illustration of the format. The report reads two things:

- The cleaners' ledger, one row per command with the bytes before and after and what each cleaner removed. That saving is exact. With `output_holdout` above 0 it also compares the median cleaned output against commands left uncleaned.
- Claude Code's own session transcripts, compared across the two arms each session was drawn into. A hash of the session id puts `holdout` of the sessions in the control arm for each mechanism, so the draw needs no state and gives the same answer every time it is read. The map is judged on directory listings of the project root in the first turn, the field notes on failed tool calls, and the iq teaching on search calls. A change is stated only once both arms hold 30 samples and the 95% margin excludes zero.

The arithmetic is the one behind the savings page of an Intentic sandbox, from the same packages, so a number here means what it means there.

## In the interface

Claude Code 2.1.287 and later can load a small mod from a plugin, code that runs inside Claude Code and draws in its interface. The plugin's mod (`hooks/register.ts`) makes the cleaners' work visible, and does nothing else: it changes no output and sends nothing.

| What | Where it shows | Needs |
| --- | --- | --- |
| A status line under the prompt, such as `intentic: Bash output trimmed 84% · 1.6M tokens saved over 12 commands`. It updates after each Bash command and stays empty until a command has been shortened. | The terminal and the Desktop app | `output_cleaners` on |
| `/intentic-pane`, the `/intentic:stats` report in a pane with a Refresh button. `/intentic-pane all` reports every project. | The terminal and the Desktop app | `node` on `PATH`, as for the rest of the plugin |

Where Claude Code draws nothing, the mod still runs and the status line has no place to go. `/intentic-pane` then answers with the report as text, as it also does in the VS Code extension and in `claude -p`. `/intentic:stats` works the same everywhere, whatever the version, and is the command to use in a script.

The status line counts from the ledger rows the session has already written (when it resumes) and adds each Bash command as it finishes. It is the same ledger `/intentic:stats` reads, so the two agree, except that a command left untrimmed on purpose by `output_holdout` counts as saving nothing in the status line. The mod does a few additions and one status update per Bash command and reads the ledger once, when the session starts. Claude Code gives a mod hook 10 seconds, and 50 ms for the hook on prompt edits, which the mod does not use.

Older Claude Code versions are not harmed by the mod. `modules` in `hooks/hooks.json` is a key those versions either do not know, in which case they read the file as before (checked on 2.1.200), or know and keep it switched off until a rollout reaches the account (seen on 2.1.283), in which case the Bash and session hooks still run and Claude Code may print one line at start saying that a hooks module was not loaded. From 2.1.287 on the module loads by default.

## Field notes

Run `/intentic:field-notes` every few weeks. It counts this project's sessions (failures by how many sessions hit them, the commands that ran and how often they failed, the files edited most) and asks Claude to rewrite `.claude/intentic/field-notes.toon` from that evidence, checking each fact against the project before writing it. Commit the file to share it with a team, or ignore it to keep it yours.

## Where it keeps things

| Path | Holds |
| --- | --- |
| `~/.claude/plugins/data/intentic-intentic/` | `sessions.jsonl` (the arms each session drew), `options.json` (the switches of the last session), `output/` (the cleaners' ledger, the full text of trimmed commands, the repeat cache), `iq/` (the logs of iq's transcript ingest) |
| `.claude/intentic/field-notes.toon` | This project's field notes |
| `.intentic/local/cache/derived/` | `fileq`'s cache: the markdown of each document it has read, reused while the document is unchanged. The directory ignores itself in git |

The plugin makes no network requests. Uninstalling it deletes the data directory unless you pass `--keep-data`.

## Not included

The Intentic sandbox also replaces lines and sections of Claude Code's system prompt. A plugin can add an output style or replace the whole prompt with fixed text, but it cannot edit the prompt line by line, and a fixed copy would go stale with each Claude Code release. The working habits that hold outside a sandbox are in the `intentic:Intentic` output style instead.

## Development

The plugin is built from the packages that own each mechanism, so the sandbox and the plugin run the same code:

- [@intentic/output-cleaners](../output-cleaners): the cleaners, `filterRun`, and `summarizeStats`.
- [@intentic/agent-context](../agent-context): the project map, the reader for field notes and the brief their writer gets, how a session draws its arm, what each turn is scored on, the comparison between the arms, and the transcript reader.
- [@intentic/fileq](../fileq): the CLI, bundled as `dist/fileq.mjs`, the text of its skill, and its NOTICE (rules adapted from SurfSense under Apache-2.0), copied to `generated/fileq-NOTICE`.
- [@intentic/iq](../../_search/iq): the iq skill and the hint a session opens with. The build rewords the hint's two sandbox phrases for a plain install and fails if they change upstream.

The mod is one source file, [hooks/register.ts](hooks/register.ts), shipped as it is: Claude Code loads TypeScript hooks modules itself, in an environment with no Node and no imports beyond the plugin's own files, so there is nothing to bundle. Its helpers are exported and tested with bun (`src/mod.test.ts`); the hooks as Claude Code wires them are tested with its own test runner (`tests/mod.test.ts`).

The build writes `dist/` (one esbuild bundle per hook and command, so an install needs no `node_modules`) and `generated/` (the skills and the output style, from the texts those packages own). Both are ignored by git.

### Key files

- [src/features.ts](src/features.ts): the switches, the one table behind both `userConfig` and what the hooks read.
- [src/session-start.ts](src/session-start.ts): what a session is told, which arm it drew, and the background work it starts.
- [src/post-bash.ts](src/post-bash.ts): the cleaning pass as a `PostToolUse` hook that returns `updatedToolOutput`.
- [src/stats.ts](src/stats.ts): the `/intentic:stats` report.
- [src/notes-evidence.ts](src/notes-evidence.ts): the session digest `/intentic:field-notes` is written from.
- [src/generated.ts](src/generated.ts): the skill and output-style files the build writes.
- [build.mjs](build.mjs): bundles, generated files, and the manifest version.

### Commands

```sh
pnpm --filter @intentic/claude-plugin build      # dist/, generated/, and the version in plugin.json
pnpm --filter @intentic/claude-plugin test
pnpm --filter @intentic/claude-plugin test:mod   # the mod's tests, through `claude plugin test` (needs `claude` 2.1.287 or later on PATH)
pnpm --filter @intentic/claude-plugin validate   # build, then `claude plugin validate --strict`
claude --plugin-dir _sandbox/claude-plugin       # a session with the checkout loaded, after a build
```

`publishConfig.executableFiles` lists every file in `bin/`. pnpm packs the release tarball and clears the executable bit of anything not listed there, and `src/manifest.test.ts` fails when a script is missing from the list.
