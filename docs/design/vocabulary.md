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

| today | becomes | state |
| --- | --- | --- |
| `command-gate.ts`, `GateSubject`, `GateOutcome` | **command-guard.ts**, `GuardSubject`, `GuardOutcome`, already under [guard/](../../_sandbox/sandbox/src/guard/command-guard.ts) | done |
| `outbound-gate.ts`, `outboundGateHooks` | **outbound-guard.ts**, `outboundGuardHooks` | done |
| `SigninGate.vue`, `signinGate.*` keys | **SignInWall.vue**, `signInWall.*` | done |
| the release, push, checkout, turn and billing gates, and a "gated" suite | **`gate`** | kept, see below |
| `CredentialGate` | **`gate`** | kept: a credential held for a named approver is a check that refuses until someone says yes |

**Three renames, not eight, and the reason is the definition.** `gate` now means exactly one thing: *a check
that can refuse an action.* Substitute that into each remaining use and it reads true — the release gate
refuses a deploy, the push gate a push, the checkout gates a land, the turn gate a turn's end, the billing gate
a spend, a credential gate the use of a secret.

The three that were renamed are the three where the substitution read FALSE. `CommandGate` did not refuse a
command, it filtered one, which is a **guard**. `signinGate` did not refuse an action, it stood in front of a
screen, which is a **wall**. `outboundGateHooks` filtered traffic, so: guard. Those three were the collision;
the other five were one idea wearing one word, which is what good vocabulary looks like.

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

Same story as `gate`: one sense was wrong, the rest were one idea.

A **lane** is one of a few parallel tracks something is sorted into or travels down — a column on the agents
board (`FleetLane`), a column on Connect (`ConnectLaneKey`), a route a probe takes (`ProbeLane`). All true, all
kept. The exception was billing, where "Free lane" meant a subscription level and nothing was travelling down
anything: **that became "free plan"**, done, across 20 files.

`tier` (a rung on a graded ladder) and `slot` (one of a fixed number of places) survive the same substitution
everywhere, so both are kept. See the audit's
[correction](../audits/vocabulary-audit.md#correction-seven-of-these-are-not-collisions).

### reload

Not a collision between two of this repo's ideas — a collision with a key on the reader's keyboard.

**Reload means F5.** Anyone reading a screen has a browser open, and every browser they have ever used spends
that word on refreshing the page. So a button saying "Reload sandbox" beside one saying "Reload page" asks them
to tell two identical words apart by their noun, in the one moment they are already confused about why the
screen is misbehaving. Worse, the cheap reading is the wrong one: pressing F5 at a sandbox running stale code
changes nothing, and the reader concludes the product is broken rather than that they pressed the wrong thing.

**The sandbox restarts. The page reloads.** One word each, and they are never swapped. The dev inner loop is
`dev-restart.sh` and the device command is `dev-restart`; the button is **Restart sandbox**, the hint under it
says what it rebuilds and how long it takes, and the only thing on that card still called a reload is the page,
which genuinely is one.

Kept, because none of them is a sandbox restarting: `location.reload()` and every "reload the page";
**hot reload** and Vite's HMR; `systemctl daemon-reload`, `ipsec reload` and an nginx reload, which are those
tools' own command names; and the extension host's **Reload extensions**, which re-runs one process inside the
sandbox rather than restarting the sandbox — a different subsystem with its own settled vocabulary.

### the rest of class A

| word | verdict |
| --- | --- |
| loop | **split, done.** The workflows feature and ordinary control flow keep the word; a paired device's resident loop became **the agent** (or **the process** where the sentence is about the OS): "the background agent", `agentProcessState`, `Agent stopped —` |
| host | **split, done.** The capability kind is now `device`, the contract is [device.contract.ts](../../_shared/sandbox-contract/src/contracts/device.contract.ts), and the types are `DeviceFacts`/`DeviceScopes`/`DeviceConfig` — which is what the screens and the `devices` extension already said. `extension-host`, `docker host`, `dind-host` and the `host` ADDRESS field (ssh, imap, a database) all keep the word, because there it means a machine serving something, not the user's own computer. Docker's **`HostConfig`** inspect key is the sharp edge of that carve-out and collides with this repo's own `DeviceConfig`: renaming it produces a key docker never emits, so every cap reads as absent and fixtures renamed alongside keep passing. Read `docker inspect` under docker's names |
| probe, registry, ledger, powers, kit, tier, slot | **kept.** Each is one idea across several subjects, not several ideas under one word. See the audit's [correction](../audits/vocabulary-audit.md#correction-seven-of-these-are-not-collisions) |
| plane | **kept.** `control plane` and `data plane` are industry terms; "app plane" is this repo's own and reads fine beside them |
| runner | **kept**, including "test runner" |

## The opaque words

The audit listed thirteen. Working through them one at a time, most did not survive contact, and the reason is
the same every time: **a word is only worth replacing if the replacement is free.** Counting occurrences finds
candidates; reading what the word names, and then checking whether the plain alternative is already spoken for,
decides them. Three renames were right. Six were wrong, and this records why so nobody re-attempts them.

### Renamed

| was | is | why it was free |
| --- | --- | --- |
| angkor | **plate** | a code name for the site's background art; the script already called its source "the master plate" ([plate-art.mjs](../../_site/site/scripts/plate-art.mjs)) |
| seat (the rail sense) | **tile** | the same object was called both: `SectionTile extends RailSeat`. Two words for one thing, and `tile` is what the UI and the rest of the code say. The ACCOUNT-seat sense (`claudeSeats`, a paid licence) is untouched: that one is standard and means something else |
| inventory (two strings only) | **your machines** | the word stays in code, where it consistently means "the list of things of a kind you have" across skills, secrets and providers. Only the two sentences a non-technical reader meets were vague |

### Kept, and why

| word | why it stays |
| --- | --- |
| chore | ordinary countable English, one idea here. `maintenance` is a mass noun: "a chore" has no singular form in it, so the prose gets worse. Its only clash is with the `chore:` commit type, which is an external convention in a different syntactic position |
| netdisk | `disk` is already taken 1,178 times for the LOCAL disk (`onDisk`, `freeDiskMb`, `staleOnDisk`). The `net` prefix is doing real work: it is the word that tells the two apart |
| fence | one idea, 593 uses, and every plain alternative is already in service for something else here: `scope` (catalog filter, fleet visibility, host scopes), `reach` (`persona-reach.ts`), `bounds` (`personaBounds`) |
| capsule | the header block of an `iq`/`webq`/`fileq` answer. `summary` already appears in those very packages; `header` would collide with HTTP headers in a tool that fetches pages. Taught in one place (the `iq` skill), which is the Class C bargain |
| episode | one turn, message or event, assembled from several raw log lines. Not `event` (that is what it collapses FROM), not `entry` (catalog entries), not `row` (`EpisodeRow` draws one). Defined at the top of its own file |
| briefing, powers, kit | each names one idea in plain English, and each reuses one word across subjects the way `verdict` does: an extension's powers and a persona's powers are the same idea asked of different things |

`ceiling`/`pool`/`allowance`/`limit` remain four words around one meter. That one is a copy problem for whoever
writes the billing screens, not a rename.

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

**Stage 3. The collisions a contributor sees. DONE.** Three of the ten were collisions and were split: `gate`
(the command and outbound guards, the sign-in wall), `loop` (a paired device's resident loop is the agent), and
`host` to `device` (a wire group, carried with its `Breaking-Note:`). The other seven — `tier`, `slot`, `probe`,
`registry`, `ledger`, `powers`, `kit` — are one idea each and stay, per the
[audit's correction](../audits/vocabulary-audit.md#correction-seven-of-these-are-not-collisions) and the
table under "The splits".

**Stage 4. The opaque words. DONE**, and not as first written: `chore` and `netdisk` stay, because their plain
replacements were already spoken for (see "The opaque words" above). What moved is `angkor` to `plate`, the rail
`seat` to `tile`, and two user-facing "inventory" sentences to "your machines". No route moved, so no breaking
note.

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
`node _tools/checks/i18n-catalogs.mjs` refuses a translation left behind under the old key.

## What the translated catalogs carry

`de`, `es`, `fr` and `pl` are translated, not seeded, so a rename in the English leaves the old word in four
other languages until someone reads them. That pass ran on 2026-09-22 (a translation job, not a rename, and the
one piece of this work a sweep cannot do): a persona is `Persona`/`persona` in all four, not `Karte`/`tarjeta`/
`carte`; a held decision is a request (`Anfrage`, `solicitud`, `demande`, `prośba`), a transcript tool call a
block, a settings panel its own name; `Recepción`/`Recepcja` became visitor chat; the billing `lane` that the
English had already made "free plan" is now `kostenloser Tarif`, `offre gratuite`, `darmowy plan`; and Polish
"Show home" stopped saying `biurko`.

Four words look retired and are not, so a future scan should skip them: Polish `karta` for a browser, editor or
terminal *tab*; French `carte du projet` for the project *map*; `hosted`/`hostowany` for the hosted plan; and
`hostname` in every language.
