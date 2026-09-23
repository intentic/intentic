import type { ListenerStatus } from "@intentic/sandbox-contract";

// Push-based listener status: an extension's gateway process POSTs its live connection/voice snapshot to
// /listeners/<provider>/status, and the activity route reads it here, the daemon holds no provider connection
// of its own to probe. The schema lives in the contract (listener-protocol.ts) so the gateways type the
// snapshot they POST against the declaration this module parses with.

// A module singleton (like listeners' batchers) with a TTL, so a crashed or stopped gateway ages out to "no
// status" instead of showing a stale "connected"; the reconcile cadence is ~30s, so 90s is three missed posts.
const STATUS_TTL_MS = 90_000;
const statuses = new Map<string, { status: ListenerStatus; at: number }>();
// Aging out is a change nobody posts, so each entry announces its own expiry; re-armed by every post.
const expiries = new Map<string, ReturnType<typeof setTimeout>>();
const movedListeners = new Set<() => void>();

const moved = (): void => {
    for (const listener of movedListeners) {
        listener();
    }
};

/** Called whenever a provider's readable status changes: a different snapshot, a first one, or one aging out. */
export const onListenerStatusMoved = (listener: () => void): (() => void) => {
    movedListeners.add(listener);
    return () => void movedListeners.delete(listener);
};

export const setListenerStatus = (provider: string, status: ListenerStatus, now: number): void => {
    const previous = listenerStatus(provider, now);
    statuses.set(provider, { status, at: now });
    clearTimeout(expiries.get(provider));
    const expiry = setTimeout(() => {
        expiries.delete(provider);
        moved();
    }, STATUS_TTL_MS + 1);
    expiry.unref();
    expiries.set(provider, expiry);
    // A gateway re-posts the same snapshot every reconcile; only a different one is news.
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(status)) {
        moved();
    }
};

// The latest status a provider's gateway posted, or undefined when none arrived within the TTL (never posted,
// or the gateway went quiet).
export const listenerStatus = (provider: string, now: number): ListenerStatus | undefined => {
    const entry = statuses.get(provider);
    if (entry === undefined || now - entry.at > STATUS_TTL_MS) {
        return undefined;
    }
    return entry.status;
};
