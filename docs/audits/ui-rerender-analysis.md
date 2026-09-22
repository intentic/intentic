# UI re-render analysis

What the editor redraws that nothing on screen asked for, measured in a real browser against `_site/demo`, and what
was changed. Four things were wrong, all of the same shape — **a dependency wider than the thing that reads it** —
and all four are fixed. Three other suspects were measured and cleared, which is recorded here so the next session
does not chase them again.

## How it was measured

`_editor/web/src/app/renderTrace.ts`, added by this pass. Dev-only (`import.meta.env.DEV` in `main.ts`, so the module
and its hook leave a production build) and idle until armed:

```js
__intenticRender.on()        // start recording
__intenticRender.table()     // redraws per component, worst first, with the write behind most of them
__intenticRender.why('X')    // every write that woke X, with the writer's frame and stack
__intenticRender.off()
```

It reports two numbers per component and they answer different questions:

- **redraws** — what the screen paid, read off Vue's own `app.config.performance` measures, split per instance so
  "30 redraws" distinguishes one card redrawn thirty times from thirty cards redrawn once.
- **triggers** — how often the component was woken. A trigger is not a redraw: Vue marks the effect dirty, then skips
  the render if every computed in the way settled on the value it already had. A component with many triggers and no
  redraws is subscribed to something noisier than it needs, and is the cheap version of the same bug.

`__intenticPerf` already measured time and the browser's profiler already measured what ran. Neither says *why* a
component that nothing changed redrew, which is the only question that leads to a fix.

## 1. The shared clock woke every consumer, armed or not

`useNow(active)` is the app's one wall clock: a single `setInterval`, ref-counted so it runs only while some readout
is live. The gate worked for the *interval* and not for the *dependency* — the returned ref was the shared one, so
every consumer was invalidated by every other consumer's tick.

Measured on `/demo/agents`, idle, 15 seconds, with one agent drawing an elapsed readout:

| component | triggers | redraws |
| --- | --- | --- |
| `SandboxGate` | 15 | 0 |
| `SandboxSwitcher` | 15 | 0 |
| `NotificationHost` | 15 | 0 |

Three shell components re-evaluating their computed chains once a second, forever, for a clock they had asked not to
receive. `useSandboxAvailability` is the clearest case: it arms `useNow` only while a connection is failing, then
reads `now.value` unconditionally.

**Fix** (`_editor/ui/src/composables/useNow.ts`): read the shared ref only while armed, and hold the instant the
consumer stopped following so a settled readout does not jump. After: those three rows are gone from the table
entirely; what remains on an idle board is the one card that genuinely ticks.

## 2. A slot's reactive reads belong to the component that invokes it

`ChatTabList` drew each open chat inline: `RailLane` → `RailCard` → `#meta` slot → `UnsentMark`, with
`draftPreview(c.draft.value)` and `tabLabel(c)` written in the list's own template. Slot content is compiled into the
parent but **executed during the child's render**, so `RailLane`'s render effect tracked the composer's draft — one
chat's typing redrew the lane header, the lane's Clear button, and rebuilt the vnodes of every card under it.

Measured, 20 keystrokes in the composer, two chats open:

| component | redraws | render time |
| --- | --- | --- |
| `RailLane` | 20 | 16 ms |
| `Button` (the lane's Clear) | 40 | 6 ms |

Linear in the number of open chats, and paid on every character.

**Fix**: `ChatTabRow.vue` — the row is a component, so the draft is read inside the thing it names. The view-model
derivation moved with it into `cardView.ts` (`createCardViews`), which is where the identity-holding rule that keeps
unchanged cards from redrawing now lives on its own. `ChatTabList` lost ~190 lines.

## 3. A wide question asked for a narrow answer

`tabsInLane` and the tab sweep called `untouched(tabFacts(conversation))` — building the whole published projection,
draft preview included, to answer four booleans. That made `clearing` (and so `ChatTabList`) a reader of every
composer's text.

**Fix**: `untouched` / `unasked` take the fields they read, and `untouchedDraft` / `unaskedDraft` answer from a live
conversation without building a `TabFacts` at all.

### Where that leaves typing

Measured from cleared storage, so it reproduces. Typing into a chat that already has a title, 20–21 keystrokes:

| component | before | after |
| --- | --- | --- |
| `RailLane` | 20 redraws / 16 ms | **0** |
| `Button` (lane Clear) | 40 / 6 ms | **0** |
| `RailCard` | 20 (the typed card) | 21 (the typed card) |

Typing into a fresh, untitled "New agent" — the case whose card *is* named by what you type — still cost
`ChatTabList` 2 redraws, `RailLane` 2 and `Button` 2 over 19 keystrokes at this point. Finding 4 took those to 0;
the table there is the current state.

## 4. The composer's draft was a dependency of the whole fleet

The deepest one, invisible from any single file. `tabFacts.preview` was `draftPreview(conversation.draft.value)`;
`useChat-strip.localStrip` carried it; `useAgents-fleet.fleet` rebuilds its entire card list from that strip; and
`fleet` is what `agentById` answers from — so a character typed into one composer invalidated the roster for every
surface that asks it anything: the board, `fleetScope`, `synthesizeSessions`, and the rail's lanes (`laneOfTab`,
`originOf`, `isArchived` all resolve through `agentById`). The work was linear in fleet size: rebuild the list,
fingerprint every agent (two `JSON.stringify` each), per character.

**Fix**: the words are not a field of anything. They are a lookup, keyed by conversation id, read where they are
drawn.

- `TabFacts` loses `preview` and keeps `unsent`. That split is the whole idea: `unsent` is the low-frequency half
  (it settles after the first character), the words are the high-frequency half, and only the second one moves while
  someone types.
- `useChat-strip` publishes two projections instead of one, and `chatEcho` carries the second on its own note. That
  note needs no owner and no revision, unlike the strip: it is a lookup the strip's `unsent` decides whether to draw
  from, so one arriving late, stale or not at all shows no words — never a wrong card.
- `chatPreviews` merges the words a closed chat set aside (`closedDrafts`, already in every window) under the live
  composers, so one lookup answers for open and set-aside drafts alike. `previewOf(id)` is that lookup.
- `FleetAgent` loses `preview`, and `agentDisplayTitle(agent, preview)` takes the words rather than reading them off
  a card. Three surfaces pass them: `AgentCard` (through a computed of its own, so Vue compares one string and only
  the card being typed into redraws), the quick-open palette, and the rail's search-results lane.

### A publish that had to be gated too

Splitting the projection is not enough on its own, and this only showed up under measurement. A keystroke wakes both
publish watchers whatever is in them: `unsent` is derived from the draft, so Vue marks the chain dirty and runs the
jobs before finding the values settled. A watcher job re-runs its getter unconditionally, and the old getter returned
a fresh array — never `Object.is`-equal — so it re-serialized the strip and called `publishStrip` on every character
with byte-identical content. In a popped-out chat that is a BroadcastChannel post per character, and the window
holding the board rebuilds its whole card list from `elsewhereStrip` for each one.

Moving the serialization into a computed fixes it: a computed compares the string it produced, and an unchanged strip
stops there. Both columns measured on `/demo/chat`, 20 keystrokes, storage cleared — the second is what shipped:

| per 20 keystrokes | words split out | + publish gated |
| --- | --- | --- |
| `fleet` rebuilt and fingerprinted | 4 `JSON.stringify` in total | 4 in total |
| strip serialized | 20 (365 bytes each) | **0** |
| strip published, and broadcast if popped out | 20 | **0** |
| previews serialized / published | 20 / 17 | 20 / 17 (~67 bytes each) |

The column before those two is not there because it needs no measuring: the words were a *field of the strip*, so
the strip changed on every character by construction, and `fleet` rebuilt and fingerprinted every agent with it —
which is the measurement that opened this finding.

### Where that leaves a keystroke

Same page, same 20 keystrokes, typing into the one case whose card *is* named by what you type:

| component | redraws | instances | what it is |
| --- | --- | --- | --- |
| `ChatPane` | 20 | 1 | the composer being typed in |
| `RailCard`, `ChatTabRow` | 20 | 1 | the row being typed into, naming itself |
| `UnsentMark`, `IdentityTile` | 17 | 1 | the mark on that row |
| `RailLane`, `ChatTabList`, `ShellDesktop`, `ChatForkLine`, `ChatPaneNotices` | **0** | — | woken 20×, drew nothing |

Everything that redraws is the card being typed into. Nothing else draws.

## Measured and cleared

Recorded so they are not re-derived:

- **The strip's `JSON.stringify` during a streaming turn.** Looks alarming — publishing serializes the whole strip —
  but `costUsd`/`inputTokens`/`outputTokens` folding over the transcript each frame only reach it when the number
  actually moves. Measured 3 serializations across a 12 s turn, not 60/s. (Read the mechanism off finding 4's second
  half, not off this bullet: the value comparison that saves it belongs to computeds, which is why the publish gate
  had to become one.)
- **The tab snapshot written per keystroke** (`useChat-tabs.ts`, whose comment invites a throttle "if profiling shows
  jank"). It does one `localStorage` + one `sessionStorage` write per character: 8.2 KB each across 20 keystrokes,
  0.3 ms total. Not jank at this size. The comment is still accurate; leave it until a fixture with twenty open chats
  and long drafts says otherwise.
- **`snapshotFingerprint` in `stabilizeFleetEntry`** — two `JSON.stringify` per agent per pass. Real, but 0.1 MB of
  serialization measured at ~1 ms, and the comment on `snapshotFingerprint` explains why the cached side cannot be
  memoized. Left alone.

## What is still woken, and why that is the floor

A keystroke still *wakes* `ShellDesktop`, `ChatTabList`, `RailLane`, `ChatForkLine` and `ChatPaneNotices` 20 times
per 20 characters, each drawing **nothing**. This is not a leftover dependency: `Conversation.unsent` is a computed
over `draft`, so a character marks that chain dirty and Vue queues every effect hanging off it, then finds every
value settled and skips the renders. A wake with no redraw costs a flag walk and a job that returns.

Taking it to zero would mean `unsent` no longer deriving from the draft — a ref written by a watcher on the boolean
edge. That trades a declarative fact for two pieces of state that can disagree, which is the shape of bug this pass
exists to remove. The computed is correct; the wake is Vue's propagation, not a modelling error. Left alone
deliberately.
