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
through reload, frozen pages, competing claims and sandbox switches. It tests the communication boundary;
the web package's store and synthesis tests cover consumers of the projection.
