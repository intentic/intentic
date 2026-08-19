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
| `NO_COLOR` | Colour off, layout unchanged. |
| `FORCE_COLOR` | Colour on even when `NO_COLOR` is set. |

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
