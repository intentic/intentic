# Chat state across windows

The daemon owns agent execution state; the window displaying chat owns its presentation state.

The fleet combines the daemon's registry with one chat projection, `chatStrip`: open tabs, active conversation,
pane order, draft previews and selected workflow. A board must not combine that projection with its own hidden
conversation store. Those conversation objects can have different drafts, tabs, transcript hydration and focus.
The board's workflow highlights and synthesis action obey the same boundary as its cards.

`floating.ts` elects the oldest live claim, with the id breaking ties. It retains competing claims separately:
a losing window announcing itself and then closing cannot remove the winner. Expiration requires both a stale
heartbeat and a fresh Web Locks query showing that the claim is gone. A suspended window can stop producing
heartbeats while its browser still holds its lock. Each reloaded realm gets a new claim id.

A claim ends at once only when its window hands the panel back while it is still running (`gone`): its Dock
press, F9, the desktop app's ×, a dock request from another window, a lost race. An unloading window cannot
tell a reload from a close, since `pagehide` is the same for both, so it announces `unloading` instead. The
note promises a return within twice that realm's own boot time, from navigation to claim. The promise is at
least the stale deadline and at most ten seconds, since a reload repeats the boot. The claim keeps the panel's
place until then, and any live claim outranks it. A reloaded realm therefore becomes the owner at its first
heartbeat, and the other windows never draw the panel in between.

A fixed deadline was rejected. The measured dev-server reload took 1.6 to 5 seconds, depending on machine
load, while a production reload fits inside the stale deadline. Any single number either flickered the panel
back on slow machines or delayed every close on fast ones. The `window.closed` flag of the opener's proxy does
tell a close from a reload, but only in the window that opened the popup, and only until that window reloads.

The cost falls on a browser close: the panel returns only when the promise lapses. It returns without
navigation, because only a hand-back moves a window to the panel's route. A dock request for an unloading
claim is answered by every window at once, since no one is left to hear it.

`chatEcho.ts` accepts a snapshot only from the current owner, for the selected sandbox, with a newer revision.
The publisher records the sandbox supplied by the restored tab store; changing the selected sandbox cannot
relabel its cached outgoing snapshot. `useChat-strip.ts` includes the restored scope in its watch key even if
the incoming tabs happen to serialize identically. Ownership and scope changes clear the old projection.

BroadcastChannel messages are transient. A one-time startup request and updates only on change can leave a
board stale forever after a lost request or response. A board therefore requests a full snapshot on ownership
and sandbox changes, on focus, on page restoration and when becoming visible. While following a floating
owner, it also requests a snapshot every 2.5 seconds. Browser suspension can delay timers; lifecycle recovery
runs when the window resumes. A holder responds after Vue has flushed tab restoration and pane reconciliation.
Empty snapshots are valid and retract stale cards.

Tabs, pane order, focus and workflow selection persist together. When the panel returns, its tab store restores
the last saved presentation rather than inferring workflow selection from a hidden window's stale state.
`intenticFocusTrace()` records ownership changes with sandbox and holder identity for diagnosis.

Protocol unit tests exercise owner replacement, stale revisions, delayed discovery, lost updates and lock-query
ordering. The separate Chromium suite in `_tools/e2e/window-sync` runs actual BroadcastChannels and Web Locks
through reload, frozen pages, competing claims, docking, closing and sandbox switches, including that a
holder's reload never hands the panel to the board. It tests the communication boundary;
the web package's store and synthesis tests cover consumers of the projection.
