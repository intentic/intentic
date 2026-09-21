# Vocabulary audit, 2026-09-21

Every domain word this repository uses, measured against two tests: does a reader have to be taught it, and
does it name more than one idea. 34 words were counted. 16 name several ideas at once, 13 name one idea under a
word nobody guesses, and 5 look like jargon while earning their keep.

This audit is the measurement. The decisions that follow from it, and the order the renames happen in, are in
[docs/design/vocabulary.md](../design/vocabulary.md).

## How this was counted

Case-insensitive word-boundary matches (`\bword s?\b`) over the tracked tree, excluding `node_modules`,
`dist`, `pnpm-lock.yaml`, the four seeded translations and `refs/`. Hits are split four ways: code
(`.ts .vue .mjs .js .astro .sql .css`), documentation (`.md`), English message catalogs (`locales/en.json`) and
everything else (JSON fixtures, contract locks, manifests).

Two things the numbers do NOT include, so every figure below is a floor rather than a total:

- **Compound identifiers.** `\bcard\b` does not match `AgentCard`, `cardId` or `desktopSyncCard`. A word
  buried inside a camelCase name is invisible to the count and still has to be renamed.
- **The other four languages.** A renamed i18n key moves in five catalogs, not one, because `de`, `es`, `fr`
  and `pl` are seeded from English and hold the same key set.

The i18n columns are counted separately and camel-aware, since the key namespace mirrors component names: a
renamed component renames its whole key block.

## What qualifies

A word is a finding when it fails one of two tests.

**The teaching test.** A person who has used the product for a week, or an agent reading the tree for the first
time, cannot infer what the word points at. `chore`, `netdisk` and `seat` fail it.

**The one-idea test.** The word names two or more things that are not the same thing. `card`, `gate` and `desk`
fail it, and failing this one is worse: a reader who learns the word still guesses wrong, and search returns
the other meaning.

A word both audiences already share is not a finding. `commit`, `branch` and `merge` are git's, `sandbox` and
`workspace` are this product's, and the maker column in
[vocabulary.ts](../../_editor/web/src/core-views/vocabulary.ts) already answers for readers who do not know
git's.

## Class A: one word, several ideas

Ranked by what the confusion costs, which is roughly how many of the meanings a user can see.

| word | code | docs | i18n keys | distinct ideas |
| --- | --- | --- | --- | --- |
| card | 6,569 | 1,163 | 272 | 7 |
| gate | 2,545 | 589 | 50 | 8 |
| area | 1,047 | 144 | 30 | 2 |
| desk | 1,083 | 152 | 49 | 5 |
| lane | 1,597 | 263 | 28 | 3 |
| tier | 1,370 | 393 | 0 | 4 |
| loop | 1,558 | 231 | 40 | 3 |
| host | see note | 269 | 4 | 4 |
| slot | 1,200 | 128 | 4 | 3 |
| probe | 1,283 | 130 | 0 | 3 |
| registry | 2,593 | 308 | 22 | 4 |
| ledger | 912 | 121 | 2 | 4 |
| runner | 1,487 | 507 | 6 | 3 |
| plane | 123 | 75 | 0 | 2 |
| powers | 212 | 16 | 30 | 2 |
| kit | 218 | 86 | 15 | 2 |

**card**, the worst of them, means all of these at once:

1. a capability catalog entry, the data that varies between two capabilities one handler serves
   ([capabilities.md](../architecture/capabilities.md), [capability-catalog](../../_shared/capability-catalog/src/index.ts));
2. a decision held for the owner to answer (`raiseCard`, `GateCard`, "held on a card");
3. a question the agent asks in chat (`chatQuestionCard`, "this app's own guidance about its question cards");
4. one tool call's block in the transcript ([ChatToolCard.vue](../../_editor/web/src/features/chat/tools/ChatToolCard.vue),
   "Shortened for this card");
5. a settings panel ("Open the Sandbox page's Environment card", `desktopSyncCard`, `sandboxUpdateCard`);
6. a tile on the agents board ([AgentCard.vue](../../_editor/web/src/features/agents/board/cards/AgentCard.vue));
7. a payment card ("A sign-in, no card, no subscription").

An eighth meaning is stale rather than live. `93a0b1034` renamed the persona concept away from "card", but the
prose did not follow: [PersonaPowersFields.vue](../../_editor/web/src/features/sandbox/personas/PersonaPowersFields.vue)
still says "every other limit on this card", and `personaForm.treeSessionWearingCard` still ships the sentence
"a session wearing this card" to five catalogs.

**gate** means a release gate (the CI webhook, [@intentic/gate](../../_sandbox/gate/README.md)), the push gate,
the checkout gates, the turn gate, an approval gate, a credential gate (`CredentialGate`), a command guard
([command-gate.ts](../../_sandbox/sandbox/src/guard/command-gate.ts)) and a sign-in wall (`signinGate`). Three
of those are checks, one is a webhook, two are approvals, one is a guard and one is a wall. `FortiGate`, a
vendor's product name, is in the count too and belongs to none of them.

**area** is the newest collision and both halves are on screen today. The wire and the access screen use it for
a named group of workspace folders ("An area is a named part of this workspace",
[SandboxAccess.vue](../../_editor/web/src/features/sandbox/access/SandboxAccess.vue)). The shell uses it for a
top-level destination behind the icon rail ("Every area is on the rail", "Next Rail Area", `AreaTile` in
[ShellDesktop.vue](../../_editor/web/src/shell/ShellDesktop.vue)). One user, one window, two areas.

**desk** is a site design variant, an app profile, an access grant that can only talk to assistants ("A desk is
not granted until it holds one"), a layout action ("Show desk") and the embeddable visitor widget
("Front Desk"). `desktop` sits one character away from all five.

**host** is not counted as a bare word because `\bhost\b` catches hostnames and HTTP hosts. Counted as
compounds: `dind-host` 76, `extension-host` 58, `docker host` 20, `host machine` 12. A fifth meaning is the
`host` capability kind, which is the user's own computer, and which
[host.contract.ts](../../_shared/sandbox-contract/src/contracts/host.contract.ts) itself documents as "what a
connected device can be asked". The screen calls that a device. The wire calls it a host.

The rest, briefly: **lane** is a billing plan ("Free lane"), a column on the agents board and a choice on the
Connect screen. **tier** is a hosted plan (`HOSTED_TIERS`), a test level (`e2eTier`), a model pin ("a tier of
its own") and a half of the topology. **loop** is the workflows feature, the process a paired device keeps
open, and the dev edit loop. **slot** is a billing unit, a hostname label
([hostnames.ts](../../_shared/sandbox-contract/src/ids/hostnames.ts)) and an ordinary concurrency slot.
**probe** dials a service, re-measures a chore and health-checks a container. **registry** is the capability
handler map ([registry.ts](../../_sandbox/sandbox/src/capabilities/registry.ts)), the agents registry, the
extension registry package and the workspace's own `registry/` directory. **ledger** counts shell commands,
money, workflow runs and chore answers. **powers** is what an extension asks for and what a persona is denied.
**kit** is a persona's instructions and the design kit.

## Class B: one idea, under a word nobody guesses

These pass the one-idea test and fail the teaching test. Cheaper to fix, and each one is a word an agent has to
look up before it can act.

| word | code | what it actually means |
| --- | --- | --- |
| chore | 610 | maintenance a repo is asking for, with evidence ([verdict.ts](../../_shared/sandbox-contract/src/chores/verdict.ts)) |
| fence | 610 | restricting a session to an area, beside an `area-scope.ts` that already says scope |
| seat | 260 | a position on the icon rail ([railMemory.ts](../../_editor/web/src/shell/rail/railMemory.ts)) |
| anchor | 1,261 | the before-state snapshot of a steered message ([steer-anchors.ts](../../_sandbox/sandbox/src/agent/anchors/steer-anchors.ts)) |
| netdisk | 143 | a network share, which the UI already calls "disk" |
| inventory | 197 | the machines you have declared |
| allowance | 511 | how much model usage is left, alongside pool, ceiling and limit for the same idea |
| briefing | 45 | the notes prepended to each message, which the chat calls "Sent with your message" |
| episode | 158 | one turn, message or event in the activity feed ([episodes.ts](../../_extensions/activity/src/episodes.ts)) |
| capsule | 44 | the header block of an `iq` answer ([app.ts](../../_search/iq/src/app.ts)) |
| geo exit | 37 | where VPN traffic leaves, under a word `process.exit` already owns |
| angkor | 13 | the site's background plate art, named after a temple ([angkor-plate.mjs](../../_site/site/scripts/angkor-plate.mjs)) |
| prepush | 55 | the checks that run before a push |

`chore` has a second problem on top of the first: `chore:` is also a conventional-commit type, enforced by
[commitlint.config.ts](../../commitlint.config.ts), so the word means "maintenance the daemon measured" and
"a commit that changed no behaviour" in the same repository. Its own schema file is already called
[maintenance.ts](../../_shared/sandbox-contract/src/schemas/maintenance.ts), which is the better word arriving
on its own.

## Class C: words that look like jargon and are not

Worth recording so a later sweep does not spend a rename on them.

- **verdict** (1,764 code hits, 12 compounds: `GateVerdict`, `SafetyVerdict`, `ChoreVerdict`, `EdgeVerdict`,
  `StopVerdict`, `GuardVerdict` and more). One word, one idea, many subjects: what a check decided. This is
  what good reuse looks like, and it is the shape every Class A word fails to have.
- **turn**, **persona**, **sandbox**, **project**. [metaphor-home.mjs](../../_tools/checks/metaphor-home.mjs)
  already names machine, sandbox, persona and project as the four product nouns and holds one picture
  responsible for defining them. They are taught on purpose, in one place, and the check keeps it that way.
- **rail**. Settings exposes it as "Icon rail" and a reader sees the thing while reading the word. The
  metaphors piled on top of it (seat, ghost seat) are the finding, not the rail.
- **land**. Jargon for half the audience and already answered for the other half: the maker column of
  [vocabulary.ts](../../_editor/web/src/core-views/vocabulary.ts) maps it to "Accept", along with branch,
  repo, commit and diff.
- **capability**. Deliberately one noun over fourteen kinds, with the reasoning written down in
  [capabilities.md](../architecture/capabilities.md). The alternative was a taxonomy of overlapping
  categories.

## What the slices rename already showed

`b04679c20` replaced slices with areas. Searching for the old word today returns 1,028 hits and not one of them
is the old concept: every match is `Array.prototype.slice`. The domain word was unfindable from the day it was
chosen, because it collided with a language builtin, and the rename could only be verified by reading rather
than by grep.

Two rules come out of that, and both are in the design document:

1. A domain word must not collide with a language or library primitive. `slice`, `map`, `key`, `state` and
   `exit` are all spoken for.
2. A retired word needs a guard. [layout.mjs](../../_tools/checks/layout.mjs) already refuses dead
   directory names, with `_apps/` and `_libs/` still being typed 89 times a month after removal as the
   measurement behind it. Nothing does the same for a retired noun, which is why "card" survived its own
   rename inside the persona screens.
