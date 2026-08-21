# UI component duplication audit

A sweep of every Vue surface in the repo (308 components across the kit, the web app, the extensions and the
desktop app) for components that solve the same problem twice. Findings were ranked by payoff: how much drift
the duplicate was causing, weighed against how hard it is to collapse.

The kit (`_editor/ui`) was already in good shape and has clearly been through dedup passes before: `FilterBar`,
`ChangeStatusMark`, `SplitView`, `ResizeSeam` and `Row`/`RowGroup` all carry comments naming the surfaces they
replaced. Date/time formatting is fully centralised: there is not a single stray `toLocaleDateString` outside
`format.ts`.

**Everything below has been acted on.** Each section states what was duplicated and what replaced it, so the
reasoning survives the change. Three user-visible bugs fell out of the work and are marked ⚑.

---

## 1. Two chat composers

**What it was.** The chat composer and the "suggested session" box were the same instrument built twice: a box
you type into, a model pill, a reasoning-effort meter, a send button. `efforts` / `effortIndex` / `effortLabel`
/ `effortFill` were duplicated verbatim between `chat/ChatPane.vue` and `agents/SuggestedSessionBox.vue`,
including the `50 + (i / top) * 45` fill curve; the pill markup and the picker host matched line for line.

**Now.** Two components in `_editor/web/src/chat/`:

- **`ComposerEffort.vue`**: the segment ladder, the fill ramp, the level word, and the rule that it draws
  nothing where the runtime doesn't take an effort. Takes a `Conversation`; `disabled` and `labelClass` are the
  only things the two composers differ on.
- **`ComposerModelPill.vue`**: provider mark · model name · chevron. It exposes its own element (`el`), because
  the button *is* the overlay's anchor and the anchor is what decides which window a panel opens in.

`ChatPane` lost the four duplicated computeds and ~35 lines of markup. Whether the *whole* composer should be
one component is still open: the rest of it (attachments, @-mentions, slash commands, dictation, queueing) is
genuinely chat-only, and the box deliberately has none of it.

**Not touched.** `_sandbox/webchat-widget/src/element.ts:219` has a third auto-grow, but that widget is a
vanilla custom element embedded in customers' pages and cannot import Vue.

---

## 2. Six implementations of "a text field that filters a list"

**What it was.** Six spellings of one control: magnifier glyph, placeholder, type to narrow. Two zoomed the
whole page when tapped on an iPhone (no `text-base` below `md`); one drew a second, unstyleable clear "×" beside
its own on Safari; three cleared on Escape and three did not. Both the kit's `SearchBar` and the web app's
`FilterField` opened their doc comment claiming to be *the* one.

**Now.** One `_editor/ui/src/components/SearchBar.vue` with two dresses:

- `variant="panel"` (default): a scrolling panel's borderless first row (the model picker, `PickerPanel`,
  `NavRail`, `FilterBar`, git-history).
- `variant="field"`: the standalone bordered box above a list, with `clearable` and `busy` folded in from
  `FilterField`.

`FilterField` is deleted. Converted: `agents/AgentsView.vue`, `chat/ChatTabList.vue`, `chat/ChatTabs.vue`,
`chat/ChatTabsMobile.vue`, `pages/sandbox/SandboxSecrets.vue`, `_extensions/automations/src/AutomationsView.vue`.

⚑ **`ChatTabsMobile.vue` had `type="search"`**: the WebKit double-clear-button bug `FilterField`'s own comment
warned about. Fixed.

---

## 3. `extension-ui` handed out both the kit component and the raw primitive it wraps

**What it was.** `_editor/extension-ui/src/index.ts` re-exported the kit *and* the PrimeVue primitives the kit
exists to hide, so extension screens drifted from the app around them: a dropdown with OS chrome beside one
with the app's own, a text field with a different focus ring.

**Now.** `Select` and `InputText` are gone from the surface; their four consumers took `Picker` and `cmp.input`
(`workflows/StepInspector.vue`, `documentation/DocsView.vue`, `repo-apps/AddAppDialog.vue`,
`acceptance/TargetChip.vue`). `Dialog` and `Popover` stay: the kit has no general dialog shell yet, and
`ConfirmDialog`/`InfoDialog` are both narrower than the five views using `Dialog` need.

---

## 4. The kit's own gaps were what forced the hand-rolls

Eighteen things existed in `@intentic/ui` but were not re-exported from `@intentic/extension-ui`. The six with
real demand now are: **`clipboardOf`**, **`AnchoredOverlay`**, **`ResponsiveOverlay`**, **`InfoDialog`**,
**`InfoTable`**, **`useListNavigation`**.

⚑ **Copying silently did nothing in a popped-out window.** A popped-out panel is teleported into a real second
window while its JS keeps running in the opener's realm, so the module-global `navigator.clipboard` belongs to a
document that isn't focused: the write rejects and every call site swallows it. The kit's `clipboardOf` reaches
the clipboard through an element instead. Four sites bypassed it and are fixed:
`_extensions/git-history/src/GitHistoryTab.vue` (which had no way to reach `clipboardOf` at all: hence the
export), `pages/workspace/WorkspaceTree.vue`, `WorkspaceDesktop.vue`, `WorkspaceMobile.vue`.

Still not exported (no demand yet): `PullToRefresh`, `BrandMark`, `PickerPanel`, `placeAnchored`,
`useHighlighter`, `withinWindow`, `initialsOf`, `formatWeekdayTime`, `vTw`, `useTextSize`, `useExplorerStyle`,
`useOsPreference`, `MachineDetail`.

---

## 5. The "sheet on mobile, popover on desktop" pair

**What it was.** The audit first counted ten sites; five of those turned out to be mobile-only sheets or
desktop-only popovers, which are not the pattern. The genuine pairs were five, across three files: `ChatPane`
(model, mode, workflow), `SuggestedSessionBox` and `HostModelPicker`.

**Now.** `_editor/ui/src/components/ResponsiveOverlay.vue`: anchor + `v-model:open` + `header` + `panelClass`,
default slot. It owns the two traps the hand-written pairs kept re-learning: the hosts must stay mounted with
only the *content* conditional (`AnchoredOverlay` places in a non-immediate watcher, so a host mounted already
open never places at all and sits parked off-screen), and there must be **one** open flag rather than one per
surface. `SuggestedSessionBox` had grown exactly that second bug: a `modelOpen` and a `modelSheetOpen`.

⚑ **The loop dialog never opened on desktop.** `ChatPane` forked its whole picker block on `v-if="mobile"` /
`v-else`, and the loop dialog (an ordinary centred dialog with no touch variant) sat in the mobile half. The
loop pill is drawn on both, so pressing it on a desktop set the flag and nothing appeared. Collapsing the fork
is what made it visible.

Since resolved a second time and more thoroughly: the loop pill now opens a `ResponsiveOverlay` menu like its
four neighbours, and the long form moved to the workflows page. A centred dialog raised from a composer had a
failure this audit's own rule predicts: it teleports into the app's document, so pressing the pill in a
**popped-out chat window** opened it in the window behind. The anchor is what decides the window, and a dialog
has no anchor.

`Picker.vue` still has its own internal swap. Folding it onto `ResponsiveOverlay` is a follow-up: `Picker`
additionally measures its trigger to floor the panel width, which `ResponsiveOverlay` has no notion of.

---

## 6. Two relative-time formatters

`_editor/ui/src/format.ts` `timeAgo` and `_editor/web/src/composables/chat/usageStatus.ts` `formatAge` were the
same ladder written twice, and had drifted at every tier: one rounded to nearest and the other floored, one
called two minutes "just now" and the other one minute.

**Now.** One `timeAgo(at, { now?, days? })`. `days: true` keeps counting in days past the first (what a "measured
N ago" reading wants); the default still hands over to the absolute timestamp (what a log or history row wants,
where "3d ago" is less useful than the date). `formatAge` survives **as a name, not an implementation**: a
one-line delegation, because eight call sites spelling `{ days: true }` inline is worse than one domain word.

It now rounds **down** everywhere: "1h ago" spans the whole hour after the first and never claims more time has
passed than has. One test changed with it: a machine last seen 90 minutes ago reads "1h ago", not "2h ago".

`_editor/web/src/components/VpnCard.vue`'s `ago` was genuinely different (an uptime *duration*, "3h 20m") and is
renamed `uptime`; the collision was an invitation to substitute the wrong one.
`composables/chat/catalog.ts` `relativeTime` is deliberately distinct and stays.

---

## 7. Smaller clusters

**"Add another" dashed tiles.** Spelled out six times at three radii and two text sizes. Now `cmp.addTile()`:
the clickable half of the dashed-outline idea whose passive half (`cmp.emptyState`, 31 uses) already existed,
which is why the clickable one kept getting rewritten. Applied in `agents/AgentsView.vue`,
`chat/ChatTabList.vue`, `shell/ShellDesktop.vue`, `pages/TerminalPanel.vue` (×2) and
`_extensions/automations/src/AutomationsView.vue` (×2).

**Auto-grow textareas.** Four hand-rolled measure-and-set implementations sit alongside `ProseField.vue`, which
sizes itself with a CSS grid replica and no JavaScript: and whose doc comment explains that measuring on
`nextTick` measures the *fallback* font and clips long text once the webfont swaps. The four have that bug.
**Not changed:** `ProseField` is borderless-prose styled and not a drop-in, and the two composer textareas carry
their own max-heights and keyboard rules. The grid-replica technique should be what any new one uses.

**Large centred empty states.** `pages/workspace/WorkspaceEmptyState.vue` and
`_extensions/memory/src/MemoryView.vue:184` are the same block at different sizes. Two instances: watch, don't
act.

**Count formatting.** `codebaseHealth.ts` `formatCount`, `refactorAsk.ts` `count` and `usageChart.ts`
`formatCompact` are three takes on "abbreviate a big number". `format.ts` has `formatTokens` and `formatBytes`
but no general one. Left alone: the three round differently on purpose and no two sit near each other.

---

## Not duplicated (checked, and fine)

- **Date/time.** One `Intl` table in `format.ts`; no strays anywhere.
- **Tooltips.** One custom directive, one documented exception list, 102 call sites. Exemplary.
- **Tables.** `InfoTable` plus two genuinely tabular `<table>`s (`PlanLimitsPanel`, `SandboxUsage`).
- **DAG graphs.** `PipelineGraph` (a mini status strip) and `PipelineDagGraph` (the full graph) look like a
  duplicate pair but are not; both derive shape from one `pipelineDag.ts`, and the full one uses the kit's
  `DagGraph`. Vue Flow appears only inside the kit.
- **Model pickers.** `ModelPicker` is the one list; `ChatModelPicker`, `HostPickerBody` and `HostModelPicker`
  are thin bindings of it.
- **Desktop app.** Uses the kit throughout; no parallel component set.
- **Spinners, badges, avatars, icons.** Single shared implementations.
