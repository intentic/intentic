# Turns that cannot fit: preventing context overflow on small-window models

A conversation on a sandbox-run `Llama-3.2-3B-Instruct-Q4_K_M` opened with two words, "Are you there?", and
died before the model saw them:

```
API Error: 400 request (49181 tokens) exceeds the available context size (16384 tokens), try increasing it
```

Nothing was wrong with the model, the weights, the server, or the message. The turn was assembled by about a
dozen independent contributors, every one of them sized against a 200k window, and the first component in the
whole stack that knew the total was `llama-server`'s request validator. This records why that is structural,
and the ordered set of changes that removes it. §7 is the build order.

## 1. What actually got sent

Measured off `sdkSystemPrompt` and the note builders in `_sandbox/sandbox/src/agent`:

| Contributor | Where | Its own ceiling | Sized against |
| --- | --- | --- | --- |
| Sandbox system prompt (`intentic` base + appends) | `agent/system-prompt.ts` | none; 9,109 chars measured (~2.3k tok) | nothing |
| Project map | `agent/workspace-map.ts` | `MAX_NOTE_CHARS` 2,800 chars | "far under what it replaces" |
| Retrieved workspace context | `agent/turn-context.ts` | `CONTEXT_BUDGET_TOKENS` 1,200 | "well under a percent of a 200k window" |
| Cross-harness iq teaching | `agent/iq-search-instruction.ts` | whole skill body, 7,735 chars (~1.9k tok) | nothing |
| Runtime-switch transcript | `agent/runtime-history.ts` | `HISTORY_CHAR_CAP` 32,000 chars (~8k tok) | orientation should not crowd out the current turn |
| Delegation / persona / setup / worktree / sync notes | `agent/turn-preamble.ts` | none each | nothing |
| Harness system prompt, tool schemas, skill and agent listings, hook output | the CLI, not the daemon | unknown to us | the harness's own defaults |

The controllable half of that list is 3–4k tokens on an opening turn. The failing request was 49,181. So
roughly 45k of it, more than nine tenths, came from the layer the daemon does not compose and does not count:
the harness's own prompt plus one JSON schema per exposed tool, times every connected capability (each bound
browser account, each connected computer, each MCP server), plus the skills and agent-type listings.

That is the first finding, and it reorders everything below: **trimming our own notes cannot fix this.** Even
with every note off, the turn does not fit.

## 2. Why it fails silently, in three parts

**The ceiling is unknown.** `CompatModel` (`endpoints/endpoint-translator.ts`) is `{name, alias}`. The picker's
catalog is whatever `/v1/models` publishes, and no probe reads a window. `contextWindow` exists in the contract,
but it arrives *after* a turn, off the SDK result frame (`agent/sdk-stream.ts`), is stored per conversation on
the registry entry (`agents/agents-registry.ts`), and is used for one thing: drawing a ring in the chat. Nothing
that composes a request has ever seen it. Worse, on a translated endpoint the number the frame reports describes
the proxy's assumed Anthropic model, not the GGUF actually answering, so the ring is confidently wrong and the
harness's own auto-compaction triggers at a threshold three orders of magnitude away from the real one.

**The floor is unknown.** No component in the daemon can state what a turn costs before the harness sends it.
The daemon knows what it wrote; the harness adds its prompt and its tool schemas downstream. The input token
count on the result frame is the only true measurement of the total, and it exists only for turns that already
succeeded.

**Nobody owns the sum.** Every budget in the table above is local, hard-coded, and justified in its own comment
against a 200k window. That was correct when it was written: for most of this repo's life the picker offered
only 200k-class subscriptions. The `localmodel` capability made the assumption false without touching a line of
the code that depends on it, and no test could catch that, because the assumption lives in prose.

## 3. The design principle

A request has exactly one budget, it is set by the model that will read it, and the layer that assembles the
request refuses rather than discovers. Three consequences:

- **Declare, don't infer.** A model carries its window as data, next to its id, resolved before any note is
  built.
- **One authority, allowances not constants.** Contributors ask for their share; they do not each hold a
  number.
- **A small window is a different product, not a smaller one.** A 3B model with 16k cannot drive a
  ninety-tool agent loop even if the request fits. The reduced shape is the deliverable, and the picker should
  say so at selection time.

## 4. Knowing the ceiling

Per source, cheapest first:

- **Sandbox-run local models.** `llama-server` answers `GET /props` with the live `n_ctx` it was started with,
  which is the authoritative number (`--ctx-size 0` reads the GGUF, but the server also clamps to what the KV
  cache can hold, and the clamp is what the 400 reports). The catalog probe already asks each endpoint a
  question (`endpoints/endpoint-catalog.ts`); this is one more field on the same read.
- **User-configured endpoints.** OpenAI-shaped `/v1/models` has no standard window field, and vLLM's
  `max_model_len` is not universal. Read it where it is offered, and put an optional "context window" field on
  the endpoint card, defaulted from the probe. Unknown stays unknown, and unknown behaves as §6 describes.
- **Native providers.** A static table, already effectively present in the harness. One entry per model id,
  checked in.

Where it lives: on the model in the catalog, not on the conversation. The window is a property of the model,
and the conversation only borrows it. The observed value from the result frame stops being the source of truth
and becomes a *check* on the declared one: a mismatch is a log line and a corrected entry, not a UI number.

## 5. Knowing the floor, and one budget for the turn

The harness's fixed cost is measurable, just not by reading our own strings. It is stable per
(runtime, model, exposed-tool set, prompt mode) and changes only when a capability is connected or a CLI is
upgraded. So measure it and cache it against exactly that key:

1. On the first successful turn for a key, the result frame's input count minus the bytes we composed is the
   floor. Store it on the sandbox, keyed as above.
2. With no cached floor, use a conservative constant per runtime (the observed opening cost of a bare turn) and
   correct it after the first turn.
3. Invalidate on capability change, harness version change, or prompt-mode change: those are the three inputs
   that move it, and all three are already events the daemon sees.

Then one module owns the arithmetic, called at the existing `preflight` seam
(`agent/turn-plan.ts` → `adapterFor(provider, harness).preflight`), which is where the provider, harness,
model and note plan are already all in scope:

```
allowance = window − floor(runtime, tools) − reserve(output) − user message
```

and `allowance` is divided among the optional notes in a fixed priority order. Each contributor takes its share
as an argument instead of holding a constant. The map renderer, the retrieval renderer and the history builder
already shed detail to hold a budget; they need a parameter, not a rewrite.

**The ladder, sheddable first:** runtime-switch transcript depth → cross-harness iq teaching → retrieved context
→ project map → delegation and other capability notes → persona and worktree notes (these two are safety, and
they go last). Whatever is shed is disclosed in the chat, using the mechanism `preambleNotes` already provides,
so the reader can see the turn ran thinner and why.

## 6. When it still does not fit

Shedding notes buys 3–4k tokens. Against a 16k window with a 45k floor, the answer is not a thinner preamble:

- **Reduced tool surface.** Tool schemas are the dominant line item, and deferral already exists: the harness
  spawns and handshakes deferred servers but keeps their schemas out of the prompt
  (`browser/browser-tools.ts` documents exactly this). A small-window profile defers everything except a core
  set (read, write, edit, shell, search), and drops the skills and agent-type listings, which only advertise
  capabilities a 3B model will not orchestrate anyway.
- **Preflight refusal, not a provider 400.** If the floor alone exceeds the window, the turn must not be sent.
  The refusal names the three numbers (window, floor, message) and the one switch that changes the outcome:
  pick a model with a larger window, raise the server's context size, or run the reduced profile.
- **Picker-time honesty.** A model whose declared window cannot hold the current profile's floor is offered
  with a warning, or offered only in the reduced profile. This is the highest-value change for the user, because
  it moves the discovery from "my first message failed" to "this model needs the small profile".
- **A coded runtime frame.** Overflow that still escapes lands in the SDK's `unknown` 4xx bucket today and
  renders as a raw red line (`agent/error-frames.ts`). It deserves a `context-overflow` code carrying the same
  actionable sentence as the preflight refusal, plus exactly one automatic retry at the reduced profile, since
  unlike a rate limit this failure is deterministic and re-sending the same request is a loop.
- **Serve a bigger window where the model allows it.** `--ctx-size 0` takes the GGUF's native length and then
  gets clamped by available KV memory. For a 3B model, raising the clamp (and, if needed, quantizing the KV
  cache) is often cheap. The local-model card should show the served window and say when it is the binding
  constraint rather than the model.

## 7. Build order

1. **`/props` probe + declared window on the catalog entry.** Smallest change, unblocks everything else.
2. **Preflight refusal on floor > window, with the three-number sentence.** Turns a provider 400 into an
   answerable statement. Ships before any budgeting work, and alone would have prevented this failure.
3. **Floor calibration cache** keyed on (runtime, model, tools, prompt mode).
4. **Budget authority at the preflight seam**, allowances threaded into the map, retrieval and history builders.
5. **Small-window profile**: tool deferral set, listings off, history depth clamped.
6. **Picker warning + `context-overflow` frame + single reduced-profile retry.**
7. **Invariant test**: the sum of every optional note's maximum, plus the recorded floor for the standard tool
   set, fits the smallest window the picker will offer. This is the check that keeps §2's third failure from
   coming back the next time someone adds a note.

## 8. Options that lose

- **Auto-summarize the preamble to fit.** A summarizer is a model call, on a sandbox whose available model is
  the 3B one that cannot hold the input, and it converts a hard failure into a quiet loss of the exact notes
  (persona, worktree) whose absence is unsafe.
- **Scale every note's budget by a fraction of the window.** Sounds principled, fails on the arithmetic: with
  a 45k floor and a 16k window, every fraction of the remainder is negative. The floor has to enter the
  calculation as a first-class term, which is why §5 measures it rather than assuming it away.
- **Derive the window from the observed result frame only.** It is the number we already have, and it is wrong
  twice: absent on the first turn, and on a translated endpoint it describes the proxy's assumed model rather
  than the GGUF answering.
- **Hide small models from the picker.** Honest, and it throws away the case the local-model card exists for.
  A 3B model is a fine one-shot helper rung (titles, commit messages) — jobs whose prompts are small by
  construction. Gate the profile, not the model.
- **Raise `--ctx-size` and call it fixed.** Buys this one model and re-arms the same failure for the next one,
  because the cause is that nothing counts, not that 16k is small.

## 9. What was built

Steps 1 and 2 of §7 shipped together; the rest of the order stands as written.

**The window is now data.** `Model` (contract `schemas/providers/provider-oauth.ts`) carries an optional `contextWindow`, and the
endpoint catalog fills it: `endpoint-catalog.ts` reads llama.cpp's `/props`
(`default_generation_settings.n_ctx`, the SERVED per-slot window, not the GGUF's training length) concurrently
with the models list, and prefers a row's own `max_model_len` where vLLM published one. It flows through the
persisted last-known-good list with everything else, so a server that is down keeps its last answer. A server
that publishes neither leaves the field absent, and absent means unknown: nothing gates on it.

**A turn that cannot fit is refused before it is sent.** `agent/context-budget.ts` holds the arithmetic and the
one estimate in it: `HARNESS_FLOOR_TOKENS`, 20k for the Claude Code loop, claiming only the always-on part of
the ~45k the failing turn measured, deliberately low so a lean sandbox is never refused a window it could have
used. `planTurn` calls it after `honoured` has composed the prompt (so the measurement is what will actually be
sent) and before the adapter dispatch, and returns a `context-window-too-small` refusal carrying the three
numbers and the three ways out. Native providers pay one string comparison; the free trial is skipped entirely,
on the same rule that keeps its credential resolution from reading a catalog.

**The words survive it.** The new code is handled in `turnFailures.ts` like the other refusals that ran nothing:
the message goes back to the queue and the notice says to pick a bigger model, rather than a red line and a
Continue button that would re-fail on the press.

What this does NOT do, stated so the next reader does not have to discover it: it cannot catch a window that is
large enough for the floor and too small for this sandbox's actual tool surface. Those still fail at the
provider, with the raw 400, until step 3 replaces the constant with a measurement and step 6 codes the runtime
frame.

## 10. What §6's last bullet turned out to be worth

"Serve a bigger window where the model allows it" was written as the small print under the interesting work. It
was the whole answer for the one source of small windows this product actually owns.

A sandbox-run local model served a flat 32,768 tokens, chosen by the card as "the smallest window that holds a
real agent turn" and sized against our own composed preamble rather than against the floor this document
measured. So the second report reads exactly like the first: a 27B model, seventeen gigabytes downloaded,
`36216 tokens exceeds the available context size (32768 tokens)`, nothing wrong with the model. §1's finding,
"trimming our own notes cannot fix this", applies unchanged to picking the cap: **the floor has to enter the
choice of window, not just the check on it.**

What shipped (`docs/local-models-design.md` §10 has the build): the window is a field on the local-model card,
in rungs, defaulting to the smallest one a full turn fits in, with the memory each rung costs stated beside it,
because the reason nobody offered this choice before was that its price was invisible. Two consequences for this
document's own ladder:

- **§6's "picker-time honesty" is now cheap for this source.** The card knows its window at add time and says
  what a small one is good for; the connections row keeps saying it. That is not the picker warning step 6 asks
  for, but it moves the discovery from "my first message failed" to "I chose this, and it told me".
- **§5's floor is the number that matters most and is still an estimate.** It is now load-bearing in two places
  rather than one: it gates the turn, and it sets a default that costs the owner gigabytes of RAM. Step 3
  (calibrate per runtime and tool set off the first successful turn) got more valuable, not less.

## 11. The ladder, built: what a small window stops paying for (Sep 2026)

§5's ladder and §7's steps 4–5 shipped, with one substitution that is the whole of what is interesting here.

**The floor did not enter the decision, on purpose.** §5 divides an allowance — `window − floor − reserve −
message` — among the contributors. Every version of that arithmetic inherits the floor's error, and §9 already
records that the floor is a deliberately low estimate (20k against a measured 49k) chosen to bias the *refusal*
toward letting turns through. That bias is right for a refusal and exactly wrong for a trim: refusing wrongly
costs the user their turn, trimming wrongly costs a little orientation. Worse, on the windows this is for, the
error term is larger than the entire preamble being divided. So `agent/prompt/window/context-trim.ts` decides off the
one number the product has already measured and priced: the local-model card's window rungs.

- At or above `LOCAL_MODEL_WINDOW_DEFAULT` (64k — the card's own "the smallest rung a full turn fits in"),
  nothing is trimmed.
- Below it, **`lean`**: every preamble note a persona card may drop, this product's ~9k-char guidance block, and
  the field-notes brief.
- Below the next rung down (32k), **`minimal`**: the base prompt itself is swapped for one paragraph
  (`SMALL_WINDOW_PROMPT`), on the runtimes whose `instructions` are `replace`.
- An unknown window trims nothing, on the same rule §9's refusal uses. Unknown is not small, and it covers every
  native subscription in the product.

Raising the card's default raises all three, because the constants are read from the contract rather than
transcribed.

**What it may never take** is the set no persona card may drop, which is not a coincidence: the trim is
expressed over the same `TurnBriefingNoteId` vocabulary the card editor uses, so the six fixtures
(`TURN_BRIEFING_FIXTURES`) are out of its reach by construction. Where the files live, who the turn is acting
as, the owner's AGENTS.md rules, and the two notes that explain a missing account all survive at any window,
including onto the swapped base — those change what a turn is *allowed* to do, and a small window is not a
reason to become unsafe. The owner's own `custom` prompt is untouched too, at any size.

**Compose first, filter second.** The notes are built with the persona's briefing as though nothing were being
trimmed, and the window's filter is applied to the finished list. The inverted order would be cheaper by one
project-map walk per opening turn, and it would make the disclosure unwriteable: what a window *left out* can
only be named by first building what the turn would otherwise have sent. Everything the notice says is read off
that diff, so it can never name a note this turn was never owed.

**The disclosure is a notice row, every turn it applies.** A `context_trim` frame carries the window, the
omitted labels and whether the base was swapped; `contextTrimLine` (in the contract, beside the schema, so a
reopened conversation renders the same words) turns it into the row. Not once per conversation: a turn forty
messages down that ran thin with nothing saying so is the failure this exists to stop. Switching to a larger
model simply stops the line. The closing clause — "your workspace rules, this turn's persona and where its
files live still rode" — is load-bearing, because without it the row reads as "your AGENTS.md may not have
arrived".

**Where the two gates meet.** §9's refusal and this trim overlap at the bottom, and the refusal wins there: on the
Claude Code loop its floor plus the output reserve is ~22k, so a 16k window is still refused outright and the trim
never gets to help. That is §1's finding holding, not a bug — trimming cannot rescue a window the loop's own fixed
cost already exceeds. The smallest tier's usable band on that runtime is the stretch between that floor and the 32k
rung; on a runtime with no measured floor, every band below 64k is the trim's.

Two consequences for the rest of this document:

- **Step 3 (calibrate the floor) is still the most valuable thing left**, and is now the only thing standing
  between here and §6's real prize: the reduced *tool surface*. §1's finding is unchanged — the preamble was
  never the expensive part — so what this buys is a few thousand tokens and an honest product, not a fixed
  16k model.
- **`turn-context.ts`'s retrieved anchors are not in the ladder**, because they are not in the card's
  vocabulary and the flag that produces them is off by default. Adding an id for them is a card-editor change,
  and belongs with whatever re-measures that experiment.

## 12. The other door: helpers, and the runs nobody presses (Sep 2026)

§11 covers turns. The question it does not answer is what happens to the rest of `/sandbox/agent` on a small
model — the three blocks the settings page draws: automatic helpers, runs you start, runs that start themselves.
Traced, they split cleanly, and only one half was exposed.

**Runs were already covered, all three blocks.** Every path that reaches a model as a turn goes through the one
`planTurn` call: interactive chat, spawned children, `scheduler.ts` automations, `loop-runner.ts`,
`workspace-events.ts`, `verify-nudge.ts`, `workflows.routes.ts`, `gate.routes.ts`. So they inherit both §9's
refusal and §11's trim for free, and a 32k-pinned automation that used to be refused may now fit.

**Helpers were not, because they are not turns.** `askRoleModel → askRung → adapter.oneShot` never touches
`planTurn`. That turns out to matter *less* than it sounds: a one-shot sends `allowedTools: []`,
`settingSources: []`, `maxTurns: 1` — no tools, no session, no transcript — so the ~20k harness floor that made
§1's turn fail is simply not there. A helper's whole exposure is its own prompt.

Every helper did cap its prompt. The caps were each chosen against a large window, and spanned 80×:

| Role | Cap | ≈ tokens |
| --- | --- | --- |
| Auto model choice, Persona routing | 600 chars | 0.15k |
| Session titles | 4,000 | 1k |
| Loop verdicts | 8,000 | 2k |
| Safety judge | 4,000 program + 8,000 policy | 3k |
| **Commit messages** | **48,000 patch + 4,000 untracked + stats** | **13k** |

Only the last one can overflow a 16k window, and it is the one this product *recommends* for a small model:
§9's own refusal sentence, and `local-models-design.md` §10, both say "keep this one for the small jobs (titles,
commit messages) it can do as a one-shot helper". We pointed owners at the single helper that could not take it.

What shipped, three changes:

- **`RoleAsk.prompt` may now be a function of the room its rung has.** `role-model.ts` resolves every rung's
  declared window once before the walk and hands each ask `helperPromptRoom(...)` — the whole window less a
  1k reply reserve, in characters, `Infinity` where the window is unknown. `sizedCommitMessagePrompt` uses it:
  built at full size, then corrected once by exactly the overshoot, because the patch is the only part that
  clips. A small model now gets a clipped diff instead of a prompt it must refuse.
- **A rung that still cannot hold the ask is stepped over, not spent.** Sending it cost a round trip, earned a
  ten-minute memo (`OTHER_REFUSED_FOR_MS`), and came back as the server's raw 400 — so a mis-sized job read as
  an intermittent one. `helperOverflow` skips it with the two numbers and the two switches that change them,
  reusing the same card-versus-server split §10 gave the turn refusal.
- **The refusal row stopped promising a resend to nobody.** The codes that ran nothing all render as "held for
  you to send again", which on an automation, a loop or a watch wake names a composer no one is looking at and a
  message no one typed. The error frame now carries `unattended`, set where the route yields a refusal, and the
  row reads accordingly. This fixes the whole group, not just the context code.

One thing deliberately not done: the helper arithmetic is NOT the turn arithmetic, and the two should not be
merged. A turn pays the floor and a one-shot does not, so a shared "budget" would either refuse helpers that
work or admit turns that cannot. They share `declaredWindow` and nothing else.

## 13. The prize, planned (Sep 2026)

§6's first bullet — the reduced tool surface — has its own build plan in
[small-window-profile.md](small-window-profile.md): what the SDK already offers for it, what each turn sends
today, the one profile and the six tools in it, and the order to build it in, starting with the floor
measurement the CLI already reports.
