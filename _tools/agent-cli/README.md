# @intentic/agent-cli

The promise an agent-facing CLI makes — capsule first, content to a budget, errors you cannot mistake for silence — held in one place for the three tools that make it.

`iq` (code), `fileq` (workspace files) and `webq` (the web) are three answers to one question: *the thing I need
is in a format I cannot read, give me the part that fits.* They were written months apart, each one's entry file
copied from the last, and the copies had already drifted in the way copies do — three spellings of "read my own
version", two hand-rolled parsers beside the one their shared dependency ships, one inline token estimate beside
the shared one it was supposed to use.

What lives here is only the part all three must answer the same way:

- **The process contract** ([src/run.ts](src/run.ts)). EPIPE is a clean stop, not a crash — an agent pipes into
  `head`. Errors go to **stdout**, because `<tool> … 2>/dev/null` is a reflex and a failure routed to stderr
  reads as an empty answer. The app loads through a thunk so a broken module graph dies as a sentence naming the
  install, not as a stack the same reflex swallows. Exit codes are 0 content / 1 none / 2 anything else.
- **The output shape** ([src/output.ts](src/output.ts)). One capsule line, one `note:` per caveat, then content
  cut on a line boundary with a trailer naming the budget it hit and the file holding the rest. A body that
  stops mid-thought with no trailer is the failure mode this exists to prevent.
- **The rest of the floor**: one XDG home per tool ([src/env.ts](src/env.ts)), one version resolver that finds
  the manifest by walking to it ([src/version.ts](src/version.ts)), one non-negative parser for counts and
  budgets ([src/flags.ts](src/flags.ts)), one in-process test seam ([src/testing.ts](src/testing.ts)).

What does **not** live here is everything that makes the three tools different: iq's grep-dialect absorption and
fusion budgets, fileq's sidecars and derivers, webq's cache, pruning and crawls. The shell takes a `name` and a
`noun` and nothing else about what the tool does.

## Key files

- [src/run.ts](src/run.ts) — the process contract; the one file a `cli.ts` is allowed to import statically, and
  `run.test.ts` fails if it ever grows a runtime import of its own.
- [src/output.ts](src/output.ts) — the capsule line and the budget cut, including the trailer that keeps a
  clipped answer from reading as a whole one.
- [src/env.ts](src/env.ts) — `<NAME>_HOME` → `XDG_CACHE_HOME` → `~/.cache/<name>`, and the shared `out` leaf.
- [src/flags.ts](src/flags.ts) — the count parser, and why stricli's own is not it.
- [src/testing.ts](src/testing.ts) — runs an app through the same `run` seam `cli.ts` uses, capturing stdout: no
  build artifact, no child process.
