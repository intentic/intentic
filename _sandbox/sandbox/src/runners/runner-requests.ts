/* WHICH RUNNER RAISED THIS CARD, the one fact a parent needs to answer a question it did not ask.
 *
 * A remote turn's question, permission prompt or plan approval is minted in the RUNNER's request registry
 * (agent/agent-requests.ts, over there), and the frame carrying its id travels to the parent, which persists
 * it and draws the card. The answer comes back to the parent as `POST /agent/reply` with a `requestId` and
 * nothing else: no conversation, no machine. The parent's own registry has never heard of that id, so
 * without this table the answer is a 404 and the remote turn waits forever, which is exactly what the
 * feature's first real run showed.
 *
 * So the parent watches the frames it is already relaying (runner-dispatch.ts) and writes down where each id
 * came from. In memory, deliberately: an id belongs to a turn that is parked RIGHT NOW, and a daemon restart
 * ends every turn it could have belonged to (the runner's own abort settles the card as cancelled).
 *
 * BOUNDED, because this is fed by a stream a remote agent controls: a turn that raised thousands of cards
 * must not grow the parent's memory without limit. Oldest-first eviction, and every id is dropped the moment
 * its `resolved` frame passes by, which is the ordinary end of a card's life. */

interface RemoteRequest {
    readonly runnerId: string;
    readonly conversationId: string;
}

// Roughly a hundred conversations' worth of simultaneously-parked cards. Far above any real fleet, low
// enough that a runaway stream costs nothing worth measuring.
const MAX_TRACKED = 2_000;

const raised = new Map<string, RemoteRequest>();

export const noteRemoteRequest = (requestId: string, request: RemoteRequest): void => {
    // Re-noting an id keeps its ORIGINAL position: a card re-announced on reconnect is the same card, and
    // refreshing its place would let one chatty turn hold the table against everyone else's.
    if (raised.has(requestId)) {
        return;
    }
    if (raised.size >= MAX_TRACKED) {
        const oldest = raised.keys().next();
        if (!oldest.done) {
            raised.delete(oldest.value);
        }
    }
    raised.set(requestId, request);
};

export const remoteRequestOf = (requestId: string): RemoteRequest | undefined => raised.get(requestId);

export const forgetRemoteRequest = (requestId: string): void => void raised.delete(requestId);

// Every card a conversation still has parked, dropped together: its turn ended, so nothing it raised can be
// answered any more. Called when a remote dispatch unwinds, however it ended.
export const forgetRemoteRequestsOf = (conversationId: string): void => {
    for (const [id, request] of raised) {
        if (request.conversationId === conversationId) {
            raised.delete(id);
        }
    }
};

// Test seam only: the table is process-wide, so a suite that asserts eviction needs a clean slate.
export const resetRemoteRequests = (): void => raised.clear();
