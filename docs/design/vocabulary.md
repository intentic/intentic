# Vocabulary: one name per idea

What each contested word means from now on, what the words it displaced become, and the order the renames
happen in. The measurement behind it is [docs/audits/vocabulary-audit.md](../audits/vocabulary-audit.md), which
found 16 words naming several ideas and 13 naming one idea nobody guesses.

The rename of slices to areas (`b04679c20`) is the model this follows and the reason it is written down. That
one was correct and still left two marks: the new word collided with an existing meaning on the first day, and
nothing stops the old word coming back.

## Three rules

**One idea per word.** A word that names an idea names nothing else in this repository. `verdict` is the
standard: twelve compounds, one meaning, and a reader who learns it once is never wrong again.

**No word a primitive already owns.** `slice` was unfindable from the day it was chosen because
`Array.prototype.slice` answers every search for it. `state`, `key`, `map`, `exit` and `run` are spoken for the
same way. A domain word has to survive `rg`.

**A word that must be taught is taught in one place.** Four product nouns already work this way: machine,
sandbox, persona and project are defined by one picture, and
[metaphor-home.mjs](../../_tools/checks/metaphor-home.mjs) refuses a tree where that stops being true. Any word
kept below because no plain alternative exists joins that list rather than accumulating explanations.

## The splits

### card

`Card` names a UI shape and nothing else. A Vue component may be called `HoverCard` or `AgentCard`, because
that is a description of the box being drawn. No domain type, no route, no wire field and **no sentence a user
reads** may use the word.

| meaning today | becomes | where |
| --- | --- | --- |
| a capability catalog entry | **entry** | `CatalogCard` to `CatalogTile` in the grid, `contributionCard` to `contributionEntry`, `connectableCards` to `connectableEntries`, `hostCard` to `hostEntry`; the type was already `CapabilityCatalogEntry`, so the word the code had won |
| a decision held for the owner | **request** | `CARD_FIELDS` to `REQUEST_FIELDS`, `TranscriptCards` to `TranscriptRequests`, `raiseCard` to `raiseRequest`, `events/cards.ts` to `events/requests.ts`, `policy/card-status.ts` to `policy/request-status.ts` |
| a question the agent asks in chat | **question** | the copy drops "card": "its own questions, checklist panel and browser tools" |
| one tool call in the transcript | **block** | "Shortened for this card" becomes "Shortened for this block", beside a `ChatCommandBlock` that already said so |
| a settings panel | name the panel | "Open the Sandbox page's Environment card" becomes "Open Environment on the Sandbox page" |
| a persona | **persona** | `personaCard.ts` to `personaRules.ts`, `reachableCards` to `reachablePersonas`, and the prose in five catalogs |
| a payment card | **card** | it is a card |

The one thing `Card` may still name is a Vue component's own box: `HoverCard`, `RailCard`, `AgentCard`, the
`bg-card` token. That line held: the rename of the rail's persona rows to `RailRow` broke the build in one file
and was reverted, which is the distinction working rather than failing.

### gate

`gate` keeps exactly one meaning: the release gate, the webhook a pipeline calls to ask the sandbox for a
verdict ([@intentic/gate](../../_sandbox/gate/README.md)). Everything else is a check, an approval, a guard or
a wall, and all four words are already in the tree.

| today | becomes |
| --- | --- |
| checkout gates | checkout **checks** (`_tools/checks/` already says so) |
| turn gate, `createTurnGate` | **turn check** |
| push gate, `prepush` | **push checks** |
| billing gate | **billing check** |
| `CredentialGate` | **CredentialApproval** |
| `command-gate.ts` | **command-guard.ts**, already under [guard/](../../_sandbox/sandbox/src/guard/command-gate.ts) |
| `signinGate` | **signInWall** |
| a "gated" e2e suite | a **credentialed** suite |

### area

The access meaning wins. It shipped last week, it is defined on screen ("An area is a named part of this
workspace"), and it is the one a user manages.

The shell's top-level destinations behind the icon rail become **sections**. `AreaTile` to `SectionTile`,
`areaReachable` to `sectionReachable`, `lastAreaPath` to `lastSectionPath`, and the copy in
[ShellDesktop.vue](../../_editor/web/src/shell/ShellDesktop.vue) follows: "Every section is on the rail",
"More sections", "Next section".

### desk

Five meanings, and the repository already owns better words for four of them.

| today | becomes | why |
| --- | --- | --- |
| the site variant and the app profile | **maker** | the profile already seeds `audience=maker`, and [maker-audience-design.md](maker-audience-design.md) is already written in that word |
| the access grant that only talks to assistants | **guest** | "A desk is not granted until it holds one" describes nothing a reader can picture. `guest` over "chat-only" because the ladder's other five rungs are single words, and a role called `chat` would collide with the surface of that name |
| "Show desk" | **Show home** | it opens the home screen |
| "Front Desk", the visitor widget | **Visitor chat** | owner's call: this one is a public product name, not internal vocabulary |
| `desktop`, `desktopSync` | unchanged | a different word for a different thing |

`desk-edition.md` becomes [maker-edition.md](maker-edition.md) and `desk-members.md` becomes
[guest-members.md](guest-members.md), since each document's whole subject is one of the words.

### lane, tier, slot

| today | becomes |
| --- | --- |
| "Free lane" | **free plan** |
| a column on the agents board | **column** |
| `LocalModelLane` on Connect | **LocalModelOption** |
| `HOSTED_TIERS` | **HOSTED_PLANS** |
| a model pinned to "a tier of its own" | "a **model** of its own" |
| the topology's "two tiers" | name them: the sandbox and the platform |
| `e2eTier` | unchanged, `tier` is reserved for test levels |
| a billing slot | **included sandbox**, `slots` in [hosted-plan.ts](../../_platform/api/src/sandbox/hosted/hosted-plan.ts) to `includedSandboxes` |
| `portLabel(slot)`, `publicLabel(slot)` | `portLabel(name)`, [hostnames.ts](../../_shared/sandbox-contract/src/ids/hostnames.ts) already documents the shape as `<label>-<sandboxId>` |
| a concurrency slot | unchanged, that is the ordinary programming word |

### the rest of class A

| word | reserved for | the other meanings become |
| --- | --- | --- |
| loop | the workflows feature | a device's agent **process**, not "its loop" |
| host | `extension-host` and `docker host` | the `host` capability kind and [host.contract.ts](../../_shared/sandbox-contract/src/contracts/host.contract.ts) become **device**, which the screens and the `devices` extension already say |
| probe | dialling a service to see if it answers | `/chores/probe` becomes `/maintenance/measure` |
| registry | the extension registry package | the capability handler map becomes **handlers** ([registry.ts](../../_sandbox/sandbox/src/capabilities/registry.ts)), the agents registry becomes **fleet** |
| ledger | money | the shell ledger becomes a **command log**, the workflow ledger **run history**, the chore ledger **answers** |
| plane | control plane, data plane | "app plane" becomes **the editor**, "hosted/account/platform plane" becomes **the platform** |
| powers | nothing | an extension asks for **permissions**, a persona is given **limits** |
| kit | the design kit | `PersonaKitFields` becomes **PersonaInstructionsFields** |
| runner | a paired device that runs agents | unchanged, including "test runner" |

## The opaque words

One idea each, under a word that has to be looked up.

| today | becomes | note |
| --- | --- | --- |
| chore | **maintenance** | its schema file is already [maintenance.ts](../../_shared/sandbox-contract/src/schemas/maintenance.ts), and `chore:` is a commit type in the same repo |
| fence, fenced | **scope, scoped** | beside an [area-scope.ts](../../_sandbox/sandbox/src/areas/area-scope.ts) that already says it |
| seat, seated, ghost seat | **pinned tile, placeholder tile** | [railMemory.ts](../../_editor/web/src/shell/rail/railMemory.ts); "Keep on the rail" is already the copy |
| anchor | **snapshot** | [steer-anchors.ts](../../_sandbox/sandbox/src/agent/anchors/steer-anchors.ts) to `steer-snapshots.ts` |
| netdisk | **disk** | the UI says "Your disks" already; `/mnt/netdisk` becomes `/mnt/disks/<name>` |
| inventory | **machines** | "Couldn't read your inventory" becomes "Couldn't read your machines" |
| ceiling, pool | **limit, allowance** | four words for one idea; `allowance` is what you get, `limit` is where it stops |
| briefing | **context notes** | the chat already labels them "Sent with your message" |
| episode | **entry** | [episodes.ts](../../_extensions/activity/src/episodes.ts) |
| capsule | **summary** | the header block of an `iq` answer ([app.ts](../../_search/iq/src/app.ts)) |
| geo exit | **egress** | frees `exit` for `process.exit`, which owns it anyway |
| angkor | **plate** | the script already calls the source "the master plate" ([angkor-plate.mjs](../../_site/site/scripts/angkor-plate.mjs)) |

## What is deliberately not renamed

`verdict`, `turn`, `persona`, `sandbox`, `project`, `machine`, `capability`, `rail`, `worktree`, `transcript`
and `land`. The audit's Class C says why for each. `land` in particular is jargon that is already answered:
[vocabulary.ts](../../_editor/web/src/core-views/vocabulary.ts) gives the maker audience "Accept", along with
draft, project and "Save a version", and the fix for a word a reader does not know is that table, not a global
rename.

Two of the renames above are more than cosmetic and want a second opinion before the work starts: retiring
"Front Desk" touches a public product name, and turning the `host` capability into `device` moves a wire group.

## Order of work

Each stage lands on its own and leaves the tree consistent. Stage 1 costs almost nothing and removes a
contradiction that is live today, so it goes first regardless of what else is picked up.

**Stage 1. Finish the last rename. DONE.** The persona screens said "card" in copy, comments and five catalogs;
`personaCard.ts` became `personaRules.ts` and `reachableCards` became `reachablePersonas`. No wire change.

**Stage 2. The collisions a user can see. MOSTLY DONE.** `area` to `section` in the shell, `desk` to guest,
maker, home and visitor chat, and the `card` split across the wire types, the capability catalog and the
user-facing copy. What is left of this stage is `lane`: the billing sense is done ("free plan"), the agents
board's columns and the rail's lanes are not, and they are 328 files of internal UI vocabulary.

**Stage 3. The collisions a contributor sees.** `gate`, `tier`, `loop`, `slot`, `probe`, `registry`, `ledger`,
`powers`, `kit`, and `host` to `device`. The last one moves a wire group and needs a `Breaking-Note:` trailer,
which [contract-shrink.mjs](../../_tools/checks/contract-shrink.mjs) will demand at the push anyway.

**Stage 4. The opaque words.** `chore` to `maintenance` and `netdisk` to `disk` both move routes and want a
breaking note; the mount path and the capability kind change with them, and per AGENTS.md there is no migration
for stored state. The rest are internal and cheap.

**Stage 5. The guard. DONE**, and carrying the nine words stages 1 and 2 retired. Stages 3 and 4 each add their
own entries to `RETIRED` as they land, which is what keeps the list honest: a word is only retired once nothing
spells it.

## What already broke on the wire

Stages 1 and 2 moved four things a client could be written against, so the commit that carries them needs a
`Breaking-Note:` trailer naming each ([contract-shrink.mjs](../../_tools/checks/contract-shrink.mjs) refuses
the push otherwise). Per AGENTS.md there is no migration for stored state: a sandbox's existing grants and
manifests are re-read against the new spellings, not converted.

| what moved | from | to |
| --- | --- | --- |
| the member-role ladder's lowest rung | `"desk"` | `"guest"` |
| the capability an agent asks to connect | `CapabilityOffer.card` | `CapabilityOffer.entry` |
| the capability the daemon suggests | `CapabilityRecommendation.card` | `CapabilityRecommendation.entry` |
| the suggestion a user dismisses | `CapabilityCardParamSchema.card` | `CapabilityEntryParamSchema.entry` |
| where an extension was installed from | `ExtensionUpdate.card` | `ExtensionUpdate.entry` |

The persona-request field names on the transcript (`plan`, `question`, `permission`, the three offers) did NOT
move: only the TypeScript names around them did, so the JSON a client reads is unchanged.

## The guard

One list, one check, read by everything that needs to know.

[`_tools/constants/src/vocabulary.mjs`](../../_tools/constants/src/vocabulary.mjs) holds `RETIRED`: each entry
is a word's retired SPELLINGS, what it became, and the date. Spellings rather than the English word, because
`slice` stays legal for `Array.prototype.slice` while `SliceSchema` does not.
[`_tools/checks/vocabulary.mjs`](../../_tools/checks/vocabulary.mjs) reads it against every tracked text file
and names the line, the word and its replacement.

Three things make it usable rather than merely correct:

- **Exemptions by reason, not by path list.** `docs/audits/` is exempt for the same reason
  [layout.mjs](../../_tools/checks/layout.mjs) exempts it: an audit describes the tree it ran against, so a
  retired word inside one is the record working. This page is exempt because a decision cannot say what a word
  became without spelling it, and the table and the check are exempt because they hold the patterns.
- **Ratcheted.** `_tools/checks/baselines/vocabulary.json` is empty, which is the strongest state the ratchet
  has: every entry may shrink or disappear, never grow, and a file not in it fails on its first offence.
- **Runs at the edit moment.** It judges one file honestly, so it carries `scoped: true` in the manifest and
  runs under `.intentic/checks.json`'s `edit` moment, where a bad word costs one edit instead of a review round.

It earned its place the hour it was written: run against a tree three renames deep, it found `areaReachable`
and `AreaTile` still spelled that way in nine files, plus six stale mentions in four documents, all of which
the passes before it had reported as finished.

## Doing the work

Rename TypeScript symbols with the `lsp` CLI rather than `sed`: it follows imports across packages, which a
regex over 94 packages does not. Three lessons from the first four words, each of which cost a red build:

- **A word-boundary replacement misses `areaReachable` and `AreaTile`.** The boundary is on the wrong side of a
  camelCase name. Sweep for the identifiers, then re-read with the guard, which is what the guard is for.
- **A blanket replacement inside one file collides with itself.** `const card = ...` beside a helper named
  `card()` became `const persona = await persona(...)` four times. Read the diff of any file where the word was
  both a local and a function.
- **A rename that moves a wire type needs the lock regenerated** (`pnpm --filter @intentic/sandbox-contract
  lock`) and the declarations re-emitted (`node _tools/scripts/build/emit-declarations.mjs`) before a type
  error means anything. Half the errors in this refactor were a stale `dist`, not a broken tree.

For i18n, move the key in all five catalogs at once, preserving key order, and let
[i18n-keys.mjs](../../_tools/checks/i18n-keys.mjs) find the call sites that did not follow.
`node _tools/checks/i18n-catalogs.mjs --fix` re-sorts afterwards.

## What the translated catalogs still carry

`de`, `es`, `fr` and `pl` are translated, not seeded, and their words were translated from the old English: the
German for a persona is still `Karte`, the Polish still `kartę`. Every key moved with the English in these
passes, so the catalogs stay in parity and nothing renders as a dotted path, but the four translations say the
retired word until a translator passes over them. That is a translation job, not a rename, and it is the one
piece of this work a sweep cannot do.
