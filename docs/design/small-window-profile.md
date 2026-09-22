# The small-window tool profile

Build plan for the one thing [context-budget-design.md](context-budget-design.md) calls the real prize and never
built (§6, first bullet; §11, first consequence). Written for a separate session; every seam below was read on
2026-09-22 and is named by file so that session starts by editing, not by re-deriving.

## 1. What is still true

A bare "Are you there?" turn on this sandbox costs ~49k tokens, of which ~45k is the harness: Claude Code's own
instructions, one schema per loaded tool, the skills listing, the agent-type listing, the deferred-tool names.
None of that is composed by the daemon, so §11's trim (notes shed, base prompt swapped) buys a few thousand
tokens and cannot make a 16k or 32k model work. The refusal in `context-budget.ts` still uses a constant floor
(`HARNESS_FLOOR_TOKENS`, 20k, deliberately low), so a 32k model is let through and fails at the provider with
the raw 400.

The owner's decision (2026-09-22): keep small local models for chat, and build the reduced tool profile rather
than drop them.

## 2. What the SDK already offers

Read from `@anthropic-ai/claude-agent-sdk@0.3.278` `sdk.d.ts`; nothing here needs a harness change.

| knob | what it does | line |
| --- | --- | --- |
| `tools: string[]` | the built-in set; `[]` disables all built-ins | 1568 |
| `disallowedTools`, `allowedTools` | subtract / restrict, already used | 1512, 1532 |
| `skills: string[] \| 'all'` | which skills are listed | 2174 |
| `settingSources: []` | SDK isolation: no `.claude/` settings, skills, hooks, `.mcp.json`, CLAUDE.md | 2151 |
| `plugins: []` | no plugin dirs (each brings skills into the listing) | 1939 |
| `agents` | subagent definitions, which is the "Available agent types" block | 1504 |
| `createSdkMcpServer({ alwaysLoad })` | pinned in the prompt vs deferred behind ToolSearch | 563 |
| `SDKContextUsage` | per-tool, per-section token counts: `mcp_tools[].tokens`, `deferredBuiltinTools`, `systemTools`, `systemPromptSections`, `agents`, `memory_files` | 3600–3790 |

The last row is the calibration §7 step 3 asked for, and it is already measured by the CLI: it rides the
synthetic assistant message a `/context` request produces (`context_usage`, line 3459) and is available through
`query.getContextUsage()` (line 2852). The floor stops being an estimate the first time any turn on the runtime
asks for it.

## 3. What the daemon sends today, per turn

Traced through `agent/run/turn/turn-plan.ts` (`planHarnessTurn`) and `agent/run/agent.ts` (`baseOptions`):

- Built-ins: the full Claude Code preset (no `tools` option is passed), minus `CLI_SCHEDULER_TOOLS`, the
  caller's `disallowedTools`, persona-denied tools and gated skills (`turn-plan.ts:724`, `agent.ts:341`).
- `settingSources: ["user", "project"]` (`agent.ts:450`), so the repo's `.claude/` skills and settings load.
- Plugins: iq, webq, every granted capability's plugin dir, extension agent dirs, the persona kit
  (`turn-plan.ts:863`). Each contributes skills to the listing.
- In-process MCP servers (`turn-plan.ts:926`, `agent.ts:917`): `ui` (1 tool, pinned), `code` (1, pinned),
  `watch` (2, pinned), `subagents` (5, pinned), plus deferred `accounts` (7), `secrets` (1), `terminal` (1),
  `deps` (2), `diagnostics` (4), `hashline` (3 when on), and the browser servers.
- Remote http MCP servers from `turnToolsOf`: internal tools, every mcp-kind capability, and one peer bridge per
  connected device and browser extension (each device is ~25 tools, deferred).
- `CHECKLIST_ENV` advertises the Task tools in the prompt.

Deferred servers keep their schemas out of the prompt but still cost a name each in the deferred list, a
handshake, and (for `alwaysLoad`) a blocking connect. Pinned schemas, the skills listing and the agent-type
listing are the bulk of the 45k.

## 4. The profile

One profile, `small`, chosen per turn on the harness runtime only (Pi, ACP, Codex and Gemini own their tool
lists; they are out of scope and say so in the code). It subtracts; every existing gate (persona powers, gated
skills, unattended plan tools) still applies on top.

| surface | full | small |
| --- | --- | --- |
| built-ins (`tools`) | preset | `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob` |
| `settingSources` | `["user","project"]` | `[]` |
| `plugins`, `skills` | as today | `[]`, `[]` |
| `agents` (subagent types) | as today | none; `Agent` is not in the built-in list either |
| in-process servers | all | `ui` only, and only on an attended turn |
| remote http servers | all | none |
| `CHECKLIST_ENV` | set | unset |
| hashline edits | per setting | off (native Edit/Write stay) |

Why these six built-ins: they are the loop a model must drive to be an agent at all, and their schemas are
small. `ToolSearch` goes because nothing is deferred to search. `Skill`, `Agent`, `Workflow`, `ListAgents`,
`WebFetch`, `WebSearch`, `NotebookEdit`, the Task tools and the plan tools are orchestration a 3B model will
not use correctly and whose descriptions are the largest schemas in the preset.

Why `ui` stays: one small schema, and it is how a small model asks instead of guessing. It already drops on an
unattended turn.

What the profile does NOT touch: the owner's AGENTS.md rules, the persona note, where the files live, and the
gate notes ride as they do under §11's trim (they are composed by the daemon, not the harness, and their
absence changes what a turn is allowed to do). The owner's `custom` prompt is untouched.

## 5. Choosing it

Today the trim tier is read off the local-model card's rungs (`context-trim.ts`: below 64k `lean`, below 32k
`minimal`). The profile joins the same decision so the two cannot disagree: `TurnTrim` gains
`readonly tools: "small"`, set for both tiers. Below 64k the tool surface is small; at or above it, full; an
unknown window trims nothing, as before.

Once the floor is measured (§6 step 1), the rung is the fallback and the measurement decides:

```
full   if floor.full  + reserve + prompt <= window
small  if floor.small + reserve + prompt <= window
refuse otherwise
```

This is §5's arithmetic with the estimate replaced by a number the CLI reported, which is the condition §11 set
for using the floor at all. The 64k rung stays the answer until the runtime has been measured once.

## 6. Build order

Each step lands on its own; 1–3 are the prize, 4–6 make it honest, 7 proves it.

1. **Measure the floor, and keep it.** New `agent/prompt/window/context-floor.ts`: a store keyed by
   `(runtime, profile)` holding the last `SDKContextUsage` reduced to one number (system prompt sections +
   loaded tool schemas + agents + memory files + skills; deferred rows excluded), persisted under
   `.intentic/local/cache/`. Fed from `sdk-stream.ts` where `modelUsage` is already read, by asking
   `getContextUsage()` once per session on the first result (any model: the floor is a property of the tool
   surface, not the model). `HARNESS_FLOOR_TOKENS` becomes the fallback, read only when the store has no row.
   `contextShortfall` takes the profile. The measured number is surfaced in the `context_trim` frame and in
   `diagnostics-tools.ts`, so the sentence "roughly N of that is the agent loop itself" stops being a guess.
   Tests: reduction of a fixture `SDKContextUsage`; the fallback path; a stale-store row is replaced, never
   summed.

2. **The profile, wired.** `AgentRequest` gains `toolProfile?: "small"`; `planHarnessTurn` sets it from
   `trim.tools` and, when set: passes `tools: SMALL_PROFILE_TOOLS`, `settingSources: []`, `plugins: []`,
   `skills: []`, no `agents`, `sdkServers` reduced to `ui`, `tools` (http) empty, `CHECKLIST_ENV` withheld,
   hashline off. `baseOptions` in `agent.ts` reads the field. The constant list lives in the contract beside
   `LOCAL_MODEL_WINDOWS` so the card copy (step 6) and the plan read the same six names. Tests: extend
   `turn-plan.testing.ts` with a 32k declared window and assert the SDK options; a persona without shell power
   still loses `Bash` under the profile.

3. **Selection by measurement.** `turnTrim` takes the floors beside the window and applies §5's rule, rung as
   fallback. The refusal sentence gains a fourth way out only when it applies: "the reduced tool set was already
   in use". Tests: the three outcomes across a measured and an unmeasured runtime.

4. **Disclosure.** `ContextTrimSchema` (contract `schemas/context-trim.ts`) gains `tools?: "small"`;
   `contextTrimLine` says what the turn could and could not do ("this turn had read, edit, write, shell and
   search, and no skills or delegation"), in the same row §11's notice already uses, every turn it applies.
   Five catalogs.

5. **A coded overflow frame, and one retry.** `error-frames.ts` learns the provider's overflow text
   (`exceeds the available context size`, `context_length_exceeded`, `prompt is too long`) and codes it
   `context-overflow` with the three-number sentence. `agent.routes.ts` retries exactly once at `small` when
   the failed turn ran `full` and the window is known, on the pattern `claude-token-refused` already uses to
   re-plan; a `small` turn that overflows is refused with the sentence, never looped. `turnFailures.ts` in the
   editor renders the code like the other unsent refusals, `unattended` included.

6. **Card honesty.** The local-model card's window rungs say beside 16k and 32k what a turn gets there: chat,
   and the six tools; no skills, no delegation, no browser. The connections row repeats it. Copy only.

7. **Prove it on this sandbox.** An opt-in e2e (`INTENTIC_E2E`) against the sandbox's own llama.cpp card at
   32k and at 16k: a turn that reads a file and edits it, asserting the `context_trim` frame carries
   `tools: "small"` and no provider 400 occurs. This is the presence check that never passed in the sessions
   that motivated this document.

Rough size: 1 ≈ 150 lines + tests, 2 ≈ 200, 3 ≈ 80, 4 ≈ 60 + catalogs, 5 ≈ 120, 6 copy, 7 one test file.

## 7. Options that lose

- **Make the profile a setting.** A second knob nobody can size; the window rung already is the knob, and it is
  priced in memory on the card.
- **Defer instead of drop.** Deferred servers still cost names, handshakes and startup, and ToolSearch itself is
  a schema; on a 16k window the list of what is not loaded is itself too long.
- **Budget per tool.** Choosing which twenty of ninety tools to load per message is a retrieval problem a 3B
  model cannot judge and the daemon cannot judge for it. Two fixed surfaces, one line between them.
- **Build it for Pi or ACP first.** Those runtimes carry no 45k floor; §12 shows their exposure is the prompt
  alone, which §11 already handles.
- **Skip step 1 and keep the constant.** Every later step then inherits an estimate that is wrong by 2× on this
  sandbox, which is how §9's refusal lets a 32k turn through today.

## 8. What this leaves open

- Whether `Grep`/`Glob` exist on the native build (`sdk.d.ts:1566` warns search may be Bash-only); step 2's
  test settles it, and `Bash` covers the gap if not.
- Whether the floor differs enough between models sharing a runtime (tokenizers) to key the store on model too.
  Step 1 records the model with the row; if two rows for one runtime disagree by more than the reply reserve,
  key on both.
