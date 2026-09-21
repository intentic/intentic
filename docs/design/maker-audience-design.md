# The maker audience: the design

How a person who does not write code uses Intentic without meeting git. The workspace keeps every mechanism it
has (a branch and worktree per conversation, land as the review boundary, restore points, commits, push) and
gains one preference, `audience`, that decides which of those mechanisms the screen names, which it hides
behind a default, and what the home view is. This records the reasoning and the plan, and section 11 records what
changed when it was built.

How a maker *arrives* on these screens without being asked, from intentic.dev/maker through the installer and the
desktop app's sign-in, is [maker-edition.md](maker-edition.md).

## 1. The gap

The product is sold to developers (`docs/marketing/positioning.md`, "Who it's for"), and every user story in
`docs/user-stories/` is written from a developer's chair. The next person to arrive is someone who wants an
assistant that writes their newsletter, keeps their notes, builds the one page site for their shop, and
answers their mail. They have the same need for a persistent agent on a machine of their own. They have no
idea what a repository is, and the app tells them about repositories on every screen.

What that person meets today, by surface:

| Surface | What it says | Where |
| --- | --- | --- |
| Rail | Chat, Agents, Workspace, Preview always on the rail | `_editor/web/src/core-views/registry.ts` `RAIL_GROUPS` |
| Workspace | a file tree of every repo, dotfiles, lockfiles, `.intentic/`, config, tests | `features/workspace/explorer/WorkspaceTree.vue` |
| Workspace sidebar | Files / Changes, the second being VSCode's SCM: repos, staged and unstaged sides, Stage, Unstage, Commit with a message box, Discard, Publish, Sync, Push, ahead and behind counts, Fetch every repo | `features/workspace/changes/ReviewPanel.vue`, `push/outgoingWork.ts` |
| Row actions | personas, checks, and the cog onto a repository's management panel (git history, docs, codebase health, apps, dependencies as its tabs) | `features/workspace/explorer/rowActions.ts`, `directory-ui/directoryTabs.ts` |
| Empty workspace | "Clone a repository. Paste a Git address" | `features/workspace/explorer/WorkspaceEmptyState.vue` |
| Agents board | a card names its branch `agent/…`, its runner and model, and offers Land now, Land again, Request land, Discard | `features/agents/board/cards/AgentCard.vue` |
| Agent review | a file list with diffs, mark as reviewed, a conflict report naming paths that refused | `features/agents/review/` |
| Terminal | a shell | the shell's own panel |

Two things make this a wall rather than a learning curve. The **centre of gravity is the file tree**: the
always on the rail Workspace tile opens on files, and everything the maker wants (what did the assistant do, is it
live, can I undo it) is a click away from a screen that shows `pnpm-lock.yaml`. And the **review boundary is
git's index**: an assistant's work is held on a branch until someone reads a diff and presses Land, then stays
uncommitted until someone writes a commit message. Both steps are the point for a developer. For a
maker both are chores with unfamiliar names, and the second one is a trap (section 5).

The good news is that most of what a maker needs already exists under a developer's name:

- **Restore points** (`features/workspace/changes/history/HistoryPanel.vue`, daemon `history/history.ts`) are a
  Drive style version history over `/work`, deliberately not git, labelled "Agent turn", "Your changes",
  "Files restored", with a Restore that rewrites the tree after saving a safety checkpoint.
- **Auto-land** is a rule at the `agent.finished` moment (`sandbox-contract/src/schemas/settings.ts`
  `RuleMomentSchema`), per agent (`/agents/{id}/auto-land`) and as a sandbox posture.
- **The daemon drafts a commit subject from the landed code** (`agents/land/landed-subject.ts`), and the
  Changes panel fills its box from it (`changes/commitMessage.ts`).
- **Roles** already split "may drive" from "may land": a collaborator sees Request land instead of Land now
  (`auth/role-floor.ts`, `AgentCard.vue`).
- **Preview** is an always on the rail tile, **`public/`** is a shareable outbox with a share view
  (`_extensions/preview`), **viewers** render docx, xlsx, pdf and media (`_extensions/viewers`), and the
  design kit has an editable `MarkdownDocument` with autosave.
- **`AGENTS.md` already has a settings page** (`/sandbox/agent?section=instructions`), so "tell the assistant how
  I like things" needs no file tree at all.
- **The tree already filters**: ignored entries and tests are one predicate shared by both trees
  (`explorer/explorerFilter.ts`), and special roles are one table (`explorer/specialPaths.ts`).

So the job is less "build a simple mode" than "give the maker a different home and different defaults over the
same machinery, and stop saying git words to them".

## 2. What the maker already thinks in

The maker's models come from Google Drive and Docs, Notion, Canva and a chat assistant. From those they bring
six words, and each maps onto one mechanism that stays exactly as it is:

| The maker says | The developer says | What runs underneath |
| --- | --- | --- |
| project | repository | a git repo under `/work`. The root counts as one (`repo === "root"` in changes) |
| the assistant's draft | branch, worktree, `agent/<id>` | `agents/worktrees/worktrees.ts` |
| accept / throw away | land / discard | `agents/land/land.ts` |
| version, go back | commit, restore point | commit, `history/history.ts` snapshot |
| what changed | diff | the same diff, rendered differently (section 6.3) |
| back up to GitHub | push, publish a branch | push |
| see it, share it | preview, `public/`, deploy | `_extensions/preview`, `_extensions/deployments` |
| instructions for the assistant | `AGENTS.md`, memory | the same file |

Two words never reach the maker at all: the index (stage, unstage) and the remote's bookkeeping (ahead, behind,
upstream, fetch). A maker's version is everything in the tree at that moment. That is also Docs' model, and it
is what makes the maker's Changes panel a different panel (section 6.9) rather than the same one renamed.

One word clashes. Today **Publish** means "push a branch that has no upstream" (`push/outgoingWork.ts`,
`unpublished`). To a maker, Publish means "put it where people can see it". The maker audience reserves Publish
for `public/` and deploys, and calls the git act "Back up". The developer audience keeps its words. Section 7
has the whole table.

## 3. Replace the extensions, or extend them?

Two clean answers were on the table, and neither survives contact with the code.

**A parallel set of extensions for makers** (a Projects view instead of Workspace, a Versions view instead of
Changes) would keep git underneath and keep the developer's screens untouched, which is the attraction. But the
Workspace is not an extension: it is 5,800 lines of core (`features/workspace/`) that own the tab strip, the
Monaco and markdown viewers, diff opening, uploads, presence, search and the `/workspace/<path>` route every
file link in a transcript points at (`lib/markdown/markdownFileLinks.ts`). An extension cannot reach any of
that (`_extensions/README.md`, the lint boundary), so a replacement would rebuild it, and a second copy of the
viewer stack is the thing that drifts. The rail's four permanent tiles are also a core table an extension
cannot unseat (`registry.ts`, `always`).

**A "simple mode" switch inside the existing screens** keeps one implementation, which is the attraction. But
it leaves the file tree as the home, which is the actual complaint, and it would be built as conditionals
through the workspace's components, against the way this codebase already handles variation (one table read
by every surface: `RAIL_GROUPS`, `specialPaths`, `explorerShows`).

The answer is the split the extension system already draws for features (`docs/architecture/extensions.md`,
"does anything else plug into it?"). **What every surface reads is core. What one audience looks at is an
extension.**

Core owns the shared mechanism, each a small table or default:

- the `audience` preference and its one reader, `useAudience` (section 4)
- the vocabulary table (section 7)
- the rail table per audience, with the rule that an `always` tile may name an extension's view id
- the tree's "technical files" filter, one predicate beside `explorerShows`
- the finishing defaults for makers (section 5), which are daemon rules rather than UI
- a read of the audience on the extension API, `api.audience()`, the way `api.theme.mode()` is read now

A first party UI extension, `_extensions/projects` (`@intentic/ext-projects`, id `intentic.projects`), owns the
maker's home: the Projects dashboard (section 6). It uses only what the public API already offers: `RepoFacts`
for detection, `GET /workspace/repos`, `GET /workspace/file` and `POST /workspace/repos/new` through
`permissions.sandbox`, and `api.href`/`api.navigate` to hand a project to the core workspace.

What this buys: a developer sees nothing change, because every maker thing is a tile, a word or a default. A
maker who turns the extension off falls back to the Workspace tile, because the rail resolves its `always`
tile to whichever of `projects` and `workspace` is registered. And the first extension to need the audience
proves the API read is enough, which is the dogfooding rule the first party packs exist for.

## 4. The audience preference

`audience: "maker" | "developer"`, a preference of the person looking, not of the box. Two people share a
sandbox today (owner and invitees), and a developer and their partner reading the same tree need different
screens over the same files.

**Storage.** With the appearance preferences (`features/settings/documentAppearance.ts`, beside `useSkin`):
`useAudience.ts` reads and writes `ui-audience` in browser storage, reactive, applied at module load. Per
browser is enough to start, exactly as theme and skin are, and it needs no daemon route. If a per account copy
is wanted later it is one platform setting, and the reader does not change.

**Setting it.** Two places.

- The empty workspace pane, where a newcomer first stands once setup has handed them over (`Setup.vue` ends by
  opening the chat, with no screen of its own to ask on), carries one card: "How will you work here?", "I write
  code" or "I don't write code" (`components/AudienceAsk.vue`). The second answer sets `maker` and, for a
  maintainer, writes the two rules of section 5 behind a checkbox that is on by default: "the assistant's
  changes apply on their own and every change is saved as a version. You can always go back." A reader between
  files (the pane over a workspace with code) is never asked here. Settings holds the question for them.
- Settings ▸ Appearance gets the same row, so either answer is one click from the other. The maker audience
  hides nothing permanently: every screen below has "All files", "Show details" or "Switch to the developer
  view" on it.

**What it changes**: the home tile, the words, the tree filter, which row actions and panels show, the
default view for a markdown file (rendered, with Edit opening the prose editor), whether the terminal panel is
offered, and the setup proposal. **What it does not change**: routes, the daemon's behaviour (those are the
sandbox's rules, set once at setup and visible in Sandbox ▸ Agent), roles, and anything an agent does.

**On the extension API**: `api.audience(): "maker" | "developer"` and `api.audience.onDidChange`, additive
(`extension-api/src/version.ts`, minor bump, `surface.json` regenerated). A view that does not ask renders as
it does today.

## 5. Review before apply becomes apply then undo

This is the one decision that changes what the product promises, so it gets its own section.

The developer's contract is *nothing the agent writes reaches my tree until I have read it*
(`docs/user-stories/04-work/01-delegate-a-task-to-an-agent.md`). The maker's contract is Docs': *the assistant
edits my thing, and I can always go back*. Same worktree, same land, two defaults:

1. **Auto-land on**, sandbox wide, for a maker's setup. A clean turn lands as it finishes. A `ready` card
   appears only when the maker turns the switch off, and then it reads "3 files changed. Accept, Look, or
   Throw away" (section 6.5).
2. **Auto-version on.** The codebase forces this one. Worktrees are cut from HEAD (`worktrees.ts`,
   `snapshot`: "the current full HEAD of every repository") and the pre turn sync rebases onto main's HEAD
   (`agents/land/sync.ts`). Landed work is applied as *uncommitted* changes. So for a person who does not
   commit, the second assistant starts from a tree without the first one's work, and so does every one after
   it. Today the developer's commit closes that gap. The maker needs it closed for them, at two moments:
   - after every land, commit the landed paths in the main tree with the subject the daemon already drafts
     (`landed-subject.ts`), through a new `agent.landed` rule moment with a `builtin` action `version-landed`.
   - before every isolated turn starts, commit whatever else is dirty in the main tree as "Your edits", so the
     maker's own hand edits in the browser editor reach the assistant. `commitWorktreeRemainder`
     (`git/remote/root-repo.ts`) is the helper that already does this for a worktree, and the main tree gets
     the same call at the sync step.

   Both are rows in the existing rule table (`RuleMomentSchema`, `RuleActionSchema`), which is where "a fourth
   is now a row here, not a release" was written for. The developer's table stays as it is.

**The safety net** is the one that exists: every turn and every user write already cuts a restore point,
and Restore already saves a `pre-restore` checkpoint first. The maker's undo is "go back to before this",
which is a press on the timeline (section 6.2). Commits give the same history a durable, pushable form for
the day a developer joins or the maker wants a backup on GitHub.

**The rejected alternative** was to run a maker's turns on the main tree (`isolated: false`, the mode
`liveWrites.ts` tracks), which removes the branch and the land from the story entirely. It was rejected
because it also removes the two things the maker benefits from without seeing: two assistants at once do not
write over each other, and a turn that goes wrong can be thrown away before it touches anything. Keeping one
mechanism for both audiences is also what keeps the product one product.

**Where the mechanism leaks** is the conflict. A land that refuses raises a card naming paths
(`agents/review/AgentConflictReport.vue`). In the maker audience that card says "The assistant's changes to
*pricing.md* no longer fit, because you edited it since. Ask the assistant to redo them?" and the button
starts a turn with the conflict report as its brief. The report is still there behind "Show details".

**Teams.** The audience is per person. Auto-land and auto-version are per sandbox. A developer who owns a
sandbox and invites a maker as a collaborator keeps their review boundary, and the maker's presses become
Request land, which the role floor already produces. The setup proposal is only offered to the owner.

## 6. The maker's surfaces

### 6.1 Projects: the home

One rail tile, `projects`, always on the rail in the maker audience in the tile Workspace holds now. It draws the
workspace's repositories as tiles: the name, the README's first paragraph, and whether the Preview area can show
it running. A press on a tile opens the Workspace rooted at that repository (6.2). The last tile is **New
project**: one press offers a free name (`new-project`, `new-project-2`), Enter makes the repository (a folder,
`git init` with its git dir on `/history` like a clone's, a README that names it, one commit so agents have a
main line to branch from) and opens it. A workspace with no repository shows only that tile.

The dashboard reads and makes repositories and does nothing else: no timeline of its own, since the Workspace
already keeps one (6.2), and no file list, since the rooted Workspace is the file list.

### 6.2 A project as its own tree, and the way back

`/workspace?dir=<repo>` roots the explorer at that repository: its files, its "N technical files hidden" line,
its creates and drops all inside it, with a chip in the toolbar that says which folder is open and is the way
back to the whole workspace (`explorer/WorkspaceDirChip.vue`, `health/workspaceScope.ts` `workspaceDir`). The
same query is what the phone's drill-down already reads, so one address opens the same folder on either shell.

What's new is the Workspace's own **Restore points** panel, which stays for a maker under the maker's words
(Versions, Go back to this): every turn and every user write already cuts one, and Restore already saves a
point of the present first. Nothing of it is duplicated on the dashboard.

### 6.3 What changed, without code

The diff is the most alienating artifact on the screen, and it is the one the maker most needs to read. Three
tiers, best available first:

1. **The sentence.** The daemon's drafted subject (`landed-subject.ts`) and the agent's own last message. This
   is what the row shows and what most makers stop at.
2. **A rendered prose diff** for markdown: the two texts rendered through the existing markdown pipeline and
   diffed at word level, drawn as Docs' suggestions (insertions underlined, deletions struck). This is a new
   viewer the extension registers (`contributes.viewers`) and opens through `api.workspace.openDiff` with a
   `DiffPayload`. Images already have `BinaryDiffView.vue`.
3. **See it.** For a site, the Preview after the change (`/preview?target=repo:<id>`, which the dashboard
   links for every project that runs), with the toolbar's Code reading one press away.

### 6.4 Files, filtered

`explorerShows` gains a third switch, *technical files*, on by default for makers and off for developers:
dotfiles and dot directories, lockfiles, `package.json` and its siblings, build and config files by extension,
`.intentic/`, and the test predicate it already has. One predicate, both trees, and a chip on the tree that says
"12 technical files hidden" so nothing is secret. The special path chips (`reference`, `public`, `memory`)
keep their tooltips and get maker wording from the vocabulary table.

### 6.5 The Agents board

The board stays: three lanes sorted by who needs you is the right shape for anyone. In the maker audience a
card drops its branch name, runner and model chips, and its verbs read from the table: Land now becomes
**Accept**, Discard becomes **Throw away**, the review drill in becomes **Look**. A `ready` card's first line
is the sentence from 6.3. The review panel (`AgentReviewPanel.vue`) opens the same file list with the prose diff
where one applies. "Mark as reviewed" stays, since a tick is not a developer concept.

### 6.6 See it and Share

Preview keeps its always tile and is renamed **See it** in the maker audience, and the dashboard links each
running project's own target. `public/` keeps its Public tab. In the tree its chip reads "shared" for a maker,
and Publish is reserved for it (section 2).

### 6.7 Instructions

The `AGENTS.md` editor exists at `/sandbox/agent?section=instructions`; the `memory` chip on the file row reads
"instructions" for a maker and says the same words in its tooltip.

### 6.8 Mobile

`shell/mobileTabs.ts` promotes four tabs. In the maker audience Workspace's tab becomes Projects, and the
Review tab keeps pointing at Approvals when that pack is on, else at the workspace's own review.

### 6.9 Saving, and what the maker audience hides

The Changes panel was going to be hidden, on the grounds that auto-version saves for the maker and restore
points are their way back. That was wrong in one place it mattered: the rail badges the uncommitted count for
both audiences, so the maker got a number on the Workspace tile with nothing behind it, and no route to a
working-tree diff at all (the tile, the tree row and the panel are the only three, and the first two never had
one). The badge has to lead somewhere.

So the Changes panel is the one surface with an audience of its own rather than a hidden one:
`features/workspace/changes/save/SavePanel.vue` reads the same `useChanges()` the developer's `ReviewPanel.vue`
does, and drops every decision git asks a developer to make.

- **No index.** One press records every repository whole (`commit` with `stage: {}`), so there is nothing to
  select and no staged/unstaged split to explain.
- **No message.** `savedMessage.ts` picks one: the sentence the commit-message model already wrote for that
  landing (`landed-subject.ts`), when every uncommitted file came from one assistant and nothing was
  truncated; the constant `Your edits` otherwise, which is the subject `version-landed.ts` already writes for
  the tree's own remainder. Nothing here asks a model — it only spends what land time produced.
- **Grouped by who, not by where.** Headings are the assistant that landed the files and "Your edits",
  since one project with one repository makes repository headings say nothing. A heading is a step UP the type
  scale from the names under it — it was once the smallest text in the panel, which is what stopped it reading
  as one — and its files hang off a rail, so the run of rows belongs to the name above it even mid-scroll.
- **Plain marks.** Git's `M`/`A`/`D` letters become a glyph, and under the file's own name the same thing in a
  word (changed, new, removed) beside the folder it is in. The name leads: a maker recognises "Offer.docx", not
  `drop/2026/Offer.docx`.
- **Throw away** is per file and all-at-once, each behind a sentence naming what goes back and what leaves the
  disk. **Back up** appears only for a project that owes its remote, and goes through `usePushFlow.askSync`
  like every other door to a push. Both whole-tree presses are glyphs in the sidebar's own icon row
  (`SaveActions.vue`, over `useSaveActions.ts`), not a bar along the panel's floor: a press that acts on
  everything belongs where the panel is titled, and the panel has one button of its own — Save, shrink-wrapped
  to its label rather than stretched across the column.

Still hidden: the terminal panel, the checks and persona row actions, and the management panel's Git and
Health tabs. Restore points stay: they are the maker's way back. Every hidden thing is back behind "Switch to
the developer view", and none of their state is lost by switching.

## 7. Vocabulary

One module, `_editor/web/src/core-views/vocabulary.ts`, a table keyed by audience and read by every surface that
says one of these words. Each entry is the whole label, not a substitution, so "Land while the agent is
working?" and "Accept while the assistant is still working?" are two strings side by side rather than a
template.

| key | developer | maker |
| --- | --- | --- |
| repo | repository | project |
| agent | agent | assistant |
| branch | branch | draft |
| land | Land now | Accept |
| landAgain | Land again | Accept again |
| requestLand | Request land | Ask to accept |
| discard | Discard | Throw away |
| review | Review | Look |
| commit | Commit | Save a version |
| changes | Changes | What changed |
| pendingChange(s) | uncommitted change(s) | unsaved change(s) |
| restorePoint | Restore point | Version |
| restore | Restore | Go back to this |
| push | Push | Back up |
| publishBranch | Publish | Back up |
| sync | Sync | Back up |
| diff | Diff | What changed |
| workspace | Workspace | Project |
| preview | Preview | See it |
| memory | memory | instructions |
| reference | reference | reference material |
| public | public | shared |

The rule for adding a row: a word goes in the table when a maker would have to ask what it means. Words that
are the same in both columns are not in the table.

## 8. Phases

Each phase can be built and merged on its own, and each leaves the developer's screens unchanged. The order puts the trap (section 5)
before the home, because a maker who gets the home first and the trap later loses work in between.

**Phase 0, the shared mechanism (core, small).**

- `features/settings/useAudience.ts`, the Appearance row, and the setup question in `Setup.vue`.
- `core-views/vocabulary.ts`, and the ~20 call sites in `AgentCard.vue`, `AgentDetail.vue`,
  `ReviewPanel.vue`, `HistoryPanel.vue`, `WorkspaceDesktop.vue`, `WorkspaceMobile.vue`, `mobileTabs.ts`,
  `specialPaths.ts` reading it.
- `registry.ts`: `RAIL_GROUPS` per audience, and an `always` tile resolves to the first registered id of a
  list (`[project, workspace]`).
- `explorerFilter.ts`: the technical predicate and its chip.
- `extension-api`: `api.audience()`, `onDidChange`, version bump.
- Daemon: the `agent.landed` moment, the `version-landed` builtin, the pre turn commit of the main tree's
  remainder, and the two rules the setup question writes into `.intentic/config/settings.json`.

**Phase 1, the home (`_extensions/projects`).** The dashboard (6.1), the rooted Workspace and its chip (6.2),
and the daemon's create route. A story in `docs/user-stories/07-make/` per block, so `ext-acceptance` walks
them.

**Phase 2, reading changes.** The prose diff viewer (6.3 tier 2), the maker agent card (6.5), the conflict
card as an ask, the rendered markdown default with the prose editor.

**Phase 3, arriving.** New project in a press, the arrival card's proposal, See it on the dashboard, mobile
tabs.

**Phase 4, the sweep.** Hide the panels and row actions of 6.9 behind the audience, the keybindings page,
the empty states, the notification wording (`shell/notifications/`), and a pass over every string the
scanner in `docs/user-stories/.acceptance.md` would have a maker read.

## 9. What this leaves open

- **The name.** `audience` with `maker` and `developer` is the proposal. The setting's question, "How will
  you work here?", matters more than the identifier. `mode`, `profile`, `face`, `lens` and `skin` are all
  taken by something else in the app.
- **Per account storage.** Browser storage matches theme and skin and needs nothing from the platform. A
  maker who opens the app on their phone would answer the question again once. If that grates, it is one
  platform setting later.
- **The dashboard as extension or core.** Extension, for the reasons in section 3, with the rail fallback as
  the guard. The rooted Workspace is core, since it is the Workspace.
- **Auto-version and a developer's own workflow.** The rules are written only when a maker's setup asks
  for them. A developer who wants "commit after land" can add the same row by hand in Sandbox ▸ Agent, which
  is the point of it being a row.

## 10. Stories to add

`docs/user-stories/07-make/`, written from the maker's chair, walked by `ext-acceptance`:

1. Arrive without code: answer the one question, land on the dashboard, start a new project in a press.
2. Ask for a change and see it happen: the assistant edits, a restore point appears, See it shows the result.
3. Read what changed without reading code: the prose diff, the code reading behind it.
4. Go back: undo the last change from the Restore points panel, and the tree is what it was.
5. Share it: the public link, and what "shared" means on a file row.
6. Switch views: a developer and a maker look at the same project and each sees their own words.

## 11. What changed on the way

Written after phases 0 to 4 were built, where the code disagreed with the plan above.

- **The question moved off the setup wizard.** `Setup.vue` ends with `router.push("/")` and the chat composer,
  so there is no screen to ask on. The card lives on the empty workspace pane instead (section 4), and only there:
  `WorkspaceEmptyState.test.ts` pins that the non-empty pane is the drop target and nothing else.
- **Auto-version is one rule, two moments.** Rather than a second rule for the pre-turn commit, the
  `version-landed` built-in at `agent.landed` also commits the main tree's remainder before an isolated turn
  starts (`agents/land/version-landed.ts`, `versionMainTree`, called from `agent.routes.ts` ahead of the sync).
  One switch on the Agent tab ("Save a version of accepted work"), one row in the table. The landed paths are
  committed with `git commit --only` after staging them (`changes-index.ts`, `commitOnly`), which leaves the
  owner's other staging alone. The subject is awaited from `landed-subject.ts` first, so nothing is amended.
- **The rail's stand-in is a field, not a list.** `RailItem.standIn` names the core id that takes an
  extension's `always` tile while that extension is not registered; `railPolicy` reads the registry to decide.
  `homeViewId()` is the one answer the desktop rail, the phone's tab bar and the mobile menu share.
- **The prose diff is the app's own.** No diff library is a dependency of the web app, so
  `viewers/proseDiff.ts` is a table LCS over paragraphs and then over words, with a cell ceiling past which a
  block reads as replaced whole. `ProseDiffView.vue` draws it, and the toolbar's Prose/Code control and the
  `ui-diff-prose` preference (auto follows the audience) decide which reading a markdown or text file opens in.
- **See it has an address.** `/preview?target=repo:<id>` selects the Preview area's target on arrival
  (`PreviewArea.vue`), so the dashboard links each running project to its own site rather than to whatever was shown last.
- **The first home was a page, and it was replaced by a dashboard.** The first build put a timeline, a file
  list and the ways in on one Project page (`_extensions/project`). The owner's read: the Workspace's restore
  points already are the timeline, and what a maker needs first is to see their projects and open one. So
  `_extensions/projects` draws tiles, makes a repository in a press (`POST /workspace/repos/new`, the daemon's
  own `git init` with a first commit), and opens the Workspace rooted at the repository (`?dir=`, section 6.2).
  Every destination is an anchor built with `appLink(api.href(...))`, which the repo's link rule
  (`navigatingControl.test.ts`) enforces across extensions.
- **The developer's surfaces step aside by audience, in place.** The Changes tab and the Restore points
  button leave the workspace sidebar, the persona and check row actions leave the tree (`rowActions.ts`, `plain`)
  and the Git and Health tabs leave the management panel (`directoryTabs.ts`), and the terminal tile leaves the
  rail and the phone menu. Each is one `maker`
  read at the call site, and each comes back with the other answer.
- **A `home` glyph was added to the icon set** while the first home existed; the dashboard wears `th-large`.

## 12. The project scope

Built after the dashboard, on the owner's read that opening a project should narrow the whole shell rather than
one view. One selection, `projectScope` (`app/projectScope.ts`), kept per sandbox like the rail's pins and shown for
everyone, developer or maker.

**What it narrows, and where.** Every surface that reads repository facts reads them through one of three
sources, and each source applies the scope once: `usePanels` (the rail's tiles, every extension view through
`api.workspace.repos()`, the preview's targets), `useRepos` (the tree's affordances and the history switcher) and
`useChanges` (the Changes list). The workspace roots at the project (`workspaceDir` is derived from the scope,
and the chip in its toolbar clears it). Nothing per view learned about projects: a pipelines or maintenance tile
that keys by repository narrows because its facts did.

**Who belongs to a project.** The agents board keeps the conversations with evidence of belonging
(`board/projectMembership.ts`): the conversation opened inside the project, or the persona it acts as starts
inside it, carries it (`context.repos`), or is fenced to a folder inside or around it. A persona that says
nothing about the project and a root-started conversation with no persona stay under All projects, so the scope
narrows rather than relabels. A draft not yet sent stays, since it was opened under the project and has no
record yet. Two facts had to reach the wire for this: `startIn` and `actsAs` are latched on the conversation at
its first turn and exposed on the summary; `startIn` is also accepted on the turn itself, so New agent under a
scope opens the conversation in the project (a persona's own start folder still wins). A held wake follows the
thread it would continue or the persona it would speak as (`actsAs`, snapshotted on the held record at hold
time); a workflow run follows any of its steps. The chip counts rows, not conversations: a hidden run's steps
hide with it and count once. The archive stays the sandbox's, since its Delete all empties the whole pile and
its count must say the whole pile. The Agents rail badge stays sandbox-wide too, so a hold on another project
is never missed while looking at one.

**Where it shows.** The Projects tile heads the rail for everyone, above Chat and Agents, since a mode needs an
indicator and a switcher belongs above what it switches: while a project is open the tile wears the project's
first two letters in place of its glyph (`Activation.monogram`) and its title reads "Projects · web"; the
dashboard marks the open tile and offers All projects; the workspace, the agents board and every extension view
that lists by repository carry the same chip (`ProjectChip`), which names the project, counts what that surface
hid, and clears the scope. The extension API grew `api.workspace.project()`, `setProject()` and
`onDidChangeProject()` (2.13.0), since the dashboard that sets the scope is an extension, then `inProject(path)`
and `Activation.monogram` (2.14.0).

**What the scope cannot reach by itself.** Pipelines, maintenance and deployments list rows from their own daemon
routes (CI runs, chore reports, the Komodo board), never through `repos()`, so they did not narrow with the three
sources above. Each now filters its own rows with `api.workspace.inProject` and says on its chip how many
repositories it hid. Documentation, acceptance and the repo-keyed tiles read `repos()` and narrowed already.

**New agent under a project.** A press naming no persona wears the project's own card
(`features/sandbox/personas/projectPersona.ts`): id `project-<name>`, opened in the project, fenced to it
(`workspace.folders`), carrying its repository (`context.repos`). Made the first time it is needed and never
rewritten, so what the owner adds to the card (accounts, a brief, a model) stays; it is an ordinary card in the
personas list and the composer's picker can swap it for another. Chosen over starting the conversation in the
folder alone because a start folder does not stop file tools leaving it, and over reusing whichever existing
persona reaches the project because that persona's accounts and brief would come along uninvited.

