# Field notes

The sandbox's own brief: what sessions here had to learn the hard way, ranked, carried in every turn's system prompt.
One switch (`fieldNotes`) turns on three parts — a file, a composer, and a measurement — and each is useless without
the other two.

## Why it is not the project map

The project map (`src/agent/prompt/workspace-map.ts`) is recomputed from the **tree** at the start of every
conversation, which is exactly why it can be trusted and exactly what bounds it: it can only ever say what a scan can
see. Which directories exist, how big each is, what each is for.

Everything a session actually loses time to is invisible to that scan. That `pnpm`'s exit code lies after a successful
build because `node_modules` is an overlay mount and the hardlink sync fails across the device boundary. That a test
sitting silent for four minutes is queued behind another session, not hung. That the owner says `/agents view` and
means `_editor/web/src/agents/`. None of it is in the tree; all of it is in the record of what has happened here.

So: **the map is derived per conversation, this is written per month.** A fact that a scan of the repository could
produce belongs in the map, and the automation's prompt says so.

## The file

`.intentic/config/field-notes.toon`, beside `safety.md` and `personas.json` — the owner's other composed-into-the-prompt
files. Tracked by the root shadow repo, so a rewrite arrives as a reviewable diff rather than as a silent change of
what every turn is told.

TOON, with a shape the reader depends on:

```
meta:
  title: ...
  derived_from: ...
priority[12]{rank,id,title,pct,cost}:
  1,ground,Which tree you are standing in and may write to,100,"edits land outside the branch"
  2,toolchain,...
ground:
  ...
toolchain:
  ...
```

Every `id` in the `priority` table is a top-level key. Ranks are integers, ids are kebab-case words — which is why the
reader can take the first two columns off a row without parsing the quoted prose in the rest of it.

## The composer: `src/agent/prompt/field-notes.ts`

Reads the `priority` table, then takes sections **whole, in rank order, while they fit `fieldNotesBudget`**. Never a
partial section: half a rule reads as a rule, and the one thing worse than an unknown trap is a truncated sentence
about it.

Three properties worth keeping:

- **The payload is sliced out of the source text, never re-encoded.** The owner's own bytes, ordering and wording
  survive. A round trip through a TOON encoder would requote and reorder, and the diff of the next rewrite would be
  noise.
- **`meta` always rides; `priority` never does.** The index looks like the thing to send, and it is not: its columns
  are a title and a cost written for whoever opens the file, and all twelve rows cost 2,350 of the default 2,800
  characters describing sections the turn was not being given. One disclosure line does the job instead — *"ranks 2-12
  are NOT below (toolchain, verify, …)"* — which is what a reader needs to tell "this sandbox has no such trap" from
  "that section did not fit".
- **A file that cannot be indexed sends nothing, and says why.** An absent file is silence (the ordinary state before
  the automation has ever run). A file that exists and whose `priority` table cannot be read is a broken automation,
  and the settings row shows it as one.

Placement is `turnPromptPlacement` (`system-prompt.ts`): the append, after the persona note and **before** the owner's
`AGENTS.md` rules, which stay last and closest to the conversation. A brief about the sandbox is context for the
owner's rules, never a rule that outranks them. A custom system prompt drops it like all of this product's guidance; a
runtime with no system seam (Pi, ACP) gets it on the user message beside the other two.

It rides the system prefix, so it is composed on every turn and served from cache on all but the first. Rewriting the
file mints a new prefix — the same cost as editing `AGENTS.md`, once a month.

## The automation

`field-notes` in `src/automations/catalog.ts`, monthly on the 1st at 04:00, offered in `/ext/automations` beside the
nightly Dreaming session. The division between the two: **Dreaming changes one thing about the sandbox each night;
this changes what every turn knows about it, once a month.**

It is *offered*, not created by the switch. An `Automation` must name the models it may spend
(`AutomationSchema.models`, min 1) precisely because work that fires while nobody is watching spends a real allowance —
so nothing here mints one on the owner's behalf. The settings row shows whether it exists, whether it is enabled, and
links to the card that creates it.

No `afterSessions` floor, unlike Dreaming: a quiet month is itself a finding, and the brief going a month unexamined is
what this is here to stop.

## The measurement

`NOTES_DESIGN` in `src/usage/turn-experiments.ts`, the third record beside the search teaching and the map.

| | |
| --- | --- |
| arm | `notesArm`, stable per conversation (`holdoutArm("field-notes", …)`) |
| cohort | `notesCohort` — first 8 hex of a sha256 over the whole file |
| headline | `failedCalls`: tool calls that came back an error |
| second reading | `callsBeforeTarget` |
| sample | mean over a conversation's turns |

**Why failed calls.** The brief's largest section is a taxonomy of what fails in this sandbox and what to do instead.
"Fewer failed calls per turn" is the promise it either keeps or does not. A turn that recovers from three errors still
had three.

**Why every turn, not the opening one.** The map is sent once with the first message, so its effect is an opening-turn
effect and averaging over a twelve-turn conversation would divide it by twelve. This sits in the prompt for the whole
session, so turn 40 is as much evidence as turn 1.

**Why a cohort at all.** The file is rewritten monthly. A window wide enough to reach `MIN_ARM_TURNS` in both arms is
wide enough to hold two revisions, and pooling them would measure neither. `experimentOf` already narrows to the
latest cohort; stamping the revision is what lets it. The cohort is recorded on **control** turns too — off the file
they were withheld from — or an arm would pair against nothing.

## What is deliberately not here

- **No observational bench.** The map has `bench:map` because it shipped before its holdout did. This had a holdout
  from the first day, and a weaker second measurement beside it only ever gets quoted when it happens to agree.
- **No per-repo notes.** The corpus is the whole fleet's history; one file per repository would duplicate most of it
  and disagree at the edges.
- **No auto-tuning of the budget.** The panel reports, the owner decides. A mechanism that widened its own budget
  because it measured itself as helpful is not one the panel could then be trusted to report on.
- **No prompt-side summarising when the file outgrows the budget.** That would measure the summary rather than the
  artifact. It sheds whole sections and says which.
