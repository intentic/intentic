# The install one-liner's output — a UX review and redesign

What a person actually sees when they paste the setup command, why it reads as raw, and the shape that fixes
it. Covers `_site/site/public/scripts/connect.{sh,ps1}` (the bootstrap shim) and `_sandbox/ic` (everything
after Docker), which together are the only intentic surface a user meets **before** they have a product.

The headline finding is in section 4: the good design already exists. It lives in the desktop app
(`_editor/desktop-app/src/setupPlan.ts`) and the terminal has never been wired to it.

---

## 1. What it looks like today

A successful first install on Linux with Docker already present. Roughly 70 lines, of which about 55 are
docker's.

```
intentic: [checking-docker] checking Docker…
intentic: [fetching-ic] fetching the ic CLI…
intentic: [preflight] preflight — checking this machine…
  ok    Docker
  ok    Disk space
  ok    Platform reachable
intentic: [claiming-code] redeeming the setup code…
intentic: [pulling-image] pulling sandbox image ghcr.io/intentic/sandbox:stable (first run can take a minute)…
stable: Pulling from intentic/sandbox
6e3729cf69e0: Pulling fs layer
a1f1879bd7bf: Pulling fs layer
c4e6c4d4ab21: Waiting
6e3729cf69e0: Downloading
a1f1879bd7bf: Downloading
6e3729cf69e0: Verifying Checksum
6e3729cf69e0: Download complete
6e3729cf69e0: Extracting
        … 40-odd more of these …
Digest: sha256:6a1f0e4b…
Status: Downloaded newer image for ghcr.io/intentic/sandbox:stable
intentic: [starting-sandbox] starting sandbox…
intentic: [waiting-health] waiting for the sandbox daemon to come up…
intentic: [verifying] verifying the sandbox is reachable end to end…
  ok    Sandbox container
  ok    Daemon health
  ok    Platform registration
  ok    Tunnel agent
  ok    Public DNS
  ok    Public URL
intentic sandbox started.
Your sandbox will be reachable at https://sandbox-3c469e9d6c58.intentic.dev (DNS may take a few seconds to propagate).
Return to the platform — your sandbox announces itself and setup continues automatically.
intentic: [connecting-machine] connecting this computer so you can manage its sandboxes from your browser…
Reachable only — no deploy target. To deploy an app onto this machine later, re-run with SELF_HOST=1 (needs sudo).
Logs: docker logs -f intentic-sandbox-3c469e9d6c58 (connect logs: /root/.intentic/logs)
Stop (keeps your /work): docker stop intentic-sandbox-3c469e9d6c58
Reset this sandbox (also removes its /work volume): ic sandbox remove 3c469e9d6c58 -y
```

Between `waiting-health` and the next line there is up to 30 seconds of nothing. Between `verifying` and its
first row, up to 120. During the pull there is a wall of hex.

The **prose is good**. Nearly every sentence here was written with care, names a real thing, and offers a
remedy — `checks.rs`'s `remedy` field is a genuinely unusual piece of discipline. Nothing below is a
complaint about the words. It is entirely about **rendering**: everything is the same size, the same colour,
and arrives in the same undifferentiated stream.

---

## 2. Twelve problems, ranked by what they cost

**1 · There is no plan, so there is no position.** Nothing ever says how many steps there are or which one
this is. The user cannot answer "am I halfway?" at any moment of a four-to-twelve minute install. This is
the single largest defect and everything else is downstream of it.

**2 · The longest step is the least legible.** The image pull is ~240s of the install's ~380s budget
(`setupPlan.ts` weights) and it is where the screen fills with layer hashes. `setupPlan.ts`'s own comment
says people abandon here. The terminal shows *more* output during the pull than anywhere else while
conveying *less*.

**3 · Waits are silent.** `health::wait_answering` polls for up to 30s printing nothing;
`doctor::verify_chain` for up to 120s. Silence after `waiting for the sandbox daemon to come up…` is
indistinguishable from a hang, and two minutes is well past where people ctrl-C.

**4 · Machine syntax is leaked into human prose.** `intentic: [waiting-health] waiting for the sandbox
daemon to come up…` says the same thing twice — once as an id for the desktop app's parser, once as a
sentence. To a person the bracket reads as a log level or an error code. `util.rs`'s comment is right that
the id must exist; it is wrong that a human has to see it.

**5 · No colour, no symbols, no weight.** Not one escape sequence in the whole binary (`grep` for `\x1b`
returns nothing). `FAIL` is distinguished from `ok` by capital letters alone. In a 70-line scroll a failure
is genuinely easy to miss. Every peer installer — rustup, bun, pnpm, homebrew, docker desktop — colours.

**6 · Five prefixes, no rule.** `intentic: [phase] msg`, `intentic: msg`, `  ok    Name`, bare prose
(`Your sandbox will be reachable…`), `intentic-requirement: {json}` (Windows), plus raw docker and, at the
end, a third-party installer script piped from `intentic.dev/computer` with its own conventions
(`connect.rs:601`). A reader cannot learn one rule and apply it.

**7 · The ending is seven equal lines.** Success, URL, next action, a caveat about deploy targets, and three
reference commands, all identical in weight. The one instruction that matters right now — *go back to your
browser* — is third, and the URL that matters second. Commands the user needs in a week are given the same
billing as the action they need in five seconds.

**8 · Detail and headline are the same size.** `  ok    Docker` is a detail row under the preflight step;
`intentic sandbox started.` is the verdict of the entire run. They render identically.

**9 · No timing, ever.** Nothing says a step took 4 minutes or 0.4 seconds. Afterwards the user cannot tell
what was slow, and neither can support reading a pasted transcript.

**10 · Prompts do not look like prompts.** The multi-sandbox chooser (`connect.rs:158-186`) prints
`[c] continue` / `[r] remove some first…` / `[q] quit` at the same weight as narration; the Docker consent
question goes to stderr as `[Y/n]`. Nothing signals *this has stopped and is waiting for you*.

**11 · Failures have structure but no frame.** `checks::failure_summary` composes a numbered
problem/fix block — genuinely good information architecture — and then it prints as undifferentiated text
after `error: ` (`main.rs:192`). The structure is invisible.

**12 · No version, no run id.** Nothing identifies which `ic` produced the transcript. The binary is
re-downloaded on every run (`connect.sh:21`), so "which version were you on" is unanswerable from the output.

---

## 3. Constraints any redesign has to survive

Listing these first, because they kill most of the obvious ideas.

| Constraint | Where it comes from | Consequence |
| --- | --- | --- |
| `intentic: [phase] msg` is a **wire contract** | `setupPlan.ts` parses it to drive the desktop app's progress bar | Cannot simply be prettified away |
| Same for the shim | `connect.sh:39` `step()` mirrors `util::step` deliberately | Both halves must move together |
| Runs under `curl … \| sh` | the one-liner | stdin is the script; no assumptions about it |
| Runs under `sudo` | Docker install needs root | `$HOME` may be root's; per-user state must not be |
| Runs on Windows PowerShell 5.1 | `connect.ps1` | VT sequences need explicit enabling; box-drawing may not render |
| Binary size is user-visible | downloaded every run; `Cargo.toml` sets `lto`/`strip` for this reason | No heavyweight TUI crate |
| Not always a terminal | desktop app spawns it; CI runs it | Rich rendering must be conditional |

The last one is the key that unlocks the rest, and this codebase already uses it: `prepare/mod.rs:46` gates
its JSON announcements on `std::io::stdout().is_terminal()`. **Split the two audiences by that same test.**
Piped output stays byte-for-byte what it is today. A terminal gets the redesign. Nothing in the desktop app
or CI changes at all.

---

## 4. The design already exists — in the wrong place

`_editor/desktop-app/src/setupPlan.ts` is a fully worked progress model:

- **A plan**, drawn in full at t=0 — every step, in order, with the ones that will not happen on this machine
  left out (`setupPlan`).
- **Weights in seconds**, so the bar is honest about time left rather than steps left. Its comment is
  explicit that "9 of 10 steps" on the far side of a four-minute pull is a lie a step counter tells.
- **Real pull progress**: a regex over docker's line-per-layer output, with a per-state completion fraction
  (`LAYER`, `LAYER_DONE`) — so the 240-second step reports genuine fractions rather than creeping on a timer.
- **A monotonic clamp**, so the bar can never go backwards as docker announces new layers.
- **Windows step reordering**, because Docker's prerequisites are a tree there and the binary must arrive
  before it can examine them.

Every one of those decisions is right, and a terminal user gets none of them. The layer lines that the
desktop app turns into a percentage are the same lines the terminal dumps raw.

So the redesign is mostly **not new thinking**. It is moving this model down into `ic` — where the run
actually happens — and letting the desktop app read the result instead of re-deriving it. That also removes
a real hazard: today the plan lives in TypeScript and the phases live in Rust, and nothing checks that they
still agree.

---

## 5. Seven principles

1. **Draw the whole plan before starting.** Scope and position are the two things the user is missing; both
   are free once the plan is a value rather than a sequence of prints.
2. **One live region, not a scrolling log.** Done steps collapse to a line with a tick and a duration. The
   running step gets a spinner and an elapsed counter. Steps not yet reached are dim.
3. **Detail is derived, not dumped.** Docker's layer chatter goes to the log file always, to the screen only
   under `--verbose` or when stdout is not a terminal. On screen it becomes `18/27 layers · 640 MB`.
4. **Colour carries meaning, never decoration.** Green passed, red failed, yellow degraded, dim detail and
   not-yet, bold the one thing to read. Honour `NO_COLOR` and `FORCE_COLOR`; fall back to ASCII markers.
5. **Nothing is silent for more than two seconds.** Every wait gets a spinner and elapsed time, and past a
   threshold a reassurance ("this usually takes about a minute").
6. **The ending has exactly one instruction.** The URL and the next action are set apart. Reference commands
   fold under a dim heading, or collapse to one pointer at `ic sandbox --help`.
7. **Failure is framed.** The existing numbered problem/fix structure, given a red rule, a count, and the
   single re-run command at the bottom.

---

## 6. What it looks like now — built

Everything below is captured from real runs, not drawn. Colour is stripped for this page; the live line is
shown at one instant rather than as the forty repaints a terminal actually sees.

### Setting up (terminal)

The shim's bullets, then the checklist. One line repaints; everything above it is settled.

```
  ·  checking Docker…
  ·  fetching the ic CLI…

  intentic · setting up your sandbox

  6 steps, roughly 6 minutes. One long download in the middle is most of it.

        ✓ Docker
        ✓ Disk space
  ✓   1  Check this computer                                                               0.1s
  ✓   2  Redeem your setup code                                                            0.8s
        Digest: sha256:ba2007b6f760367abfac59981cb8a9a2ca46b6c88aa3ad8bc82b55c684e6be81
        Status: Downloaded newer image for ghcr.io/intentic/sandbox:stable
  ⠙   3  Download the sandbox image  ·  6 layers · 87%                     43s · ~2m left
```

The pull's forty-odd layer lines are gone from the screen and still whole in the log. What replaced them is
derived from those same lines, so it is real progress rather than a timer.

### Finished

```
  ✓  Your sandbox is running.                                                            took 2m

     https://sandbox-525352699a74.intentic.dev

     Go back to your browser — your sandbox announces itself and setup continues there.

     later  its logs      docker logs -f intentic-sandbox-525352699a74
            stop it       docker stop intentic-sandbox-525352699a74
            reset it      ic sandbox remove 525352699a74 -y
            setup log     /root/.intentic/logs
            deploy here   re-run with SELF_HOST=1 (needs sudo)
```

Two things to read, then a footnote. The old ending gave all seven lines the same weight, which put *go back
to your browser* third.

### Stopped

```
  ✗  found 2 problems — fix them and re-run the same command:

    1. Platform reachable
       problem: could not reach the platform at http://127.0.0.1:9 — io: Connection
                refused
       fix:     check this machine's internet connection (DNS, proxy, firewall), then
                re-run.

    2. Cloudflare token
       problem: the Cloudflare API token was rejected.
       fix:     could not reach the Cloudflare API to validate the token: http status: 400
```

The same words `checks::failure_summary` has always composed. Only the frame, the colour and the hanging
indent under `fix:` are new — long remedies used to run off the right edge.

### Piped — byte-for-byte unchanged

```
intentic: [preflight] preflight — checking this machine…
  ok    Docker
  ok    Disk space
  FAIL  Platform reachable
error: found 2 problems — fix them and re-run the same command:
…
```

This is the property that makes the rest safe, and it is verified rather than asserted — see section 9.

---

## 7. How it is built

**`_sandbox/ic/src/ui.rs`** owns every byte the binary shows a person. `util::step`, `checks::print_row` and
the Windows checklist all route through it, so the two row vocabularies that used to exist in parallel now
converge by construction.

**The split is `std::io::stdout().is_terminal()`**, the same test `prepare/mod.rs` already used to gate its
JSON announcements. The desktop app spawns this binary with `Stdio::piped()` (`scripts.rs`) and CI redirects
it, so neither can ever reach the rich path. `INTENTIC_PLAIN=1` forces plain; `NO_COLOR` and `FORCE_COLOR` are
honoured.

**The live region is exactly one line.** Redrawing a checklist in place needs the cursor moved up N lines,
which needs to know when a line wrapped — and this binary runs under `curl | sudo sh`, inside dash, on
PowerShell 5.1, in terminals of unknown width. A carriage return plus a truncation to a conservative width
needs none of that. Everything settled scrolls above. The one rule callers follow: anything writing to stdout
outside the module (docker's own output, a piped installer, an interactive question) is bracketed by
`ui::suspend()` / `ui::resume()`.

**No new crates.** ANSI is a dozen consts, `IsTerminal` is std, the spinner is one daemon thread on a 110 ms
tick, and Windows VT is three `extern "system"` declarations against the kernel32 every Windows binary already
links. The binary is downloaded on every run, so its size is in the user's critical path.

**The pull's layer lines** are parsed into a fraction rather than counted. Docker under-reports `Pull
complete` when it is not talking to a terminal — a measured six-layer pull reported three — so a completion
tally freezes partway and reads as a stuck install. The average always advances, is clamped monotonic against
a growing denominator, and stops at 99 because only the flow knows a step finished.

**The shim** (`connect.sh`, `connect.ps1`) splits the same way and keeps narrating in both. It could not go
quiet in a terminal: its one long step is a Docker install that can run ten minutes.

---

## 8. What shipped, and what did not

| # | Change | Fixes | State |
| --- | --- | --- | --- |
| 1 | `ui.rs`, TTY split, colour, glyphs, wrapping | 5, 8, 11 | **done** |
| 2 | Plan up front; a numbered checklist with per-step durations | 1, 4, 9, 12 | **done** |
| 3 | Spinner + elapsed + estimate on every wait; the doctor names the link it is waiting on | 3, 10 | **done** |
| 4 | Docker's layer lines become one derived progress readout | 2 | **done** |
| 5 | The ending ranked: address, instruction, footnotes | 7 | **done** |
| 6 | Questions bracketed so nothing repaints over them | 10 | **done** |
| 7 | Shim and binary share one voice in a terminal | 6 | **done** |
| 8 | Emit the plan on the wire; the desktop app reads it instead of its own copy | drift hazard | **not done** |
| 9 | The two piped agent installers speak the same vocabulary | 6 | **not done** |
| 10 | Stamp a real version into `ic` | 12 | **not done** |

**8** is the one worth doing next. `setupPlan.ts` and `connect.rs` now hold the same plan in two languages and
nothing checks that they agree; a step added to one is a desktop progress bar that silently stops moving.
Neither is wrong today, and both were verified by hand against each other while this was written.

**9** leaves `intentic.dev/sync` and `intentic.dev/computer` printing in their own voice at the end of a
setup. They are bracketed by `suspend`/`resume`, so they no longer collide with the live line — they simply
look like different programs, because they are.

**10** stays open because `ic`'s Cargo version is never stamped by the release pipeline (`set-versions.sh`
does not touch it), so the header would read `ic 0.0.0`. The header prints the version only when it is not
`0.0.0`, so stamping it is the entire remaining change.

---

## 9. How it was verified

- **Piped output is byte-identical.** The pre-change binary was built from `f84e1496b` in a throwaway git
  worktree and run head-to-head with the new one across three flows — a two-failure preflight, `sandbox list`,
  and a real image pull ending at the run contract. 31 lines, diff clean apart from the log timestamp.
- **The rich path was run, not reasoned about.** Under a pty (`script`), against real registry pulls, and once
  end to end against `ghcr.io/intentic/sandbox:stable` — a real pull, container start, health wait, postflight
  chain and the finished block. That is where the pull readout's stall was found and fixed.
- **The shim's split** was exercised under `dash` both piped and on a pty.
- 130 unit tests, `clippy -D warnings` clean, `cargo fmt --check` clean. New tests cover layer parsing, the
  monotonic pull readout, the clamped estimate, wrapping, and the pull-noise rule — the last asserting that an
  `unauthorized` is never swallowed, since that line is the whole diagnosis of a failed pull.
- `connect.ps1` re-checked against the two Windows-PowerShell-5.1 rules the desktop crate's tests enforce:
  ASCII-only bytes, and no redirection while `Stop` is in force.

**Not verified by running:** the Windows path. There is no Windows cross-target in this workspace, so
`prepare/mod.rs` and `prepare/fix.rs` changes are read-checked only. They are mechanical — three print sites
routed through `ui::progress`, one checklist through `ui::row`, two questions bracketed — but they are the one
part of this that has not executed.

---

## 10. What not to do

- **Do not add a TUI framework.** The binary is downloaded on every run and its size is in the user's critical
  path; `Cargo.toml` already trades build time for bytes deliberately.
- **Do not hide docker's output.** It goes to the log unconditionally. Only the terminal is decluttered, and
  only for lines the readout already accounts for.
- **Do not let the terminal renderer become the only renderer.** The piped form is a contract with the desktop
  app and with every CI run. It must stay boring.
- **Do not widen the pull filter.** It refuses layer reports, a bare token, and `X: Pulling from Y`. Every
  other line docker emits is a sentence, and one of those sentences is why a failed pull failed.
