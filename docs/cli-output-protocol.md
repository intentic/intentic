# The CLI output protocol

What every intentic command-line tool writes, and what may be read from it. This is a **contract**: three
programs in two languages emit it and two parsers depend on it, so the shapes below are not house style, they
are load-bearing.

Implementations:

| Emits | Where |
| --- | --- |
| `ic` (Rust) | `_sandbox/ic/src/ui.rs` |
| `intentic-sync`, `intentic-host` (TypeScript) | `_computers/local-agent/src/ui.ts` |
| the served bootstrap shims (sh, PowerShell) | `_site/site/public/scripts/connect.{sh,ps1}` |

Parsers:

| Reads | Where |
| --- | --- |
| the desktop app's progress bar | `_editor/desktop-app/src/desktop.ts`, `src/setupPlan.ts` |
| the platform's setup wizard | via `SetupReportSchema.stage`, posted by `ic`'s reporter |

---

## 1. The line

```
intentic: [<phase>] <message>
```

`<phase>` matches `[a-z-]+`. Everything else a tool prints — narration, a downloader's output, a diagnosis —
carries no phase and is **detail under whichever phase is currently running**, never a step of its own.

The id exists so a reader never has to recognise the sentence. Prose is reworded whenever it reads better, and
a progress bar that moves when somebody fixes a typo is worse than no progress bar.

### Rules

1. **A phase is announced once, when it starts.** There is no "phase ended" line; the next phase ending it is
   what ends it, and the process exiting ends the last one.
2. **The cursor only moves forward.** A phase already passed is narration, not a step. Parsers must not rewind.
3. **An unknown phase is narration.** A parser that does not carry a phase in its own plan shows the line as
   detail under the running step rather than guessing. This is what lets a tool add a phase without breaking
   anything that reads it.
4. **Ordering is the emitting tool's.** Nothing may assume a fixed sequence: `ic` reorders its first two steps
   on Windows, and skips whole phases that do not apply to a machine.

---

## 2. The three rendering modes

One question decides the mode: **is stdout a terminal**. That single test is why a redrawing renderer is safe
to have at all — a parser can never reach one.

| Mode | When | What it writes |
| --- | --- | --- |
| `plain` | stdout is not a terminal | Section 1's lines, and nothing else. No colour, no escapes, no repaints. |
| `rich` | stdout is a terminal | A banner, a numbered checklist with durations, one repainting status line, a ranked ending. |
| `nested` | forced by a parent tool | Indented detail only. No banner, no checklist, no ending block. |

### `plain` is a frozen shape

The desktop app spawns installs with redirected stdio and CI redirects them into logs. **Changing what `plain`
writes is a breaking change** and must be verified against the parsers above, not assumed. `ic`'s piped output
was proved byte-identical across the redesign by building the previous binary in a throwaway worktree and
diffing three real flows — that is the bar.

### `nested` is what makes an install read as one program

`ic sandbox connect` runs the sync and computer installers in the middle of its own checklist. Left alone each
would see a terminal, decide it owned the screen, and open a second banner with a second plan inside somebody
else's setup. So the parent sets `INTENTIC_UI=nested` and the child renders as detail under the parent's
running step.

A parent in `plain` sets nothing: the child inherits the pipe and reaches the same conclusion by itself.

### Overrides

| Variable | Effect |
| --- | --- |
| `INTENTIC_UI` | `plain` \| `rich` \| `nested` — forces the mode. Anything else is ignored. `nested` is a **child's** mode: `ic` sets it on the agents it spawns and never reads it for itself. |
| `INTENTIC_PLAIN=1` | Forces `plain`. The older spelling; both renderers honour it. |
| `INTENTIC_NO_PROMPT=1` | **There is nobody to ask.** Every prompt reads as "no answer", which each caller already treats as a refusal. See below. |
| `NO_COLOR` | Colour off, layout unchanged. |
| `FORCE_COLOR` | Colour on even when `NO_COLOR` is set. |

### `INTENTIC_NO_PROMPT` — the caller saying it outright

A flow asks a question when it believes a person is there, and it works that out by probing for a controlling
terminal: `/dev/tty` on Unix, `CONOUT$` on Windows. Those probes are good and they stay. This is the belt to
their braces, for the one caller that already knows the answer for certain.

The desktop app spawns these flows from a GUI process with no window, no console and closed stdin. If a probe
is ever wrong there, the cost is not a bad guess — it is an install that never ends, in front of somebody
watching a spinner. So the app says so outright rather than being inferred about.

Exactly `1`. An unset variable, an empty one and a `0` all leave the probes in charge, because the one thing
this must never do is silence a question a real person is sitting in front of.

---

## 2b. Machine-readable side channels

`plain` carries two markers that are **not** phases and must never be parsed as one. Both are emitted only
when stdout is a pipe: in a terminal the same information is already prose, and JSON in the middle of a
checklist is unreadable.

```
intentic-requirement: {"id":…,"title":…,"problem":…,"remedy":…,"action":…,"detail":…}
intentic-requirement-state: {"id":…,"state":"running"|"done"|"failed","detail":…}
```

- **`intentic-requirement:`** — one per thing standing between this machine and a running sandbox. `action`
  is a closed set (`fix`, `fixElevated`, `restart`, `firmware`, `hostVm`, `user`, `signOut`, `unsupported`)
  and decides what the reader can offer: a button, a restart, or a walkthrough.
- **`intentic-requirement-state:`** — how one of them is going, while it is going. Without it a reader can
  draw a single spinner for the ten minutes it takes to switch WSL2 on, download 600 MB, run an installer and
  wait for an engine. `detail` carries the changing measurement.

The prefixes are deliberately one hyphen apart from each other and unrelated to `intentic: [phase]`. A parser
that took a requirement for a phase would slide its cursor to a step that does not exist.

## 2c. Exit codes

`ic docker prepare` has two outcomes that are **not failures**, and a caller must be able to tell them from
one without reading prose:

| Code | Meaning |
| --- | --- |
| `0` | Ready. |
| `1` | Something went wrong. |
| `3` | Requirements were reported and **nothing was changed** — come back with `-y` (or `INSTALL_DOCKER=1`). |
| `4` | Windows has to restart first. Everything that could be done has been. |

Every Windows install that needs anything at all ends its first pass on `3`, by design: the flow reports what
it would change and stops, because there may be no terminal to ask the one question on. A reader that treats
that as a crash is calling the design broken — and a reader with nothing else to say then shows the user
`connect.ps1 exited with status 3` and no diagnosis at all.

The shims pass the code through unread (`exit $LASTEXITCODE`), so it reaches whatever started them.

---

## 3. Handing over the terminal

In `rich` the last line on screen is repainted with a carriage return. Anything that writes to the same stdout
**without going through the renderer** — a spawned child, a downloader's own output, an interactive question —
must be bracketed:

```
ui.suspend();   // erase the live line, stop repainting
…child writes freely…
ui.resume();
```

Skipping this does not corrupt data; it corrupts the screen, which is worse than it sounds during an install
somebody is deciding whether to trust.

---

## 4. Row and ending vocabulary

Settled verdicts about one thing — a preflight check, a reachability link, a Windows requirement — share one
vocabulary across every tool, because a user meeting two checklists in one install should not have to learn
two.

```
  ok    <name>
  warn  <name> — <note>
  FAIL  <name>
  skip  <name> — <note>
```

The separator appears only when there is a note. A failing row carries no detail on purpose: the composed
summary that ends the run names every failure **with its fix**, and saying it twice buries the copy that is
actionable.

A finished run ends with exactly one address and one instruction, then footnotes. The old ending gave seven
lines equal weight, which put *go back to your browser* third.

---

## 5. Adding a phase

1. Add it to the emitting tool.
2. If a progress bar should advance on it, add it to `setupPlan.ts` with a weight in seconds. If not, do
   nothing — rule 3 covers it.
3. Do not rename an existing phase. The id is the stable part; the sentence beside it is not.

Weights are guesses and are only ever compared, never shown. They exist so an estimate is about **time** left
rather than **steps** left: "8 of 9" on the near side of a four-minute download is a lie a step counter tells
and a weighted estimate does not.
