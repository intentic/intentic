// Which runner raised this card: a remote question, permission or plan approval is minted in the runner's registry, but
// its reply comes back as just a requestId, nothing the parent's registry recognizes. Watches the frames it already
// relays and records each id's origin, in memory (a restart ends every parked turn) and bounded (oldest-first
// eviction).

interface RemoteRequest {
    readonly runnerId: string;
    readonly conversationId: string;
}

// About a hundred conversations' worth of parked cards: far above any real fleet, cheap even runaway.
const MAX_TRACKED = 2_000;

const raised = new Map<string, RemoteRequest>();

export const noteRemoteRequest = (requestId: string, request: RemoteRequest): void => {
    // Re-noting keeps the original position: refreshing it would let one chatty turn crowd out everyone else.
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

// Drops every card still parked for a conversation whose turn ended; called whenever a remote dispatch unwinds.
export const forgetRemoteRequestsOf = (conversationId: string): void => {
    for (const [id, request] of raised) {
        if (request.conversationId === conversationId) {
            raised.delete(id);
        }
    }
};

// Test seam only: the table is process-wide, so a suite that asserts eviction needs a clean slate.
export const resetRemoteRequests = (): void => raised.clear();
