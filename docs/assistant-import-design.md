# Importing an OpenClaw or Hermes setup: the design

How a person who already runs OpenClaw or Hermes Agent on their own hardware brings that life into an
Intentic sandbox without re-typing it: two source adapters feeding one normalized migration plan, applied
through the native provisioning paths that already exist, previewed before anything is written, and honest
about what cannot move. This records the reasoning; §10 records what changed when the Hermes slice was built
(`_sandbox/sandbox/src/migrations/`, the `/migrations/*` routes, and the card on Sandbox → Environment).

## 1. The gap

The positioning shelf (`docs/marketing/positioning.md`) files OpenClaw and Hermes under *personal AI
assistants* ("self-hosted on your hardware and your accounts) the same conviction: but pointed at a life
rather than a repository", and closes with "an assistant that can call a webhook can start an agent here."
That composure line is true and useless to the person who matters: someone who has six months of SOUL.md,
memory files, skills, cron jobs and channel wiring in `~/.openclaw` or `~/.hermes` and wants an agent that
can *also* touch a repository. For them the switching cost **is** the setup, and today we offer nothing.

Three surfaces already do import-shaped work, and none of them closes this:

| Surface | What it does | Why it doesn't cover this |
| --- | --- | --- |
| `_sandbox/sandbox/src/portability/` (`POST /bundles/restore`) | Full sandbox export/import | Intentic→Intentic only; the tar layout and manifest are our own |
| `_editor/web/src/composables/extensions/memoryImport.ts` | "Run this prompt in your old assistant, paste the answer" → fenced merge into `CLAUDE.md`/`AGENTS.md` | Memory only; loses skills, crons, channels, models, secrets |
| `_editor/web/src/components/ForticlientImport.vue` | Parse one foreign config file to prefill one capability card | The right *gesture* at 1/40th the scope |

Two problems, and they compound. **The knowledge is scattered across formats**: an OpenClaw setup is
JSON5 config + markdown bootstrap files + a cron store + channel credential state + model auth profiles,
and Hermes is YAML + `.env` + markdown + SQLite; no single copy gesture moves it. **Half of it must not
move mechanically**: WhatsApp pairing state desynchronizes if copied, browser sessions are
identity-class, API keys need explicit consent. A naive "upload your folder" importer would either break
silently or exfiltrate credentials casually. Both failure modes already have named defenses in this repo;
the design below is mostly the discipline of reusing them.

## 2. The rules the importer inherits

Worth restating before proposing anything, because together they kill most of the obvious designs.

> Every decision is re-derived on the way in. `restore.ts` never trusts what the bundle says about itself.
>: `_sandbox/sandbox/src/portability/restore.ts`

> `needsAction` is the deliverable. The restore does not pretend to have made the target identical.
>: `restore.ts:actionsFor`

> A stored credential never enters the model's context.
>: `_sandbox/sandbox/src/browser/accounts-tools.ts`

> No migration logic – assume fresh state.
>: `/work/CLAUDE.md`

Four consequences:

1. **Fresh sandbox only.** The importer runs as a step of the Setup wizard, into a sandbox that has no
   state to conflict with. OpenClaw's own `migrate` command draws the same line: "onboarding imports
   require a fresh OpenClaw setup"; merge-into-existing is where their complexity budget went, and we
   decline to spend ours there. The one exception is memory, which uses the already-idempotent fenced
   merge and can therefore rerun anytime.
2. **The archive is untrusted input.** Adapters parse it; nothing in it is executed, and no path from it
   is written verbatim. Every plan item is re-validated against *our* schemas at apply time, exactly as
   `restore.ts` refuses a tar entry our manifests don't class as carryable.
3. **Secrets are opt-in, vault-only.** Mirroring OpenClaw's `--include-secrets`: the plan lists each
   credential *by name and destination*, the owner ticks them, values go into the secret vault or ride a
   capability's `config` at add time, and anything the importer writes into a prompt, config or automation
   says `{{secret:name}}`: never a literal.
4. **The report admits what didn't move.** Sessions, pairings, logins, the built image: each becomes a
   `needsAction` entry addressed to the owner, not a silent omission.

## 3. What a foreign setup actually is

Verified against the projects' own docs (OpenClaw: [migration guide](https://docs.openclaw.ai/install/migrating),
[migrate command](https://docs.openclaw.ai/cli/migrate), [agent config](https://docs.openclaw.ai/gateway/config-agents);
Hermes: [quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)). Their `migrate`
command is also prior art for us twice over: it imports *from Hermes and Claude into OpenClaw*, so its
itemization is a peer-reviewed inventory of what these setups contain, and its preview-first UX is the shape
users of these tools already expect.

**OpenClaw** (state dir `~/.openclaw`, workspace `~/.openclaw/workspace`):

| Artifact | Where | Nature |
| --- | --- | --- |
| `openclaw.json` (JSON5) | state dir | identity, per-agent model + workspace, heartbeat, channels (WhatsApp/Telegram/Discord/…), gateway |
| `SOUL.md`, `IDENTITY.md` | workspace | personality, voice, behavioral boundaries: injected every session |
| `USER.md`, `MEMORY.md`, `memory/*.md` | workspace | who the owner is; long-term memory |
| `AGENTS.md` | workspace | operating instructions |
| `HEARTBEAT.md` + cron `jobs.json` | workspace / state dir | plain-English recurring checklist + structured cron jobs |
| `skills/<name>/SKILL.md` | workspace | user-authored skills, agent-skills format |
| `agents/<id>/agent/auth-profiles.json` | state dir | model provider credentials |
| `credentials/` | state dir | channel state: WhatsApp ratchets, bot tokens |
| sessions, logs | state dir | transcripts |

**Hermes** (state dir `~/.hermes`):

| Artifact | Where | Nature |
| --- | --- | --- |
| `config.yaml` | state dir | default + fallback models, 30-odd providers, MCP servers, gateway platforms |
| `.env`, `auth.json` | state dir | API keys, OAuth credentials |
| `SOUL.md`, `AGENTS.md` | workspace | same roles as OpenClaw's |
| memory dir | workspace | long-term memory markdown |
| `skills/**/SKILL.md` | workspace | skills, sometimes nested (their own migrate flattens them) |
| sessions, plugins, SQLite, logs | state dir | excluded even by their own migrate |

The overlap is no accident: the ecosystem converged on `SKILL.md` folders, root markdown bootstrap files,
and cron-plus-channels. That convergence is why two adapters can share one plan format.

## 4. Architecture: two adapters, one plan, native apply

```
~/.openclaw ─┐                                       ┌─ capability add path  (identities, endpoints,
             ├─ ingest ─ adapter ─ MigrationPlan ─┬──┤   connectors, mcp)
~/.hermes  ──┘   (tar)   (pure)    (previewed,    │  ├─ secret vault         (opt-in)
                                    itemized,     │  ├─ POST /skills
                                    owner-edited) │  ├─ POST /automations
                                                  │  ├─ mergeMemory fences   (CLAUDE.md / AGENTS.md)
                                                  │  ├─ settings.json        (via SandboxSettingsSchema)
                                                  │  └─ imports/<source>/    (the unmapped remainder)
                                                  └─ MigrationReport { applied, refused, needsAction }
```

A new module `_sandbox/sandbox/src/migrations/` beside `portability/`: a sibling, not a tenant, because
portability's invariant is "both sides speak the manifest" and here only one side does.

**`SourceAdapter`** is the whole abstraction: `detect(files) → {source, version, agents[]}` and
`plan(files) → MigrationItem[]`. Adapters are pure functions over an in-memory file map: no filesystem,
no network: so they unit-test against fixture trees and can run in the browser for instant preview
before any upload. `openclaw.ts` parses JSON5, `hermes.ts` parses YAML + dotenv; both tolerate unknown
keys, and anything unrecognized degrades to an `unmapped` item, never a failure. A third-party assistant
becomes importable by writing one adapter; nothing downstream changes.

**`MigrationItem`** is a tagged union keyed by *target*, not source:
`capability | secret | skill | automation | memory | knowledge | settings | persona | unmapped`:
each carrying the translated payload (already in our schema), a human label, a `requiresSecret?` name
list, and provenance (source path). The apply loop is source-agnostic and deliberately boring: it walks
the ticked items and calls the same code the "+" grid, the skills page and the automations page call.
No parallel writers into `.intentic/`: the capability handler's `apply()` still writes the account
skill, composes the environment overlay and starts gateway processes, because the importer went through
the front door.

**Ingestion, three routes, one pipeline:**

1. **Upload**: `POST /migrations/plan` with a tar of the state dir + workspace (or an archive from
   OpenClaw's own export skill, which we detect). Returns the plan; `POST /migrations/apply` takes the
   ticked item ids + `includeSecrets`. Raw Hono streaming routes next to `/bundles/*`, owner-only,
   same `MAX_UPLOAD_BYTES`.
2. **Enrolled computer**: the genuinely seamless path. If the machine running OpenClaw/Hermes is
   enrolled as a `host` capability, the daemon reads the two directories over the host channel itself:
   detect → plan → preview with zero manual packing. Setup already offers desktop sync at this exact
   moment (`SetupSyncOption.vue`); this is the same gesture pointed at a different directory.
3. **Paste**: the existing `memoryImport.ts` prompt flow stays as the floor for someone who wants only
   the memory, or whose assistant we have no adapter for.

## 5. The mapping

The heart of the design. Left column is theirs, right is the native thing it becomes: never a shim that
emulates the foreign runtime.

| Theirs | Becomes | Mechanism |
| --- | --- | --- |
| `SOUL.md` + `IDENTITY.md` | The sandbox's voice: `settings.systemPromptMode: "custom"` + `systemPrompt` when it reads as operating doctrine; a **persona** (`PROMPT.md` kit) when it reads as a character the agent acts as | Settings write / persona create. The adapter proposes, the owner picks, this is the one mapping with taste in it, flagged in the preview |
| `USER.md`, `MEMORY.md`, `memory/*.md` | Fenced block in `CLAUDE.md`/`AGENTS.md` via `mergeMemory`, under a per-source fence id (`intentic:imported-openclaw`) so reruns and the generic memory importer never fight | Idempotent merge |
| Long-lived facts about people/projects inside memory | `knowledge/` notes, then `kb check` | Deferred to the agent (§7): entity extraction is judgment, not translation |
| `AGENTS.md` | Same fenced merge into ours; it remains entirely user-owned | Idempotent merge |
| `HEARTBEAT.md` | One `schedule` automation whose prompt is the file, `chore: true`, default cadence from their heartbeat config | `POST /automations` |
| cron `jobs.json` / Hermes cron | One `AutomationSchema` record each: cron expression → `schedule` trigger, message → `prompt`, `requireApproval: true` on anything whose prompt implies outbound sends | `POST /automations` |
| `skills/<name>/SKILL.md` | `.intentic/config/skills/<name>/` + enabled in `settings.skills` | `POST /skills`; frontmatter normalized to our two-key form, nested Hermes skills flattened |
| Channel configs (Telegram, Discord, Slack, WhatsApp…) | The matching extension's connector capability + its `listener` automation | Capability add path; bot tokens are secrets (§6). We already ship `_extensions/{discord,slack,telegram,whatsapp}`: the mapping is config-shape translation, not new channels |
| Model config (`openclaw.json` agents, Hermes `config.yaml` + fallbacks) | Native provider when it maps through `agent-catalog.ts` (claude/codex/gemini/…); an `endpoint` capability for anything OpenAI/Anthropic-protocol we don't carry natively | Settings + capability add. Fallback chains have no native equivalent → `unmapped`, noted in the report |
| MCP server definitions | `mcp` capabilities | Capability add path |
| `auth-profiles.json`, `.env`, `auth.json` | Secret vault entries / capability config fields | §6: only with opt-in |
| Sessions, transcripts, logs, SQLite | **Refused.** Listed in the report | Matches both tools' own export defaults; our history is not a container for theirs |
| WhatsApp/Signal pairing state | **Refused** even with secrets on | Ratcheting state desyncs when copied, their migration docs warn about exactly this. `needsAction: "Pair WhatsApp again"` |
| Everything else in the workspace | `imports/<source>/` in the sandbox workspace, verbatim | The agent's reference pile, listed as `unmapped` items |

## 6. Secrets

The plan phase never reads secret *values*: adapters record `{name, sourcePath, destination}` and the
preview shows exactly that. At apply, with the owner's tick per item: env-shaped keys →
`POST /secrets`; connector/bot tokens → the capability's secret field, extracted into the vault by the
handler's own `secret()` hook. From that moment the standard machinery owns them: masked to
`{{secret:name}}` on every read path, resolved only at the moments a value actually leaves. The
uploaded archive is deleted after apply (or on abandon); it is a credential store and does not get to
linger in `/history`.

## 7. The agent finishes the last mile

Mechanical translation ends where judgment begins, and pretending otherwise is how importers produce
uncanny half-setups. So the apply step's final act is to write `imports/<source>/report.json` and start
a first conversation seeded with it. The agent then walks the remainder *with* the owner:

- every `needsAction` item: sign back into accounts via the accounts tools, re-pair channels, verify
  one imported automation actually fires;
- distill `imports/<source>/` leftovers and imported memory into `knowledge/` notes where they are
  entity-shaped;
- read each imported automation back to the owner in plain words and confirm cadence and approval
  settings: imported crons default to `requireApproval` for anything outbound, and the agent is the
  right interlocutor for relaxing that, one automation at a time.

This is also the honest answer to "seamless": the seam exists (sessions, pairings, logins do not move),
and the product's job is to make crossing it a guided ten-minutes, not to deny it.

## 8. Surfaces and contract changes

- **Setup wizard**: a "Coming from OpenClaw or Hermes?" step after name/compose, detect, preview plan
  as a ticked checklist, apply, hand off into the seeded first conversation. Resumable like the rest of
  Setup.
- **"+" grid**: an *Import from…* card per source for the person who skipped it during Setup
  (fresh-state rule still applies: the card hides once the sandbox has meaningful state, except the
  memory-only paste flow, which is always safe).
- **Contract**: `MigrationItemSchema`, `MigrationPlanSchema`, `MigrationReportSchema` (the report reuses
  `ImportReportSchema`'s `{applied, refused, needsAction}` shape) in `sandbox-contract`, lock
  regenerated. Routes `POST /migrations/plan|apply` beside `/bundles/*`.
- **State manifest**: `imports/` enters `WORKSPACE_STATE_FILES` with an explicit portability class
  (`carry`: it is owner content once landed); the coverage guard fails the build otherwise.
- **Placement**: adapters and apply in the daemon (`_sandbox/sandbox/src/migrations/`), preview UI in
  `_editor/web`. Not an extension in v1: the importer writes settings, skills, automations *and*
  capabilities, which is core's privilege; an adapter-contribution point for extensions is a later
  door this design leaves open but does not build.

## 9. What this deliberately does not do

- **No live bridge.** We do not gateway to a still-running OpenClaw/Hermes instance. Import is a
  crossing, not a federation; the composure story ("an assistant that can call a webhook…") already
  covers coexistence.
- **No merge into a lived-in sandbox** beyond fenced memory. Fresh state or the paste flow.
- **No transcript import.** Their history stays theirs; memory files are the distillate the tools
  themselves maintain for exactly this purpose.
- **No credential moves without a tick**, and no pairing-state moves at all.
- **No format emulation.** A HEARTBEAT.md becomes an automation; it does not become a heartbeat
  subsystem. Every imported thing must be visible, editable and deletable in the native UI the day
  after import, indistinguishable from having been created here.

## 10. What changed on the way (both slices, built)

Both adapters are implemented: `MigrationPlanSchema`/`MigrationApplySchema`/`MigrationReportSchema` in the
sandbox contract; `_sandbox/sandbox/src/migrations/` (`archive.ts` reader, `adapter-shared.ts`: the name
shaping, secret/skill/cron/MCP planners both sources must not disagree on: `hermes.ts` and `openclaw.ts`
adapters, `apply.ts` loop, `migrations.ts` dispatch); raw `POST /migrations/plan|apply` + `DELETE /migrations`
beside the bundle routes; and `MigrationCard.vue` next to the bundle card: one upload button, the daemon
recognizes which tool packed the archive. Calls this doc made that the build corrected:

- **SOUL.md lands as fenced memory, not as `systemPrompt`.** §5 offered "custom system prompt or persona,
  owner picks", but `systemPromptMode: custom` means *the entire prompt and nothing else*, which would trade
  the tuned harness prompt for a personality file and quietly degrade every turn. The safe translation is a
  fenced block in the memory files with the persona suggestion in the item's own description; the persona
  path stays a later, deliberate act.
- **`imports/` needs no manifest entry.** §8 planned a `WORKSPACE_STATE_FILES` row, but the workspace volume
  defaults to `carry` for exactly this class of content: `imports/hermes/` is owner content the day it
  lands, and only `.intentic/` paths the daemon builds need declaring. Nothing new to declare, because the
  held upload deliberately never touches disk: the pending archive lives in daemon memory under a token
  (it is a credential store; a temp file would be a second copy with a lifetime somebody must remember).
- **Env secrets are gated on DevOps being active.** The env store IS `desired-state/.env`; on a sandbox
  without DevOps a secret item fails with that stated reason rather than inventing a second store. The
  apply loop is deliberately re-runnable (fenced memory, upserts, existing capability ids refused), so
  "activate DevOps and run the import again, ticking what failed" is a safe answer.
- **Channel configs became `needsAction`, not capabilities, in v1.** Adding a connector capability requires
  its extension's contribution to resolve; on a fresh sandbox it may not be installed. The honest v1 is the
  reconnect instruction, with the bot token riding the secrets path so the reconnect is one paste: the
  §5 table's capability mapping stands as the target state.
- **OpenClaw's JSON5 config is read by a deliberately partial reader** (`json5ish.ts`): comments, trailing
  commas, bare keys and single quotes (the edits people actually make) but not the long tail (hex numbers,
  line continuations). Past that the config is refused by name and the file items still import; a real JSON5
  dependency is one small add away if a real archive ever defeats this.
- **OpenClaw's daily memory diary splits in two.** The §5 rule "memory files → fenced merge" would put a
  year of `memory/YYYY-MM-DD.md` into files every turn reads. The build keeps the curated stores plus the
  newest two weeks in the fence and lands the whole diary under `imports/openclaw/memory/` for the agent to
  search on demand.
- **The instruction turned out to be the hard part, and it got its own pass.** One caption holding both
  tools' archive commands assumed six things at once: that you know which command is yours, that you have a
  shell, that it is on the machine the assistant runs on, that your setup is at the default path, that you
  know where the file lands, and that you know it will hold your keys. Every wrong assumption failed *after*
  packing, copying and uploading. The card now asks in the order that resolves fastest: a connected computer
  first (§4's route 2, now built: `host-scan.ts` walks the machine's own folder over the socket it already
  holds, so there is nothing to pack), then one tool, then one command with its output location named, with a
  server, a container and a moved folder each answered in a fold beside it. OpenClaw's path uses that tool's
  own backup command rather than teaching an archive: it cannot get the paths wrong.
- **The direct read reads, it never runs.** A shell command would be one call instead of many, and `shell` is
  a scope an owner may have switched off; reads inside a machine's roots need no scope at all. It also reads
  only what an adapter can consume (`scan-policy.ts`), while sharing the skip policy with the archive path:
  so `credentials/` is never read down either door.
- **An unrecognized upload diagnoses itself** (`diagnose.ts`) instead of repeating the instruction that just
  failed: an empty archive, the workspace folder packed instead of the whole setup, a whole home directory,
  or a list of what the archive actually held.
- **`schedule.kind: "every"` converts only where cron says it cleanly** (whole minutes/hours/a day); "every
  90 minutes" is refused with the reason rather than approximated onto a rhythm the owner never chose.
  One-time `at` jobs are refused too: by import day they are jobs in the past. HEARTBEAT.md becomes one
  scheduled automation on the configured heartbeat interval, exactly as §5 planned.
